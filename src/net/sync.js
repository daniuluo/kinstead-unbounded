// Keeping a guest's copy of the town in step with the host's.
//
// A guest joins with a snapshot: an ordinary save (see save/saves.js) plus the
// few things saves leave out. After that the host compares the town with what
// it last sent, several times a second, and sends only what changed (a
// delta). Every few seconds it sends every building and villager instead (a
// keyframe), so a guest can never drift for long. Guests apply deltas without
// running any World rules, then re-emit the World events that the views,
// villagers and transit listen to.

import { BUILDINGS } from '../defs.js';
import { serialize, deserialize } from '../save/saves.js';
import { spareOf, setFloor } from '../world/world.js';
import { Net } from '../world/net.js';
import { cleanText, cleanColor, hasKey } from '../util/text.js';

// Bump when the messages change in a way older pages can't read. (100 and
// up: the town without a grid, which can't play with towns on squares.)
export const PROTOCOL = 101;

const r2 = (v) => Math.round(v * 100) / 100;

function conRec(c) {
  const o = { ...c };
  if (typeof o.done === 'number') o.done = r2(o.done);
  return o;
}

// One building as [id, type, level, x, z, variant, a, built, w, d, flavor,
// con, leases, look, spare] — as the save has it.
export function buildingRec(b) {
  return [b.id, b.type, b.level, b.x, b.z, b.variant, b.a, b.built, b.w, b.d, b.flavor || null,
    b.con ? conRec(b.con) : null, b.leases && b.leases.length ? b.leases : null, b.look || null, b.spare ? [b.spare.w, b.spare.d, ...(b.spare.sx != null ? [b.spare.sx, b.spare.sz] : [])] : null];
}

// One villager: the save's record plus their school place.
export function residentRec(r) {
  return [r.id, r.first, r.last, r.age, r.home ?? -1, r.job ?? -1, r.look, r.wealth != null ? Math.round(r.wealth) : null, r.fam ?? null,
    r.years != null ? r2(r.years) : null, r.edu ?? null, r.edYrs ?? null, r.school ?? null];
}

const linesRec = (w) => w.lines.map(l => ({ id: l.id, mode: l.mode, name: l.name, color: l.color, stops: l.stops.slice(), vehicles: l.vehicles }));
const moneyRec = (m) => (Number.isFinite(m) ? r2(m) : 'inf');
const clockRec = (g) => [g.world.day, Math.round(g.world.hours * 1000) / 1000, g.speed, moneyRec(g.world.money), g.world.stats];
const stateRec = (w) => ({ taxRate: w.taxRate, nextId: w.nextId, titleIdx: w.titleIdx, townName: w.townName, sandbox: { ...w.sandbox }, research: w.research, entry: w.entry });

// Trees grouped by the unit square they stand in (a way to send fewer of
// them at a time): its key → flat list of [x, z, kind, size, turn].
const treeKey = (w, x, z) => Math.floor(z) * w.N + Math.floor(x);
function treeTiles(w) {
  const out = new Map();
  for (const t of w.trees) {
    const k = treeKey(w, t.x, t.z);
    let a = out.get(k);
    if (!a) out.set(k, (a = []));
    a.push(Math.round(t.x * 100), Math.round(t.z * 100), t.k, Math.round(t.s * 100), Math.round(t.r * 100));
  }
  return out;
}
const fieldsRec = (w) => [...w.parcels.values()].map(f => [f.id, f.farm, f.x, f.z, f.a]);

const heights = (w) => Int16Array.from(w.terrain.H, (v) => Math.round(v * 1000));

// ---------------------------------------------------------------- snapshot

export function makeSnapshot(game) {
  const w = game.world;
  return {
    save: serialize(w),
    school: [...w.residents.values()].filter(r => r.school != null).map(r => [r.id, r.school]),
    lines: linesRec(w),
    clock: clockRec(game),
  };
}

export function worldFromSnapshot(snap) {
  const w = deserialize(snap.save);
  for (const [id, s] of snap.school || []) { const r = w.residents.get(id); if (r) r.school = s; }
  if (Array.isArray(snap.lines)) w.lines = snap.lines.map(cleanLine);
  const c = snap.clock;
  if (c) { w.day = c[0]; w.hours = c[1]; w.money = c[3] === 'inf' ? Infinity : c[3]; Object.assign(w.stats, c[4] || {}); }
  return w;
}

