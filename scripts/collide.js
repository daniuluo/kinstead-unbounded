// Collision playtest: plays towns headless with their real building models
// standing in (built as the game draws them), and checks that nothing passes
// through anything solid:
//  - villagers walking, strolling, working or waiting inside a wall, a shed,
//    a fence or a statue (but for the step in through their own door), or on
//    open water;
//  - building models reaching out of their plots, onto a road or into a
//    neighbour's;
//  - coaches, carts and trains through a building; gondola cabins and cables
//    through a roof, and a cable through its own cabins' roofs;
//  - villagers walking into each other, vehicles into each other, and
//    villagers into vehicles (counted, over every moment of the days played).
// Besides what the villagers and vehicles happen to do over a few days, it
// sweeps every way in to every door, every stroll between a park's walks and
// seats, every outdoor work area and every gondola route, so nothing is left
// to luck. No starter has a gondola, so each town gets two lines strung
// across its busiest part first.
// Usage: node scripts/collide.js [towns=all] [days=2] [--verbose] [--probe=id,x,z] [--seed=n] [--everyone]
//   towns: starter ids, comma-separated ('all': every starter but the heavy
//   Metropolis, and 'curves' and 'freeform'; 'scale': a big town grown by
//   the demo bot; 'curves': the market town with curving streets laid out
//   of it, lined with buildings facing them at whatever angle; 'freeform':
//   the market town with every building turned on its plot as far as it
//   will go)
//   --probe: the solid parts of building id over point (x, z), its door, and
//   the way villagers walk in to it
//   --seed: the same run every time; --everyone: every villager drawn, not
//   the crowd thinned where it gathers, as the game draws it by default

import * as THREE from 'three';
import { GeoBuilder } from '../src/render/geo.js';
import { buildModel, workArea } from '../src/render/buildings.js';
import { STARTERS, loadStarter } from '../src/world/starters.js';
import { World, isOpen, doorPoint, plotOf, ownPlot, findPlot } from '../src/world/world.js';
import { toLocal, toWorld, pointAt } from '../src/world/geom.js';
import { plotPath } from '../src/sim/plotNav.js';
import { growDemoTown } from '../src/world/demo.js';
import { PathFinder } from '../src/sim/path.js';
import { Sim } from '../src/sim/sim.js';
import { Agents, walkY } from '../src/sim/agents.js';
import { Transit, G_HANG, CABIN } from '../src/sim/transit.js';
import { Animals } from '../src/sim/animals.js';
import { Construction } from '../src/sim/construction.js';
import { BUILDINGS } from '../src/defs.js';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const VERBOSE = process.argv.includes('--verbose');
const EVERYONE = process.argv.includes('--everyone');
// --seed=n: the same run every time (Math.random a seeded stream)
const SEED = process.argv.find(a => a.startsWith('--seed='));
if (SEED) Math.random = mulberry(Number(SEED.slice(7)));
const DAYS = Number(args[1] || 2);
const which = (args[0] || 'all').split(',');
const TRACE = Number((process.argv.find(a => a.startsWith('--probe=')) || '--probe=-1').slice(8).split(',')[0]);

// --------------------------------------------------- the models' solid parts
// Every primitive a GeoBuilder adds is tagged with its own id, which survives
// the merge into one geometry and the model's fit into its plot, so the
// finished model can be split back into its parts.
let PID = 0;
const add0 = GeoBuilder.prototype.add;
GeoBuilder.prototype.add = function (geo, color, local) {
  add0.call(this, geo, color, local);
  const g = this.parts[this.parts.length - 1];
  g.setAttribute('pid', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(++PID), 1));
  return this;
};

