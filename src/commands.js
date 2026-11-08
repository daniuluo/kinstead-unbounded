// Every change a player makes to the town is a command: a small plain object
// such as { t: 'place', type: 'house', x: 10, z: 12 }. In single-player and on
// a multiplayer host, game.cmd() applies it at once; a guest sends it to the
// host, which checks it with the same World rules as its own actions and
// applies it for everyone (see src/net/). Commands carry only what a player
// chose, never rule-bending options, and each one is checked before it runs.
// A guest the host has made a visitor can't run any.

import { BUILDINGS, TECHS, TRANSIT, PRODUCE, KINDS } from './defs.js';
import { STYLES } from './render/buildings.js';
import { ROAD_OPS, applyRoadEdit, applyDress } from './world/streets.js';
import { DRESSINGS } from './config.js';
import { cleanText, hasKey } from './util/text.js';

const SPEEDS = [0, 1, 2, 4, 8, 16, 32];
const LOOKS = new Set(STYLES.map(s => s.id));
const SANDBOX = ['infiniteMoney', 'unlockAll', 'freeUpgrades', 'instantBuild'];

const int = (v, lo = -1e9, hi = 1e9) => Number.isInteger(v) && v >= lo && v <= hi;
const opt = (v, lo, hi) => v == null || int(v, lo, hi);
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo - 1e-9 && v <= hi + 1e-9;
// a point on the map (any position: nothing is on squares)
const pt = (w, x, z) => num(x, 0, w.N) && num(z, 0, w.N);
const at = (w, c) => pt(w, c.x, c.z);
// an angle a building may face (radians, as b.a)
const ang = (v) => v == null || num(v, -10, 10);
// the points a player drew a road or track through: [[x, z]], a few hundred at most
const curve = (w, list) => Array.isArray(list) && list.length >= 2 && list.length <= 400 && list.every(p => Array.isArray(p) && p.length === 2 && pt(w, p[0], p[1]));
// road edge ids
const ids = (list, max = 20000) => Array.isArray(list) && list.length > 0 && list.length <= max && list.every(v => int(v, 0));
// a box [x0, z0, x1, z1]
const box = (w, b) => Array.isArray(b) && b.length === 4 && pt(w, b[0], b[1]) && pt(w, b[2], b[3]) && b[2] >= b[0] && b[3] >= b[1];
// farm fields: [[x, z, a]]
const fields = (w, list, max = 400) => Array.isArray(list) && list.length > 0 && list.length <= max && list.every(p => Array.isArray(p) && (p.length === 2 || p.length === 3) && pt(w, p[0], p[1]) && (p.length === 2 || ang(p[2])));
const ok = (v, reason) => (v ? { ok: true } : { ok: false, reason });

// The priority flag lives on the job itself (b.con), so it is saved, sent to
// guests with the building, and gone once the job is done.
function setPriority(w, id, on) {
  const b = w.buildings.get(id);
  if (!b || !b.con) return { ok: false, reason: 'Nothing is being built there' };
  if (on) b.con.priority = true; else delete b.con.priority;
  return { ok: true, building: b };
}
export const VISITOR_REASON = "You're a visitor in this town: you can look around and point things out, but only builders can change it.";