// ------------------------------------------------------------- host side

// Remembers what was last sent, and works out what changed since.
export class Tracker {
  constructor(game) {
    this.game = game;
    this.died = new Set();
    const w = game.world;
    const trees = () => { this.treesDirty = true; };
    for (const e of ['trees', 'building:add', 'building:change', 'terrain']) w.on(e, trees);
    w.on('terrain', () => { this.hDirty = true; });
    this.reset();
  }

  // Take the town as it is now as what every guest has (a snapshot was just sent).
  reset() {
    const w = this.game.world;
    this.b = new Map();
    for (const b of w.buildings.values()) this.b.set(b.id, JSON.stringify(buildingRec(b)));
    this.r = new Map();
    for (const r of w.residents.values()) this.r.set(r.id, JSON.stringify(residentRec(r)));
    this.roads = JSON.stringify(w.roads.toRec());
    this.rails = JSON.stringify(w.rails.toRec());
    this.rv = w.roads.version; this.lv = w.rails.version;
    this.fields = JSON.stringify(fieldsRec(w));
    this.H = heights(w);
    this.trees = new Map([...treeTiles(w)].map(([t, a]) => [t, a.join()]));
    this.ln = JSON.stringify(linesRec(w));
    this.s = JSON.stringify(stateRec(w));
    this.c = JSON.stringify(clockRec(this.game));
    this.histDay = w.history.length ? w.history[w.history.length - 1].day : -1;
    this.treesDirty = this.hDirty = false;
    this.died.clear();
  }

  // Everything that changed since the last call, or null. A keyframe (full)
  // carries every building and villager, and the ids of all of them.
  diff({ full = false, events = null } = {}) {
    const g = this.game, w = g.world, d = {};
    // buildings
    const ub = [], seen = new Set();
    for (const b of w.buildings.values()) {
      seen.add(b.id);
      const rec = buildingRec(b), sig = JSON.stringify(rec);
      if (full || this.b.get(b.id) !== sig) { ub.push(rec); this.b.set(b.id, sig); }
    }
    const rb = [];
    for (const id of this.b.keys()) if (!seen.has(id)) rb.push(id);
    for (const id of rb) this.b.delete(id);
    if (ub.length) d.b = ub;
    if (rb.length) d.rb = rb;
    if (full) d.ab = [...seen];
    // villagers
    const ur = [], seenR = new Set();
    for (const r of w.residents.values()) {
      seenR.add(r.id);
      const rec = residentRec(r), sig = JSON.stringify(rec);
      if (full || this.r.get(r.id) !== sig) { ur.push(rec); this.r.set(r.id, sig); }
    }
    const rr = [];
    for (const id of this.r.keys()) if (!seenR.has(id)) rr.push(id);
    for (const id of rr) this.r.delete(id);
    if (ur.length) d.r = ur;
    if (rr.length) {
      d.rr = rr;
      const died = rr.filter(id => this.died.has(id));
      if (died.length) d.died = died;
    }
    this.died.clear();
    if (full) d.ar = [...seenR];
    // roads and track (the whole network when it has changed: towns have
    // a few hundred stretches of road at most), farm fields, the land
    if (full || w.roads.version !== this.rv) {
      this.rv = w.roads.version;
      const rec = JSON.stringify(w.roads.toRec());
      if (full || rec !== this.roads) { d.rd = JSON.parse(rec); this.roads = rec; }
    }
    if (full || w.rails.version !== this.lv) {
      this.lv = w.rails.version;
      const rec = JSON.stringify(w.rails.toRec());
      if (full || rec !== this.rails) { d.rl = JSON.parse(rec); this.rails = rec; }
    }
    const fl = JSON.stringify(fieldsRec(w));
    if (full || fl !== this.fields) { d.fl = JSON.parse(fl); this.fields = fl; }
    if (this.hDirty) {
      this.hDirty = false;
      const H = heights(w), out = [];
      for (let i = 0; i < H.length; i++) if (H[i] !== this.H[i]) { out.push(i, H[i]); this.H[i] = H[i]; }
      if (out.length) d.h = out;
    }
    if (this.treesDirty) {
      this.treesDirty = false;
      const now = treeTiles(w), out = [];
      for (const [t, a] of now) { const sig = a.join(); if (this.trees.get(t) !== sig) { out.push([t, a]); this.trees.set(t, sig); } }
      for (const t of [...this.trees.keys()]) if (!now.has(t)) { out.push([t, []]); this.trees.delete(t); }
      if (out.length) d.tr = out;
    }
    // transit lines, town state, history, clock
    const ln = JSON.stringify(linesRec(w));
    if (full || ln !== this.ln) { d.ln = JSON.parse(ln); this.ln = ln; }
    const s = JSON.stringify(stateRec(w));
    if (full || s !== this.s) { d.s = JSON.parse(s); this.s = s; }
    const hist = w.history.filter(h => h.day > this.histDay);
    if (hist.length) { d.hist = hist; this.histDay = hist[hist.length - 1].day; }
    const c = clockRec(g), cs = JSON.stringify(c);
    if (full || cs !== this.c) { d.c = c; this.c = cs; }
    if (events && events.length) d.ev = events;
    if (full) d.k = 1;
    return Object.keys(d).length ? d : null;
  }
}