// convex hull of [x, z] points, anticlockwise (x right, z down the page)
function hull(pts) {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 1e-12) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 1e-12) up.pop(); up.push(p); }
  lo.pop(); up.pop();
  return lo.concat(up);
}
const area = (h) => { let s = 0; for (let i = 0; i < h.length; i++) { const a = h[i], b = h[(i + 1) % h.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; };
// How far point (x, z) is outside convex hull h (negative: that far inside;
// outside, a lower bound near the corners, which is all the tests need).
function outside(h, x, z) {
  if (h.length < 3) return Infinity;
  let s = -Infinity;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const ex = b[0] - a[0], ez = b[1] - a[1], L = Math.hypot(ex, ez) || 1e-9;
    // outward normal of an anticlockwise hull (in x, z) is (ez, -ex)
    s = Math.max(s, ((x - a[0]) * ez - (z - a[1]) * ex) / L);
  }
  return s;
}

// The solid parts of every building, filed by unit square, and what the game's
// WorldView would set on each building from its model (door, spots, open).
class Solids {
  constructor(w, game) {
    this.w = w; this.game = game;
    this.byB = new Map();      // building id → its parts
    this.tiles = new Map();    // unit square (its index) → parts over it
    this.items = new Map();    // stands in for game.view.items (transit asks how tall a building is)
    for (const b of w.buildings.values()) this.add(b);
    w.on('building:add', (b) => this.add(b));
    w.on('building:change', (b) => { this.remove(b); this.add(b); });
    w.on('building:refit', (b) => { this.remove(b); this.add(b); });
    w.on('building:remove', (b) => this.remove(b));
  }

  add(b) {
    const w = this.w, t = w.terrain;
    const ground = (x, z) => t.heightAt(x, z);
    // as WorldView.takenFn: another building's plot or a road (a pier stops short of it)
    const taken = (x, z, id) => { if (!w.inBounds(x, z)) return false; const o = w.buildingAt(x, z); return (!!o && o.id !== id) || !!w.roadAt(x, z); };
    const up = b.con && b.con.kind === 'upgrade';
    const target = b.con ? buildModel(up ? { ...b, type: b.con.toType || b.type, level: b.con.to, look: b.con.look !== undefined ? b.con.look : b.look, flavor: b.con.flavor !== undefined ? b.con.flavor : b.flavor } : b, { ground, taken }) : null;
    const model = b.con ? (up ? buildModel(b, { ground, taken }) : target) : buildModel(b, { ground, taken });
    const jit = model.jitter;
    const th = b.a + jit.yaw, co = Math.cos(th), si = Math.sin(th);
    const cx = b.x + jit.ox, cz = b.z + jit.oz;
    const toW = (x, z) => [cx + x * co + z * si, cz - x * si + z * co];
    // as WorldView.addBuilding / _addSite
    b.work = workArea(b);
    b.spots = !b.con && model.spots && model.spots.length ? model.spots.map(p => toW(p.x, p.z)) : null;
    const d = model.door;
    if (d) { const [x, z] = toW(d.x, d.z); b.door = { x, y: d.y + b.baseY, z, dx: d.dx * co + d.dz * si, dz: -d.dx * si + d.dz * co, ground: b.baseY }; } else b.door = null;
    b.open = !!model.open;
    // a gondola station's way up and its deck, as WorldView sets them
    const toW3 = (p) => { const [x, z] = toW(p.x, p.z); return { x, y: p.y + b.baseY, z }; };
    b.stair = !b.con && model.stair ? model.stair.map(toW3) : null;
    b.deck = !b.con && model.deck ? toW3(model.deck) : null;
    b.seats = !b.con && model.seats ? model.seats.map(p => ({ ...toW3(p), h: p.h + th, at: b.id })) : null;
    b.stand = !b.con && model.stand ? model.stand.map(toW3) : null;
    this.items.set(b.id, { mesh: { geometry: (target || model).geo, position: { x: cx, y: b.baseY, z: cz }, rotation: { y: th } }, site: b.con ? { target: (target || model).geo } : null });
    // a building site's walls are only part built: nothing solid yet
    if (b.con || !model.geo) { this.byB.set(b.id, []); return; }
    const P = model.geo.attributes.position.array, I = model.geo.attributes.pid.array;
    const parts = [];
    let i0 = 0;
    for (let i = 1; i <= I.length; i++) {
      if (i < I.length && I[i] === I[i0]) continue;
      const seen = new Set(), pts = [];
      let y0 = Infinity, y1 = -Infinity;
      for (let k = i0; k < i; k++) {
        const [x, z] = toW(P[k * 3], P[k * 3 + 2]), y = P[k * 3 + 1] + b.baseY;
        y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        const key = `${Math.round(x * 1e4)},${Math.round(z * 1e4)}`;
        if (!seen.has(key)) { seen.add(key); pts.push([x, z]); }
      }
      i0 = i;
      const h = hull(pts);
      if (h.length < 3) continue;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const [x, z] of h) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
      parts.push({ b, h, x0, x1, z0, z1, y0, y1, a: area(h) });
    }
    this.byB.set(b.id, parts);
    for (const p of parts) {
      for (let tz = Math.floor(p.z0); tz <= Math.floor(p.z1); tz++) for (let tx = Math.floor(p.x0); tx <= Math.floor(p.x1); tx++) {
        if (!w.inBounds(tx, tz)) continue;
        const k = tz * w.N + tx;
        let l = this.tiles.get(k);
        if (!l) this.tiles.set(k, l = []);
        l.push(p);
      }
    }
  }

  remove(b) {
    const parts = this.byB.get(b.id);
    this.items.delete(b.id);
    if (!parts) return;
    this.byB.delete(b.id);
    const gone = new Set(parts);
    for (const p of parts) for (let tz = Math.floor(p.z0); tz <= Math.floor(p.z1); tz++) for (let tx = Math.floor(p.x0); tx <= Math.floor(p.x1); tx++) {
      if (!this.w.inBounds(tx, tz)) continue;
      const k = tz * this.w.N + tx, l = this.tiles.get(k);
      if (l) this.tiles.set(k, l.filter(q => !gone.has(q)));
    }
  }

  // The part at (x, z) that a villager standing at height y would be inside:
  // a wall (from their feet to above their middle), or failing that something
  // low (a fence, a bench, a low wall, a hedge), or null. r: how far inside
  // it they must be; skip: a building whose parts don't count.
  hit(x, z, y, r = 0.015, skip = null) {
    if (!this.w.inBounds(x, z)) return null;
    const l = this.tiles.get(Math.floor(z) * this.w.N + Math.floor(x));
    if (!l) return null;
    let low = null;
    for (const p of l) {
      if (p.b === skip || x < p.x0 || x > p.x1 || z < p.z0 || z > p.z1) continue;
      if (p.y0 > y + 0.06 || p.y1 < y + 0.045) continue;   // overhead (eaves, awnings, signs) or flat (paving, lawn, steps)
      if (outside(p.h, x, z) > -r) continue;
      // no higher than the floor or the doorway: a step, a flight of steps
      // up to a portico, a plinth or a footing, to be climbed rather than
      // walked through
      if (p.y1 <= Math.max(p.b.baseY, p.b.door ? p.b.door.y : -Infinity) + 0.035) { low ||= { p, kind: 'step' }; continue; }
      if (p.y1 >= y + 0.12 && p.a >= 0.0016) return { p, kind: 'wall' };
      if (p.a >= 0.0004) low ||= { p, kind: 'low' };
    }
    return low;
  }

  // Parts within r of (x, z) whose heights overlap [ya, yb] (a gondola cabin).
  touch(x, z, ya, yb, r) {
    const out = [];
    for (let tz = Math.floor(z - r); tz <= Math.floor(z + r); tz++) for (let tx = Math.floor(x - r); tx <= Math.floor(x + r); tx++) {
      if (!this.w.inBounds(tx, tz)) continue;
      for (const p of this.tiles.get(tz * this.w.N + tx) || []) {
        if (p.y1 < ya || p.y0 > yb || x < p.x0 - r || x > p.x1 + r || z < p.z0 - r || z > p.z1 + r) continue;
        if (p.a < 0.0016) continue;   // a lamp post, a flagpole: not worth a swerve
        if (outside(p.h, x, z) < r - 0.005 && !out.includes(p)) out.push(p);
      }
    }
    return out;
  }
}

// ----------------------------------------------------------------- findings
const name = (b) => `${BUILDINGS[b.type].levels[b.level].name} (${b.type}.${b.level}${b.look ? ' ' + b.look : ''}${b.flavor ? ' ' + b.flavor : ''})`;
class Findings {
  constructor() { this.map = new Map(); }
  // kind of fault, what it involves, where; counted, with the first few places kept
  add(kind, what, at, serious = true) {
    const key = kind + ' | ' + what;
    let f = this.map.get(key);
    if (!f) this.map.set(key, f = { kind, what, n: 0, at: [], serious });
    f.n++;
    if (f.at.length < 3) f.at.push(at);
  }
  get serious() { let n = 0; for (const f of this.map.values()) if (f.serious) n++; return n; }
  print(indent = '  ') {
    const list = [...this.map.values()].sort((a, b) => (b.serious - a.serious) || a.kind.localeCompare(b.kind) || b.n - a.n);
    for (const f of list) console.log(`${indent}${f.serious ? 'FAIL' : 'warn'} ${f.kind}: ${f.what} ×${f.n}${VERBOSE || f.serious ? '  at ' + f.at.join('; ') : ''}`);
  }
}
const at = (x, z) => `(${x.toFixed(2)}, ${z.toFixed(2)})`;
const THING = { wall: 'a wall', low: 'something low', step: 'the steps (not up them)' };