// t → { check(world, cmd), run(game, cmd), host: only the host may do it }
export const COMMANDS = {
  // put up a building with its middle at (x, z), facing a (radians; by
  // default the nearest street)
  place: {
    check: (w, c) => hasKey(BUILDINGS, c.type) && !BUILDINGS[c.type].hidden && at(w, c) && ang(c.a) && opt(c.variant, 0, 2 ** 31)
      && (c.flavor == null || (hasKey(KINDS, c.type) && hasKey(KINDS[c.type], c.flavor))),
    run: (g, c) => g.world.placeBuilding(c.type, c.x, c.z, { variant: c.variant ?? undefined, a: c.a ?? undefined, flavor: c.flavor ?? undefined }),
  },
  // turn a building about its middle to face a
  turn: {
    check: (w, c) => int(c.id) && num(c.a, -10, 10),
    run: (g, c) => g.world.turnBuilding(c.id, c.a),
  },
  // lay a curve of road at this level through the points drawn (ctrl)
  roads: {
    check: (w, c) => int(c.level, 1, 3) && curve(w, c.ctrl),
    run: (g, c) => g.world.placeRoad(c.ctrl, c.level),
  },
  rails: {
    check: (w, c) => curve(w, c.ctrl),
    run: (g, c) => g.world.placeRail(c.ctrl),
  },
  // a stretch of road (junction to junction) taken up
  unroad: {
    check: (w, c) => int(c.e, 0),
    run: (g, c) => { const r = g.world.removeRoadEdge(c.e); return r === true ? { ok: true } : { ok: false, reason: r || 'Cannot remove' }; },
  },
  // stretches of road brought up (or down) to a level
  roadlevel: {
    check: (w, c) => ids(c.ids) && int(c.level, 1, 3),
    run: (g, c) => g.world.setLevel(c.ids, c.level),
  },
  // upgrade, downgrade or take up a whole selection of road edges
  roadedit: {
    check: (w, c) => ROAD_OPS.includes(c.op) && ids(c.ids),
    run: (g, c) => applyRoadEdit(g.world, c.ids, c.op),
  },
  // dress a selection of road edges (trees, hedges, lamps, a median; 0: plain)
  dress: {
    check: (w, c) => int(c.kind, 0, DRESSINGS.length - 1) && ids(c.ids) && (c.look == null || typeof c.look === 'boolean'),
    run: (g, c) => applyDress(g.world, c.ids, c.kind, !!c.look),
  },
  unrail: {
    check: (w, c) => int(c.e, 0),
    run: (g, c) => ok(g.world.removeRailEdge(c.e), 'No track there'),
  },
  // demolish whatever stands at a point (a building, track, a stretch of
  // road, a field, trees), or everything in a box
  bulldoze: {
    check: (w, c) => (c.box == null ? at(w, c) : box(w, c.box)),
    run: (g, c) => {
      if (!c.box) { const r = g.world.bulldoze(c.x, c.z); return { ...r, n: r.ok ? 1 : 0 }; }
      return g.world.bulldozeBox(c.box);
    },
  },
  // what a farm grows or raises
  // another kind of planting or monument
  kind: {
    check: (w, c) => int(c.id) && typeof c.kind === 'string' && Object.values(KINDS).some(K => hasKey(K, c.kind)),
    run: (g, c) => g.world.setKind(c.id, c.kind),
  },
  produce: {
    check: (w, c) => int(c.id) && hasKey(PRODUCE, c.produce),
    run: (g, c) => g.world.setProduce(c.id, c.produce),
  },
  // add fields to a farm, or take them out
  fields: {
    check: (w, c) => int(c.id) && typeof c.add === 'boolean' && fields(w, c.fields),
    run: (g, c) => g.world.setFields(c.id, c.fields, c.add),
  },
  terraform: {
    check: (w, c) => at(w, c) && ['raise', 'lower', 'flatten'].includes(c.mode),
    run: (g, c) => g.world.terraform(c.x, c.z, c.mode),
  },
  plant: {
    check: at,
    run: (g, c) => g.world.plantTree(c.x, c.z),
  },
  upgrade: {
    check: (w, c) => int(c.id) && (c.to == null || c.to === 'extend' || hasKey(BUILDINGS, c.to)) && (c.look === undefined || c.look === null || LOOKS.has(c.look)),
    run: (g, c) => g.world.upgradeBuilding(c.id, c.to || null, c.look),
  },
  // a new style without an upgrade (null: back to the building's own)
  restyle: {
    check: (w, c) => int(c.id) && (c.look === null || LOOKS.has(c.look)),
    run: (g, c) => g.world.restyleBuilding(c.id, c.look),
  },
  expand: {
    check: (w, c) => int(c.id) && int(c.dir, 0, 23) && ['land', 'strip', 'takeover', 'estate', 'grand'].includes(c.kind),
    run: (g, c) => g.world.expandBuilding(c.id, c.dir, c.kind),
  },
  merge: {
    check: (w, c) => int(c.a) && int(c.b) && c.a !== c.b,
    run: (g, c) => g.world.mergeBuildings(c.a, c.b),
  },
  move: {
    check: (w, c) => int(c.id) && at(w, c) && ang(c.a),
    run: (g, c) => g.world.moveBuilding(c.id, c.x, c.z, { a: c.a ?? undefined }),
  },
  demolish: {
    check: (w, c) => int(c.id),
    run: (g, c) => g.world.demolishBuilding(c.id),
  },
  // put a building site first (or back in line) for the builders
  priority: {
    check: (w, c) => int(c.id) && typeof c.on === 'boolean',
    run: (g, c) => setPriority(g.world, c.id, c.on),
  },
  research: {
    check: (w, c) => hasKey(TECHS, c.id),
    run: (g, c) => ok(g.world.startResearch(c.id), "That project can't be started yet"),
  },
  tax: {
    check: (w, c) => int(c.rate, 0, 20),
    run: (g, c) => { g.world.taxRate = c.rate; g.sim.recompute(); return { ok: true }; },
  },
  rename: {
    check: (w, c) => typeof c.name === 'string' && c.name.length <= 200 && cleanText(c.name).length > 0,
    run: (g, c) => { g.world.townName = cleanText(c.name, 40); return { ok: true }; },
  },
  line: {
    check: (w, c) => hasKey(TRANSIT, c.mode) && Array.isArray(c.stops) && c.stops.length <= 64 && c.stops.every(s => int(s)),
    run: (g, c) => g.transit.createLine(c.mode, c.stops),
  },
  unline: {
    check: (w, c) => int(c.id),
    run: (g, c) => { const had = g.world.lines.some(l => l.id === c.id); g.transit.deleteLine(c.id); return ok(had, 'That line is gone'); },
  },
  vehicles: {
    check: (w, c) => int(c.id) && int(c.n, 0, 16),
    run: (g, c) => g.transit.setVehicles(c.id, c.n),
  },
  speed: {
    check: (w, c) => SPEEDS.includes(c.s),
    run: (g, c) => { g.applySpeed(c.s); return { ok: true }; },
  },
  // the sandbox switches belong to whoever's town it is
  // lay power lines underground along these streets (Underground Cables)
  bury: {
    check: (w, c) => ids(c.ids),
    run: (g, c) => g.world.buryLines(c.ids),
  },
  sandbox: {
    host: true,
    check: (w, c) => !!c.opts && typeof c.opts === 'object' && Object.keys(c.opts).every(k => SANDBOX.includes(k) && typeof c.opts[k] === 'boolean'),
    run: (g, c) => { g.world.setSandbox(c.opts); g.sim.recompute(); return { ok: true }; },
  },
};