// ------------------------------------------------------------ guest side

function plotHeights(w, b) { setFloor(w.terrain, b); }

function setLeases(w, b, leases) {
  b.leases = leases ? leases.map(l => ({ ...l })) : [];
  const e = (b.ext = { x0: 0, x1: 0, z0: 0, z1: 0 });
  for (const l of b.leases) e[l.side] = l.buyer ? l.amt : -l.amt;
}

// The parts of a building site that change its look (not its progress).
const conLook = (c) => (c ? JSON.stringify([c.kind, c.to, c.toType, c.look, c.flavor, c.wait, c.moved, c.expand, c.extend]) : '');

// Apply one delta (or keyframe) from the host. Returns what changed that the
// UI may want to refresh for.
export function applyDelta(game, d) {
  const w = game.world, ag = game.agents;
  const out = { sandbox: false };
  let simDirty = false;

  // 1. villagers who left town or passed away (before their homes go)
  const goneR = new Set(d.rr || []);
  if (d.ar) { const all = new Set(d.ar); for (const id of w.residents.keys()) if (!all.has(id)) goneR.add(id); }
  const died = new Set(d.died || []);
  const leaving = [];
  for (const id of goneR) {
    const r = w.residents.get(id);
    if (!r) continue;
    if (died.has(id) || !ag) { ag?.remove(r); w.residents.delete(id); } else leaving.push(id);
  }
  if (leaving.length) ag.depart(leaving);
  if (goneR.size) simDirty = true;

  // 2. buildings taken off the map
  const goneB = new Set(d.rb || []);
  if (d.ab) { const all = new Set(d.ab); for (const id of w.buildings.keys()) if (!all.has(id)) goneB.add(id); }
  let structural = false;
  for (const id of goneB) {
    const b = w.buildings.get(id);
    if (!b) continue;
    w.plots.remove(b);
    w.buildings.delete(id);
    w.emit('building:remove', b);
    structural = true;
  }

  // 3. roads, track and the lie of the land (the networks whole; what
  // changed on them, dressings and buried lines too, is worked out here)
  let roads = false, dressed = false;
  if (d.rd) {
    const before = w.roads, net = Net.fromRec(d.rd, 'road');
    const dressOf = (n) => JSON.stringify([...n.edges.values()].map(e => [e.id, e.dress || 0]));
    const buriedOf = (n) => JSON.stringify([...n.edges.values()].map(e => [e.id, e.buried || 0]));
    dressed = dressOf(before) !== dressOf(net);
    const buried = buriedOf(before) !== buriedOf(net);
    w.roads = net;
    if (w.roads.nodes.has(w.entry.node)) { const n = w.roads.nodes.get(w.entry.node); w.entry = { node: n.id, x: n.x, z: n.z }; }
    roads = true;
    if (buried) w.emit('lines');
    if (dressed) w.emit('dress');
  }
  const rails = !!d.rl;
  if (d.rl) w.rails = Net.fromRec(d.rl, 'rail');
  // farmland
  if (d.fl) {
    for (const f of [...w.parcels.values()]) w._removeField(f);
    for (const [id, farm, x, z, a] of Array.isArray(d.fl) ? d.fl : []) if ([id, farm, x, z, a].every(Number.isFinite)) w._addField(farm, x, z, a, id);
    w._countFields(); w.emit('fields'); simDirty = true;
  }
  let land = null;
  if (d.h) {
    const S = w.N + 1, H = w.terrain.H;
    land = { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity };
    for (let k = 0; k < d.h.length; k += 2) {
      const i = d.h[k], cx = i % S, cz = (i / S) | 0;
      H[i] = d.h[k + 1] / 1000;
      land.x0 = Math.min(land.x0, cx - 1); land.z0 = Math.min(land.z0, cz - 1);
      land.x1 = Math.max(land.x1, cx); land.z1 = Math.max(land.z1, cz);
    }
  }
  if (roads || land || dressed) structural = true;   // dressings move buildings back from the verge too

  // 4. buildings added or changed (events wait until access is sorted out)
  const added = [], changed = [], refit = [], done = [];
  let railLinks = rails;
  for (const rec of d.b || []) {
    const [id, type, level, x, z, variant, a, built, bw, bd, flavor, con, leases, look, sp] = rec;
    const spare = spareOf(sp, bw, bd);
    if (!hasKey(BUILDINGS, type) || ![x, z, a].every(Number.isFinite)) continue;
    const def = BUILDINGS[type];
    let b = w.buildings.get(id);
    if (!b) {
      w.restoreBuilding({ id, type, level, x, z, variant, a, built, w: bw, d: bd, flavor, con, leases, look, spare });
      b = w.buildings.get(id);
      if (!b) continue;
      added.push(b);
      if (def.needsRail) railLinks = true;
      structural = true;
      continue;
    }
    const moved = b.x !== x || b.z !== z || b.a !== a || b.w !== bw || b.d !== bd;
    const prev = b.con;
    const looks = moved || b.type !== type || b.level !== level || (b.look || null) !== look || (b.flavor || null) !== flavor
      || b.variant !== variant || conLook(prev) !== conLook(con)
      || JSON.stringify(b.spare || null) !== JSON.stringify(spare || null);
    if (moved) {
      b.x = x; b.z = z; b.a = a; b.w = bw; b.d = bd; b.size = Math.max(bw, bd);
      w._file(b);
      if (def.needsRail) railLinks = true;
      structural = true;
    }
    if (b.type !== type || b.level !== level) simDirty = true;
    const spared = JSON.stringify(b.spare || null) !== JSON.stringify(spare || null);
    if (spared) simDirty = true;
    Object.assign(b, { type, level, variant, built, flavor, look });
    if (spare) b.spare = spare; else delete b.spare;
    // the floor, once the plot and the part the building stands on are known
    if (moved || spared) plotHeights(w, b);
    // keep the same site object while it is the same job, so builders keep their place in the queue
    if (!con) b.con = null;
    else if (prev && conLook(prev) === conLook(con)) Object.assign(prev, con);
    else b.con = { ...con };
    if (!!prev !== !!b.con) simDirty = true;
    if (JSON.stringify(b.leases && b.leases.length ? b.leases : null) !== JSON.stringify(leases)) {
      setLeases(w, b, leases);
      w._file(b);
      if (!looks) refit.push(b);
      structural = true;
      simDirty = true;
    }
    if (looks) changed.push(b);
    if (prev && !b.con) done.push({ building: b, kind: prev.kind, moved: !!prev.moved });
  }
  if (added.length || changed.length) simDirty = true;

  // 5. who reaches the roads, and which buildings come forward to the street
  if (structural) w.updateRoadNetwork();
  if (railLinks) w.updateRailLinks();
  if (land) w.emit('terrain', land);
  for (const b of added) w.emit('building:add', b);
  for (const b of changed) w.emit('building:change', b);
  for (const b of refit) w.emit('building:refit', b);
  for (const e of done) w.emit('building:done', e);

  // 6. trees
  if (d.tr) {
    const tilesChanged = new Set(d.tr.map(([t]) => t));
    w._dropTrees(w.trees.filter(t => tilesChanged.has(treeKey(w, t.x, t.z))));
    for (const [, a] of d.tr) for (let i = 0; i + 4 < a.length; i += 5) w.addTree(a[i] / 100, a[i + 1] / 100, a[i + 2], a[i + 3] / 100, a[i + 4] / 100);
    w.emit('trees');
  }

  // 7. villagers who arrived or changed
  for (const rec of d.r || []) if (upsertResident(game, rec)) simDirty = true;

  // 8. transit lines (updated in place, so the vehicles on them carry on)
  if (d.ln) {
    const byId = new Map(w.lines.map(l => [l.id, l]));
    w.lines = (Array.isArray(d.ln) ? d.ln : []).map(cleanLine).map(l => {
      const cur = byId.get(l.id);
      if (!cur) return l;
      Object.assign(cur, l);
      return cur;
    });
    w.emit('lines');
  }

  // 9. the town's state, history and clock
  if (d.s) {
    const s = d.s;
    const before = new Set(w.research.done);
    out.sandbox = JSON.stringify(w.sandbox) !== JSON.stringify(s.sandbox);
    if (s.taxRate !== w.taxRate) simDirty = true;
    Object.assign(w, { taxRate: s.taxRate, nextId: s.nextId, titleIdx: s.titleIdx, townName: cleanText(s.townName, 40) || w.townName, entry: s.entry });
    Object.assign(w.sandbox, s.sandbox);
    w.research = { ...s.research, done: s.research.done.slice() };
    for (const id of w.research.done) if (!before.has(id)) w.emit('research:done', id);
  }
  if (d.hist) { w.history.push(...d.hist); while (w.history.length > 400) w.history.shift(); }
  if (d.c) {
    const [day, hours, speed, money, stats] = d.c;
    w.money = money === 'inf' ? Infinity : money;
    Object.assign(w.stats, stats);
    if (game.sim.syncClock) game.sim.syncClock(day, hours);
    else { w.day = day; w.hours = hours; }
    if (speed !== game.speed) game.applySpeed(speed);
  }
  if (simDirty) game.sim.dirty = true;

  // 10. things that happened, for notices and the people walking in
  for (const [e, a, b, c] of d.ev || []) {
    if (e === 'arrive') {
      const home = w.buildings.get(a), fam = b.map(id => w.residents.get(id)).filter(Boolean);
      if (!home || !fam.length) continue;
      ag?.arrive(fam, home);
      game.emit('arrived', { building: home, family: fam });
    } else if (e === 'land') {
      const buyer = w.buildings.get(a), seller = w.buildings.get(b);
      if (buyer && seller) w.emit('land:sold', { buyer, seller, price: c });
    } else if (['born', 'died', 'graduated', 'season', 'milestone', 'departed'].includes(e)) game.emit(e, a);
  }
  return out;
}