// ------------------------------------------------------------- static sweeps
// Every way in to every door: from the pavement of its street, at the lanes
// villagers keep to, through the gate and up to the door.
function sweepDoors(game, S, F, lanes) {
  const w = game.world, ag = game.agents;
  for (const B of w.buildings.values()) {
    if (!B.access || !isOpen(B) || !B.door || B.open) continue;
    const def = BUILDINGS[B.type];
    if (def.stop || def.outdoor) continue;
    // a short walk in along its street, from a unit along it either way
    const a = B.access, e = w.roads.edges.get(a.e);
    if (!e) continue;
    const s0 = a.s + 1 <= e.len ? a.s + 1 : a.s - 1;
    if (s0 < 0) continue;
    const fp = pointAt(e.pts, e.cum, s0), from = [fp[0], fp[1]];
    const tiles = game.paths.road({ e: e.id, s: s0 }, a);
    if (!tiles) continue;
    for (const lane of lanes) {
      const r = { lk: { lane, speed: 1, scale: 1 }, school: null, at: B.id };
      const wk = ag._walk(r, B, B, tiles, { x: from[0], z: from[1] }, () => {});
      ag._drop(wk);
      const pts = wk.pts, n = pts.length - 1;   // the last leg (door → inside) is the way in through the wall
      if (TRACE === B.id) {
        console.log(`  trace #${B.id} lane ${lane}: doorIn ${wk.doorIn} · ${pts.slice(-6).map(([x, z]) => at(x, z)).join(' → ')}`);
        // and the height a villager walks at, over the floor, along the last legs
        const ys = [];
        for (let s = Math.max(0, n - wk.doorIn - 1); s < n; s++) for (let j = 0; j < 4; j++) {
          const [ax, az] = pts[s], [bx, bz] = pts[s + 1], x = ax + ((bx - ax) * j) / 4, z = az + ((bz - az) * j) / 4;
          Object.assign(wk, { seg: s, t: j / 4, x, z });
          ys.push((walkY(w, wk) - B.baseY).toFixed(3));
        }
        console.log(`    heights over the floor: ${ys.join(' ')} (door ${(B.door.y - B.baseY).toFixed(3)})`);
      }
      let found = null;
      // from the last point on the street, through the gate, up the step to the door
      for (let s = Math.max(0, n - wk.doorIn - 1); s < n - 1 && !found; s++) {
        const [ax, az] = pts[s], [bx, bz] = pts[s + 1], L = Math.hypot(bx - ax, bz - az), k = Math.max(1, Math.ceil(L / 0.02));
        for (let j = 0; j <= k && !found; j++) {
          const x = ax + ((bx - ax) * j) / k, z = az + ((bz - az) * j) / k;
          Object.assign(wk, { seg: s, t: j / k, x, z });
          const h = S.hit(x, z, walkY(w, wk));
          if (h) found = { h, x, z, own: h.p.b === B };
        }
      }
      if (found) {
        const { h, x, z, own } = found;
        F.add(`way in through ${THING[h.kind]}`, own ? `${name(B)}, its own` : `${name(B)}, through the ${name(h.p.b)} next door`, `${at(x, z)} #${B.id}`, h.kind === 'wall' || !own);
        break;
      }
    }
  }
}

// Strollers walk from one of a park's walks and seats to another, outdoor
// workers and visitors to anywhere in their area: every such walk, from the
// gate and from one spot to another, the way the villagers take it (round
// what stands on the plot, where the game knows the way: plotNav).
function sweepGrounds(game, S, F) {
  const w = game.world, ag = game.agents;
  for (const B of w.buildings.values()) {
    // (nobody comes to a place with no road to it)
    if (!isOpen(B) || !B.access) continue;
    const def = BUILDINGS[B.type];
    const strolls = B.spots && B.spots.length > 1;
    if (!strolls && !(def.outdoorWork || def.outdoor || B.open)) continue;
    let goals;
    if (strolls) goals = B.spots;
    else {
      // (an area in the plot's own frame: [x0, z0, x1, z1, its rectangle])
      const R = ownPlot(B), area = B.work || workArea(B) || [-R.hw + 0.15, -R.hd + 0.15, R.hw - 0.15, R.hd - 0.15, R];
      goals = [];
      for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) goals.push(toWorld(area[4] || R, area[0] + ((area[2] - area[0]) * i) / 4, area[1] + ((area[3] - area[1]) * j) / 4));
    }
    const g = ag._gridOf(B), gate = doorPoint(B);
    // a stroller sets off again from where they stopped: the spot, or the
    // open ground nearest it if the model has something standing on it
    const stop = (p) => (g && (plotPath(g, gate.x, gate.z, p[0], p[1]) || []).at(-1)) || p;
    const froms = [[gate.x, gate.z], ...(strolls ? B.spots.map(stop) : [])];
    let walks = 0, bad = 0, walls = 0, ex = null;
    for (const from of froms) for (const to of goals) {
      if (from === to) continue;
      // (with no way there, a villager goes somewhere else instead)
      const p = g ? plotPath(g, from[0], from[1], to[0], to[1]) : [to];
      if (!p) continue;
      walks++;
      const way = [from, ...p];
      let hit = null;
      for (let i = 0; i < way.length - 1 && !hit; i++) {
        const [ax, az] = way[i], [bx, bz] = way[i + 1], L = Math.hypot(bx - ax, bz - az), k = Math.max(1, Math.ceil(L / 0.03));
        for (let s2 = 0; s2 <= k && !hit; s2++) {
          const x = ax + ((bx - ax) * s2) / k, z = az + ((bz - az) * s2) / k;
          // (the gate itself is on the plot's edge, by the pavement)
          if (i === 0 && from === froms[0] && Math.hypot(x - gate.x, z - gate.z) < 0.06) continue;
          hit = S.hit(x, z, B.baseY + 0.012);
          if (hit) hit = { ...hit, x, z };
        }
      }
      if (!hit) continue;
      bad++;
      const where = at(hit.x, hit.z) + ` (${hit.p.b === B ? 'its own' : name(hit.p.b)})`;
      if (hit.kind === 'wall' && !walls++) ex = where;
      else ex ||= where;
    }
    if (bad) F.add(`${strolls ? 'strollers' : 'workers or visitors'} walk through ${walls ? 'something solid' : 'something low'}`, `${name(B)}: ${bad} of ${walks} walks${g ? '' : ' (no way round known)'}`, `${ex} #${B.id}`, walls > 0);
  }
}