// Check and apply one command. `from` is the remote player who sent it
// (null for the local player). Returns the World's own result object.
export function runCommand(game, cmd, from = null) {
  if (from && from.role !== 'builder') return { ok: false, reason: VISITOR_REASON };
  const def = cmd && typeof cmd === 'object' && hasKey(COMMANDS, cmd.t) ? COMMANDS[cmd.t] : null;
  if (!def) return { ok: false, reason: 'Unknown action' };
  if (!game.world || game.demo) return { ok: false, reason: 'No town is open' };
  if (from && def.host) return { ok: false, reason: 'Only the host can change that' };
  let valid = false;
  try { valid = def.check(game.world, cmd); } catch { valid = false; }
  if (!valid) return { ok: false, reason: "That action isn't valid" };
  const r = def.run(game, cmd) || { ok: false };
  game.emit?.('command', { cmd, r, from });
  return r;
}

// Results travel back to a guest as plain data: building and line objects
// become ids (the guest looks them up in its own copy of the town, which has
// already been updated by the time the result arrives).
const PLAIN = ['ok', 'reason', 'instant', 'kind', 'placed', 'spent', 'failed', 'cost', 'what', 'n', 'refund', 'skipped', 'linked'];
export function packResult(r) {
  if (!r || typeof r !== 'object') return { ok: !!r };
  const out = {};
  for (const k of PLAIN) if (r[k] !== undefined && (typeof r[k] !== 'object' || r[k] === null)) out[k] = r[k];
  if (out.ok === undefined && r.placed === undefined) out.ok = false;
  if (r.building) out.building = r.building.id;
  if (r.old) out.old = r.old.id;
  if (r.line) out.line = { id: r.line.id, name: r.line.name, mode: r.line.mode };
  return out;
}

export function unpackResult(r, world) {
  const out = { ...r };
  if (r.building != null) out.building = world.buildings.get(r.building) || null;
  if (r.old != null) out.old = world.buildings.get(r.old) || null;
  return out;
}

// A few actions are worth telling the other players about.
export function describeCommand(cmd, r, world) {
  if (!r || r.ok === false) return null;
  switch (cmd.t) {
    case 'speed': return cmd.s === 0 ? 'paused the game' : `set the speed to ${cmd.s}×`;
    case 'research': return TECHS[cmd.id] ? `started researching ${TECHS[cmd.id].name}` : null;
    case 'tax': return `set taxes to ${cmd.rate}%`;
    case 'rename': return `renamed the town ${world.townName}`;
    case 'line': return r.line ? `opened ${r.line.name}` : null;
    case 'unline': return 'closed a transit line';
    case 'sandbox': return 'changed the sandbox switches';
    case 'bury': return r.n ? `put the power lines underground along ${r.n} stretch${r.n === 1 ? '' : 'es'} of road` : null;
    default: return null;
  }
}