// A transit line as the host describes it, kept to what the game uses.
function cleanLine(l) {
  return { id: l?.id, mode: l?.mode, name: cleanText(l?.name, 40), color: cleanColor(l?.color), stops: Array.isArray(l?.stops) ? l.stops.filter(Number.isInteger) : [], vehicles: Number.isInteger(l?.vehicles) ? l.vehicles : 1 };
}

function upsertResident(game, rec) {
  const w = game.world, ag = game.agents;
  const [id, rawFirst, rawLast, age, home, job, look, wealth, fam, years, edu, edYrs, school] = rec;
  const first = cleanText(rawFirst, 24), last = cleanText(rawLast, 24);
  const H = home >= 0 ? home : null, J = job >= 0 ? job : null;
  let r = w.residents.get(id);
  if (!r) {
    r = { id, first, last, age, home: H, job: J, look, mood: 60 };
    w.residents.set(id, r);
  }
  const moved = r.home !== H, grew = r.age !== age;
  const dirty = moved || grew || r.job !== J || (r.school ?? null) !== school || !r.lk;
  Object.assign(r, { first, last, age, home: H, job: J, look });
  if (wealth != null) r.wealth = wealth; else delete r.wealth;
  if (fam != null) r.fam = fam;
  if (years != null) r.years = years;
  if (edu != null) r.edu = edu;
  if (edYrs && typeof edYrs === 'object') r.edYrs = edYrs;
  r.school = school;
  if (r.lk && ag) {
    if (grew) ag.refreshLook(r);
    if (moved) ag.relocate(r);
  }
  return dirty;
}