// Every part of every model inside its own plot (or its frontage, or the land
// it took on), but for what reaches out on purpose (a pier over the water):
// in the plot's own frame, whatever its angle, its front forward into the
// verge as far as it may come.
function sweepPlots(game, S, F) {
  const w = game.world;
  for (const B of w.buildings.values()) {
    const R = plotOf(B), f = Math.max(B.front || 0, B.ownFront || 0);
    let worst = 0, ex = null;
    for (const p of S.byB.get(B.id) || []) {
      if (p.y1 - p.y0 < 0.01 && p.y1 < B.baseY + 0.03) continue;   // flat on the ground (a path, a shadow)
      for (const [x, z] of p.h) {
        const [lx, lz] = toLocal(R, x, z), out = Math.max(Math.abs(lx) - R.hw, -lz - R.hd, lz - R.hd - f);
        if (out > worst) { worst = out; ex = [x, z]; }
      }
    }
    if (worst > 0.03) {
      const o = w.inBounds(ex[0], ex[1]) ? w.buildingAt(ex[0], ex[1]) : null;
      const onto = o && o !== B ? `into the ${name(o)}` : w.roadAt(ex[0], ex[1]) ? 'onto the road' : w.waterAt(ex[0], ex[1]) ? 'over the water' : 'onto open ground';
      F.add('model reaches out of its plot', `${name(B)} ${onto}`, `${worst.toFixed(2)} at ${at(ex[0], ex[1])} #${B.id}`, onto !== 'over the water' && onto !== 'onto open ground');
    }
  }
}

// Gondola cabins along every route, and the cables, clear of every roof, and
// of the cabins' own roofs, climbing past them.
function sweepCables(game, S, F) {
  const T = game.transit;
  for (const line of game.world.lines) {
    const r = T.routes.get(line.id);
    if (!r || line.mode !== 'gondola' || !r.ys) continue;
    const cc = T.cabinClearance(r);
    if (cc.clear < 0.005) F.add('gondola cable through its cabins', line.name, `${cc.clear.toFixed(3)} at ${at(cc.at.x, cc.at.z)}`);
    const stops = new Set(line.stops);
    const hits = new Map();
    for (let i = 0; i < r.pts.length - 1; i++) {
      const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], ya = r.ys[i], yb = r.ys[i + 1];
      const L = Math.hypot(bx - ax, bz - az), k = Math.max(1, Math.ceil(L / 0.08));
      for (let s = 0; s <= k; s++) {
        const u = s / k, x = ax + (bx - ax) * u, z = az + (bz - az) * u, y = ya + (yb - ya) * u;
        // the cabin: from under its floor (G_HANG below the cable) to over its roof; and the cable itself
        for (const p of S.touch(x, z, y - G_HANG - 0.02, y - G_HANG + CABIN.H + 0.02, 0.12)) if (!stops.has(p.b.id)) hits.set(p.b.id, { what: 'cabin', p, x, z });
        for (const p of S.touch(x, z, y - 0.01, y + 0.01, 0.01)) if (!stops.has(p.b.id) && !hits.has(p.b.id)) hits.set(p.b.id, { what: 'cable', p, x, z });
      }
    }
    for (const h of hits.values()) F.add(`gondola ${h.what} through a building`, `${line.name} through the ${name(h.p.b)}`, `${at(h.x, h.z)} #${h.p.b.id}`);
  }
  // and two lines' cables, wherever they pass near enough for their cabins
  // to meet (a cabin's width apart, and a little) away from their stations:
  // one over the other, room for a cabin and its hanger between
  const lines = game.world.lines.filter(l => l.mode === 'gondola' && T.routes.get(l.id));
  const ends = new Map(lines.map(l => [l, T._ends(l, l.stops.map(id => game.world.buildings.get(id)))]));
  const nearEnd = (l, x, z) => ends.get(l).some(([ex, ez]) => Math.hypot(ex - x, ez - z) < 0.6);
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const A = T.routes.get(lines[i].id), B = T.routes.get(lines[j].id);
    let worst = Infinity, where = null;
    A.pts.forEach(([x, z], p) => {
      if (nearEnd(lines[i], x, z) || nearEnd(lines[j], x, z)) return;
      for (let q = 0; q + 1 < B.pts.length; q++) {
        const [cx, cz] = B.pts[q], [dx, dz] = B.pts[q + 1], ex = dx - cx, ez = dz - cz, L2 = ex * ex + ez * ez || 1e-9;
        const t = Math.max(0, Math.min(1, ((x - cx) * ex + (z - cz) * ez) / L2));
        if (Math.hypot(x - cx - ex * t, z - cz - ez * t) > CABIN.W + 0.02) continue;
        const gap = Math.abs(A.ys[p] - (B.ys[q] + (B.ys[q + 1] - B.ys[q]) * t));
        if (gap < worst) { worst = gap; where = [x, z]; }
      }
    });
    if (worst < G_HANG + 0.08) F.add('gondola lines cross with no room for a cabin', `${lines[i].name} and ${lines[j].name}`, `${worst.toFixed(2)} apart at ${at(where[0], where[1])}`);
  }
}

// Villagers, vehicles and villagers and vehicles running into each other,
// this moment: counted into bump.
function crowdCheck(game, bump) {
  const ag = game.agents, T = game.transit, D = 0.05;
  // (those drawn: the crowd on screen)
  const list = [...ag.walkers].filter(wk => wk.delay <= 0 && wk.mode !== 'ride' && wk.shown !== false && !(wk.mode === 'path' && ((wk.doorOut && wk.seg === 0) || (wk.doorIn && wk.seg >= wk.pts.length - 2))));
  const grid = new Map(), key = (x, z) => Math.floor(x / 0.25) * 65536 + Math.floor(z / 0.25);
  for (const wk of list) { const k = key(wk.x, wk.z); (grid.get(k) || grid.set(k, []).get(k)).push(wk); }
  bump.pairs += list.length;
  for (const a of list) {
    const cx = Math.floor(a.x / 0.25), cz = Math.floor(a.z / 0.25);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) for (const b of grid.get((cx + dx) * 65536 + cz + dz) || []) {
      if (b === a || b._n < a._n || (a.sit && b.sit) || Math.abs(a.y - b.y) > 0.2 || Math.hypot(a.x - b.x, a.z - b.z) >= D) continue;
      const kind = (wk) => wk.sit ? 'sitting' : wk.mode === 'path' ? (wk.narrow ? (wk.ys ? 'on a way up' : wk.doorIn && wk.seg >= wk.pts.length - wk.doorIn - 1 ? 'going in' : wk.doorOut && wk.seg < wk.doorOut ? 'coming out' : 'off a plot') : 'walking') : wk.mode;
      const pk = [kind(a), kind(b)].sort().join(' + ');
      (bump.kinds ||= new Map()).set(pk, (bump.kinds.get(pk) || 0) + 1);
      if ((a.mode === 'path' && a.narrow) || (b.mode === 'path' && b.narrow)) bump.narrow++;
      else { bump.street++; bump.streetAt ||= [a.x, a.z]; }
    }
  }
  const bodies = T._bodies(), ground = bodies.filter(o => !o.air);
  // two boxes overlap (separating axes, with a little give)
  const corners = (o) => { const c = []; for (const [u, l] of [[o.f, o.w], [o.f, -o.w], [-o.b, -o.w], [-o.b, o.w]]) c.push([o.x + o.hx * u + o.hz * l, o.z + o.hz * u - o.hx * l]); return c; };
  const sep = (A, B) => {
    for (const P of [A, B]) for (let i = 0; i < 4; i++) {
      const [ax, az] = P[i], [bx, bz] = P[(i + 1) % 4], nx = -(bz - az), nz = bx - ax;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const [x, z] of A) { const d = x * nx + z * nz; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
      for (const [x, z] of B) { const d = x * nx + z * nz; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
      const L = Math.hypot(nx, nz) || 1;
      if (a1 < b0 + 0.02 * L || b1 < a0 + 0.02 * L) return true;
    }
    return false;
  };
  for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
    const a = bodies[i], b = bodies[j];
    if (a.owner === b.owner || a.air !== b.air || Math.abs(a.y - b.y) > 0.25 || Math.hypot(a.x - b.x, a.z - b.z) > 0.9) continue;
    if (sep(corners(a), corners(b))) continue;
    const k = [a, b].map(o => o.air ? 'cabin' : o.owner.line ? o.owner.line.name : 'cart').sort().join(' and ');
    if (VERBOSE && !bump.carAt) for (const o of [a, b]) { const v = o.owner; console.log(`      first run-in: ${o.air ? 'cabin' : v.line ? v.line.name : 'cart'} at ${at(o.x, o.z)} heading ${Math.atan2(o.hx, o.hz).toFixed(2)} ${v.state || ''} s ${(v.s || 0).toFixed(2)} wait ${(v.wait || 0).toFixed(2)} by ${v.by ? (v.by.line ? v.by.line.name : 'cart') : '-'}`); }
    bump.cars.set(k, (bump.cars.get(k) || 0) + 1);
    bump.carAt ||= [a.x, a.z];
  }
  for (const o of ground) for (const wk of ag.near(o.x, o.z, 0.5)) {
    if (wk.mode === 'ride' || Math.abs(wk.y - o.y) > 0.15) continue;
    const rx = wk.x - o.x, rz = wk.z - o.z, along = rx * o.hx + rz * o.hz, lat = rx * o.hz - rz * o.hx;
    if (Math.abs(lat) < o.w && along < o.f && along > -o.b) {
      bump.feet++; bump.feetAt ||= [wk.x, wk.z];
      const v = o.owner, k = `${wk.sit ? 'sitting' : wk.mode === 'path' ? (wk.narrow ? 'narrow' : 'walking') : wk.mode} in a ${v.line ? 'coach' : 'cart'} ${v.state === 'dwell' ? 'at a stop' : v.wait > 0 ? 'waiting' : 'moving'}`;
      (bump.feetKinds ||= new Map()).set(k, (bump.feetKinds.get(k) || 0) + 1);
    }
  }
  // (and how long vehicles are held up in traffic, and why)
  for (const v of [...T.vehicles, ...T.carts]) {
    if (v.wait > (bump.maxWait || 0)) { bump.maxWait = v.wait; bump.maxWaitAt = v; }
    if (v.wait <= 20) continue;
    bump.longWaits = (bump.longWaits || 0) + 1;
    const k = (v.why || '?') + (v.by ? (v.by.state === 'dwell' ? ' (one at a stop)' : v.by.wait > 0 ? ' (one held up)' : ' (one moving)') : '');
    (bump.whys ||= new Map()).set(k, (bump.whys.get(k) || 0) + 1);
  }
}

// Gondola lines across the busiest part of the town (no starter has one):
// stations on open ground by a road, as far apart as a line goes, with as many
// buildings under the cable as can be found; one line of two stations and one
// of three, with a few cabins each.
function gondolas(game) {
  const w = game.world, rng = mulberry(w.N * 7919 + w.buildings.size);
  w.setSandbox({ infiniteMoney: true, unlockAll: true });
  // (spots for a station along the streets: [x, z, a])
  const open = [];
  findPlot(w, 'gondola', { x: w.N / 2, z: w.N / 2 }, { r: w.N, step: 0.5, test: (x, z, a, chk) => { if (chk && chk.access && open.length < 400) open.push([x, z, a]); return !chk; } });
  const under = (a, b) => {
    const seen = new Set(), L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let u = 0; u <= L; u += 0.25) {
      const o = w.buildingAt(a[0] + ((b[0] - a[0]) * u) / L, a[1] + ((b[1] - a[1]) * u) / L);
      if (o) seen.add(o.id);
    }
    return seen.size;
  };
  const station = ([x, z, a]) => {
    const r = w.placeBuilding('gondola', x, z, { a, instant: true });
    if (r.ok && r.building.access) return r.building;
    if (r.ok) w.removeBuilding(r.building.id, 0);
    return null;
  };
  const made = [];
  for (const n of [2, 3]) {
    const tries = [];
    for (let k = 0; k < 600 && open.length > 2; k++) {
      const pts = [open[(rng() * open.length) | 0]];
      for (let j = 1; j < n; j++) pts.push(open[(rng() * open.length) | 0]);
      let ok = true, score = 0;
      for (let j = 1; j < n && ok; j++) { const L = Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]); if (L < 8 || L > 22) ok = false; else score += under(pts[j - 1], pts[j]); }
      if (ok) tries.push({ pts, score });
    }
    // (the best that the game lets be built: not one whose cable runs along
    // the other's, say)
    tries.sort((a, b) => b.score - a.score);
    for (const best of tries.slice(0, 12)) {
      const st = best.pts.map(station);
      const r = st.every(Boolean) ? game.transit.createLine('gondola', st.map(s => s.id)) : { ok: false };
      if (r.ok) { game.transit.setVehicles(r.line.id, 6); made.push(r.line); break; }
      for (const s of st) if (s) w.removeBuilding(s.id, 0);
    }
  }
  // and an interchange where two more lines meet, out from berths of their
  // own to a station each
  const hubs = [];
  findPlot(w, 'gondolahub', { x: w.N / 2, z: w.N / 2 }, { r: w.N, step: 0.5, test: (x, z, a, chk) => { if (chk && chk.access && hubs.length < 200) hubs.push([x, z, a]); return !chk; } });
  for (let k = 0; k < 30 && hubs.length; k++) {
    const [hx, hz, ha] = hubs.splice((rng() * hubs.length) | 0, 1)[0];
    const r = w.placeBuilding('gondolahub', hx, hz, { a: ha, instant: true });
    if (!r.ok || !r.building.access) { if (r.ok) w.removeBuilding(r.building.id, 0); continue; }
    const H = r.building, ends = open.filter(([x, z]) => { const L = Math.hypot(x - hx, z - hz); return L >= 8 && L <= 20; });
    const mine = [];
    for (let t = 0; t < 40 && mine.length < 2 && ends.length; t++) {
      const s = station(ends[(rng() * ends.length) | 0]);
      const lr = s ? game.transit.createLine('gondola', [H.id, s.id]) : { ok: false };
      if (lr.ok) mine.push({ line: lr.line, s }); else if (s) w.removeBuilding(s.id, 0);
    }
    if (mine.length === 2) { for (const m of mine) { game.transit.setVehicles(m.line.id, 6); made.push(m.line); } break; }
    for (const m of mine) { game.transit.deleteLine(m.line.id); w.removeBuilding(m.s.id, 0); }
    w.removeBuilding(H.id, 0);
  }
  game.transit.rebuild();
  // each line, how long its spans are and the pylons holding them up
  return made.map(l => {
    const R = game.transit.routes.get(l.id);
    const legs = (R && R.legs || []).map(g => `${g.L.toFixed(1)} units, ${g.pylons.length} pylon${g.pylons.length === 1 ? '' : 's'}${g.pylons.length ? ' up to ' + Math.max(...g.pylons.map(p => p.h - p.g)).toFixed(2) : ''}`);
    return `${l.name} (${l.stops.length} stations; ${legs.join(' · ')})`;
  });
}
function mulberry(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ------------------------------------------------------------------ a town
function play(label, w) {
  const t0 = performance.now();
  const F = new Findings();
  const scene = { add() {}, remove() {} };
  const game = {
    // (at 2×, as it's played; at 8× everyone moves further than their own
    // width in a step of the test, and nobody could keep out of anyone's way)
    speed: 2, env: { night: 0 }, renderer: { scene, worldToScreen: () => ({ x: 0, y: 0 }) }, view: { smoke: { emit() {} }, items: null },
    // (the crowd as it's drawn by default, thinned where it gathers; with
    // --everyone, every villager drawn, the busiest the streets can look)
    settings: { villagers: EVERYONE ? 'all' : 'crowds' },
    _ev: {}, on(e, f) { (this._ev[e] ||= []).push(f); }, emit(e, d) { for (const f of this._ev[e] || []) f(d); },
  };
  game.world = w;
  const S = new Solids(w, game);
  game.view.items = S.items;
  game.paths = new PathFinder(w);
  game.sim = new Sim(game);
  game.transit = new Transit(game);
  game.sim.recompute();
  game.agents = new Agents(game);
  game.animals = new Animals(game);
  game.construction = new Construction(game);
  game.transit.rebuild();
  game.transit.planCarts();
  game.on('day', () => game.transit.planCarts());
  w.on('roads', () => game.paths.invalidate?.());
  const built = performance.now() - t0;
  const cable = gondolas(game);
  if (cable.length) console.log(`     (gondolas added: ${cable.join(', ')})`);

  // --probe=id,x,z: the parts of building id over a point, and its door
  const probe = process.argv.find(a => a.startsWith('--probe='));
  if (probe) {
    const [id, x, z] = probe.slice(8).split(',').map(Number), B = w.buildings.get(id);
    if (B) {
      console.log(`  probe ${name(B)} #${id} at ${at(x, z)}: plot ${B.x},${B.z} ${B.w}×${B.d} turned ${B.a} base ${B.baseY.toFixed(3)} door`, B.door && { x: +B.door.x.toFixed(3), z: +B.door.z.toFixed(3), dx: +B.door.dx.toFixed(2), dz: +B.door.dz.toFixed(2) });
      for (const p of S.byB.get(id) || []) if (outside(p.h, x, z) < 0.03) console.log(`    part y ${(p.y0 - B.baseY).toFixed(3)}–${(p.y1 - B.baseY).toFixed(3)} x ${p.x0.toFixed(3)}–${p.x1.toFixed(3)} z ${p.z0.toFixed(3)}–${p.z1.toFixed(3)} area ${p.a.toFixed(4)} out ${outside(p.h, x, z).toFixed(3)}`);
    }
  }

  // what every building stands in, and every way about it
  const lanes = [0.26, 0.28, 0.3];
  sweepPlots(game, S, F);
  sweepDoors(game, S, F, lanes);
  sweepGrounds(game, S, F);
  sweepCables(game, S, F);

  // then a few days of everyone going about their business
  const seen = new Set();   // one finding per walker and building
  const once = (wk, b) => { const k = (wk.r ? wk.r.id : 'g' + wk.lk.lane) + ':' + b.id; if (seen.has(k)) return false; seen.add(k); return true; };
  const start = w.day;
  let steps = 0, samples = 0;
  const rode = new Set(), climbed = new Set(), sat = new Set(), lifted = new Set();   // who rode a gondola, who climbed up to one, who sat down to wait, who rode a station's lift
  // villagers into each other (on the street, and in a doorway or on stairs
  // where they take turns), vehicles into each other, villagers into vehicles
  const bump = { street: 0, narrow: 0, pairs: 0, cars: new Map(), feet: 0, feetAt: null, carAt: null, streetAt: null };
  const cost = { agents: 0, transit: 0 };   // (the time the villagers and the vehicles take a step)
  while (w.day < start + DAYS && steps < 400000) {
    const g = game.sim.update(0.1), t1 = performance.now();
    game.agents.update(0.1, g);
    const t2 = performance.now();
    game.construction.update(0.1, g);
    const t3 = performance.now();
    game.transit.update(0.1);
    cost.agents += t2 - t1; cost.transit += performance.now() - t3;
    game.animals.update(0.1, game.speed);
    steps++;
    for (const wk of game.agents.walkers) {
      if (wk.delay > 0) continue;
      samples++;
      // (in a gondola cabin: the cabins are checked below)
      if (wk.mode === 'ride') { if (wk.r) rode.add(wk.r.id); continue; }
      if (wk.sit && wk.r) sat.add(wk.r.id);
      const onWay = wk.mode === 'path' && wk.ys && wk.ys[wk.seg] != null && wk.ys[wk.seg + 1] != null;
      if (onWay && wk.ys[wk.seg + 1] > wk.ys[wk.seg] + 0.05 && wk.r) climbed.add(wk.r.id);
      if (wk.lift && wk.r && wk.lift.riders.includes(wk)) lifted.add(wk.r.id);
      if (wk.liftWait > (bump.liftWait || 0)) { bump.liftWait = wk.liftWait; bump.liftAt = [wk.x, wk.z]; }
      const y = wk.mode === 'wander' ? wk.baseY : wk.y;
      let skip = null, where = wk.mode;
      if (wk.mode === 'path') {
        const n = wk.pts.length;
        // the step through the wall to the inside, in or out (from a body's
        // width short of the doorway itself, on)
        const near = (p) => Math.hypot(wk.x - p[0], wk.z - p[1]) < 0.03;
        if (wk.doorIn && (wk.seg >= n - 2 || near(wk.pts[n - 2]))) continue;
        if (wk.doorOut && (wk.seg === 0 || near(wk.pts[1]))) continue;
        where = wk.doorIn && wk.seg >= n - wk.doorIn - 2 ? 'going in a door' : wk.doorOut && wk.seg < wk.doorOut ? 'coming out of a door' : 'on the street';
        if (w.inBounds(wk.x, wk.z) && w.waterAt(wk.x, wk.z) && !w.roadAt(wk.x, wk.z, 0.05) && !w.buildingAt(wk.x, wk.z) && once(wk, { id: 'water' + Math.floor(wk.x) + ',' + Math.floor(wk.z) })) F.add('villager walks on the water', where, at(wk.x, wk.z));
      } else if (wk.mode === 'wander') {
        const B = wk.r && w.buildings.get(wk.r.at);
        where = B ? `${wk.working ? 'working' : 'strolling'} at the ${name(B)}` : 'wandering';
        // builders walk round the scaffolding of a site with no walls yet
        if (wk.ring) continue;
      } else if (wk.mode === 'wait') where = 'waiting at a stop';
      const h = S.hit(wk.x, wk.z, y, 0.015, skip);
      // (on a gondola station's own way up or down, into its lift is the way)
      if (h && onWay && BUILDINGS[h.p.b.type].stop === 'gondola') continue;
      if (!h || !once(wk, h.p.b)) continue;
      const serious = h.kind === 'wall' && (wk.mode !== 'wander' || where.startsWith('working'));
      if (TRACE === h.p.b.id) console.log(`  hit #${TRACE}: ${where} at ${at(wk.x, wk.z)}, ${(y - h.p.b.baseY).toFixed(3)} over its floor; seg ${wk.seg} of ${wk.pts.length - 1}, doorIn ${wk.doorIn}, t ${wk.t.toFixed(2)}; part ${(h.p.y0 - h.p.b.baseY).toFixed(3)}–${(h.p.y1 - h.p.b.baseY).toFixed(3)} area ${h.p.a.toFixed(4)}; way ${wk.pts.slice(-5).map(([x, z]) => at(x, z)).join(' → ')}${wk.ys ? ' (with heights)' : ''}`);
      F.add(`villager inside ${THING[h.kind]}`, `${where}, in the ${name(h.p.b)}`, `${at(wk.x, wk.z)} #${h.p.b.id}`, serious);
    }
    // coaches, trains and carts on the ground; gondola cabins in the air
    if (steps % 3 === 0) {
      for (const v of game.transit.vehicles) {
        const cable = v.line.mode === 'gondola';
        for (const m of v.meshes) {
          const p = m.position;
          if (cable) {
            for (const q of S.touch(p.x, p.z, p.y - G_HANG - 0.02, p.y - G_HANG + CABIN.H + 0.02, 0.12)) if (!v.line.stops.includes(q.b.id)) F.add('gondola cabin inside a building', `${v.line.name}, the ${name(q.b)}`, `${at(p.x, p.z)} y ${p.y.toFixed(2)} #${q.b.id}`);
          } else {
            const h = S.hit(p.x, p.z, p.y, 0.03);
            if (h && h.kind === 'wall') F.add(`${v.line.mode === 'rail' ? 'train' : 'coach'} through a building`, `${v.line.name}, the ${name(h.p.b)}`, `${at(p.x, p.z)} #${h.p.b.id}`);
          }
        }
      }
      for (const c of game.transit.carts) {
        const p = c.mesh.position, h = S.hit(p.x, p.z, p.y, 0.03);
        if (h && h.kind === 'wall') F.add('cart through a building', `the ${name(h.p.b)}`, `${at(p.x, p.z)} #${h.p.b.id}`);
      }
    }
    crowdCheck(game, bump);
  }
  // how often they ran into each other, in every thousand villager
  // positions: on the street, more than ten is a crowd that doesn't make
  // room (a busy city's pavements, with everyone drawn, come to five to
  // eight, mostly overtaking and at crossings; a village's to under one);
  // in doorways and on stairs, where they take turns, more than thirty; and
  // more than one in a thousand inside a coach or a cart is one that runs
  // them down, or a crowd that walks through it
  const rate = (n) => (1000 * n) / Math.max(1, bump.pairs);
  if (bump.pairs) {
    const st = rate(bump.street), na = rate(bump.narrow);
    if (st > 1 || na > 5) F.add('villagers walk into each other', `on the street ${st.toFixed(2)} and in doorways or on stairs ${na.toFixed(2)} in every thousand moments`, bump.streetAt ? at(bump.streetAt[0], bump.streetAt[1]) : '-', st > 10 || na > 30);
  }
  if (bump.feet) F.add('villagers inside a vehicle', `${bump.feet} moments, ${rate(bump.feet).toFixed(2)} in every thousand`, bump.feetAt ? at(bump.feetAt[0], bump.feetAt[1]) : '-', rate(bump.feet) > 1 && bump.feet > 40);
  // (and nobody kept waiting at a lift's door: its car comes for them)
  if (bump.liftWait > 60) F.add('villager kept waiting for a lift', `${bump.liftWait.toFixed(0)} s`, at(bump.liftAt[0], bump.liftAt[1]));
  if (bump.maxWait > 60) F.add('vehicles held up in traffic', `the longest ${bump.maxWait.toFixed(0)} s (${bump.maxWaitAt.line ? bump.maxWaitAt.line.name : 'a cart'}), ${bump.longWaits || 0} vehicle-moments over 20 s`, '-', false);
  if (VERBOSE) for (const l of w.lines) if (l.mode === 'gondola') { const st = game.transit.stats[l.id] || {}; console.log(`      ${l.name}: ${l.stops.length} stations, ${st.trips || 0} trips planned on it, ${st.riders || 0} riders`); }
  if (VERBOSE) console.log(`      a step takes: the villagers ${(cost.agents / steps).toFixed(2)} ms, the vehicles ${(cost.transit / steps).toFixed(2)} ms`);
  if (VERBOSE && bump.whys) console.log('      held up over 20 s, waiting for: ' + [...bump.whys].sort((x, y) => y[1] - x[1]).map(([k, n]) => k + ' ' + n).join(' · '));
  if (VERBOSE && bump.feetKinds) console.log('      villagers inside vehicles: ' + [...bump.feetKinds].sort((x, y) => y[1] - x[1]).map(([k, n]) => k + ' ' + n).join(' · '));
  if (VERBOSE && bump.kinds) console.log('      villagers into each other: ' + [...bump.kinds].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, n]) => `${k} ${n}`).join(' · '));
  for (const [k, n] of bump.cars) if (n > 2) F.add('vehicles run into each other', k, `×${n} ${bump.carAt ? at(bump.carAt[0], bump.carAt[1]) : ''}`);
  // what changed while they played (sites finished, upgrades): sweep again
  sweepPlots(game, S, F);
  sweepCables(game, S, F);
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  const parts = [...S.byB.values()].reduce((n, l) => n + l.length, 0);
  console.log(`${F.serious ? 'FAIL' : 'ok  '} ${label}: ${w.buildings.size} buildings (${parts} solid parts, models in ${(built / 1000).toFixed(1)} s) · ${w.population} villagers · ${game.world.lines.length} lines (${climbed.size} climbed to a gondola, ${lifted.size} in a lift, ${rode.size} rode one in sight, ${sat.size} sat down to wait) · ${DAYS} days, ${samples} villager positions checked · ${secs} s`);
  F.print('     ');
  return F.serious;
}

// A few curving streets out of a town, lined with homes and shops facing
// them at whatever angle the curve gives, for the 'curves' town.
function curvingStreets(w) {
  w.setSandbox({ ...w.sandbox, infiniteMoney: true, unlockAll: true });
  const kinds = ['house', 'bakery', 'house', 'grocer', 'house', 'tavern', 'house', 'coffeehouse', 'playground', 'house', 'garden'];
  const rnd = mulberry(4242 + Number(process.env.COLLIDE_SEED || 0));
  let laid = 0, n = 0, t = 0;
  const ends = [...w.roads.nodes.values()].filter(nd => nd.edges.length === 1 && nd.id !== w.entry.node);
  const sides = [...w.roads.edges.values()].filter(e => e.len > 3 && w.connected.has(e.a));
  for (let k = 0; k < 80 && laid < 4; k++) {
    // from a dead end on, or off the side of a street
    let x, z, ux, uz;
    if (ends.length && rnd() < 0.5) {
      const nd = ends[(rnd() * ends.length) | 0], e = w.roads.edges.get(nd.edges[0]), a = w.roads.dirAt(e, nd.id) + Math.PI;
      x = nd.x; z = nd.z; ux = Math.sin(a); uz = Math.cos(a);
    } else {
      const e = sides[(rnd() * sides.length) | 0], p = pointAt(e.pts, e.cum, 1 + rnd() * (e.len - 2)), sd = rnd() < 0.5 ? 1 : -1;
      x = p[0]; z = p[1]; ux = -p[4] * sd; uz = p[3] * sd;
    }
    const bend = (rnd() - 0.5) * 1.6, c = Math.cos(bend), si = Math.sin(bend), vx = ux * c + uz * si, vz = -ux * si + uz * c, L = 7;
    const pts = [[x, z], [x + (ux + vx) * L / 4, z + (uz + vz) * L / 4], [x + vx * L, z + vz * L]];
    if (!w.placeRoad(pts, 1 + (laid % 3)).placed) continue;
    laid++;
    for (let i = 1; i <= 6; i++) for (const sd of [1, -1]) {
      const q = [x + (ux * (6 - i) / 6 + vx * i / 6) * L * i / 6, z + (uz * (6 - i) / 6 + vz * i / 6) * L * i / 6];
      const s2 = findPlot(w, kinds[n % kinds.length], { x: q[0] - uz * sd * 0.9, z: q[1] + ux * sd * 0.9 }, { r: 1.2 });
      if (s2 && w.placeBuilding(kinds[n % kinds.length], s2.x, s2.z, { a: s2.a, instant: true, variant: 1000 + n * 7919 + t * 31 + Number(process.env.COLLIDE_SEED || 0) * 104729 }).ok) n++;
      t++;
    }
  }
  console.log(`     (${laid} curving streets, ${n} buildings facing them)`);
}

let failed = 0;
const towns = which.includes('all') ? [...STARTERS.filter(d => !d.heavy).map(d => d.id), 'curves', 'freeform'] : which;
for (const id of towns) {
  if (id === 'freeform') {
    const w = loadStarter('market', { name: 'Askew' });
    // every building turned on its plot, as far either way as it will go
    // (and still face its street, or anything at all for a park)
    let n = 0, seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
    for (const b of w.buildings.values()) {
      const want = (rnd() * 2 - 1) * 0.7;
      for (const k of [1, 0.6, 0.3, 0.1]) if (w.turnBuilding(b.id, b.a + want * k).ok) { n++; break; }
    }
    console.log(`     (${n} buildings turned)`);
    failed += play('market town, every building askew', w) ? 1 : 0;
    continue;
  }
  if (id === 'curves') {
    const w = loadStarter('market', { name: 'Bendham' });
    curvingStreets(w);
    failed += play('market town with curving streets', w) ? 1 : 0;
    continue;
  }
  if (id === 'scale') {
    const w = World.createNew({ N: 64, seed: 77, name: 'Botton' });
    growDemoTown(w, 77, 2);
    failed += play('demo-grown town', w) ? 1 : 0;
    continue;
  }
  const def = STARTERS.find(d => d.id === id);
  if (!def) { console.log(`no starter called ${id}`); failed++; continue; }
  failed += play(def.name, loadStarter(def.id, { name: 'Testham' })) ? 1 : 0;
}
console.log(failed ? `\n${failed} town(s) with collisions` : '\nno collisions found');
process.exit(failed ? 1 : 0);
