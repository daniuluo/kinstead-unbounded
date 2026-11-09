// Headless smoke test: generates worlds, builds every model, runs the
// simulation for a few in-game days and round-trips a save.
// Usage: npm install three@0.170.0 --no-save && node scripts/check.js
//
// In this fork there is no grid: plots are rectangles at any angle, roads
// are curves (src/world/net.js), and the checks set their towns up with
// the helpers below (a street from point to point, a plot along a street).

import { CONFIG } from '../src/config.js';
import { World, plotOf, ownPlot, sizeOf, SETBACK, findPlot, seatOf, capOf, isOpen, HALF } from '../src/world/world.js';
import { rect, toWorld, toLocal, rectsOverlap, aabbOf, pointAt, wrapAngle } from '../src/world/geom.js';
import { growDemoTown } from '../src/world/demo.js';
import { PathFinder } from '../src/sim/path.js';
import { Sim, cellOf } from '../src/sim/sim.js';
import { Agents } from '../src/sim/agents.js';
import { Transit, G_HANG } from '../src/sim/transit.js';
import { Animals } from '../src/sim/animals.js';
import { Construction } from '../src/sim/construction.js';
import { siteGeo, bodyBox } from '../src/render/construction.js';
import { serialize, deserialize } from '../src/save/saves.js';
import { buildModel, STYLES } from '../src/render/buildings.js';
import { BUILDINGS, TECHS } from '../src/defs.js';
import { makeAudit } from './audit.js';

let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.error('FAIL', msg); } else console.log('ok  ', msg); };
// a group of checks: one that throws counts as a failure, and the rest go on
const block = async (name, f) => {
  try { await f(); } catch (e) { failures++; console.error('FAIL', `${name} threw: ${(e.stack || String(e)).split('\n').slice(0, 5).join(' | ')}`); }
};
const PI = Math.PI;
const listen = (tw) => ({ world: tw, speed: 0, _ev: {}, on(e, f) { (this._ev[e] ||= []).push(f); }, emit(e, d) { for (const f of this._ev[e] || []) f(d); } });

// ---------------------------------------------------- setting towns up
// Open ground: a W × D box from (x0, z0) with no building, road, track,
// field or water on it, the ground no rougher than `rough`.
function clearAt(tw, x0, z0, W, D, rough = 0.5) {
  if (x0 < 0.5 || z0 < 0.5 || x0 + W > tw.N - 0.5 || z0 + D > tw.N - 0.5) return false;
  let lo = Infinity, hi = -Infinity;
  for (let z = z0; z <= z0 + D + 1e-9; z += 0.25) for (let x = x0; x <= x0 + W + 1e-9; x += 0.25) {
    if (tw.waterAt(x, z) || tw.buildingAt(x, z) || tw.roadAt(x, z, 0.3) || tw.railAt(x, z, 0.3) || tw.fieldAt(x, z)) return false;
    const h = tw.terrain.heightAt(x, z);
    lo = Math.min(lo, h); hi = Math.max(hi, h);
    if (hi - lo > rough) return false;
  }
  return true;
}
// The open box nearest a point, searched outward a unit at a time: its
// corner { x, z }, or null.
function openBox(tw, W, D, near = null, rough = 0.5) {
  const c = near || { x: tw.N / 2, z: tw.N / 2 };
  for (let r = 0; r < tw.N; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
    const x0 = Math.round(c.x - W / 2) + dx, z0 = Math.round(c.z - D / 2) + dz;
    if (clearAt(tw, x0, z0, W, D, rough)) return { x: x0, z: z0 };
  }
  return null;
}
// Level the ground over a box (and a unit round it) and clear its trees.
function levelBox(tw, x0, z0, W, D, h = 0.5) {
  for (let z = Math.floor(z0) - 1; z <= Math.ceil(z0 + D) + 1; z++) for (let x = Math.floor(x0) - 1; x <= Math.ceil(x0 + W) + 1; x++) {
    if (x >= 0 && z >= 0 && x <= tw.N && z <= tw.N) tw.terrain.setCh(x, z, h);
  }
  tw._clearTreesIn(rect(x0 + W / 2, z0 + D / 2, 0, W / 2 + 1, D / 2 + 1));
}
// A street through these points, at a level: its edge ids (throws if it
// can't be laid: the checks set up their own ground for it).
function street(tw, pts, level = 1) {
  const sb = tw.sandbox.unlockAll;
  if (level > 1) tw.setSandbox({ unlockAll: true });
  const r = tw.placeRoad(pts, level);
  if (level > 1) tw.setSandbox({ unlockAll: sb });
  if (!r.placed) throw new Error(`street ${JSON.stringify(pts.map(p => p.map(v => +v.toFixed(2))))}: ${r.failed}`);
  return r.edges;
}
// A building on a street of its own, laid across open ground: the street
// runs along x in front of the plot (which faces -z, towards it), with room
// beside the plot (left: towards -x, right: towards +x) and behind it
// (back). The building, or null.
function lot(tw, type, o = {}) {
  const [w0, d0] = sizeOf(type), W = o.w ?? w0, D = o.d ?? d0;
  const L = o.left ?? 0, R = o.right ?? 0, B = o.back ?? 0;
  const bw = W + L + R + 1.6, bd = SETBACK + D + B + 0.6;
  const at = openBox(tw, bw, bd, o.near, o.rough ?? 0.5);
  if (!at) return null;
  if (o.flat) levelBox(tw, at.x, at.z, bw, bd, o.flat);
  const zr = at.z + 0.3, cx = at.x + 0.8 + L + W / 2;
  street(tw, [[at.x + 0.3, zr], [at.x + bw - 0.3, zr]], o.road ?? 1);
  const p = tw.placeBuilding(type, cx, zr + SETBACK + D / 2, { instant: true, ignoreUnlock: true, a: PI, w: W, d: D, ...(o.opts || {}) });
  return p.ok ? p.building : null;
}
// A building that must stand by the water, on a street of its own laid
// along the shore: its back to the water, the street across its front,
// room for a neighbour on its left (its own -x: right, as the pair below
// puts it). The building, or null.
function shoreLot(tw, type, o = {}) {
  const [W, D] = sizeOf(type), side = o.right ?? 0;
  for (let z = 2; z < tw.N - 2; z++) for (let x = 2; x < tw.N - 2; x++) for (let k = 0; k < 4; k++) {
    const a = (k * PI) / 2, R = rect(x + 0.5, z + 0.5, a, W / 2, D / 2);
    if (!tw.waterAt(...toWorld(R, 0, -D / 2 - 0.35))) continue;
    let fine = true;
    for (let lz = -D / 2 + 0.1; lz <= D / 2 + SETBACK + 0.45 && fine; lz += 0.25) for (let lx = -W / 2 - side - 0.6; lx <= W / 2 + 0.6 && fine; lx += 0.25) {
      const [px, pz] = toWorld(R, lx, lz);
      if (!tw.inBounds(px, pz) || tw.waterAt(px, pz) || tw.buildingAt(px, pz) || tw.roadAt(px, pz, 0.3) || tw.railAt(px, pz, 0.3) || tw.fieldAt(px, pz)) fine = false;
    }
    if (!fine) continue;
    const r = tw.placeRoad([toWorld(R, -W / 2 - side - 0.5, D / 2 + SETBACK), toWorld(R, W / 2 + 0.5, D / 2 + SETBACK)], 1);
    if (!r.placed) continue;
    const p = tw.placeBuilding(type, R.cx, R.cz, { instant: true, ignoreUnlock: true, a });
    if (p.ok) return p.building;
    for (const id of r.edges) if (tw.roads.edges.has(id)) tw.removeRoadEdge(id);
  }
  return null;
}
// A building of this type along the town's own streets near a point (the
// seat, unless told), on the roads to the way out unless o.conn is false.
function near(tw, type, at = null, o = {}) {
  const c = at || seatOf(tw) || { x: tw.N / 2, z: tw.N / 2 };
  const f = findPlot(tw, type, { x: c.x, z: c.z }, {
    r: o.r ?? 14, w: o.w, d: o.d, score: o.score, step: o.step,
    opts: { ignoreUnlock: true, ignoreMoney: true, ...(o.opts || {}) },
    test: (x, z, a, chk) => (!o.test || o.test(x, z, a, chk)) && (!chk || o.conn === false || !!(chk.access && chk.access.conn)),
  });
  if (!f) return null;
  const p = tw.placeBuilding(type, f.x, f.z, { a: f.a, instant: o.instant ?? true, ignoreUnlock: true, ignoreMoney: o.ignoreMoney, w: o.w, d: o.d, level: o.level, flavor: o.flavor });
  return p.ok ? p.building : null;
}
// Where a building of this type would stand beside b (its own x axis: -1
// its left, 1 its right), square to it: [x, z].
const besideAt = (b, type, side) => { const [w1] = sizeOf(type); return toWorld(ownPlot(b), side * (b.w + w1) / 2, 0); };
// Two buildings side by side facing the same street: along the town's own
// streets when there is room there, or else on a street of their own.
function pair(tw, ta, tb, o = {}) {
  const [wa] = sizeOf(ta), [wb] = sizeOf(tb);
  const second = (A) => { const [x, z] = besideAt(A, tb, -1); const p = tw.placeBuilding(tb, x, z, { a: A.a, instant: true, ignoreUnlock: true }); return p.ok ? p.building : null; };
  if (!o.own) {
    // (both on the street: a park beside a home must reach it too; by the water, anywhere it is)
    const wet = BUILDINGS[ta].needsWater || BUILDINGS[tb].needsWater;
    const A = near(tw, ta, o.near, { r: o.r ?? (wet ? tw.N : 18), conn: o.conn, test: (x, z, a, chk) => { if (!chk) return true; const [nx, nz] = toWorld(chk.rect, -(wa + wb) / 2, 0), c = tw.checkBuild(tb, nx, nz, { a, ignoreUnlock: true, ignoreMoney: true }); return c.ok && (o.conn === false || !!(c.access && c.access.conn)); } });
    if (A) { const B = second(A); if (B) return [A, B]; tw.removeBuilding(A.id, 0); }
  }
  const A = BUILDINGS[ta].needsWater ? shoreLot(tw, ta, { right: wb + 0.2 }) : lot(tw, ta, { right: wb + 0.2, near: o.lotNear });
  const B = A && second(A);
  return A && B ? [A, B] : null;
}
// the area of a polygon
const areaOf = (pts) => { let s = 0; for (let i = 0; i < pts.length; i++) { const [x0, z0] = pts[i], [x1, z1] = pts[(i + 1) % pts.length]; s += x0 * z1 - x1 * z0; } return Math.abs(s) / 2; };
// the middle of a polygon's corners
const midOf = (pts) => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
// a building's model, at a place in the world (buildModel takes its middle and turn)
const at0 = (o) => ({ x: 0, z: 0, a: 0, ...o });

// 1. every model builds
let verts = 0;
for (const [type, def] of Object.entries(BUILDINGS)) {
  def.levels.forEach((_, level) => {
    for (const variant of [1, 2, 3, 4]) {
      const W = def.merged ? (variant % 2 ? 2 : 1) : def.size, D = def.merged ? (variant % 2 ? 1 : 2) : def.size;
      const flavor = type === 'shophouse' ? ['market', 'bakery', 'tavern', 'market'][variant - 1] : null;
      const look = variant === 4 ? STYLES[level % STYLES.length].id : null;
      const ext = variant === 3 && def.size === 1 ? { x0: type === 'house' ? -0.25 : 0.25, x1: 0, z0: 0, z1: 0 } : null;
      const b = at0({ type, level, variant, flavor, look, ext, size: Math.max(W, D), w: W, d: D, baseY: 0.5, minY: 0.2, a: variant * 0.7 - 1.2, rail: def.needsRail ? { k: 2 } : null });
      const m = buildModel(b);
      if (!m.geo || !m.geo.attributes.position.count) throw new Error(`empty model ${type} L${level}`);
      for (const v of m.geo.attributes.position.array) if (!Number.isFinite(v)) throw new Error(`NaN in ${type} L${level}`);
      verts += m.geo.attributes.position.count;
      // and every stage of putting it up / taking it down
      if (variant === 1) {
        const box = bodyBox(m.geo);
        for (const kind of ['build', 'merge', 'dismantle', 'upgrade']) for (const p of [0, 0.15, 0.5, 0.95]) {
          const g = siteGeo({ target: m.geo, old: m.geo, box, oldBox: box, kind, p, wait: null, Ex: W / 2, Ez: D / 2, gy: () => 0, seed: 7 });
          for (const v of g.attributes.position.array) if (!Number.isFinite(v)) throw new Error(`NaN in site ${type} ${kind}`);
        }
      }
    }
  });
}
ok(true, `all building models build, at any angle (${verts} verts total)`);
// ...and a shop with homes above for every trade it can be joined from
{
  const { MERGES } = await import('../src/defs.js');
  const flavors = MERGES.find(m => m.to === 'shophouse').b;
  for (const flavor of flavors) for (let level = 0; level < BUILDINGS.shophouse.levels.length; level++) for (const rot of [0, 1]) {
    const b = at0({ type: 'shophouse', level, variant: 5 + level, flavor, size: 2, w: rot ? 1 : 2, d: rot ? 2 : 1, baseY: 0.5, minY: 0.2, a: rot * 0.4 });
    const m = buildModel(b);
    if (!m.geo || !m.geo.attributes.position.count || !m.door) throw new Error(`shophouse ${flavor} L${level}`);
  }
  ok(true, `a shop with homes above builds for every trade it is joined from (${flavors.join(', ')})`);
}
// ...and depends only on the building, not on what the page built before it
// (the title screen's random demo town): every model built in a fresh
// process, and again in one that has built a different town first
{
  const { execFileSync } = await import('node:child_process');
  const src = (p) => JSON.stringify(new URL(`../src/${p}`, import.meta.url).href);
  const hashes = (warm) => execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { World } = await import(${src('world/world.js')});
    const { growDemoTown } = await import(${src('world/demo.js')});
    const { buildModel } = await import(${src('render/buildings.js')});
    const { BUILDINGS } = await import(${src('defs.js')});
    if (${warm}) {
      const w = World.createNew({ N: 44, seed: ${warm}, name: 'T' });
      growDemoTown(w, ${warm}, 1);
      for (const b of w.buildings.values()) buildModel(b, { ground: (x, z) => w.terrain.heightAt(x, z) });
    }
    const ground = (x, z) => 0.5 + 0.08 * Math.sin(x * 1.7) + 0.06 * Math.cos(z * 1.3), out = [];
    for (const [type, def] of Object.entries(BUILDINGS)) def.levels.forEach((_, level) => {
      for (const variant of [21, 22]) {
        const W = def.merged ? 2 : def.size, D = def.merged ? 1 : def.size;
        const b = { type, level, variant, x: 3, z: 5, a: variant * 0.3, size: Math.max(W, D), w: W, d: D, baseY: 0.6, minY: 0.4, rail: def.needsRail ? { k: 2 } : null };
        const at = buildModel(b, { ground }).geo.attributes;
        let h = 2166136261;
        for (const a of [at.position.array, at.color.array]) for (const x of new Uint8Array(a.buffer, a.byteOffset, a.byteLength)) h = Math.imul(h ^ x, 16777619);
        out.push(type + ' L' + level + ':' + (h >>> 0).toString(16));
      }
    });
    process.stdout.write(out.join('\\n'));
  `]).toString().split('\n');
  const cold = hashes(0), changed = [];
  for (const warm of [101, 202]) hashes(warm).forEach((h, i) => { if (h !== cold[i]) changed.push(h.split(':')[0]); });
  ok(cold.length > 100 && !changed.length, `building models are the same whatever was built before them (${cold.length} models${changed.length ? `; changed: ${[...new Set(changed)].slice(0, 6).join(', ')}` : ''})`);
}

// 1b. shops: on a street corner (b.corner) the shopfront turns the corner,
// the model stays inside its plot and the villagers' way in stays the shop
// door at the front (not the back door every shop now has); and a shop with
// homes above keeps the look of its trade, so no two trades look alike
{
  const { CORNER_SHOPS, MERGES } = await import('../src/defs.js');
  const THREE = await import('three');
  const bad = [];
  let shops = 0;
  for (const type of CORNER_SHOPS) {
    const def = BUILDINGS[type];
    def.levels.forEach((_, level) => {
      const bw = def.merged ? 2 : def.size, bd = def.merged ? 1 : def.size;
      const base = { type, level, variant: 11 + level, flavor: def.merged ? 'grocer' : null, size: def.size, w: bw, d: bd, baseY: 0, minY: 0, rot: 0 };
      const plain = buildModel(base, { flat: true });
      // the open market and the market hall have no shopfront; the inn's
      // wings and the ironmonger's open store take their right-hand side
      const none = type === 'market' && (level === 0 || level === 3), right = (type === 'tavern' && level > 0) || (type === 'ironmonger' && level === 0);
      for (const corner of [1, 2, 3]) {
        const m = buildModel({ ...base, corner }, { flat: true }), bb = new THREE.Box3().setFromBufferAttribute(m.geo.attributes.position);
        shops++;
        if (m.geo.attributes.position.count <= plain.geo.attributes.position.count && !none && !(right && corner === 2)) bad.push(`${type} L${level} corner ${corner}: no side front`);
        if (bb.min.x < -bw / 2 - 0.005 || bb.max.x > bw / 2 + 0.005 || bb.min.z < -bd / 2 - 0.005 || bb.max.z > bd / 2 + 0.005) bad.push(`${type} L${level} corner ${corner}: off its plot`);
        if (plain.door && (!m.door || m.door.dz < 0.9)) bad.push(`${type} L${level} corner ${corner}: the way in faces ${m.door && m.door.dz.toFixed(2)}`);
      }
    });
  }
  ok(!bad.length, `corner shops turn their shopfront round the corner, inside their plots, the door still at the front (${shops} models)${bad.length ? ': ' + bad.join('; ') : ''}`);
  const flavors = MERGES.find(m => m.to === 'shophouse').b, alike = [];
  for (let level = 0; level < BUILDINGS.shophouse.levels.length; level++) {
    const seen = new Map();
    for (const flavor of flavors) {
      const g = buildModel({ type: 'shophouse', level, variant: 9, flavor, size: 2, w: 2, d: 1, baseY: 0, minY: 0, rot: 0 }, { flat: true }).geo;
      const col = g.attributes.color.array;
      let sum = 0;
      for (let i = 0; i < col.length; i += 7) sum += col[i];
      const sig = `${g.attributes.position.count}:${sum.toFixed(2)}`;
      if (seen.has(sig)) alike.push(`L${level} ${seen.get(sig)} = ${flavor}`);
      seen.set(sig, flavor);
    }
  }
  ok(!alike.length, `a shop with homes above looks like its own trade at every level${alike.length ? ': ' + alike.join('; ') : ''}`);
}

// 1c. the world knows a shop stands on a street corner from the roads round
// it (b.corner: 1 its left, 2 its right), rebuilds it when that changes, and
// never saves it: a load works it out again
await block('1c corner shops', async () => {
  const tw = World.createNew({ N: 48, seed: 77, name: 'Cornerby' });
  tw.setSandbox({ infiniteMoney: true, unlockAll: true, instantBuild: true });
  const o = openBox(tw, 6, 5, { x: 12, z: 12 });
  levelBox(tw, o.x, o.z, 6, 5);
  // a street along x, ending at X + 1; the shop facing it from the +z side
  const X = o.x + 2.5, Z = o.z + 1;
  street(tw, [[o.x + 0.3, Z], [X + 1, Z]]);
  const r = tw.placeBuilding('grocer', X, Z + SETBACK + 0.5, { instant: true });
  const shop = r.ok ? r.building : null;
  ok(!!shop && Math.abs(wrapAngle(shop.a - PI)) < 0.01 && !shop.corner, `a shop with only a street in front is not on a corner, and turns to face the street by itself (${r.reason || shop.a})`);
  const refits = [];
  tw.on('building:refit', (b) => refits.push(b.id));
  // facing -z, its left as seen from the street is +x: a side street there
  const [side] = street(tw, [[X + 1, Z], [X + 1, Z + 2.8]]);
  ok(shop.corner === 1 && refits.includes(shop.id), `a side street turning the corner makes it a corner shop, rebuilt (corner ${shop.corner})`);
  ok(shop.sides === 1, `and the world knows its left side is on a street, for its walls there (sides ${shop.sides})`);
  const saved = JSON.stringify(serialize(tw));
  ok(!saved.includes('corner'), 'the corner is never saved');
  const tw2 = deserialize(JSON.parse(saved));
  ok(tw2.buildings.get(shop.id).corner === 1 && tw2.buildings.get(shop.id).sides === 1, 'a loaded town works the corner and the street sides out again');
  refits.length = 0;
  tw.removeRoadEdge(side);
  ok(!shop.corner && !shop.sides && refits.includes(shop.id), 'taking the side street up makes it an ordinary shop again');
});

// 1d. a building with a street along its side or back has windows on that
// wall (b.sides), whatever its looks; yards, farms, towers and open stalls,
// whose street side is a yard or has no walls, aside
{
  const YARDS = new Set(['windgen', 'well', 'farm', 'homestead', 'orchard', 'builder', 'contractor', 'joinery']);
  const DIRS = { left: [-1, 0], right: [1, 0], back: [0, -1] };
  const blank = [];
  let n = 0;
  for (const [type, d] of Object.entries(BUILDINGS)) {
    if (d.park || d.stop || YARDS.has(type)) continue;
    const W = d.merged ? 2 : d.size, D = d.merged ? 1 : d.size;
    for (let level = 0; level < d.levels.length; level++) for (const variant of [777, 4242, 31337]) {
      if (type === 'market' && level === 0) continue;
      const g = buildModel({ type, level, variant, size: d.size, w: W, d: D, baseY: 0, minY: 0, rot: 0, rail: d.needsRail ? { k: 2 } : null, sides: 7 }, { flat: true }).geo;
      const P = g.attributes.position.array, Nn = g.attributes.normal.array, C = g.attributes.color.array, E = g.attributes.emit.array;
      const cnt = { left: 0, right: 0, back: 0 };
      for (let i = 0; i < P.length / 3; i++) {
        const r = C[i * 3], gg = C[i * 3 + 1], bl = C[i * 3 + 2];
        if (!(E[i * 4 + 3] > 0 || (bl > r * 1.25 && bl < 0.12 && gg < 0.09))) continue;
        for (const [k, [dx, dz]] of Object.entries(DIRS)) if (Nn[i * 3] * dx + Nn[i * 3 + 2] * dz > 0.9 && P[i * 3] * dx + P[i * 3 + 2] * dz > -0.1) cnt[k]++;
      }
      n++;
      const none = Object.keys(cnt).filter(k => !cnt[k]);
      if (none.length) blank.push(`${type} L${level} (${variant}): ${none.join(', ')}`);
    }
  }
  ok(!blank.length, `a building with streets at its sides and back has windows on every wall facing them (${n} models)${blank.length ? ': ' + blank.slice(0, 8).join('; ') : ''}`);
}

// 1e. buildings with the same name and level take shapes of their own (see
// forms.js), not only colours of their own: the height of each of a few
// building kinds over a 12 × 12 grid of its plot, compared seed by seed
{
  const G = 12, kinds = [['house', 0], ['house', 1], ['flats', 2], ['terrace', 2], ['grocer', 1], ['offices', 2], ['market', 3], ['chapel', 1], ['workshop', 2], ['farm', 0], ['coachstop', 0], ['townhall', 1]];
  const flat = [];
  for (const [type, level] of kinds) {
    const d = BUILDINGS[type], W = d.merged ? 2 : d.size, D = d.merged ? 1 : d.size, maps = [];
    for (let v = 0; v < 8; v++) {
      const g = buildModel({ type, level, variant: 5003 + v * 7919, size: Math.max(W, D), w: W, d: D, baseY: 0, minY: 0, rot: 0 }, { flat: true }).geo, P = g.attributes.position.array;
      const hm = new Float32Array(G * G);
      for (let i = 0; i < P.length; i += 3) {
        const gx = Math.floor(((P[i] + W / 2) / W) * G), gz = Math.floor(((P[i + 2] + D / 2) / D) * G);
        if (gx >= 0 && gz >= 0 && gx < G && gz < G) hm[gz * G + gx] = Math.max(hm[gz * G + gx], P[i + 1]);
      }
      maps.push(hm);
    }
    let sum = 0, pairs = 0;
    for (let a = 0; a < maps.length; a++) for (let b = a + 1; b < maps.length; b++) {
      let n = 0;
      for (let j = 0; j < G * G; j++) if (Math.abs(maps[a][j] - maps[b][j]) > 0.06) n++;
      sum += n / (G * G); pairs++;
    }
    if (sum / pairs < 0.08) flat.push(`${type}.${level} ${(sum / pairs).toFixed(3)}`);
  }
  ok(!flat.length, `buildings of the same name and level take shapes of their own, seed by seed (${kinds.length} kinds)${flat.length ? ': too alike ' + flat.join(', ') : ''}`);
}

// 2. terrain generation over many seeds
for (let s = 1; s <= 25; s++) {
  const w = World.createNew({ N: 48, seed: s * 7919, name: 'T' });
  const th = [...w.buildings.values()].find(b => b.type === 'townhall');
  if (!th) { ok(false, `seed ${s}: no town hall`); continue; }
  if (!th.connected) ok(false, `seed ${s}: town hall not connected`);
}
ok(true, 'generated 25 worlds');
// and hilly and mountainous valleys: the village on the valley floor, its
// town hall on the road, high ground round it with steep slopes to climb
for (const relief of ['hilly', 'mountains']) {
  let fine = 0, high = 0, steep = 0;
  for (let s = 1; s <= 12; s++) {
    const w = World.createNew({ N: 48, seed: s * 7919, name: 'T', relief });
    const th = [...w.buildings.values()].find(b => b.type === 'townhall');
    if (th && th.connected) fine++;
    let top = 0, st = 0;
    for (let z = 0; z < w.N; z++) for (let x = 0; x < w.N; x++) { top = Math.max(top, w.terrain.tileAvg(x, z)); if (w.terrain.slope(x, z) > 0.85) st++; }
    high += top; steep += st / (w.N * w.N);
  }
  ok(fine === 12 && high / 12 > (relief === 'hilly' ? 3 : 5) && steep / 12 > 0.05, `${relief === 'hilly' ? 'hilly' : 'mountain'} valleys found their village on the valley floor (${fine} of 12), the land up to ${(high / 12).toFixed(1)} high round it, ${Math.round((100 * steep) / 12)}% of it too steep for a road`);
}

// 3. simulation
const scene = { add() {}, remove() {} };
const events = {};
const game = {
  speed: 4, env: { night: 0 },
  renderer: { scene, worldToScreen: () => ({ x: 0, y: 0 }) },
  view: { smoke: { emit() {} } },
  _ev: {},
  on(e, f) { (this._ev[e] ||= []).push(f); },
  emit(e, d) { events[e] = (events[e] || 0) + 1; for (const f of this._ev[e] || []) f(d); },
};
const w = World.createNew({ N: 48, seed: 4242, name: 'Testbury' });
ok([...w.buildings.values()].some(b => b.type === 'builder'), "new towns start with a builder's yard");
growDemoTown(w, 99, 1);
ok([...w.buildings.values()].some(b => b.type === 'terrace' || b.type === 'shophouse'), 'demo town has joined buildings');
ok([...w.buildings.values()].some(b => Math.abs(Math.sin(2 * b.a)) > 0.05), 'and buildings that stand at angles other than the four ways');
game.world = w;
game.paths = new PathFinder(w);
game.sim = new Sim(game);
game.transit = new Transit(game);
game.sim.seedFounders();
game.agents = new Agents(game);
game.construction = new Construction(game);
game.on('day', () => game.transit.planCarts());
const step = (dt) => { const g = game.sim.update(dt); game.agents.update(dt, g); game.construction.update(dt, g); game.transit.update(dt); return g; };
game.transit.rebuild();
game.transit.planCarts();
const pop0 = w.population;
ok(pop0 > 10, `demo town seeded with ${pop0} villagers`);

// add a coach line between stops along the roads, well apart
const stops = [];
for (let k = 0; k < 3; k++) {
  const b = near(w, 'coachstop', null, { r: 22, test: (x, z) => stops.every(s => Math.hypot(s.x - x, s.z - z) >= 8) });
  if (b) stops.push(b);
}
w.money += 1000;
const line = game.transit.createLine('coach', stops.map(s => s.id));
ok(line.ok && stops.length >= 2, `coach line created through ${stops.length} stops (${line.reason || 'ok'})`);
game.transit.rebuild();

let maxWalkers = 0, frames = 0;
const startDay = w.day;
while (w.day < startDay + 6 && frames < 40000) {
  step(0.1);
  maxWalkers = Math.max(maxWalkers, game.agents.walkers.size);
  frames++;
}
ok(w.day >= startDay + 6, `ran 6 days in ${frames} frames`);
ok(maxWalkers > 5, `villagers walked about (peak ${maxWalkers} on screen)`);
ok((events.coins || 0) > 0, `shops / fares earned coins (${events.coins} payouts, ${w.stats.visitIncome} coins)`);
const st = game.transit.stats[line.line?.id] || { riders: 0 };
console.log('      coach riders:', st.riders, ' population:', pop0, '→', w.population, ' money:', Math.round(w.money), ' happiness:', Math.round(game.sim.happiness));
ok(game.transit.vehicles.length === 1, 'one coach on the line');
{
  // the happiness breakdown shown to the player must add up to the real score
  const homes = [...w.buildings.values()].filter(b => b.factors && b.factors.parts);
  const off = homes.filter(b => {
    const sum = b.factors.parts.reduce((n, p) => n + p[1], 0);
    return Math.abs(Math.max(0, Math.min(100, Math.round(sum))) - b.happiness) > 1;
  });
  ok(homes.length > 0 && !off.length, `happiness breakdowns add up (${homes.length} homes${off.length ? `, ${off.length} off` : ''})`);
}

// A building that needs track (a station) beside rail edge e at s, on one
// side of it (1 or -1), its back to the track and a street of its own in
// front: the building, or null.
function byTrack(tw, type, e, s, side) {
  const [x, z, , dx, dz] = pointAt(e.pts, e.cum, s), nx = -dz * side, nz = dx * side;
  const [W, D] = sizeOf(type), r0 = 0.3 + D + SETBACK, h = W / 2 + 0.5;
  street(tw, [[x + nx * r0 - dx * h, z + nz * r0 - dz * h], [x + nx * r0 + dx * h, z + nz * r0 + dz * h]]);
  const r = tw.placeBuilding(type, x + nx * (0.3 + D / 2), z + nz * (0.3 + D / 2), { instant: true, a: Math.atan2(nx, nz) });
  if (!r.ok) console.log('      (by the track:', r.reason + ')');
  return r.ok ? r.building : null;
}
// points round a circle from angle t0 to t1 (radians, x = sin, z = cos)
const arc = (cx, cz, R, t0, t1, n) => Array.from({ length: n + 1 }, (_, i) => { const t = t0 + ((t1 - t0) * i) / n; return [cx + R * Math.sin(t), cz + R * Math.cos(t)]; });

// 3b. railway: trains never reverse, so a dead-end line is refused and a
// loop of track (laid as curves) runs forward forever
await block('3b railway', async () => {
  w.setSandbox({ infiniteMoney: true, unlockAll: true });
  const o = openBox(w, 16, 13, { x: 10, z: 10 }, 1.2);
  if (!o) { console.log('      (no room for a rail loop on this map)'); return; }
  levelBox(w, o.x, o.z, 16, 13);
  const cx = o.x + 8, cz = o.z + 6.5, zt = cz - 2, zb = cz + 2;
  const lay = (pts) => { const r = w.placeRail(pts); if (!r.placed) throw new Error('track: ' + r.failed); };
  const edgeNear = (x, z) => w.rails.nearest(x, z, 0.4).e;
  // a station by the track near (x, z), on its north side (dir -1) or south (1)
  const stationAt = (x, z, dir) => { const h = w.rails.nearest(x, z, 0.4), e = h.e, p = pointAt(e.pts, e.cum, h.s); return byTrack(w, 'station', e, h.s, Math.sign(p[3] * dir) || 1); };
  // the top of the loop, and a spur off it: a dead end a train would have to back out of
  lay([[cx - 4, zt], [cx + 4, zt]]);
  const s1 = stationAt(cx - 2, zt, -1);
  lay([[cx + 1, zt], [cx + 3.5, zt - 2.5]]);
  const spur = edgeNear(cx + 2.4, zt - 1.4);
  const sp = pointAt(spur.pts, spur.cum, spur.len * 0.6), s2tmp = byTrack(w, 'station', spur, spur.len * 0.6, sp[3] > 0 ? -1 : 1);
  ok(s1 && s2tmp && s1.rail && s2tmp.rail && Math.abs(wrapAngle(s2tmp.a - s1.a)) > 0.5, 'stations stand beside the track, square to it whichever way it runs');
  const dead = game.transit.createLine('rail', [s1.id, s2tmp.id]);
  ok(!dead.ok && /reverse/.test(dead.reason), `dead-end line refused ("${dead.reason}")`);
  w.removeBuilding(s2tmp.id);
  w.removeRailEdge(spur.id);
  ok(w.rails.edges.size === 1, `taking the spur up leaves the line one stretch of track again (${w.rails.edges.size})`);
  // close the loop: round the end, back along the bottom and round the other end
  lay([...arc(cx + 4, cz, 2, PI, 0, 12), ...Array.from({ length: 7 }, (_, i) => [cx + 3 - i, zb]), ...arc(cx - 4, cz, 2, 0, -PI, 12)]);
  const s2 = stationAt(cx + 2, zb, 1);
  const rl = game.transit.createLine('rail', [s1.id, s2.id]);
  ok(rl.ok, `loop line created (${rl.reason || 'ok'})`);
  game.transit.rebuild();
  const v = game.transit.vehicles.find(v => v.line.mode === 'rail');
  const L = v.route.length;
  const visited = new Set();
  let backwards = 0, laps = 0, minGap = Infinity, maxGap = 0, prev = v.s;
  for (let i = 0; i < 6000; i++) {
    step(0.05);
    const ds = ((v.s - prev) + L) % L;
    if (ds > L / 2) backwards++;
    if (v.s < prev - L / 2) laps++;
    prev = v.s;
    if (v.state === 'dwell') visited.add(v.next);
    const p0 = v.meshes[0].position, p1 = v.meshes[1].position;
    const gap = Math.hypot(p0.x - p1.x, p0.z - p1.z);
    minGap = Math.min(minGap, gap); maxGap = Math.max(maxGap, gap);
  }
  ok(backwards === 0, `train only ever moves forward (${laps} laps of a ${L.toFixed(1)}-unit loop)`);
  ok(laps >= 1, 'train completes laps of the loop');
  ok(visited.size === 2, `train calls at both stations (${[...visited].join(', ')})`);
  ok(minGap > 0.4 && maxGap < 0.62, `cars stay coupled round the curves (gap ${minGap.toFixed(2)}–${maxGap.toFixed(2)})`);
  w.setSandbox({ infiniteMoney: false, unlockAll: false });
  ok(Number.isFinite(w.money), 'sandbox can be switched off again');
});
w.setSandbox({ infiniteMoney: false, unlockAll: false });

// 3b2. gondolas: a line runs straight between two stations over whatever lies
// between, its pylons on open ground and its cabins clear of the roofs; the
// cabins go round and round, evenly spaced, calling at both stations and
// carrying riders; the line saves and loads, and goes with a station
await block('3b2 gondolas', async () => {
  w.setSandbox({ infiniteMoney: true, unlockAll: true });
  // how many buildings stand under the straight line between two points
  const under = (a, b) => {
    const seen = new Set(), L = Math.hypot(b.x - a.x, b.z - a.z);
    for (let u = 0; u <= L; u += 0.25) {
      const o = w.buildingAt(a.x + ((b.x - a.x) * u) / L, a.z + ((b.z - a.z) * u) / L);
      if (o && o !== a && o !== b) seen.add(o.id);
    }
    return seen.size;
  };
  const th = seatOf(w);
  const A = near(w, 'gondola', th, { r: 12 });
  // the far station: 14 or more away over at least three roofs, among
  // homes, where the walk round by the streets is the longest for the way
  // straight across (so the cable saves the most)
  const { walkCost } = await import('../src/sim/agents.js');
  const spots = [];
  if (A) findPlot(w, 'gondola', A, { r: 30, opts: { ignoreMoney: true }, test: (x, z, a, chk) => {
    if (Math.hypot(x - A.x, z - A.z) < 14 || under(A, { x, z }) < 3 || w.buildingsNear(x, z, 3.5).filter(b => b.access && b.connected).length < 3) return false;
    if (!chk) return spots.length < 60;
    if (chk.access && chk.access.conn) spots.push({ x, z, a, access: chk.access });
    return false;
  } });
  let best = null;
  for (const sp of spots) {
    const way = game.paths.road(A.access, sp.access), k = way ? walkCost(w, way) / Math.hypot(sp.x - A.x, sp.z - A.z) : 0;
    if (way && (!best || k > best.k)) best = { ...sp, k };
  }
  const B = best && w.placeBuilding('gondola', best.x, best.z, { a: best.a, instant: true }).building;
  if (!A || !B) { console.log('      (no room for a gondola line on this map)'); if (A) w.removeBuilding(A.id, 0); return; }
  const gl = game.transit.createLine('gondola', [A.id, B.id]);
  ok(gl.ok && gl.line.name === 'Red Line', `gondola line created over ${under(A, B)} buildings, ${Math.hypot(B.x - A.x, B.z - A.z).toFixed(1)} units (${gl.reason || gl.line.name})`);
  game.transit.setVehicles(gl.line.id, 4);
  game.transit.rebuild();
  const r = game.transit.routes.get(gl.line.id);
  const pylons = r.legs.flatMap(l => l.pylons);
  ok(pylons.length >= 1 && pylons.every(p => { const o = w.buildingAt(p.x, p.z); return game.transit._pylonSpot(p.x, p.z) >= 0 && (!o || BUILDINGS[o.type].park) && p.h - p.g <= 6.001; }), `its ${pylons.length} pylon(s) stand where there is room (open ground, a field, a park or a road's verge), at most 6 high`);
  let worst = Infinity;
  r.pts.forEach(([x, z], i) => {
    if (Math.hypot(x - A.x, z - A.z) < 0.7 || Math.hypot(x - B.x, z - B.z) < 0.7) return;
    const o = w.buildingAt(x, z);
    if (o) worst = Math.min(worst, r.ys[i] - G_HANG - game.transit._topOf(o));
  });
  ok(worst > 0, `the cabins clear every roof under the line (the closest by ${worst.toFixed(2)})`);
  ok(r.marks.length === 2 && r.wheels.length === 2 && game.transit.cables.has(gl.line.id), 'it turns round a bullwheel at each end, with its cable drawn');
  // send villagers on trips from near one station to near the other that
  // are quicker by gondola than on foot, as the streets go
  const by = (S) => [...w.buildings.values()].filter(b => b !== A && b !== B && b.access && b.connected && isOpen(b) && Math.hypot(b.x - S.x, b.z - S.z) <= 6);
  const trips = [];
  for (const f of by(A)) for (const t of by(B)) {
    if (trips.length >= 3) break;
    const way = game.paths.road(f.access, t.access);
    const p = way && game.transit.plan(f, t, walkCost(w, way));
    if (p && p.line === gl.line) trips.push([f, t]);
  }
  const sent = [...w.residents.values()].filter(x => x.loc === 'in').slice(0, trips.length);
  sent.forEach((r, i) => { r.at = trips[i][0].id; game.agents.go(r, trips[i][1].id); });
  const rode = new Set();
  const cabins = game.transit.vehicles.filter(v => v.line === gl.line);
  const L = r.length, prev = cabins.map(v => v.s), called = new Set();
  let backwards = 0, minGap = Infinity;
  for (let i = 0; i < 5000; i++) {
    step(0.05);
    cabins.forEach((v, k) => {
      if (((v.s - prev[k]) + L) % L > L / 2) backwards++;
      prev[k] = v.s;
      if (v.state === 'dwell') called.add(v.route.marks[v.next].stop);
    });
    const ss = cabins.map(v => v.s).sort((a, b) => a - b);
    for (let k = 0; k < ss.length; k++) minGap = Math.min(minGap, ((ss[(k + 1) % ss.length] - ss[k]) + L) % L);
    for (const r of sent) if (r.loc === 'ride' && game.transit.lineNameOf(r) === gl.line.name) rode.add(r.id);
  }
  const gs = game.transit.stats[gl.line.id] || { riders: 0, fares: 0 };
  ok(cabins.length === 4 && backwards === 0 && called.size === 2, `4 cabins run round the line, never backwards, calling at both stations`);
  ok(minGap > L / 8, `the cabins stay spread out (closest ${minGap.toFixed(1)} of ${(L / 4).toFixed(1)} units apart)`);
  ok(trips.length && rode.size === sent.length && gs.riders >= sent.length && gs.fares > 0, `villagers sent where the gondola is quicker than the streets ride it (${rode.size} of ${sent.length}; ${gs.riders} riders in all, $${gs.fares} in fares)`);
  // a trip to the top of a hill, the station up there with it: walking it
  // takes the climb as well, the gondola climbs for them
  {
    const lo = { x: A.x + 1, z: A.z, baseY: A.baseY }, up = 4, was = B.baseY;
    B.baseY = was + up;
    const hi = { x: B.x + 1, z: B.z, baseY: B.baseY }, flat = (Math.abs(hi.x - lo.x) + Math.abs(hi.z - lo.z)) * 1.2, hill = flat + CONFIG.CLIMB * up;
    const p = game.transit.plan(lo, hi, hill);
    B.baseY = was;
    ok(p && p.line === gl.line && p.cost < flat, `a trip up a hill takes the gondola: walking it is ${hill.toFixed(0)} units' worth, climbing counted, by gondola ${p ? p.cost.toFixed(0) : '-'}`);
  }
  const back = deserialize(JSON.parse(JSON.stringify(serialize(w))));
  const bl = back.lines.find(l => l.id === gl.line.id);
  const t2 = new Transit({ world: back, renderer: { scene }, paths: new PathFinder(back), view: null, emit() {}, on() {} });
  t2.rebuild();
  ok(bl && bl.mode === 'gondola' && bl.vehicles === 4 && t2.routes.get(bl.id) && t2.vehicles.filter(v => v.line === bl).length === 4, 'a gondola line saves and loads, cabins and all');
  w.removeBuilding(B.id);
  game.transit.rebuild();
  ok(gl.line.broken && !game.transit.vehicles.some(v => v.line === gl.line) && !game.transit.cables.has(gl.line.id), 'demolishing a station takes the line out of service, cable and cabins');
  game.transit.deleteLine(gl.line.id);
  w.removeBuilding(A.id);
});
w.setSandbox({ infiniteMoney: false, unlockAll: false });

// 3b3. gondolas up the mountainside, from beside the town hall on the valley
// floor to the highest flat ground up the escarpment: no span steeper than a
// cabin can hang under, the cable clear of every cabin's roof all the way
await block('3b3 mountain gondolas', async () => {
  let lines = 0, steepest = 0, closest = Infinity;
  for (let s = 1; s <= 8; s++) {
    const mw = World.createNew({ N: 64, seed: s * 1009, name: 'T', relief: 'mountains' });
    mw.setSandbox({ infiniteMoney: true, unlockAll: true, instantBuild: true });
    const mg = { speed: 1, env: { night: 0 }, renderer: { scene }, view: { smoke: { emit() {} } }, _ev: {}, on(e, f) { (this._ev[e] ||= []).push(f); }, emit(e, d) { for (const f of this._ev[e] || []) f(d); }, world: mw };
    mg.paths = new PathFinder(mw); mg.sim = new Sim(mg); mg.transit = new Transit(mg);
    const th = seatOf(mw), t = mw.terrain;
    const lo = near(mw, 'gondola', th, { r: 6, test: (x, z) => Math.hypot(x - th.x, z - th.z) > 2 });
    if (!lo) continue;
    let hi = null, top = 0;
    for (let z = 3; z < mw.N - 3; z++) for (let x = 3; x < mw.N - 3; x++) {
      const h = t.tileAvg(x, z), d = Math.hypot(x + 0.5 - lo.x, z + 0.5 - lo.z);
      if (h > top && d > 9 && d < 18 && t.slope(x, z) < 0.3 && t.slope(x, z + 1) < 0.3 && t.slope(x - 1, z + 1) < 0.3 && t.slope(x + 1, z + 1) < 0.3) { top = h; hi = [x + 0.5, z + 0.5]; }
    }
    if (!hi) continue;
    // a street of its own up there, in front of the station
    if (!mw.placeRoad([[hi[0] - 1.2, hi[1] + 1], [hi[0] + 1.2, hi[1] + 1]], 1).placed) continue;
    const up = mw.placeBuilding('gondola', hi[0], hi[1], { instant: true });
    const ln = up.ok ? mg.transit.createLine('gondola', [lo.id, up.building.id]) : { ok: false };
    if (!ln.ok) continue;
    mg.transit.rebuild();
    const r = mg.transit.routes.get(ln.line.id);
    if (!r) continue;
    lines++;
    for (const leg of r.legs) for (let i = 0; i + 1 < leg.sup.length; i++) steepest = Math.max(steepest, Math.abs(leg.sup[i + 1].s.h - leg.sup[i].s.h) / (leg.sup[i + 1].u - leg.sup[i].u));
    closest = Math.min(closest, mg.transit.cabinClearance(r).clear);
  }
  ok(lines >= 6 && steepest <= 1.001 && closest > 0.005, `gondolas up the mountainside (${lines} lines): no span steeper than one in one (the steepest ${steepest.toFixed(2)}), the cable over every cabin's roof all the way (by ${closest.toFixed(3)} at the closest)`);
});

// 3c. animals keep out of buildings and stay in their habitat
await block('3c animals', async () => {
  const animals = new Animals(game);
  const counts = {};
  for (const a of animals.list) counts[a.sp] = (counts[a.sp] || 0) + 1;
  ok(animals.list.length > 5, `animals spawned: ${JSON.stringify(counts)}`);
  let bad = 0;
  const check = () => {
    for (const a of animals.list) {
      const b = w.buildingAt(a.x, a.z), water = w.waterAt(a.x, a.z);
      if (a.sp === 'duck') { if (!water) bad++; }
      else if (a.farm != null) { if (!b || b.id !== a.farm) bad++; }
      else if (b || water) bad++;
    }
  };
  for (let i = 0; i < 1500; i++) {
    game.sim.update(0.05); game.agents.update(0.05, 0.05); animals.update(0.05, 4);
    if (i % 25 === 0) check();
  }
  ok(bad === 0, `no animal walked into a building or out of its habitat (${bad} violations)`);
  // build right on top of a wild animal: it should be moved out of the way
  const wild = animals.list.find(a => a.farm == null && a.sp !== 'duck' && clearAt(w, a.x - 1.5, a.z - 0.8, 3, 2.6, 0.8));
  if (wild) {
    w.setSandbox({ infiniteMoney: true, unlockAll: true });
    street(w, [[wild.x - 1.2, wild.z + 1], [wild.x + 1.2, wild.z + 1]]);
    const r = w.placeBuilding('house', wild.x, wild.z, {});
    for (let i = 0; i < 30; i++) animals.update(0.05, 1);
    ok(r.ok && (!animals.list.includes(wild) || w.buildingAt(wild.x, wild.z) === null), `animal under a new building steps aside (${r.reason || 'built'})`);
    w.setSandbox({ infiniteMoney: false, unlockAll: false });
  } else console.log('      (no open ground round a wild animal to build on)');
});

// 3d. construction: builders walk out, work on site, and finish the job
// (a free plot along the town's streets, on the roads to the way out: { x, z, a })
const freeSpot = (W = 1, D = 1, skip = []) => findPlot(w, 'house', seatOf(w), { r: 20, w: W, d: D, opts: { ignoreMoney: true, ignoreUnlock: true }, test: (x, z, a, chk) => skip.every(s => Math.hypot(s.x - x, s.z - z) > 1.5) && (!chk || !!(chk.access && chk.access.conn)) });
const runUntil = (pred, days = 6) => {
  const end = w.day + days;
  let peak = 0;
  while (w.day < end) {
    step(0.1);
    for (const c of game.construction.crew.values()) peak = Math.max(peak, c.onSite);
    if (pred()) return { ok: true, peak };
  }
  return { ok: false, peak };
};
await block('3d construction', async () => {
  w.money = 1e6;
  // founders are random: make sure the builder's yard has a builder
  const yard = [...w.buildings.values()].find(b => BUILDINGS[b.type].builders);
  if (yard && ![...w.residents.values()].some(r => r.job === yard.id)) {
    const hand = [...w.residents.values()].find(r => r.age === 'adult');
    if (hand) { hand.job = yard.id; game.sim.recompute(); }
  }
  const spot = freeSpot();
  const r = w.placeBuilding('house', spot.x, spot.z, { a: spot.a });
  ok(r.ok && r.building.con && r.building.con.kind === 'build', 'a new cottage starts as a building site');
  // hired hands start every site at once; make this one big enough that the
  // town's builders, on their slow walk from the yard, get there before
  // the hands finish it
  r.building.con.work *= 20;
  const t0 = w.day * 24 + w.hours;
  const res = runUntil(() => !r.building.con);
  const took = w.day * 24 + w.hours - t0;
  ok(res.ok && res.peak > 0, `builders put it up on site (peak ${res.peak} on site, ${took.toFixed(1)} game hours)`);
  ok(took > 2, 'construction takes a while');

  // branching upgrade with a chosen style
  w.setSandbox({ freeUpgrades: true, unlockAll: true });
  const h = r.building;
  h.level = 1;
  const opts = w.upgradeOptions(h);
  ok(opts.length === 2 && opts.map(o => o.type).join() === 'villa,flats', `a Family House can become: ${opts.map(o => o.type).join(' or ')}`);
  const up = w.upgradeBuilding(h.id, 'villa', 'stone');
  ok(up.ok && h.con && h.con.toType === 'villa', 'upgrade to a villa started');
  const res2 = runUntil(() => !h.con);
  ok(res2.ok && h.type === 'villa' && h.level === 0 && h.look === 'stone', `villa finished in stone (${h.type} L${h.level} ${h.look})`);
  // a new style without an upgrade: paid for, and a job for the builders
  {
    const m0 = w.money, chk = w.restyleCheck(h, 'brick');
    const rr = w.restyleBuilding(h.id, 'brick');
    ok(chk.ok && rr.ok && w.money === m0 - chk.cost && chk.cost === Math.max(30, Math.round(w.buildValue(h) * 0.3)) && h.con && h.con.restyle && h.type === 'villa' && h.level === 0, `restyling without an upgrade costs $${chk.cost} and starts a job`);
    ok(runUntil(() => !h.con).ok && h.look === 'brick' && h.type === 'villa' && h.level === 0, 'builders restyle it in brick, same building and level');
    ok(!w.restyleBuilding(h.id, 'brick').ok, 'restyling to the style it has already is refused');
  }

  // a site the player puts first gets the builders before an older one
  {
    const { runCommand } = await import('../src/commands.js');
    const sa = freeSpot(), A = w.placeBuilding('house', sa.x, sa.z, { a: sa.a }).building;
    const sb = freeSpot(), B = w.placeBuilding('house', sb.x, sb.z, { a: sb.a }).building;
    A.con.work *= 20; B.con.work *= 20;   // so the hired hands don't finish them before the builders come
    const pr = runCommand(game, { t: 'priority', id: B.id, on: true });
    const crew = (b) => game.construction.crew.get(b.id) || { assigned: 0 };
    const got = runUntil(() => crew(A).assigned > 0 || crew(B).assigned > 0);
    ok(pr.ok && B.con && B.con.priority === true && got.ok && crew(B).assigned > 0 && crew(A).assigned === 0, `a site put first gets the builders before an older one (${crew(B).assigned} at it, ${crew(A).assigned} at the older)`);
    ok(deserialize(JSON.parse(JSON.stringify(serialize(w)))).buildings.get(B.id).con.priority === true, "saves keep a site's priority");
    ok(!runCommand(game, { t: 'priority', id: h.id, on: true }).ok && !runCommand(game, { t: 'priority', id: B.id, on: 'yes' }).ok, 'only a building site can be put first, and only by a yes or no');
    ok(runUntil(() => !A.con && !B.con).ok, 'both sites get finished');
  }

  // joining two neighbours
  let pr2 = null;
  for (const a of w.buildings.values()) {
    if (a.con) continue;
    const m = w.mergeOptions(a).find(m => m.type === 'terrace' || m.type === 'shophouse');
    if (m) { pr2 = [a, m]; break; }
  }
  if (!pr2) {
    // (the demo town may have joined every pair already: two cottages side by side)
    const P = pair(w, 'house', 'house');
    const m = P && w.mergeOptions(P[0]).find(m => m.other === P[1]);
    if (m) pr2 = [P[0], m];
  }
  if (pr2) {
    const [a, m] = pr2;
    const people = [...w.residents.values()].filter(r => r.home === a.id || r.home === m.other.id).length;
    const mr = w.mergeBuildings(a.id, m.other.id);
    const nb = mr.building;
    ok(mr.ok && nb.w * nb.d === 2 && !w.buildings.has(a.id), `joined into a ${m.name} on a ${nb.w}×${nb.d} plot`);
    const kept = [...w.residents.values()].filter(r => r.home === nb.id).length;
    ok(kept === people, `everyone moved in (${kept}/${people})`);
    ok(runUntil(() => !nb.con).ok, 'builders finished the joined building');
  } else ok(false, 'no pair of neighbours to join');

  // moving a house: taken down, carted over, rebuilt (turned to its new street)
  const home = [...w.buildings.values()].find(b => b.type === 'house' && !b.con && b.residents.length);
  const dest = freeSpot(1, 1, [home]);
  const who = home.residents.slice();
  const mv = w.moveBuilding(home.id, dest.x, dest.z, { a: dest.a });
  ok(mv.ok && home.con && home.con.kind === 'dismantle' && mv.building.con.wait === 'dismantle', `move: old house is being taken down (${mv.reason || 'ok'})`);
  ok(mv.ok && Math.abs(wrapAngle(mv.building.a - dest.a)) < 0.002, 'and goes up again facing its new street');
  ok(who.every(id => w.residents.get(id)?.home === mv.building.id), 'the household now belongs to the new plot');
  let sawHaul = false;
  const res3 = runUntil(() => { if (mv.building.con && mv.building.con.wait === 'haul') sawHaul = true; return !mv.building.con; }, 8);
  ok(res3.ok && !w.buildings.has(home.id), `moved house rebuilt on its new plot (old plot cleared, cart ${sawHaul ? 'used' : 'skipped'})`);

  // land deals never make plots overlap
  w.setSandbox({ instantBuild: true });
  let deals = 0;
  for (let k = 0; k < 6; k++) w.encroachPass();
  for (const b of w.buildings.values()) deals += (b.leases || []).filter(l => l.buyer).length;
  if (!deals) {
    // make one: a villa next to a cottage
    for (const b of [...w.buildings.values()]) {
      if (b.type !== 'house' || b.con) continue;
      for (const side of [1, -1]) {
        const [x, z] = besideAt(b, 'villa', side);
        if (!w.checkBuild('villa', x, z, { a: b.a, ignoreMoney: true, ignoreUnlock: true }).ok) continue;
        const v = w.placeBuilding('villa', x, z, { a: b.a, ignoreUnlock: true });
        if (v.ok) w.tryEncroach(v.building);
        break;
      }
      deals = [...w.buildings.values()].reduce((n, x) => n + (x.leases || []).filter(l => l.buyer).length, 0);
      if (deals) break;
    }
  }
  const all = [...w.buildings.values()], rects = all.map(plotOf);
  ok(all.some(b => b.front > 0), `buildings come forward to the street (${all.filter(b => b.front > 0).length})`);
  let overlaps = 0;
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (rectsOverlap(rects[i], rects[j], 0.004)) overlaps++;
  ok(deals > 0, `big homes bought garden land (${deals} deal${deals === 1 ? '' : 's'})`);
  ok(overlaps === 0, `no two plots overlap after land deals (${overlaps})`);
  w.setSandbox({ freeUpgrades: false, unlockAll: false, instantBuild: false });
});
w.setSandbox({ freeUpgrades: false, unlockAll: false, instantBuild: false });

// 3d0. combination joins: every pairing in every recipe yields its building,
// and no earlier recipe takes a pair meant for a later one (in a fresh town
// with long streets, so there is room for every pair)
await block('3d0 joins', async () => {
  const { MERGES } = await import('../src/defs.js');
  const tw = World.createNew({ N: 64, seed: 31, name: 'Joinbury' });
  tw.setSandbox({ infiniteMoney: true, unlockAll: true, instantBuild: true });
  const pairs = [];
  for (const m of MERGES) for (const ta of m.a) for (const tb of m.b) pairs.push([ta, tb, m.to]);
  const wrong = [];
  for (const [ta, tb, to] of pairs) {
    const P = pair(tw, ta, tb);
    const r = P ? tw.mergeBuildings(P[0].id, P[1].id) : { ok: false, reason: 'no room' };
    if (!r.ok || r.building.type !== to) wrong.push(`${ta} + ${tb} → ${r.ok ? r.building.type : r.reason} (not ${to})`);
  }
  ok(!wrong.length, `every pairing in every join recipe makes its building (${pairs.length} pairs, ${MERGES.length} recipes)${wrong.length ? ': ' + wrong.join('; ') : ''}`);
  // and only between neighbours standing square to each other, side by side
  const P = pair(tw, 'house', 'house');
  ok(P && tw.mergeOptions(P[0]).some(m => m.other === P[1]), 'two cottages side by side can join');
  const spot = { x: P[1].x, z: P[1].z, a: P[1].a };
  tw.removeBuilding(P[1].id, 0);
  const [ox, oz] = toWorld(rect(spot.x, spot.z, spot.a, 0.5, 0.5), -0.12, 0);
  const skew = tw.placeBuilding('house', ox, oz, { instant: true, a: spot.a + 0.2 });
  ok(skew.ok && !tw.mergeOptions(P[0]).some(m => m.other === skew.building), `...but not with one beside it turned askew (${skew.reason || 'turned 0.2'})`);
});

// 3d0d. a tea garden lifts the street round it and sells tea; a free library
// joined from a stationer and a school adds to research once it's staffed
await block('3d0d tea garden and library', async () => {
  const { RESEARCH_SOURCES, tradesOf } = await import('../src/defs.js');
  const tw = World.createNew({ N: 48, seed: 35, name: 'Teaby' });
  tw.setSandbox({ infiniteMoney: true, unlockAll: true, instantBuild: true });
  const tg = listen(tw);
  const sim = new Sim(tg);
  sim.seedFounders();
  const [Co, Gr] = pair(tw, 'coffeehouse', 'garden');
  const [fx, fz] = toWorld(ownPlot(Co), 0, Co.d / 2 + 1.2), i = cellOf(tw.N, fx, fz);
  sim.recompute();
  const before = sim.appeal[i];
  const t = tw.mergeBuildings(Co.id, Gr.id);
  sim.recompute();
  ok(t.ok && t.building.type === 'teagarden' && tradesOf(t.building).includes('tea') && sim.appeal[i] > before, `a coffee house and a green make a Tea Garden that sells tea and lifts the street (appeal ${before.toFixed(1)} → ${sim.appeal[i].toFixed(1)})`);
  // the library goes on the town's own street, so it is connected and staffed
  const [St, Sc] = pair(tw, 'stationer', 'school');
  const lib = tw.mergeBuildings(St.id, Sc.id).building;
  for (const r of [...tw.residents.values()].filter(r => r.age === 'adult').slice(0, 2)) { r.job = lib.id; r.edu = 3; }
  sim.recompute();
  const src = sim.researchSources().find(s => s.name === 'Free Library');
  ok(lib.type === 'library' && lib.connected && RESEARCH_SOURCES.library && src && src.points > 0, `a stationer and a school make a Free Library that adds ${src ? src.points : 0} research a day`);
});

// 3d0c. a builder's yard joined with a woodcutter is still where the builders
// work from, and they work faster; a chapel keeps its look in its vicarage
await block('3d0c yards and vicarage', async () => {
  const tw = World.createNew({ N: 48, seed: 34, name: 'Yardley' });
  tw.setSandbox({ infiniteMoney: true, unlockAll: true, instantBuild: true });
  const [Y, Wd] = pair(tw, 'builder', 'lumber');
  const r = tw.mergeBuildings(Y.id, Wd.id), def = r.ok && BUILDINGS[r.building.type];
  ok(def && def.builders && def.levels[0].rate > BUILDINGS.builder.levels[0].rate && capOf(r.building, 'jobs') >= 6, `a builder's yard and a woodcutter make a ${def && def.levels[0].name} whose builders work at ${def && def.levels[0].rate}×`);
  const [Ch, Co] = pair(tw, 'house', 'chapel');
  const v = tw.mergeBuildings(Ch.id, Co.id);
  ok(v.ok && v.building.type === 'vicarage' && v.building.variant === Co.variant, 'a chapel taking in the cottage next door keeps the chapel\'s look');
});

// 3d0b. a joined building is never a level the town can't build yet, a grand
// home leads when it takes in a cottage, and the join says who must move out
await block('3d0b join levels', async () => {
  const tw = World.createNew({ N: 48, seed: 33, name: 'Clampton' });
  tw.money = 1e6;
  Object.defineProperty(tw, 'unlockPop', { value: 500 });
  tw.research.done.push('carpentry', 'joining', 'masonry', 'stonework', 'architecture', 'homes2', 'homes3', 'brickmaking', 'urban', 'flats');
  const [V, H] = pair(tw, 'villa', 'house');
  V.level = 1;   // a Manor House
  let opt = tw.mergeOptions(V).find(m => m.other === H);
  ok(opt && opt.type === 'mansion' && opt.level === 0, `a Manor House and a cottage make a ${opt && opt.name} until Grand Architecture is researched`);
  tw.research.done.push('pigments', 'paints', 'grandarch');
  opt = tw.mergeOptions(V).find(m => m.other === H);
  ok(opt && opt.level === 1 && opt.name === 'Stately Home', `...and a ${opt && opt.name} after`);
  const r = tw.mergeBuildings(V.id, H.id);
  ok(r.ok && r.building.variant === V.variant, 'the villa leads: the joined house keeps its look, not the cottage\'s');
  const [F, G] = pair(tw, 'flats', 'flats');
  F.level = G.level = 2;   // two Mansion Blocks, full
  const full = BUILDINGS.flats.levels[2].housing, room = BUILDINGS.apartments.levels[1].housing;
  F.residents = new Array(full).fill(0); G.residents = new Array(full).fill(0);
  tw.research.done.push('steam', 'electricity', 'hydraulics', 'highrise');
  opt = tw.mergeOptions(F).find(m => m.other === G);
  ok(opt && opt.name === 'Grand Apartments' && opt.moveOut === Math.max(0, 2 * full - room), `two full Mansion Blocks (${full} each) joined into the ${opt && opt.name} (${room}) say ${opt && opt.moveOut} must move out`);
  F.residents = []; G.residents = [];
  // ...and when the two hold more than what they become, the ones who won't fit
  const [V2, H2] = pair(tw, 'villa', 'house');
  V2.level = 2; H2.level = 1;   // a Grand Manor and a Family House, full
  const a = BUILDINGS.villa.levels[2].housing, b = BUILDINGS.house.levels[1].housing, into = BUILDINGS.mansion.levels[1].housing;
  V2.residents = new Array(a).fill(0); H2.residents = new Array(b).fill(0);
  const o2 = tw.mergeOptions(V2).find(m => m.other === H2);
  ok(o2 && o2.name === 'Stately Home' && o2.moveOut === a + b - into && o2.moveOut > 0, `a full Grand Manor (${a}) and Family House (${b}) joined into a ${o2 && o2.name} (${into}) say ${o2 && o2.moveOut} must move out`);
  V2.residents = []; H2.residents = [];
});

// 3d0f. farms: the farmyard by the road with fields behind; farmland beyond
// the plot (squares of it at the farm's own angle, touching it, up to a
// limit, priced, blocking building, cleared by the bulldozer and with the
// farm); what a farm produces; a homestead
await block('3d0f farms', async () => {
  const { homeField, aheadOf } = await import('../src/world/world.js');
  const { PRODUCE } = await import('../src/defs.js');
  const { workArea } = await import('../src/render/buildings.js');
  const tw = World.createNew({ N: 48, seed: 61, name: 'Furrowby' });
  tw.setSandbox({ unlockAll: true, instantBuild: true });
  tw.money = 1e5;
  const th = seatOf(tw);
  // (with room behind and beside it for its fields)
  const roomy = (x, z, a) => { const R = rect(x, z, a, 1, 1); return [[-2.5, -0.5], [2.5, -0.5], [-1.5, -1.5], [0.5, -2.5], [-0.5, -2.5]].every(([lx, lz]) => { const [px, pz] = toWorld(R, lx, lz); return !tw.buildingAt(px, pz) && !tw.roadAt(px, pz, 0.3) && !tw.waterAt(px, pz); }); };
  const F = near(tw, 'farm', th, { r: 18, test: (x, z, a) => roomy(x, z, a) });
  ok(!!F, 'found room for a test farm');
  const wk = workArea(F);
  ok((wk[1] + wk[3]) / 2 < 0 && wk[4] && Math.abs(wk[4].a - F.a) < 1e-9, 'its fields lie behind the farmyard, away from the road, in its own frame');
  // squares of land round it, lined up with the farm: beside it and behind it
  const P = ownPlot(F), lattice = [];
  for (let j = -6; j <= 3; j++) for (let i = -6; i <= 6; i++) { const [x, z] = toWorld(P, i * 1 + 0.5 * ((F.w + 1) % 2), j - 0.5 + 0.5 * (F.d % 2)); lattice.push([x, z, F.a]); }
  const [bx, bz] = toWorld(P, 0, -F.d / 2 - 6.5);
  const far = tw.planFields(F.id, [[bx, bz, F.a]], true);
  ok(!far.n && /touch/.test(far.tiles[0].reason || ''), `a field must touch the farm or its fields (${far.tiles[0].reason})`);
  const hf = homeField(F), [hx, hz] = toLocal(P, hf.cx, hf.cz);
  ok(hf && Math.abs(hx) < 1e-6 && hz < 0 && Math.abs(hf.hw * 2 - F.w) < 1e-6 && tw.buildingAt(hf.cx, hf.cz) === F, 'its own field is the back of its plot, one farmland with the fields beyond');
  const ahead = lattice.find(([x, z]) => aheadOf(F, x, z) > 0.5 && !tw.roadAt(x, z, 0.7) && !tw.buildingAt(x, z) && !tw.waterAt(x, z));
  ok(!ahead || /behind and beside/.test(tw._fieldBlock(F, rect(ahead[0], ahead[1], F.a, 0.5, 0.5)) || ''), 'fields go behind and beside a farm, not between it and the road');
  const m0 = tw.money, plan = tw.planFields(F.id, lattice, true), r1 = tw.setFields(F.id, lattice, true);
  ok(r1.ok && F.fields === CONFIG.FIELD_MAX[0] && tw.money === m0 - plan.cost && plan.cost >= CONFIG.FIELD_MAX[0] * CONFIG.FIELD_COST, `a farmstead ploughs up to ${CONFIG.FIELD_MAX[0]} fields at $${CONFIG.FIELD_COST} each ($${plan.cost})`);
  ok(tw.fieldsOf(F.id).every(f => Math.abs(wrapAngle(f.a - F.a)) < 0.002), 'its fields lie at the farm\'s own angle');
  ok(capOf(F, 'jobs') === Math.round(BUILDINGS.farm.levels[0].jobs + F.fields * CONFIG.FIELD_JOBS), `each field adds work (${capOf(F, 'jobs')} jobs)`);
  tw.upgradeBuilding(F.id);
  ok(tw.setFields(F.id, lattice, true).ok && F.fields === CONFIG.FIELD_MAX[1], `a farm works more (${F.fields})`);
  // a field turned askew, touching the others: fine too
  const f0 = tw.fieldsOf(F.id)[0];
  ok(!tw.checkBuild('house', f0.x, f0.z, { a: f0.a }).ok && !tw.checkRoad([[f0.x - 0.45, f0.z], [f0.x + 0.45, f0.z]], 1).ok, 'fields block buildings and roads');
  const n1 = F.fields;
  ok(tw.bulldoze(f0.x, f0.z).ok && F.fields === n1 - 1 && !tw.parcels.has(f0.id), 'the bulldozer takes a field out');
  // a field at an angle of its own, touching the back of the farm
  tw.setFields(F.id, tw.fieldsOf(F.id).map(f => [f.x, f.z, f.a]), false);
  const [kx, kz] = toWorld(P, 0, -F.d / 2 - 0.5 * (Math.cos(0.4) + Math.sin(0.4)) - 0.02);
  const skew = tw.setFields(F.id, [[kx, kz, F.a + 0.4]], true);
  ok(skew.ok && F.fields === 1 && Math.abs(wrapAngle(tw.fieldsOf(F.id)[0].a - F.a - 0.4)) < 0.002, `a field can lie at an angle of its own, where it touches the farmland (${skew.reason || 'ploughed'})`);
  tw.setFields(F.id, lattice, true);
  // what it produces: jobs and earnings
  const sim = new Sim({ world: tw, speed: 0, agents: { relocate() {}, depart() {}, arrive() {} }, _ev: {}, on(e, f) { (this._ev[e] ||= []).push(f); }, emit(e, d) { for (const f of this._ev[e] || []) f(d); } });
  const j0 = capOf(F, 'jobs');
  ok(tw.setProduce(F.id, 'sheep').ok && F.flavor === 'sheep' && capOf(F, 'jobs') === Math.round((BUILDINGS.farm.levels[1].jobs + F.fields * CONFIG.FIELD_JOBS) * PRODUCE.sheep.jobs), `sheep take fewer hands (${j0} → ${capOf(F, 'jobs')})`);
  ok(!tw.setProduce(F.id, 'unicorns').ok && !tw.setProduce(F.id, 'sheep').ok, 'only real produce, and only a change');
  sim.recompute();
  F.working = 1;   // fully staffed, for the sum
  const perWorker = sim.incomeOf(F) / capOf(F, 'jobs');
  ok(perWorker > BUILDINGS.farm.levels[1].income * 1.4, `each shepherd earns more ($${perWorker.toFixed(1)} a worker)`);
  // saved and loaded
  const back = deserialize(JSON.parse(JSON.stringify(serialize(tw))));
  const FB = back.buildings.get(F.id), sig = (W) => [...W.parcels.values()].map(f => `${f.farm}:${f.x},${f.z},${f.a}`).sort().join(' ');
  ok(FB.fields === F.fields && sig(back) === sig(tw) && FB.flavor === 'sheep', 'saves keep the fields, where and how they lie, and what the farm keeps');
  // a homestead: a cottage beside it joined on
  let cot = null;
  for (const [lx, lz] of [[1.5, 0.5], [-1.5, 0.5], [1.5, -0.5], [-1.5, -0.5]]) {
    const [x, z] = toWorld(ownPlot(F), lx, lz);
    // (the field there makes way)
    for (const f of tw.fieldsOf(F.id)) if (rectsOverlap(f.rect, rect(x, z, F.a, 0.5, 0.5), 0.004)) tw.setFields(F.id, [[f.x, f.z, f.a]], false);
    const p = tw.placeBuilding('house', x, z, { instant: true, a: F.a });
    if (p.ok) { cot = p.building; break; }
  }
  if (cot) {
    sim.makeFamily(cot, 3);
    const people = cot.residents.slice();
    const opt = tw.mergeOptions(F).find(m => m.farmJoin && m.other === cot);
    const jr = opt && tw.mergeBuildings(F.id, cot.id);
    ok(jr && jr.ok && F.type === 'homestead' && !tw.buildings.has(cot.id) && people.every(id => tw.residents.get(id).home === F.id) && F.fields > 0 && F.flavor === 'sheep', `a cottage joined on makes it a homestead: the family moves in, the fields and flock stay (${people.length} people)`);
  } else ok(false, 'no room for a cottage beside the farm');
  // a farm turned orchard keeps its fields, planted with fruit trees
  {
    const G = near(tw, 'farm', th, { r: 24, test: (x, z, a) => Math.hypot(x - F.x, z - F.z) >= 10 && roomy(x, z, a) });
    if (G) {
      tw.upgradeBuilding(G.id);
      const GP = ownPlot(G), lat = [];
      for (let j = -4; j <= 2; j++) for (let i = -4; i <= 4; i++) { const [x, z] = toWorld(GP, i + 0.5, j - 0.5); lat.push([x, z]); }
      tw.setFields(G.id, lat, true);
      const n0 = G.fields, u = tw.upgradeBuilding(G.id, 'orchard');
      ok(u.ok && G.type === 'orchard' && n0 > 0 && G.fields === n0 && tw.fieldMax(G) >= n0 && !homeField(G) && !tw.setProduce(G.id, 'sheep').ok, `a farm turned orchard keeps its ${n0} fields (as fruit trees), and grows only fruit`);
    } else ok(false, 'no room for a second farm');
  }
  // gone with the farm
  const id = F.id;
  tw.removeBuilding(id, 0);
  ok(![...tw.parcels.values()].some(f => f.farm === id), 'its fields go with the farm');
});

// 3d0c. shopping trips spread over the trades the town sells: everyday food
// most, the town's only draper still gets the clothes shopping, a trade sold
// only far from home is shopped for less; offices take no shoppers, and a
// shop with homes above sells its own trade
await block('3d0c shopping', async () => {
  const { tradesOf, TRADES } = await import('../src/defs.js');
  const { visitKind } = await import('../src/sim/agents.js');
  const tw = World.createNew({ N: 48, seed: 35, name: 'Shopton' });
  tw.setSandbox({ infiniteMoney: true, unlockAll: true, instantBuild: true });
  const [home, mk] = pair(tw, 'house', 'market');
  const nearby = ['bakery', 'butcher', 'draper'].map(t => pair(tw, t, 'garden', { near: home })[0]);
  let far = null;
  for (let k = 0; k < 40 && !far; k++) {
    const t = (k * 2.4) % (2 * PI), d = 18 + (k % 8);
    const at = { x: home.x + d * Math.sin(t), z: home.z + d * Math.cos(t) };
    if (at.x < 4 || at.z < 4 || at.x > tw.N - 4 || at.z > tw.N - 4) continue;
    const b = lot(tw, 'bank', { near: at });
    if (b && Math.hypot(b.x - home.x, b.z - home.z) >= 16 && Math.hypot(b.x - home.x, b.z - home.z) <= 28) far = b;
    else if (b) tw.removeBuilding(b.id, 0);
  }
  const shops = [mk, ...nearby, far].filter(Boolean);
  const A = { world: tw, _nearest: Agents.prototype._nearest };
  const n = 6000;
  const draws = (list) => { const got = new Map(); for (let i = 0; i < n; i++) { const id = Agents.prototype._shopFor.call(A, { home: home.id }, list); got.set(id, (got.get(id) || 0) + 1); } return got; };
  const got = draws(shops);
  const share = (b) => (got.get(b.id) || 0) / n;
  const [bak, but, dra] = nearby;
  const pct = (b) => `${Math.round(share(b) * 100)}%`;
  ok(shops.every(b => share(b) > 0), `every trade gets shoppers (market ${pct(mk)}, bakery ${pct(bak)}, butcher ${pct(but)}, draper ${pct(dra)}${far ? `, a bank ${Math.hypot(far.x - home.x, far.z - home.z).toFixed(0)} units off ${pct(far)}` : ''})`);
  ok(share(mk) > share(bak) && share(bak) > share(but) && share(but) > share(dra) && share(dra) > 0.05, 'everyday trades are shopped for most, clothes less, but the lone draper still gets its share');
  // (the same bank as if it stood by the house: measured against the draper
  // instead, the far bank's share sat within a percent of the bar wherever
  // the draper's plot fell a few units further off, and 1 run in 5 failed)
  const beside = far && (draws(shops.map(b => (b === far ? { ...b, x: home.x + 1.5, z: home.z } : b))).get(far.id) || 0) / n;
  ok(!far || share(far) < 0.5 * beside, `a trade only sold far from home is shopped for less${far ? ` (the bank ${(share(far) * 100).toFixed(1)}%, ${(beside * 100).toFixed(1)}% were it beside the house)` : ''}`);
  ok(visitKind(BUILDINGS.offices) === null && !tradesOf({ type: 'offices' }).length, 'offices take no shoppers');
  ok(tradesOf({ type: 'shophouse', flavor: 'butcher' }).join() === 'meat' && tradesOf({ type: 'deptstore' }).includes('clothes') && !tradesOf({ type: 'deptstore' }).includes('banking'), 'a shophouse sells its own trade, a department store every trade but banking');
});

// 3d0d. somewhere to play: a home with children and a play area in reach is
// happier for it, one without children isn't asked, and children mostly
// head for somewhere to play
await block('3d0d play', async () => {
  const tw = World.createNew({ N: 48, seed: 37, name: 'Playford' });
  tw.setSandbox({ infiniteMoney: true, unlockAll: true, instantBuild: true });
  const [home, pg] = pair(tw, 'house', 'playground');
  const [other, gd] = pair(tw, 'house', 'garden');
  const kid = { id: tw.newId(), first: 'Pip', last: 'Swing', age: 'child', years: 8, edu: 0, home: home.id, job: null, look: 12345, mood: 60 };
  tw.residents.set(kid.id, kid); home.residents.push(kid.id);
  const sim = new Sim(listen(tw));
  const play = (b) => { sim.recompute(); sim._happiness(); const p = b.factors.parts.find(q => q[0] === 'play'); return p ? p[1] : null; };
  ok(play(home) === 4 && play(other) === null, 'a home with a child beside a play area gets +4 for somewhere to play; a home without children isn\'t asked');
  const A = { world: tw, _nearest: Agents.prototype._nearest, _shopFor: Agents.prototype._shopFor, _places: Agents.prototype._places, _candidates: (pred) => [...tw.buildings.values()].filter(b => pred(BUILDINGS[b.type], b)) };
  let toPlay = 0, outings = 0;
  for (let i = 0; i < 400; i++) { Agents.prototype.planDay.call(A, kid, null); for (const p of kid.plan) if (p.dest === pg.id || p.dest === gd.id) { outings++; if (p.dest === pg.id) toPlay++; } }
  ok(outings > 100 && toPlay / outings > 0.6, `children mostly head for somewhere to play (${Math.round((toPlay / outings) * 100)}% of ${outings} outings to the play area, the rest to the garden)`);
  tw.removeBuilding(pg.id, 0);
  ok(play(home) === 0, 'without the play area the home misses it');
});

// 3d1a. taking the land beside or behind a building leaves it where it
// stood: same place, same turn, same floor, before and after a save (which
// rounds the ground heights a little)
await block('3d1a taking land stays put', async () => {
  const tw = World.createNew({ N: 48, seed: 39, name: 'Stayput' });
  tw.setSandbox({ infiniteMoney: true, unlockAll: true, instantBuild: true });
  const B0 = lot(tw, 'bakery', { left: 1.3, right: 1.3, back: 1.3 });
  const spot = { x: B0.x, z: B0.z, a: B0.a };
  tw.removeBuilding(B0.id, 0);
  // where its front door is in the world, from its model
  const doorAt = (b) => {
    const d = buildModel(b).door, th = b.a;
    return [b.x + d.x * Math.cos(th) + d.z * Math.sin(th), b.z - d.x * Math.sin(th) + d.z * Math.cos(th), b.baseY];
  };
  const tried = [], moved = [];
  for (let k = 0; k < 4; k++) {
    for (const variant of [16, 48]) {   // both ends a seed would pick
      const r = tw.placeBuilding('bakery', spot.x, spot.z, { instant: true, variant, a: spot.a });
      if (!r.ok) continue;
      const b = r.building, before = doorAt(b);
      const opt = tw.expandOptions(b).find(o => o.dir === k && o.kind === 'land');
      if (opt && tw.expandBuilding(b.id, k, 'land').ok) {
        const after = doorAt(b);
        const w2 = deserialize(JSON.parse(JSON.stringify(serialize(tw))));
        const loaded = doorAt(w2.buildings.get(b.id));
        const off = Math.max(...before.map((v, i) => Math.max(Math.abs(v - after[i]), Math.abs(v - loaded[i]))));
        tried.push(`${opt.where} v${variant}`);
        if (off > 2e-3) moved.push(`${opt.where} v${variant} by ${off.toFixed(3)}`);
      }
      tw.removeBuilding(b.id, 0);
    }
  }
  ok(tried.length >= 4 && !moved.length, `taking land leaves the building where it stood (${tried.join(', ')})${moved.length ? ': moved ' + moved.join('; ') : ''}`);
});

// 3d1b. ...and where the street ends beside it, the grown plot doesn't come
// forward over the neighbour in front of its new land (only the building
// itself does, over its own street)
await block('3d1b street end', async () => {
  const { auditTown } = await import('./audit.js');
  const tw = World.createNew({ N: 48, seed: 41, name: 'Streetend' });
  tw.setSandbox({ infiniteMoney: true, unlockAll: true, instantBuild: true });
  const o = openBox(tw, 7, 5, { x: 14, z: 14 });
  levelBox(tw, o.x, o.z, 7, 5);
  // a street along z = Z ending at X + 0.5, the bakery behind its end; a
  // neighbour past the end that faces another street
  const X = o.x + 3, Z = o.z + 2;
  street(tw, [[o.x + 0.3, Z], [X + 0.5, Z]]);
  street(tw, [[X + 0.75, Z - 1], [X + 3, Z - 1]]);
  const a = tw.placeBuilding('bakery', X, Z + SETBACK + 0.5, { instant: true, a: PI });
  const c = tw.placeBuilding('bakery', X + 1.25, Z, { instant: true, a: PI });
  const A = a.ok ? a.building : null, C = c.ok ? c.building : null;
  ok(A && C, `a bakery behind the street's end and one past it (${a.reason || c.reason || 'both built'})`);
  const opt = A && tw.expandOptions(A).find(q => q.kind === 'land' && Math.hypot(midOf(q.rects[0])[0] - (X + 1), midOf(q.rects[0])[1] - (Z + 1)) < 0.1);
  const grew = opt && tw.expandBuilding(A.id, opt.dir, 'land').ok;
  const faults = [];
  auditTown(tw, (m) => faults.push(m));
  ok(grew && !faults.some(m => /overlap/.test(m)) && (A.front || 0) === 0 && A.ownFront > 0, `a plot grown past the end of its street keeps behind the neighbour in front of its new land (front ${A && A.front}, the building's own ${A && A.ownFront})${faults.length ? ': ' + faults.join('; ') : ''}`);
});

// 3d1. taking a neighbouring plot: the land first (no builders, the building
// stays its size), then what to build across it
await block('3d1 neighbouring plot', async () => {
  const { sizeK, sizeKFor } = await import('../src/world/world.js');
  const { CLEAR_COST } = await import('../src/config.js');
  w.setSandbox({ infiniteMoney: true });
  let done = null;
  for (const b of [...w.buildings.values()]) {
    if (b.type !== 'house' || b.con) continue;
    const opt = w.expandOptions(b).find(o => o.kind === 'land') || w.expandOptions(b).find(o => o.kind === 'takeover');
    if (!opt) continue;
    const r = w.expandBuilding(b.id, opt.dir, opt.kind);
    if (r.ok) { done = { b, opt }; break; }
  }
  ok(done && done.b.w * done.b.d === 2 && !done.b.con && done.b.spare && sizeK(done.b) === 1, `a house takes a neighbouring plot (${done ? done.opt.kind : 'none'}) as land only: no builders, still its own size`);
  if (done) {
    const b = done.b, [mx, mz] = midOf(done.opt.rects[0]);
    ok(w.buildingAt(mx, mz) === b, 'the new plot belongs to it');
    ok(done.opt.kind !== 'land' || (done.opt.cost >= CONFIG.PLOT_PRICE && (done.opt.cost - CONFIG.PLOT_PRICE) % CLEAR_COST === 0), `an empty plot costs the price of the land, and of clearing its trees ($${done.opt.cost})`);
    const opts = w.upgradeOptions(b), big = opts.filter(o => o.large).map(o => o.type);
    ok(big.length >= 2 && opts.some(o => o.extend), `then it can be rebuilt bigger (${big.join(', ')}) or extended`);
    const cap0 = capOf(b, 'housing'), chk = w.upgradeCheck(b, 'extend');
    ok(chk.target && chk.target.extend && chk.cost === Math.max(20, Math.round((BUILDINGS.house.levels.slice(0, b.level + 1).reduce((s, L) => s + L.cost, 0)) * (sizeKFor('house', 2, 1) - 1))), `extending costs what the extra half is worth ($${chk.cost})`);
    const r = w.upgradeBuilding(b.id, 'extend');
    ok(r.ok && b.con && b.con.extend && b.spare, 'builders extend it across the plot');
    ok(runUntil(() => !b.con).ok && !b.spare && sizeK(b) === 1.5 && capOf(b, 'housing') === Math.round(BUILDINGS.house.levels[b.level].housing * 1.5) && capOf(b, 'housing') > cap0, `extended, it holds half as many again (${cap0} → ${capOf(b, 'housing')})`);
  }
  w.setSandbox({ infiniteMoney: false });
  w.money = 1e6;
});
w.setSandbox({ infiniteMoney: false });
w.money = 1e6;

// 3d1a. land deals beside street corners: a plot never reaches into a third
// plot, whichever order the deals and the buildings come in (laid out as
// plots in rows, a unit square each: (x, z) the square, its middle at
// x + 0.5, z + 0.5)
await block('3d1a land deals by corners', async () => {
  const base = World.createNew({ N: 40, seed: 3, name: 'Dealby' });
  const o = openBox(base, 13, 9, { x: 8, z: 8 });
  const town = (spurs, builds, back = true) => {
    const tw = deserialize(JSON.parse(JSON.stringify(serialize(base))));
    tw.setSandbox({ infiniteMoney: true, unlockAll: true, instantBuild: true });
    levelBox(tw, o.x, o.z, 13, 9);
    const T = (x, z) => [o.x + x + 0.5, o.z + z + 0.5];
    street(tw, [T(-0.2, 6), T(11.2, 6)]);
    if (back) street(tw, [T(-0.2, 3), T(11.2, 3)]);
    // a spur up from the street to just short of the plot it ends at
    for (const [x, z] of spurs) street(tw, [T(x, 6), [T(x, z)[0], T(x, z)[1] - 0.23]]);
    const at = {};
    for (const [k, type, x, z] of builds) { const p = tw.placeBuilding(type, ...T(x, z)); at[k] = p.ok ? p.building : null; }
    return { tw, at, T };
  };
  const overlapsIn = (tw) => {
    const found = [];
    makeAudit({ world: tw, construction: {}, agents: { walkers: [] }, animals: { list: [] } }, (d, m) => { if (m.startsWith('plots overlap')) found.push(m); })(0);
    return found;
  };
  const axes = (b) => new Set((b.leases || []).filter(l => l.buyer).map(l => l.side[0]));
  // a villa between a cottage beside it and one behind it buys from only one
  // of them, so a chapel can still go on the corner plot between the two
  {
    const { tw, at, T } = town([], [['v', 'villa', 5, 5], ['a', 'house', 4, 5], ['b', 'house', 5, 4]]);
    tw.tryEncroach(at.v);
    const c = tw.placeBuilding('chapel', ...T(4, 4));
    ok(at.v && at.a && at.b && axes(at.v).size === 1 && c.ok && !overlapsIn(tw).length, `a villa buys garden on one axis only (${[...axes(at.v)]}) and the corner plot stays free ${c.reason || ''} ${overlapsIn(tw).join('; ')}`);
  }
  // a cottage between two villas sells a strip to one of them only
  {
    const { tw, at } = town([], [['h', 'house', 5, 5], ['a', 'villa', 4, 5], ['b', 'villa', 5, 4]]);
    tw.tryEncroach(at.a); tw.tryEncroach(at.b);
    ok((at.h.leases || []).length === 1 && !overlapsIn(tw).length, `a cottage sells one strip at most (${(at.h.leases || []).length}) ${overlapsIn(tw).join('; ')}`);
  }
  // a villa facing a spur, with a strip of the cottage's garden beside it
  // (the cottage facing a spur of its own, square to the villa): neither the
  // plot nor its front runs into a building on the corner next to it
  {
    const spurs = [[5, 5], [7, 4]];
    const a = town(spurs, [['v', 'villa', 5, 4], ['h', 'house', 6, 4]], false);
    a.tw.tryEncroach(a.at.v);
    const turned = a.at.h && Math.abs(Math.abs(wrapAngle(a.at.h.a - a.at.v.a)) - PI / 2) < 0.01;
    const sold = (a.at.v.leases || []).length === 1;
    a.tw.placeBuilding('market', ...a.T(6, 5));
    const b = town(spurs, [['v', 'villa', 5, 4], ['h', 'house', 6, 4], ['m', 'market', 6, 5]], false);
    b.tw.tryEncroach(b.at.v);
    ok(turned && sold && (b.at.v.leases || []).length === 1 && !overlapsIn(a.tw).length && !overlapsIn(b.tw).length,
      `a villa with a strip beside it keeps clear of the corner plot (front ${a.at.v.front} / ${b.at.v.front}) ${[...overlapsIn(a.tw), ...overlapsIn(b.tw)].join('; ')}`);
  }
});

// 3d1e. single-family homes take one family (a few in the big houses), and
// newcomers to them come as one family sized to the house; a home with more
// households than it takes (an old save) lets the newest one move on
await block('3d1e households', async () => {
  const { householdCap } = await import('../src/world/world.js');
  const { householdsIn } = await import('../src/sim/people.js');
  const sim = game.sim;
  w.setSandbox({ infiniteMoney: true, unlockAll: true, instantBuild: true });
  const evict = (b) => { for (const id of b.residents) w.residents.delete(id); b.residents = []; };
  const fh = near(w, 'house', null, { r: 20 });
  fh.level = 1;   // a Family House: room for 6, one household
  const sizes = [];
  for (let k = 0; k < 30; k++) { sizes.push(sim.makeFamily(fh, capOf(fh, 'housing')).length); evict(fh); }
  ok(sizes.every(n => n >= 5 && n <= 6), `newcomers to a family house come as one family of 5–6 (${Math.min(...sizes)}–${Math.max(...sizes)})`);
  sim.makeFamily(fh, 3);
  ok(householdsIn(w, fh) === 1 && fh.residents.length < capOf(fh, 'housing') && !sim.vacantHomes().includes(fh), 'with a family in, it takes no other household, though it has room');
  ok(householdCap({ type: 'house', level: 0 }) === 1 && householdCap({ type: 'villa', level: 2 }) === 2 && householdCap({ type: 'flats', level: 0 }) === Infinity, 'cottages and villas take one family, a grand manor two, flats any number');
  // an old save: two households in one cottage, and a home with room nearby
  const c = near(w, 'house', null, { r: 20 });
  evict(c);
  const lodger = sim.makeFamily(c, 1)[0], other = sim.makeFamily(c, 1)[0];
  lodger.fam = lodger.id; other.fam = other.id;
  const spare = near(w, 'flats', null, { r: 20 });
  sim.recompute();
  sim._settleHouseholds();
  ok(householdsIn(w, c) === 1 && c.residents.includes(lodger.id) && w.residents.get(other.id).home !== c.id, 'an extra household moves on to a home with room (the newest one)');
  for (const b of [fh, c, spare]) if (b && w.buildings.has(b.id)) { evict(b); w.removeBuilding(b.id, 0); }
});
w.setSandbox({ infiniteMoney: false, unlockAll: false, instantBuild: false });
w.money = 1e6;

// 3d1b. a home rebuilt to hold fewer people (a Grand Manor on a double plot
// becoming a Country Mansion): the households that no longer fit move out
await block('3d1b fewer people', async () => {
  w.setSandbox({ infiniteMoney: true, unlockAll: true, freeUpgrades: true, instantBuild: true });
  const b = [...w.buildings.values()].find(b => b.type === 'house' && !b.con && b.w * b.d === 2);
  if (b) {
    b.type = 'villa'; b.level = 2;
    const people = () => [...w.residents.values()].filter(r => r.home === b.id);
    while (people().length < capOf(b, 'housing')) game.agents.arrive(game.sim.makeFamily(b, capOf(b, 'housing') - people().length), b);
    game.sim.recompute();
    const before = people(), was = capOf(b, 'housing');
    const chk = w.upgradeCheck(b, 'mansion');
    const r = w.upgradeBuilding(b.id, 'mansion');
    const stay = people(), cap = capOf(b, 'housing');
    const moved = before.filter(p => w.residents.has(p.id) && p.home !== b.id);
    const left = before.filter(p => !w.residents.has(p.id));
    const fam = (p) => p.fam ?? p.id;
    const split = before.some(p => !stay.includes(p) && stay.some(s => fam(s) === fam(p)));
    const fits = (h) => h && [...w.residents.values()].filter(r => r.home === h.id).length <= capOf(h, 'housing');
    ok(r.ok && b.type === 'mansion' && stay.length <= cap && chk.moveOut === before.length - stay.length,
      `a Grand Manor (${before.length}/${was}) rebuilt as a ${BUILDINGS.mansion.levels[0].name} keeps ${stay.length}/${cap}; ${moved.length} moved house, ${left.length} left (${chk.moveOut} foretold)`);
    ok(!split && moved.every(p => fits(w.buildings.get(p.home))), 'whole households move out, into homes with room');
  } else ok(false, 'no house on a double plot to rebuild');
});
w.setSandbox({ infiniteMoney: false, unlockAll: false, freeUpgrades: false, instantBuild: false });
w.money = 1e6;

// 3d1c. with Great Plots a double plot grows into a 2×2 estate onto the land
// behind it, and can then be rebuilt as its 2×2 counterpart (every ESTATE
// recipe), at the level it had reached
await block('3d1c estates', async () => {
  const { ESTATE, techForLevel } = await import('../src/defs.js');
  const { sizeK } = await import('../src/world/world.js');
  const tw = World.createNew({ N: 64, seed: 37, name: 'Grangeley' });
  tw.setSandbox({ infiniteMoney: true, instantBuild: true });
  tw.research.done.push('surveying');
  const made = [];
  let gated = null;
  for (const [src, list] of Object.entries(ESTATE)) {
    for (let tries = 0; tries < 3; tries++) {
      const b = lot(tw, src, { w: 2, d: 1, back: 1.2, opts: { level: BUILDINGS[src].levels.length - 1 } });
      if (!b) break;
      if (gated === null) { gated = !tw.expandOptions(b).some(o => o.kind === 'estate'); tw.research.done.push('bigplots'); }
      const opt = tw.expandOptions(b).find(o => o.kind === 'estate');
      if (!opt || !tw.expandBuilding(b.id, opt.dir, 'estate').ok) { tw.removeBuilding(b.id, 0); continue; }
      tw.setSandbox({ unlockAll: true, freeUpgrades: true });
      const up = tw.upgradeOptions(b).find(o => o.estate && o.type === list[0]);
      const r = up && tw.upgradeBuilding(b.id, up.type);
      tw.setSandbox({ unlockAll: false, freeUpgrades: false });
      const L = BUILDINGS[b.type].levels[b.level], m = r && r.ok && buildModel(b);
      if (r && r.ok && b.type === list[0] && b.w * b.d === 4 && sizeK(b) === 1 && capOf(b, L.housing ? 'housing' : 'jobs') === (L.housing || L.jobs || 0)
        && b.level === Math.min(BUILDINGS[src].levels.length - 1, BUILDINGS[b.type].levels.length - 1) && !tw.expandOptions(b).length && m.geo.attributes.position.count) {
        made.push(`${src}→${b.type}`);
        break;
      }
    }
  }
  ok(gated, 'a double plot only grows into a 2×2 estate once Great Plots is researched');
  ok(made.length === Object.keys(ESTATE).length, `every double-plot building grown to 2×2 rebuilds as its estate, at its level (${made.join(', ')})`);
  ok(Object.values(ESTATE).flat().every(t => BUILDINGS[t].estate && techForLevel(t, 0) && BUILDINGS[t].levels.every((_, i) => techForLevel(t, i))), 'every estate level is gated by research');
});

// 3d1d. parks: every park type looks different from one plot to the next
// (its own seed) and the same every time it is drawn, keeps its layout as
// it goes up a level, follows the seasons, and gives its visitors somewhere
// to stroll to; a park joined from a little one keeps that one's feature
{
  const { parkFeature } = await import('../src/world/world.js');
  // (where everything is and what colour)
  const hashOf = (geo) => { let h = 0; const a = geo.attributes.position.array, c = geo.attributes.color.array; for (let i = 0; i < a.length; i += 5) h = (Math.imul(h, 31) + Math.round(a[i] * 1000) + Math.round(c[i] * 255)) | 0; return h; };
  const mk = (type, level, variant, season = 1) => {
    const d = BUILDINGS[type], W = d.merged ? 2 : d.size, D = d.merged ? 1 : d.size;
    return buildModel({ type, level, variant, size: Math.max(W, D), w: W, d: D, baseY: 0.5, minY: 0.2, rot: 0 }, { flat: true, season });
  };
  const alike = [], unstable = [], still = [], nowhere = [];
  for (const [type, d] of Object.entries(BUILDINGS)) {
    if (!d.park) continue;
    const L = d.levels.length - 1;
    const looks = new Set([1, 2, 3, 4, 5, 6].map(v => hashOf(mk(type, L, v * 7919 + 13).geo)));
    if (looks.size < 4) alike.push(`${type} (${looks.size} looks in 6)`);
    if (hashOf(mk(type, L, 4242).geo) !== hashOf(mk(type, L, 4242).geo)) unstable.push(type);
    if (type !== 'statue' && hashOf(mk(type, L, 4242, 1).geo) === hashOf(mk(type, L, 4242, 3).geo)) still.push(type);
    if (d.outdoor && !mk(type, L, 4242).spots.length) nowhere.push(type);
  }
  ok(!alike.length, `every park type looks different from one plot to the next${alike.length ? ': not ' + alike.join(', ') : ''}`);
  ok(!unstable.length, `...and the same every time it is drawn${unstable.length ? ': not ' + unstable.join(', ') : ''}`);
  ok(!still.length, `every park follows the seasons${still.length ? ': not ' + still.join(', ') : ''}`);
  ok(!nowhere.length, `every open-air park gives its visitors somewhere to stroll to${nowhere.length ? ': not ' + nowhere.join(', ') : ''}`);
  // its layout stays as it goes up a level: the green's great tree (or its
  // pump, maypole or yews) stands in the same corner at every level
  const corner = (geo) => { const p = geo.attributes.position.array; let sx = 0, sz = 0, n = 0; for (let i = 0; i < p.length; i += 3) if (p[i + 1] > 0.3) { sx += p[i]; sz += p[i + 2]; n++; } return n ? [Math.sign(sx), Math.sign(sz)] : [0, 0]; };
  const moved = [11, 22, 33, 44, 55, 66].filter(v => { const a = corner(mk('garden', 0, v).geo), b = corner(mk('garden', 1, v).geo); return a[0] !== b[0] || a[1] !== b[1]; });
  ok(moved.length <= 1, `a green keeps its great tree in its corner as it becomes a garden (${6 - moved.length} of 6)`);
  ok(parkFeature('park', ['garden', 'bandstand']) === 'bandstand' && parkFeature('lakepark', ['pond', 'pond']) === null && parkFeature('botanic', ['physic', 'pond']) === 'pond', 'a park joined from a little park with a feature of its own keeps it');
}

// 3d1e. parks grow: a little park takes the empty plot beside it and is
// rebuilt as the double-plot park; a double-plot park grows into a 2×2
// estate taking in the little parks in the way; and with Public Parks a 2×2
// park grows into 3×3 grounds and those into 4×4, laid out round the park
// it was (in the corner it stood in), saved and loaded back. (Laid out in
// rows of unit plots: T(x, z) the middle of plot x along, z back.)
await block('3d1e parks grow', async () => {
  const { parkOrigin, GRAND, techForLevel } = await import('../src/defs.js');
  const { runCommand } = await import('../src/commands.js');
  const tw = World.createNew({ N: 64, seed: 41, name: 'Greenwick' });
  tw.setSandbox({ infiniteMoney: true, instantBuild: true, freeUpgrades: true });
  for (const t of ['surveying', 'joining', 'gardening', 'bigplots', 'parks2']) tw.research.done.push(t);
  // an open 6 × 5 block with a street along its front (row 5)
  const o = openBox(tw, 7, 7, { x: 20, z: 20 });
  levelBox(tw, o.x, o.z, 7, 7);
  const T = (x, z) => [o.x + 1 + x, o.z + 1 + z];
  street(tw, [[o.x + 0.3, T(0, 5)[1]], [o.x + 6.7, T(0, 5)[1]]]);
  const put = (type, x, z, opt = {}) => { const p = tw.placeBuilding(type, ...T(x, z), { instant: true, ignoreUnlock: true, a: 0, ...opt }); if (!p.ok) throw new Error(`${type} at ${x},${z}: ${p.reason}`); return p.building; };
  const nearPt = (pts, [x, z]) => Math.hypot(midOf(pts)[0] - x, midOf(pts)[1] - z) < 0.1;
  // a pond takes the empty plot behind it and becomes a lake garden
  const pond = put('pond', 5, 4);
  const land = tw.expandOptions(pond).find(q => q.kind === 'land' && nearPt(q.rects[0], T(5, 3)));
  ok(land && !tw.expandOptions(pond).some(q => q.kind !== 'land'), 'a little park can take the empty plot beside it (and only empty land)');
  tw.expandBuilding(pond.id, land.dir, 'land');
  const up = tw.upgradeOptions(pond);
  ok(up.some(q => q.type === 'lakepark' && q.large) && !up.some(q => q.extend), `...and be rebuilt across the double plot as a lake garden, not extended as it is (${up.map(q => q.type + (q.extend ? '+' : '')).join(', ')})`);
  ok(tw.upgradeBuilding(pond.id, 'lakepark').ok && pond.type === 'lakepark' && pond.w * pond.d === 2 && !pond.spare, 'the pond is a lake garden on its double plot');
  // a garden and a rose garden join into a park that keeps its roses...
  const g1 = put('garden', 0, 4), g2 = put('rosegarden', 1, 4);
  const park = tw.mergeBuildings(g1.id, g2.id).building;
  ok(park && park.type === 'park' && park.flavor === 'rosegarden', `a garden and a rose garden join into a park laid out round the roses (${park && park.flavor})`);
  // ...which grows onto the plots behind it, taking in the pond there
  const duck = put('pond', 0, 3), stat = put('statue', 2, 2);
  const est = tw.expandOptions(park).find(q => q.kind === 'estate' && q.absorb.length);
  ok(est && est.absorb[0] === duck && /becomes part of the park/.test(est.warn || '') && est.cost < 2 * CONFIG.PLOT_PRICE, `a park growing into a 2×2 estate takes in the little park in the way, paying only for the empty plot ($${est && est.cost})`);
  tw.expandBuilding(park.id, est.dir, 'estate');
  ok(!tw.buildings.has(duck.id) && tw.buildingAt(...T(0, 3)) === park && park.w * park.d === 4, 'the pond is now part of the park');
  ok(tw.upgradeBuilding(park.id, 'landscapepark').ok && park.type === 'landscapepark' && park.flavor === 'rosegarden', 'rebuilt as a landscape park, it keeps its roses');
  // grounds: only with Public Parks
  ok(!tw.expandOptions(park).length, 'a 2×2 park only grows into bigger grounds once Public Parks is researched');
  tw.research.done.push('publicparks');
  const grand = tw.expandOptions(park).filter(q => q.kind === 'grand');
  const g3 = grand.find(q => q.absorb.includes(stat));
  const areaSum = (q) => q.rects.reduce((s, pts) => s + areaOf(pts), 0);
  ok(grand.length >= 1 && grand.every(q => Math.abs(areaSum(q) - 5) < 1e-6) && g3, `...then it can take the land round a corner (${grand.length} ways, 5 plots' worth each), taking in the statue in the way`);
  ok(g3 && runCommand({ world: tw, demo: false }, { t: 'expand', id: park.id, dir: g3.dir, kind: 'grand' }).ok, 'the expand command takes the land for bigger grounds');
  const sp0 = { ...(park.spare || {}) };
  ok(park.w === 3 && park.d === 3 && park.spare && park.spare.w === 2 && !tw.buildings.has(stat.id), `the park now stands on 3×3 grounds, the landscape park in its corner (${JSON.stringify(park.spare)})`);
  const gup = tw.upgradeOptions(park);
  ok(gup.some(q => q.type === 'grandpark' && q.grand) && !gup.some(q => q.extend), 'it can be laid out as a Grand Park');
  tw.upgradeBuilding(park.id, 'grandpark');
  const o1 = parkOrigin(park.flavor);
  ok(park.type === 'grandpark' && o1 && o1.type === 'landscapepark' && o1.sx === sp0.sx && o1.sz === sp0.sz && o1.inner === 'rosegarden' && !park.spare, `the Grand Park is laid out round the landscape park it was, in its corner (${park.flavor})`);
  // and again into 4×4: a City Park
  const city = tw.expandOptions(park).filter(q => q.kind === 'grand');
  ok(city.length && city.every(q => Math.abs(areaSum(q) - 7) < 1e-6), `a Grand Park grows again onto 7 more plots' worth (${city.length} ways)`);
  if (city.length) {
    tw.expandBuilding(park.id, city[0].dir, 'grand');
    tw.upgradeBuilding(park.id, 'citypark');
    const o2 = parkOrigin(park.flavor), o3 = o2 && parkOrigin(o2.inner);
    ok(park.type === 'citypark' && park.w === 4 && o2.type === 'grandpark' && o3 && o3.type === 'landscapepark' && !tw.expandOptions(park).length, `a City Park on 4×4 grounds round the Grand Park, round the landscape park (${park.flavor})`);
    const m0 = buildModel(park), cells = new Set();
    for (let dz = 0; dz < 4; dz++) for (let dx = 0; dx < 4; dx++) cells.add(tw.buildingAt(...toWorld(ownPlot(park), dx - 1.5, dz - 1.5)));
    ok(m0.geo.attributes.position.count > 0 && cells.size === 1 && cells.has(park), 'every plot of the City Park is the park\'s, and it builds');
    // saved and loaded back: same grounds, same layout
    const back = deserialize(JSON.parse(JSON.stringify(serialize(tw)))).buildings.get(park.id);
    const h = (geo) => { let s = 0; const a = geo.attributes.position.array; for (let i = 0; i < a.length; i += 11) s = (Math.imul(s, 31) + Math.round(a[i] * 1000)) | 0; return s; };
    ok(back && back.type === 'citypark' && back.w === 4 && back.d === 4 && back.flavor === park.flavor && h(buildModel(back).geo) === h(m0.geo), 'a save keeps the City Park, its grounds and what it grew from, drawn the same');
  }
  ok(Object.values(GRAND).flat().filter(t => BUILDINGS[t].park).every(t => BUILDINGS[t].grand && BUILDINGS[t].levels.every((_, i) => techForLevel(t, i) === 'publicparks')), 'every level of the grand parks takes Public Parks');
});

// 3d1f. what the new parks do: a bandstand brings culture to the streets
// round it, allotments cheer homes with the retired in them (and the old go
// and dig there), and the boating lake and the zoo charge their visitors
await block('3d1f new parks', async () => {
  const tw = World.createNew({ N: 48, seed: 39, name: 'Bandbury' });
  tw.setSandbox({ infiniteMoney: true, unlockAll: true, instantBuild: true });
  const sim = new Sim(listen(tw));
  // on the town's own street, so they are connected
  const [home, stand] = pair(tw, 'house', 'bandstand');
  sim.recompute();
  const i = cellOf(tw.N, home.x, home.z);
  const cult = sim.coverage.culture[i];
  const spot = { x: stand.x, z: stand.z, a: stand.a };
  tw.removeBuilding(stand.id, 0);
  sim.recompute();
  ok(home.connected && cult && !sim.coverage.culture[i], 'a bandstand brings culture to the homes round it');
  const old = { id: tw.newId(), first: 'Ada', last: 'Spade', age: 'elder', years: 70, edu: 1, home: home.id, job: null, look: 4321, mood: 60 };
  tw.residents.set(old.id, old); home.residents.push(old.id);
  const potter = () => { sim.recompute(); sim._happiness(); const p = home.factors.parts.find(q => q[0] === 'potter'); return p ? p[1] : null; };
  const before = potter();
  const plot = tw.placeBuilding('allotment', spot.x, spot.z, { instant: true, a: spot.a }).building;
  const after = potter();
  ok(before === 0 && after === 3, `a home with someone retired in it is happier with allotments in reach (${before} → +${after})`);
  const A = { world: tw, _nearest: Agents.prototype._nearest, _shopFor: Agents.prototype._shopFor, _places: Agents.prototype._places, _candidates: (pred) => [...tw.buildings.values()].filter(b => b.access && pred(BUILDINGS[b.type], b)) };
  // (with a green beside it too, so the allotment isn't the only park to go to)
  let green = null;
  for (const [lx, lz] of [[1, 0], [0, -1]]) { const p = tw.placeBuilding('garden', ...toWorld(ownPlot(home), lx, lz), { instant: true, a: home.a }); if (p.ok) { green = p.building; break; } }
  let digs = 0;
  for (let k = 0; k < 200; k++) { A._lists = null; Agents.prototype.planDay.call(A, old, null); if (old.plan.some(p => p.dest === plot.id && p.t < 11.5)) digs++; }
  ok(green && digs > 50 && digs < 180, `the old go and dig their allotment of a morning, some mornings (${digs} in 200)`);
  // a boat hired on the boating lake is paid for; a stroll in the town park isn't
  const pay = (type, level) => {
    const W = 2, D = BUILDINGS[type].merged ? 1 : 2;
    const b = lot(tw, type, { w: W, d: D, opts: { level } });
    if (!b) return null;
    b.wet = 2;
    const m0 = tw.stats.visitIncome, ag = { world: tw, game: { sim, emit() {} }, _visiting: Agents.prototype._visiting, _occupancy: () => new Map(), _drop() {} };
    b.working = 1;
    Agents.prototype._arrive.call(ag, { id: -1, age: 'adult', home: home.id, job: null, walk: null }, b.id);
    tw.removeBuilding(b.id, 0);
    return Math.round(tw.stats.visitIncome - m0);
  };
  const boat = pay('lakepark', 1), stroll = pay('park', 0), zoo = pay('zoo', 0);
  ok(boat === BUILDINGS.lakepark.levels[1].visit && stroll === 0 && zoo === BUILDINGS.zoo.levels[0].visit, `the boating lake takes $${boat} a visit and the zoo $${zoo}; a walk in the park is free (${stroll})`);
  // grounds keep the uses of the park they grew from
  const { researchOf, visitOf } = await import('../src/defs.js');
  const gz = { type: 'grandpark', level: 0, flavor: 'zoo#1@1,1' }, gp = { type: 'citypark', level: 1, flavor: 'grandpark#0@1,1/palmhouse#1@-1,1' };
  ok(visitOf(gz) === BUILDINGS.zoo.levels[1].visit && researchOf(gp) === 8 && researchOf({ type: 'grandpark', level: 0, flavor: 'landscapepark#1' }) === 0 && visitOf({ type: 'grandpark', level: 0, flavor: null }) === 0,
    `grounds grown from a zoo keep its gate ($${visitOf(gz)}), and from the royal botanic gardens their research (${researchOf(gp)} a day)`);
});

// 3d1g. plantings and monuments come in kinds: each kind builds at every
// level and looks like no other, one without a kind takes one by its seed
// (from those that need no research), a kind can be chosen when it is
// built (if researched) and reworked later by the builders for a share of
// its worth, and a grand monument brings culture
await block('3d1g kinds', async () => {
  const { KINDS, REKIND, kindOf } = await import('../src/defs.js');
  const { runCommand } = await import('../src/commands.js');
  const hashOf = (geo) => { let h = 0; const a = geo.attributes.position.array, c = geo.attributes.color.array; for (let i = 0; i < a.length; i += 5) h = (Math.imul(h, 31) + Math.round(a[i] * 1000) + Math.round(c[i] * 255)) | 0; return h; };
  const bad = [], looks = new Map();
  for (const [type, K] of Object.entries(KINDS)) for (const kind of Object.keys(K)) BUILDINGS[type].levels.forEach((_, level) => {
    const b = at0({ type, level, variant: 4242, flavor: kind, size: 1, w: 1, d: 1, baseY: 0.5, minY: 0.2 });
    let h = null;
    for (const season of [0, 1, 2, 3]) {
      const m = buildModel(b, { flat: true, season });
      if (!m.geo || !m.geo.attributes.position.count || [...m.geo.attributes.position.array].some(v => !Number.isFinite(v))) bad.push(`${type} ${kind} L${level}`);
      else if (season === 1) h = hashOf(m.geo);
    }
    const key = `${type}:${level}`;
    if (!looks.has(key)) looks.set(key, new Set());
    looks.get(key).add(h);
  });
  ok(!bad.length, `every kind of planting (${Object.keys(KINDS.flowers).length}) and monument (${Object.keys(KINDS.statue).length}) builds at every level and season${bad.length ? ': not ' + bad.join(', ') : ''}`);
  ok([...looks].every(([k, s]) => s.size === Object.keys(KINDS[k.split(':')[0]]).length), `...and at each level each kind looks like no other (${[...looks].map(([k, s]) => `${k} ${s.size}`).join(', ')})`);
  const seeds = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(v => kindOf({ type: 'statue', variant: v * 977 })));
  ok(seeds.size >= 3 && [...seeds].every(k => !KINDS.statue[k].tech) && kindOf({ type: 'statue', variant: 5, flavor: 'clock' }) === 'clock' && kindOf({ type: 'house', variant: 5 }) === null,
    `one without a kind takes one by its seed, of those needing no research (${[...seeds].join(', ')})`);
  // choosing one when it is built, and reworking it later
  const tw = World.createNew({ N: 48, seed: 43, name: 'Kindleton' });
  tw.money = 1e6;
  const G = { world: tw, demo: false };
  const s1 = findPlot(tw, 'flowers', seatOf(tw), { r: 16, opts: { ignoreUnlock: true } });
  const locked = runCommand(G, { t: 'place', type: 'flowers', x: s1.x, z: s1.z, a: s1.a, flavor: 'knot' });
  tw.research.done.push('gardening', 'botany', 'stonework');
  const knot = runCommand(G, { t: 'place', type: 'flowers', x: s1.x, z: s1.z, a: s1.a, flavor: 'knot' });
  ok(!locked.ok && /Botany/.test(locked.reason || '') && knot.ok && knot.building.flavor === 'knot' && kindOf(knot.building) === 'knot', `a planting can be built as a herb knot once Botany is researched (${locked.reason})`);
  const s2 = findPlot(tw, 'flowers', seatOf(tw), { r: 16, opts: { ignoreUnlock: true } });
  ok(!runCommand(G, { t: 'place', type: 'flowers', x: s2.x, z: s2.z, a: s2.a, flavor: 'clock' }).ok && !runCommand(G, { t: 'place', type: 'house', x: s2.x, z: s2.z, a: s2.a, flavor: 'rockery' }).ok, 'a kind of one is refused for the other, and for anything else');
  const plot = knot.building;
  plot.con = null;
  const m0 = tw.money, ck = tw.kindCheck(plot, 'rockery');
  const rk = runCommand(G, { t: 'kind', id: plot.id, kind: 'rockery' });
  ok(ck.ok && rk.ok && plot.con && plot.con.kind === 'upgrade' && plot.con.flavor === 'rockery' && tw.money === m0 - ck.cost && ck.cost === Math.max(20, Math.round(tw.buildValue(plot) * REKIND)) && plot.flavor === 'knot',
    `builders rework the knot as a rockery for $${ck.cost} (${Math.round(REKIND * 100)}% of its worth)`);
  tw.finishConstruction(plot);
  ok(plot.flavor === 'rockery' && plot.level === 0 && !plot.con, 'when they are done it is a rockery, at its level');
  ok(!tw.kindCheck(plot, 'rockery').ok && !tw.kindCheck(plot, 'arch').ok && !tw.kindCheck(plot, 'tree').ok, 'not as the kind it is, a kind it has not, or one not yet researched');
  // a grand monument brings culture
  const sim = new Sim(listen(tw));
  const mon = near(tw, 'statue', null, { r: 16, level: 1, flavor: 'founder' });
  const count = () => { sim.recompute(); let n = 0; for (const v of sim.coverage.culture) n += v ? 1 : 0; return n; };
  const before = count();
  mon.level = 2;
  const after = count();
  ok(after > before && BUILDINGS.statue.levels[2].culture > 0, `a grand monument brings culture to the streets within ${BUILDINGS.statue.levels[2].culture} units (a civic one doesn't)`);
});

// 3d1h. the seat of government: the town hall comes in styles, rebuilt in
// another for a share of all the seat has cost; at its top level, with
// Capital City, it grows onto the land round a corner (taking in the little
// parks there, never a building) into 3×3 grounds rebuilt as a Civic Centre
// and then a Capitol, and on into 4×4 for a Parliament, never extended as
// it is; there is only one seat; its tax bonus goes with it; the civic
// buildings near it make a civic quarter, each kind adding to the taxes
// once; every seat and civic model fits its plot; and a save keeps it all
await block('3d1h seat of government', async () => {
  const { SEAT_RESTYLE, seatWorth, CIVIC_QUARTER, CIVIC_TYPES, kindOf, SEAT_STYLES } = await import('../src/defs.js');
  const { civicQuarter } = await import('../src/world/world.js');
  const { runCommand } = await import('../src/commands.js');
  const tw = World.createNew({ N: 64, seed: 47, name: 'Capitalton' });
  tw.setSandbox({ infiniteMoney: true, instantBuild: true, freeUpgrades: true });
  const G = { world: tw, demo: false };
  const sim = new Sim(listen(tw));
  // the founders' town hall, its styles
  let th = seatOf(tw);
  ok(th && th.type === 'townhall' && kindOf(th) === 'tower' && kindOf({ ...th, level: 4 }) === 'dome' && kindOf({ ...th, flavor: 'gothic' }) === 'gothic',
    'a town hall with no style chosen has a clock tower, and a dome once it is a Civic Palace');
  const locked = tw.kindCheck(th, 'classical');
  tw.research.done.push('stonework', 'architecture');
  const cost = tw.kindCheck(th, 'classical').cost;
  const rs = runCommand(G, { t: 'kind', id: th.id, kind: 'classical' });
  ok(!locked.ok && /Architecture/.test(locked.reason) && rs.ok && th.flavor === 'classical' && th.level === 0 && cost === Math.round(seatWorth(th) * SEAT_RESTYLE),
    `the temple front waits for Architecture; then builders rebuild it in that style for $${cost} (${Math.round(SEAT_RESTYLE * 100)}% of all the seat has cost)`);
  ok(seatWorth({ type: 'capitol', level: 0 }) > seatWorth({ type: 'townhall', level: 4 }) && seatWorth({ type: 'parliament', level: 1 }) > seatWorth({ type: 'parliament', level: 0 }),
    'restyling only gets dearer as the seat grows');
  // a fresh seat on an open block (plots in rows, T(x, z) the middle of one),
  // a street along its front at row 6 and room across it
  tw.removeBuilding(th.id, 0);
  const o = openBox(tw, 14, 11, { x: 16, z: 16 });
  levelBox(tw, o.x, o.z, 14, 11);
  const T = (x, z) => [o.x + 4 + x, o.z + 1 + z];
  street(tw, [[o.x + 0.3, T(0, 6)[1]], [o.x + 13.7, T(0, 6)[1]]]);
  th = tw.placeBuilding('townhall', ...T(2.5, 4.5), { instant: true, ignoreUnlock: true, flavor: 'dome' }).building;
  ok(th && Math.abs(wrapAngle(th.a)) < 0.01, 'a new town hall faces the street');
  ok(!tw.placeBuilding('townhall', ...T(0.5, 0.5), { instant: true, ignoreUnlock: true }).ok, 'there is only one town hall');
  tw.research.done.push('surveying', 'bigplots', 'grandarch', 'civic', 'municipal', 'metropolis');
  ok(!tw.expandOptions(th).length, 'the town hall does not grow its grounds below its top level');
  th.level = 4;
  ok(!tw.expandOptions(th).length, '...nor a Civic Palace before Capital City is researched');
  tw.research.done.push('capital');
  // a monument on one corner of the land it could take, a house on another
  const stat = tw.placeBuilding('statue', ...T(4, 3), { instant: true, ignoreUnlock: true, a: 0 }).building;
  const hut = tw.placeBuilding('house', ...T(1, 5), { instant: true, ignoreUnlock: true }).building;
  const grow = tw.expandOptions(th).filter(q => q.kind === 'grand');
  const g3 = grow.find(q => q.absorb.includes(stat));
  ok(stat && hut && grow.length >= 1 && grow.every(q => !q.absorb.includes(hut)) && g3 && /part of the grounds/.test(g3.warn || ''),
    `the Civic Palace can take the land round a corner (${grow.length} ways), taking in the monument there but never the house`);
  ok(runCommand(G, { t: 'expand', id: th.id, dir: g3.dir, kind: 'grand' }).ok && th.w === 3 && th.spare && !tw.buildings.has(stat.id) && tw.buildings.has(hut.id), `it stands on 3×3 grounds, in its corner (${JSON.stringify(th.spare)})`);
  const up3 = tw.upgradeOptions(th);
  ok(up3.length === 1 && up3[0].type === 'capitol' && up3[0].level === 0 && up3[0].grand, `it is offered the Civic Centre (the first level), never extended as it is (${up3.map(q => `${q.type}.${q.level}`).join(', ')})`);
  ok(runCommand(G, { t: 'upgrade', id: th.id, to: 'capitol' }).ok && th.type === 'capitol' && th.level === 0 && th.flavor === 'dome' && !th.spare, 'rebuilt as the Civic Centre, in its style');
  ok(/Only one/.test(tw.checkBuild('townhall', ...T(0.5, 0.5), { ignoreUnlock: true }).reason || ''), 'and still no second town hall beside the Civic Centre');
  ok(!tw.expandOptions(th).length, 'a Civic Centre grows no more until it is the Capitol');
  runCommand(G, { t: 'upgrade', id: th.id });
  const g4 = tw.expandOptions(th).filter(q => q.kind === 'grand');
  ok(th.type === 'capitol' && th.level === 1 && g4.length && g4.every(q => Math.abs(q.rects.reduce((s, p) => s + areaOf(p), 0) - 7) < 1e-6), `the Capitol can take 7 more plots' worth for 4×4 grounds (${g4.length} ways)`);
  tw.expandBuilding(th.id, g4[0].dir, 'grand');
  ok(tw.upgradeBuilding(th.id, 'parliament').ok && th.type === 'parliament' && th.w === 4 && th.d === 4 && !tw.expandOptions(th).length, 'and be rebuilt as the Parliament House, which grows no further');
  // its tax bonus, and the civic quarter round it
  const old = { id: tw.newId(), first: 'Ada', last: 'Ledger', age: 'elder', years: 70, edu: 1, home: null, job: null, look: 1, mood: 60 };
  tw.residents.set(old.id, old);
  const taxes = () => { sim.recompute(); return sim.budget.income.taxes; };
  const t0 = taxes(), bonus = BUILDINGS.parliament.levels[0].taxBonus;
  ok(Math.abs(t0 - 1.5 * (tw.taxRate / 10) * (1 + bonus)) < 1e-9, `the Parliament House raises every tax by ${Math.round(bonus * 100)}%`);
  const civic = (type) => { const b = near(tw, type, th, { r: 12, conn: false }); if (b) b.connected = true; return b; };
  const law = civic('lawcourts'), mus = civic('museum'), mus2 = civic('museum');
  const q = civicQuarter(tw);
  ok(law && mus && mus2 && q.kinds.length === 2 && Math.abs(q.tax - 2 * CIVIC_QUARTER.tax) < 1e-9 && q.members.length === 3,
    `law courts and two museums near it make a civic quarter of ${q.kinds.length} kinds: +${Math.round(q.tax * 100)}% tax (a second museum adds nothing)`);
  const t1 = taxes();
  ok(Math.abs(t1 / t0 - (1 + bonus + q.tax) / (1 + bonus)) < 1e-9, `...on top of the seat's own bonus (taxes ×${(t1 / t0).toFixed(3)})`);
  const lx = law.x;
  law.x = th.x + 2 + CIVIC_QUARTER.reach;
  const q2 = civicQuarter(tw);
  law.x = lx;
  ok(!q2.members.some(m => m.b === law) && q2.kinds.length === 1, `law courts more than ${CIVIC_QUARTER.reach} units away are no part of it`);
  ok(CIVIC_TYPES.length === 4 && CIVIC_TYPES.includes('library'), `the civic buildings: ${CIVIC_TYPES.join(', ')}`);
  const { techForLevel } = await import('../src/defs.js');
  ok(['capitol', 'parliament'].every(t => BUILDINGS[t].levels.every((_, i) => techForLevel(t, i) === 'capital')), 'every level of the Capitol and the Parliament takes Capital City');
  // every seat style and civic building fits its plot, and builds in every season
  const shrunk = [];
  for (const type of ['townhall', 'capitol', 'parliament', 'lawcourts', 'museum', 'operahouse']) {
    const d = BUILDINGS[type];
    d.levels.forEach((_, level) => {
      for (const flavor of d.seat ? Object.keys(SEAT_STYLES) : [null]) for (const season of [0, 3]) {
        const fit = {}, m = buildModel(at0({ type, level, variant: 77 + level, flavor, size: d.size, w: d.size, d: d.size, baseY: 0.5, minY: 0.2, a: (level % 4) * 0.8 }), { fit, season });
        if (!m.geo || !m.door || fit.k < (type === 'townhall' ? 0.97 : 0.99)) shrunk.push(`${type}.${level} ${flavor || ''} ${fit.k && fit.k.toFixed(3)}`);
      }
    });
  }
  ok(!shrunk.length, `every style of the seat at every level, and every civic building, fits its plot with a door${shrunk.length ? ': not ' + shrunk.join(', ') : ''}`);
  // a save keeps the Parliament, its grounds and its style
  tw.kindCheck(th, 'gothic').ok && tw.setKind(th.id, 'gothic');
  const back = deserialize(JSON.parse(JSON.stringify(serialize(tw)))).buildings.get(th.id);
  ok(back && back.type === 'parliament' && back.w === 4 && back.flavor === 'gothic' && back.level === th.level, 'a save keeps the Parliament on its 4×4 grounds, in its Gothic style');
});

// 3d2. demolition takes a crew and some time
await block('3d2 demolition', async () => {
  const target = [...w.buildings.values()].find(b => b.type === 'house' && !b.con && b.residents.length);
  const people = target.residents.slice();
  const r = w.demolishBuilding(target.id);
  ok(r.ok && target.con && target.con.kind === 'demolish', 'demolition starts as a job for a crew');
  ok(people.every(id => w.residents.get(id)?.home !== target.id), 'the household moved out at once');
  const res = runUntil(() => !w.buildings.has(target.id), 4);
  ok(res.ok, `the crew pulled it down (peak ${res.peak} on site)`);
});

// 3d3. research gates buildings and is earned daily
await block('3d3 research', async () => {
  const fresh = World.createNew({ N: 32, seed: 99, name: 'Lab' });
  const spot = findPlot(fresh, 'house', seatOf(fresh), { r: 14, opts: { ignoreMoney: true } });
  fresh.residents.set(9999, { id: 9999, age: 'adult' });
  for (let i = 0; i < 40; i++) fresh.residents.set(10000 + i, { id: 10000 + i, age: 'adult' });
  const c1 = fresh.checkBuild('bakery', spot.x, spot.z, { a: spot.a, ignoreMoney: true });
  ok(!c1.ok && /Research/.test(c1.reason), `a bakery needs research first ("${c1.reason}")`);
  ok(fresh.startResearch('commerce') && fresh.research.current === 'commerce', 'research project started');
  fresh.addResearch(TECHS.commerce.cost);
  ok(fresh.research.done.includes('commerce') && fresh.checkBuild('bakery', spot.x, spot.z, { a: spot.a, ignoreMoney: true }).ok, 'finished research unlocks the bakery');
  ok(!fresh.canResearch('highrise'), 'later projects wait for their prerequisites');
});

// 3d4. school stages: children go to the stage for their age; a school can
// grow larger or move on to the next stage (the bigger stages need room)
await block('3d4 schools', async () => {
  const sch = [...w.buildings.values()].find(b => b.type === 'school') || near(w, 'school', null, { r: 20 });
  w.setSandbox({ unlockAll: true });
  const opts = w.upgradeOptions(sch).map(o => o.type);
  ok(opts.includes('school') && opts.includes('middleschool'), `a schoolhouse can grow larger or become a middle school (${opts.join(', ')})`);
  game.sim.recompute();
  const kid = [...w.residents.values()].find(r => r.school != null && r.age === 'child');
  ok(!kid || BUILDINGS[w.buildings.get(kid.school).type].levels[w.buildings.get(kid.school).level].teaches === 1 + (kid.years >= 11) + (kid.years >= 14), 'children are placed at the stage for their age');
  sch.type = 'middleschool'; sch.level = 0;
  const hs = w.upgradeCheck(sch, 'highschool');
  ok(hs.reqs.some(r => r.space && !r.met), 'a high school needs a double plot first');
  sch.type = 'school';
});
w.setSandbox({ unlockAll: false });

// 3e. utilities: a generator powers the town, demand is counted
await block('3e utilities', async () => {
  game.sim.recompute();
  const before = [...w.buildings.values()].filter(b => b.powered).length;
  const gen = near(w, 'windgen', null, { r: 22 });
  game.sim.recompute();
  const U = game.sim.utility;
  const after = [...w.buildings.values()].filter(b => b.powered).length;
  ok(gen && U.power.gen >= 25 && after > before, `a wind generator powers ${after} buildings (${U.power.demand}/${U.power.gen} kW)`);
  ok(U.water.supply > 0 && U.water.demand === w.population, `water: ${U.water.demand} villagers, supply for ${U.water.supply}`);
});

// 3f. power, water and workers decide what works (Sim._working): an
// unpowered machine makes nothing, street lamps go dark, things without
// water or staff do less, and the issues panel lists what has stopped
// (in a small fresh town, so supply is under control)
await block('3f power water workers', async () => {
  const { RoadsView } = await import('../src/render/roadsView.js');
  const { computeIssues } = await import('../src/ui/issues.js');
  const { streetOf } = await import('../src/world/streets.js');
  const tw = World.createNew({ N: 40, seed: 77, name: 'Wattsby' });
  tw.setSandbox({ infiniteMoney: true, unlockAll: true, instantBuild: true });
  const tg = listen(tw);
  const sim = tg.sim = new Sim(tg);
  sim.seedFounders();
  // founders are random: make sure of two grown-ups to staff things
  for (const r of [...tw.residents.values()].slice(0, 2)) { r.age = 'adult'; r.years = 30; r.school = null; }
  const well = [...tw.buildings.values()].find(b => b.type === 'well');
  // cobbled streets get lamps
  tw.setLevel([...tw.roads.edges.keys()], 2);
  const by = (type, max = 12) => near(tw, type, well, { r: max });
  const mf = by('workshop');
  mf.level = 2;
  for (const r of tw.residents.values()) if (r.age === 'adult') r.job = mf.id;
  for (let k = 0; k < 8 && (sim.recompute(), sim.powerShare < 1); k++) by('windgen', 16);
  const rv = new RoadsView(tw, { add() {}, remove() {} });
  rv.lit = (x, z) => sim.lampLit(x, z);
  rv.rebuild();
  const lamps = rv.lamps.length;
  ok(mf.powered && mf.working > 0 && sim.incomeOf(mf) > 0, `a powered Manufactory works (${Math.round(mf.working * 100)}% staffed, $${Math.round(sim.incomeOf(mf))} a day)`);
  ok(lamps > 0 && rv.darkLamps === 0, `street lamps are lit with enough power (${lamps})`);
  // cut the power
  for (const b of [...tw.buildings.values()]) if (BUILDINGS[b.type].generator) tw.removeBuilding(b.id, 0);
  sim.recompute();
  rv.rebuild();
  ok(!mf.powered && mf.working === 0 && mf.blockers.includes('power') && sim.incomeOf(mf) === 0, `an unpowered Manufactory makes nothing (lacks ${mf.blockers.join(', ')})`);
  ok(rv.lamps.length === 0 && rv.darkLamps === lamps, `street lamps go dark without power (${rv.darkLamps})`);
  const iss = computeIssues(tg).map(i => i.text);
  ok(iss.some(t => /manufactory stopped — no power/.test(t)), `issues list the stopped works ("${iss.find(t => /no power/.test(t))}")`);
  for (let k = 0; k < 8 && (sim.recompute(), sim.powerShare < 1); k++) by('windgen', 16);
  ok(mf.working > 0 && !computeIssues(tg).some(i => /no power/.test(i.text)), 'it starts again once the power is back');
  // water: without it a bakery works at reduced output, a clinic reaches
  // less, homes can't expand, and the issues panel says so
  const bak = by('bakery'), cl = by('clinic');
  let n = 0;
  for (const r of tw.residents.values()) if (r.age === 'adult') { r.job = n++ % 2 ? bak.id : cl.id; r.edu = 3; }
  sim.recompute();
  const k0 = bak.working, reach0 = sim.reachOf(cl);
  ok(bak.wet === 2 && cl.wet === 2 && k0 > 0 && reach0 > 0, `the bakery and clinic have running water (bakery at ${Math.round(k0 * 100)}%, clinic reaches ${reach0} units)`);
  const home = [...tw.buildings.values()].find(b => b.type === 'house' && b.wet === 2 && tw.expandOptions(b).length) || (() => { const h = by('house', 16); sim.recompute(); return h && h.wet === 2 && tw.expandOptions(h).length ? h : null; })();
  const grow = home && tw.expandOptions(home)[0];
  tw.removeBuilding(well.id, 0);
  sim.recompute();
  ok(bak.blockers.includes('water') && Math.abs(bak.working - k0 * 0.3) < 1e-9, `without water the bakery works at 30% of that (${Math.round(bak.working * 100)}%)`);
  ok(cl.blockers.includes('water') && sim.reachOf(cl) < reach0, `without water the clinic reaches less (${reach0} → ${sim.reachOf(cl)} units)`);
  ok(computeIssues(tg).some(i => /bakery without water/.test(i.text)), 'issues list the bakery without water');
  ok(home && home.blockers.includes('water') && !tw.expandOptions(home).length && /water/.test(tw.expandBuilding(home.id, grow.dir, grow.kind).reason || ''), "a home that could expand can't once its water is gone");
  // workers: a school with no teachers has no places
  const sch = by('school');
  sim.recompute();
  ok(!sch.workers.length && sim.seatsOf(sch) === 0 && sch.working === 0 && sch.blockers.includes('workers') && computeIssues(tg).some(i => /schoolhouse with no workers/.test(i.text)), 'a school with no teachers has no places, and the issues panel says so');
  // water comes through the mains under the streets: one well anywhere on
  // the roads waters a bakery right across town, but nothing off the roads
  const { runCommand } = await import('../src/commands.js');
  const { townRoadTiles } = await import('../src/ui/working.js');
  const well2 = by('well', 16);
  const fb = near(tw, 'bakery', well2, { r: 60, score: (x, z) => -Math.hypot(x - well2.x, z - well2.z) });
  const fd2 = Math.hypot(fb.x - well2.x, fb.z - well2.z);
  const lone = lot(tw, 'house');
  sim.recompute();
  ok(fb.connected && fb.wet === 2 && !fb.blockers.includes('water') && fd2 > 6, `water reaches a bakery ${fd2.toFixed(0)} units from the well, through the mains`);
  ok(lone && !lone.connected && lone.wet === 0, 'a home on a road that leads nowhere gets no water');
  // power lines can be buried (Underground Cables): street by street or the
  // whole town; the poles come down, the street looks better, saves keep it
  by('windgen', 16);
  sim.recompute();
  rv.rebuild();
  const th = seatOf(tw), a = th.access, poles0 = rv.poles;
  const appeal0 = sim.appeal[cellOf(tw.N, a.x, a.z)];
  tw.setSandbox({ unlockAll: false });
  ok(!runCommand(tg, { t: 'bury', ids: streetOf(tw, a.e) }).ok, 'burying power lines needs Underground Cables');
  tw.setSandbox({ unlockAll: true });
  ok(!runCommand(tg, { t: 'bury', ids: [-1] }).ok, 'a bury command with no such road is refused');
  const r1 = runCommand(tg, { t: 'bury', ids: streetOf(tw, a.e) });
  sim.recompute();
  rv.rebuild();
  ok(r1.ok && r1.n > 0 && rv.poles < poles0 && sim.appeal[cellOf(tw.N, a.x, a.z)] > appeal0, `burying one street takes its poles down (${poles0} → ${rv.poles} poles) and makes it prettier`);
  const r2 = runCommand(tg, { t: 'bury', ids: townRoadTiles(tw) });
  rv.rebuild();
  ok(r2.ok && rv.poles === 0, `burying every line in town leaves no poles (${r2.n} more stretches of road)`);
  const back = deserialize(JSON.parse(JSON.stringify(serialize(tw))));
  ok(townRoadTiles(tw).every(id => back.roads.edges.get(id).buried === 1), 'saves keep the buried power lines');
});

// 3g. curved roads and road selection: a stroke is laid as a smooth curve
// (net.js), splitting the roads it crosses or ends on into junctions;
// curves too tight, roads too close alongside, and anything in the way are
// refused; the surface, junctions and all, is road where it should be and
// villagers keep to it; a click picks a stretch between junctions; plans
// add up costs and refunds and say what can't change and who'd be cut off
await block('3g curved roads', async () => {
  const { surfaceAt, edgeAt, edgesInBox, streetOf, planRoadEdit, applyRoadEdit } = await import('../src/world/streets.js');
  const { routeLine } = await import('../src/sim/path.js');
  const { tightest } = await import('../src/world/geom.js');
  const { RoadsView } = await import('../src/render/roadsView.js');
  const { runCommand } = await import('../src/commands.js');
  const { ROAD_LEVELS, ROAD_SALVAGE } = await import('../src/config.js');
  const tw = World.createNew({ N: 48, seed: 5, name: 'Bendwick' });
  tw.money = 1e6;
  const o = openBox(tw, 12, 12, { x: 12, z: 12 }, 1.5);
  ok(!!o, 'found a free patch for the road checks');
  levelBox(tw, o.x, o.z, 12, 12);
  const P = (x, z) => [o.x + x, o.z + z];
  tw.setSandbox({ unlockAll: true });
  // a cobbled street across the patch (the way in at its west end), a dirt
  // lane curving across it, and a paved street off it, curving away
  const C = street(tw, [P(0.5, 6), P(11.5, 6)], 2);
  const before = tw.roads.edges.size;
  const L = street(tw, [P(2, 10.5), P(3.5, 8), P(5.5, 6), P(7, 4), P(9, 1.5)], 1);
  const Pv = street(tw, [P(9, 6), P(9.3, 8.5), P(10.5, 10.5)], 3);
  tw.setSandbox({ unlockAll: false });
  const deg = (n) => n.edges.length, inPatch = (n) => n.x > o.x && n.x < o.x + 12 && n.z > o.z && n.z < o.z + 12;
  const cross = [...tw.roads.nodes.values()].find(n => inPatch(n) && deg(n) === 4), tee = [...tw.roads.nodes.values()].find(n => inPatch(n) && deg(n) === 3);
  ok(C.length === 1 && L.length === 2 && Pv.length === 1 && tw.roads.edges.size === before + 5, `the lane crosses the street in a junction, the paved street meets it in another (the street now ${tw.roads.edges.size - before - 2} stretches)`);
  ok(cross && Math.hypot(cross.x - (o.x + 5.5), cross.z - (o.z + 6)) < 0.3 && tee && Math.hypot(tee.x - (o.x + 9), tee.z - (o.z + 6)) < 0.45, 'the junctions are where the roads meet');
  const lane = L.map(id => tw.roads.edges.get(id));
  ok(lane.every(e => e.pts.length > 8 && tightest(e.pts, 0.2) >= 0.32), `the lane is a smooth curve (${lane.map(e => e.pts.length).join(' + ')} points, its tightest bend ${Math.min(...lane.map(e => tightest(e.pts, 0.2))).toFixed(2)} across)`);
  // refusals
  const zig = tw.checkRoad([P(1, 1), P(1.6, 1.2), P(1.1, 1.5), P(1.7, 1.8)], 1);
  ok(!zig.ok && /tight/.test(zig.reason), `a bend too tight to drive is refused ("${zig.reason}")`);
  const along = tw.checkRoad([P(1.5, 6.45), P(4.5, 6.45)], 1);
  ok(!along.ok && /alongside/.test(along.reason), `a road too close alongside another is refused ("${along.reason}")`);
  // the surface: road along the middle, verge beyond, the junction filled
  const e0 = lane[0], m = pointAt(e0.pts, e0.cum, e0.len / 2), nx = -m[4], nz = m[3];
  ok(surfaceAt(tw, m[0], m[1]) > 0 && surfaceAt(tw, m[0] + nx * (HALF[1] - 0.03), m[1] + nz * (HALF[1] - 0.03)) > 0 && surfaceAt(tw, m[0] + nx * (HALF[1] + 0.04), m[1] + nz * (HALF[1] + 0.04)) === 0, 'the lane is road out to its edges, and grass beyond');
  ok(surfaceAt(tw, cross.x, cross.z) > 0 && surfaceAt(tw, tee.x + 0.12, tee.z + 0.12) > 0, 'and the junctions are road right across');
  // the way in, at the street's west end
  const west = tw.roads.nodeNear(o.x + 0.5, o.z + 6, 0.2);
  tw.entry = { node: west.id, x: west.x, z: west.z };
  tw.updateRoadNetwork();
  ok([...tw.roads.edges.values()].filter(e => edgesInBox(tw, [o.x, o.z, o.x + 12, o.z + 12]).includes(e.id)).every(e => tw.edgeConnected(e.id)), 'every stretch reaches the way in');
  // houses along the lane and the paved street, facing them at whatever angle
  const H1 = near(tw, 'house', { x: o.x + 7.6, z: o.z + 3.2 }, { r: 1.6, test: (x, z) => z < o.z + 5 });
  const H2 = near(tw, 'house', { x: o.x + 10.2, z: o.z + 9.5 }, { r: 1.8 });
  ok(H1 && H2 && H1.access.e === L.find(id => tw.roads.edges.get(id).pts.some(p => p[1] < o.z + 3)) && tw.roads.edges.get(H2.access.e).level === 3, 'a house faces the lane and another the paved street, each on its own stretch');
  ok([H1, H2].every(b => Math.abs(Math.sin(2 * b.a)) > 0.05), `and stand turned to them, not to the compass (${H1.a.toFixed(2)}, ${H2.a.toFixed(2)})`);
  // villagers walking between them keep to the road, either side of it
  const pf = new PathFinder(tw);
  const route = pf.road(H1.access, H2.access);
  const sides = route ? [0.08, -0.08].map(off => routeLine(tw.roads, route, off)) : [];
  ok(route && route.pieces.length >= 3 && sides.every(pts => pts.length > 20 && pts.every(([x, z]) => surfaceAt(tw, x, z) > 0)), `the way between them runs along the curves and through the junctions, and either side of it stays on the road (${route ? route.pieces.length : 0} stretches)`);
  const view = new RoadsView(tw, scene);
  ok([...view.surface.geometry.attributes.position.array].every(Number.isFinite) && view.surface.geometry.attributes.position.count > 0, 'curved road surfaces and their junctions build cleanly');
  view.dispose();
  // picking
  ok(edgeAt(tw, m[0], m[1]) === e0 && !edgeAt(tw, o.x + 1, o.z + 1), 'a click picks the stretch it lands on; grass picks nothing');
  const st = streetOf(tw, lane[0].id);
  ok(st.length === 2 && st.includes(lane[1].id), 'the street a stretch is part of carries on through the junction the way it runs, not round the corner');
  const all = edgesInBox(tw, [o.x, o.z, o.x + 12, o.z + 12]);
  ok(all.length === 6, `a box picks every stretch in it (${all.length})`);
  // plans: costs, refunds, what can't change and why
  const dirt = L, paved = Pv, cob = [...tw.roads.edges.values()].find(e => e.level === 2 && [e.a, e.b].includes(cross.id) && [e.a, e.b].includes(tee.id)).id;
  const locked = planRoadEdit(tw, all, 'up');
  ok(locked.n === 0 && locked.blocked.some(b => /Unlocks at 25/.test(b.reason)) && locked.blocked.some(b => /paved/.test(b.reason)), 'upgrades wait for their unlock, and paved streets go no higher');
  tw.setSandbox({ unlockAll: true });
  const up = planRoadEdit(tw, all, 'up');
  const groups = new Map();
  for (const id of all) { const e = tw.roads.edges.get(id); if (e.level < 3) groups.set(e.level + 1, (groups.get(e.level + 1) || 0) + (ROAD_LEVELS[e.level + 1].cost - ROAD_LEVELS[e.level].cost) * e.len); }
  const want = [...groups.values()].reduce((s, v) => s + Math.round(v), 0);
  ok(up.n === 5 && up.cost === want && up.blocked.length === 1 && up.blocked[0].n === 1, `upgrading the lot costs each step over its length ($${up.cost}); the paved street is skipped`);
  const down = planRoadEdit(tw, [...dirt, ...paved], 'down');
  const dw = Math.round((ROAD_LEVELS[3].cost - ROAD_LEVELS[2].cost) * tw.roads.edges.get(paved[0]).len * ROAD_SALVAGE);
  ok(down.n === 1 && down.refund === dw && down.blocked[0].n === 2, `downgrading pays back a quarter of the difference ($${down.refund}); dirt can't go lower`);
  const rm = planRoadEdit(tw, [cob], 'remove');
  ok(rm.n === 1 && rm.refund === tw.removeCheck(cob).refund && rm.refund === Math.round(ROAD_LEVELS[2].cost * tw.roads.edges.get(cob).len * ROAD_SALVAGE), `taking up a cobbled stretch pays back $${rm.refund}`);
  const entry = planRoadEdit(tw, [west.edges[0]], 'remove');
  ok(entry.n === 0 && /outside world/.test(entry.blocked[0].reason), 'the road to the outside world must stay');
  // who would be cut off: a coach line between the two houses
  tw.lines.push({ id: 9999, mode: 'coach', name: 'Test Line', color: '#fff', stops: [H1.id, H2.id], vehicles: 1 });
  const rec0 = JSON.stringify(tw.roads.toRec());
  const cutPaved = planRoadEdit(tw, paved, 'remove', { paths: pf });
  ok(cutPaved.lost.includes(H2.id) && !cutPaved.lost.includes(H1.id) && cutPaved.lines.includes(9999), 'taking up the paved street leaves its house without a road and the coach line without a route');
  const cutMid = planRoadEdit(tw, [cob], 'remove', { paths: pf });
  ok(!cutMid.lost.length && cutMid.lines.includes(9999) && cutMid.cut.includes(H2.id), 'taking up the stretch between the junctions breaks the line too, and cuts the paved street\'s house off from the way out');
  const tail = tw.roads.nodeNear(o.x + 11.5, o.z + 6, 0.2).edges[0];
  ok(!planRoadEdit(tw, [tail], 'remove', { paths: pf }).lines.length && !planRoadEdit(tw, [tail], 'remove', { paths: pf }).detour.length, 'a stretch the line does not need leaves it alone');
  const fwd = [...tw.buildings.values()].find(b => b.front > 0 && all.includes(b.access?.e));
  ok(!fwd || planRoadEdit(tw, [fwd.access.e], 'remove').back.includes(fwd.id), 'a house standing forward into the street would step back');
  ok(JSON.stringify(tw.roads.toRec()) === rec0, 'plans change nothing');
  // doing it
  tw.money = 3;
  const poor = applyRoadEdit(tw, dirt, 'up');
  ok(!poor.ok && poor.reason === 'Not enough money' && tw.roads.edges.get(dirt[0]).level === 1 && tw.money === 3, 'an upgrade the town cannot afford changes nothing');
  tw.money = 1000;
  const cost = planRoadEdit(tw, dirt, 'up').cost;
  const did = applyRoadEdit(tw, dirt, 'up');
  ok(did.ok && did.n === 2 && did.cost === cost && tw.money === 1000 - cost && dirt.every(id => tw.roads.edges.get(id).level === 2), `upgrading the lane makes it cobbled and costs $${cost}`);
  const g2 = { world: tw, demo: false, emit() {} };
  ok(!runCommand(g2, { t: 'roadedit', op: 'paint', ids: dirt }).ok, 'the roadedit command refuses unknown actions');
  const m1 = tw.money, gone = runCommand(g2, { t: 'roadedit', op: 'remove', ids: [cob] });
  ok(gone.ok && gone.refund === rm.refund && tw.money === m1 + rm.refund && !tw.roads.edges.has(cob) && !H2.connected, 'taking the stretch up through the command pays back its refund, and the paved street is cut off');
  const m2 = tw.money, back = tw.removeCheck(tail).refund;
  ok(runCommand(g2, { t: 'unroad', e: tail }).ok && tw.money === m2 + back, 'taking up a single stretch pays back too');
});

// 3h. dressing a street: trees, hedges, lamps or a planted median priced by
// its length, kept off junctions, corners and driveways, liked by the
// neighbours, saved, and taken away with the road; and no boulevards (two
// roads side by side make one only on squares)
await block('3h street dressing', async () => {
  const { planDress, applyDress, dressSpots, plainLamps, planRoadEdit, applyRoadEdit, lengthOf } = await import('../src/world/streets.js');
  const { runCommand } = await import('../src/commands.js');
  const { DRESSINGS, dressRefund, ROAD_LEVELS, ROAD_SALVAGE } = await import('../src/config.js');
  const { doorPoint } = await import('../src/world/world.js');
  const tw = World.createNew({ N: 48, seed: 12, name: 'Avenue End' });
  tw.money = 1e6;
  const o = openBox(tw, 12, 10, { x: 12, z: 12 }, 1.5);
  levelBox(tw, o.x, o.z, 12, 10);
  const P = (x, z) => [o.x + x, o.z + z];
  // a paved street bending across the patch, a cobbled one down from it
  // curving east, and a cottage beside the paved street
  const paved = street(tw, [P(0.5, 2.5), P(5, 2), P(11.5, 3)], 3);
  const cob = street(tw, [P(5, 2.05), P(5.3, 6), P(8, 8.5)], 2);
  const H = near(tw, 'house', { x: o.x + 2.5, z: o.z + 3.4 }, { r: 1.2, conn: false });
  const all = [...tw.roads.edges.keys()].filter(id => edgesNear(id));
  function edgesNear(id) { const e = tw.roads.edges.get(id); return e.pts.every(([x, z]) => x >= o.x - 0.1 && x <= o.x + 12.1 && z >= o.z - 0.1 && z <= o.z + 10.1); }
  const pv = all.filter(id => tw.roads.edges.get(id).level === 3), cb = all.filter(id => tw.roads.edges.get(id).level === 2);
  ok(H && pv.length === 2 && cb.length === 1, `the paved street meets the cobbled one in a junction (${pv.length} + ${cb.length} stretches), a cottage beside it`);
  const units = (ids) => ids.reduce((s, id) => s + Math.max(1, Math.round(tw.roads.edges.get(id).len)), 0);
  const early = planDress(tw, all, 1);
  ok(!early.n && /Unlocks at 25/.test(early.blocked[0].reason) && planDress(tw, all, 2).n === all.length, 'avenues wait for a village; hedges can go in from the start');
  tw.setSandbox({ unlockAll: true });
  const med = planDress(tw, all, 4);
  ok(med.n === pv.length && med.blocked[0].reason === 'Only on paved streets', 'a planted median only goes down paved streets');
  const trees = planDress(tw, all, 1);
  ok(trees.n === all.length && trees.cost === units(all) * DRESSINGS[1].cost, `an avenue costs $${DRESSINGS[1].cost} a unit of street ($${trees.cost} for ${units(all)})`);
  const BLVD = DRESSINGS.findIndex(d => d && d.blvd);
  ok(BLVD > 0 && /squares/.test(planDress(tw, all, BLVD).blocked[0].reason), 'boulevard looks are for towns on squares: here a street is dressed instead');
  // the cottage's appeal before and after (the sim adds it up)
  const sim = new Sim(listen(tw));
  sim.recompute();
  const hi = cellOf(tw.N, H.x, H.z), before = sim.appeal[hi], m0 = tw.money, forward = H.front;
  sim._budget();
  const upkeep0 = sim.budget.expense.roads;
  ok(applyDress(tw, all, 1).ok && tw.money === m0 - trees.cost && all.every(id => tw.roads.edges.get(id).dress === 1), 'the avenue is planted and paid for');
  sim.recompute();
  sim._budget();
  ok(sim.appeal[hi] > before + 1, `the cottage beside it likes it (appeal ${before.toFixed(1)} → ${sim.appeal[hi].toFixed(1)})`);
  ok(Math.abs(sim.budget.expense.roads - upkeep0 - lengthOf(tw, all) * DRESSINGS[1].upkeep) < 1e-6, 'and the avenue has its upkeep, by its length');
  let sp = dressSpots(tw);
  const knots = [...tw.roads.nodes.values()].filter(n => n.edges.length > 2 || n.edges.length === 1);
  const clearOf = (list, r) => list.every(p => knots.every(n => Math.hypot(p.x - n.x, p.z - n.z) > r));
  ok(sp.trees.length > 10 && clearOf(sp.trees, 0.4), `street trees (${sp.trees.length}) stand clear of the junction and the ends`);
  const door = doorPoint(H);
  ok(forward > 0 && trees.back.includes(H.id) && H.front === 0, `the cottage that stood forward into the street (${forward}) steps back behind its trees`);
  ok(sp.trees.every(p => Math.hypot(p.x - door.x, p.z - door.z) > 0.2), 'and they leave the cottage its driveway');
  // hedges instead along the paved street: a quarter of the trees back
  const m1 = tw.money, hedge = applyDress(tw, pv, 2);
  ok(hedge.ok && hedge.refund === units(pv) * dressRefund(1) && tw.money === m1 - hedge.spent + hedge.refund, 'swapping trees for hedges pays back a quarter of the trees');
  sp = dressSpots(tw);
  ok(sp.hedges.length > 50 && sp.hedges.every(p => Math.hypot(p.x - door.x, p.z - door.z) > 0.13) && clearOf(sp.hedges, 0.3), `hedges (${sp.hedges.length} plants) run along the street with gaps at the junction and the driveway`);
  // lamps down the cobbled street, instead of its plain ones
  const plainOn = (ids) => plainLamps(tw).filter(p => { const h = tw.roads.nearest(p.x, p.z, 0.6); return h && ids.includes(h.e.id); }).length;
  ok(plainOn(cb) > 0, `a plain cobbled street has its street lamps (${plainOn(cb)})`);
  applyDress(tw, cb, 3);
  sp = dressSpots(tw);
  ok(sp.lamps.length >= 3 && !plainOn(cb), `a lamp-lit street has its own lamps (${sp.lamps.length}) and none of the plain ones`);
  // a planted median down the paved street
  applyDress(tw, pv, 4);
  sp = dressSpots(tw);
  ok(sp.medians.length === pv.length && sp.shrubs.length > 6 && sp.medians.every(md => md.pts.every(([x, z]) => knots.every(n => Math.hypot(x - n.x, z - n.z) > 0.4))), 'the median runs down the paved street, stopping short of the junction and the ends');
  ok(planRoadEdit(tw, pv, 'down').undressed === pv.length, 'downgrading below paving would take the median off');
  applyRoadEdit(tw, [pv[0]], 'down');
  ok(tw.roads.edges.get(pv[0]).dress === 0 && tw.roads.edges.get(pv[0]).level === 2, 'and does');
  // saved, sent to guests through the command, and gone with the road
  const back = deserialize(JSON.parse(JSON.stringify(serialize(tw))));
  ok(all.every(id => back.roads.edges.get(id).dress === tw.roads.edges.get(id).dress) && all.some(id => back.roads.edges.get(id).dress), 'saves keep the dressed streets');
  const g2 = { world: tw, demo: false, emit() {} };
  ok(!runCommand(g2, { t: 'dress', kind: DRESSINGS.length, ids: cb }).ok && runCommand(g2, { t: 'dress', kind: 0, ids: [pv[1]] }).ok && !tw.roads.edges.get(pv[1]).dress, 'the dress command refuses unknown kinds and can take a dressing away');
  const m2 = tw.money, rc = tw.removeCheck(cb[0]), ce = tw.roads.edges.get(cb[0]);
  const want = Math.round(ROAD_LEVELS[2].cost * ce.len * ROAD_SALVAGE + dressRefund(3) * Math.max(1, Math.round(ce.len)));
  ok(rc.ok && rc.refund === want && tw.removeRoadEdge(cb[0]) === true && tw.money === m2 + want, `taking a lamp-lit street up takes its lamps too (a quarter of both back: ${want})`);
});

// 3j. free placement: a building stands anywhere, at any angle, its front
// to a street within reach: placed facing the road by itself, turned by the
// player (as far as it still faces a street, a park any way), moved to a new
// spot and angle; its plot is a turned rectangle that nothing overlaps; its
// model stays on its plot whatever the angle, its door at the front; the
// angle is saved
await block('3j free placement', async () => {
  const { runCommand } = await import('../src/commands.js');
  const { doorPoint } = await import('../src/world/world.js');
  const { auditTown } = await import('./audit.js');
  // every one-plot building's model stays on its plot (and the verge it may
  // come forward into), and its door at the front, at any angle
  let tried = 0, worst = 0, at = '', doors = 0, wrongDoor = 0;
  for (const [type, def] of Object.entries(BUILDINGS)) {
    // (not one that reaches over the water, a pier, on purpose, nor a farm's fields)
    if (def.size !== 1 || def.merged || def.needsWater || def.fields) continue;
    for (const [i, a] of [-2.4, -0.7, 0.35, 1.1, 2.9].entries()) {
      const front = i % 2 ? 0.16 : 0;
      const b = { type, level: def.levels.length - 1, variant: 11 + i, size: 1, w: 1, d: 1, x: 10.3, z: 7.7, a, baseY: 0.5, minY: 0.5, front, rail: def.needsRail ? { k: 2 } : null };
      const m = buildModel(b), R = rect(b.x, b.z, a, 0.5, 0.5);
      tried++;
      for (const [wx, wz] of m.foot) {
        const [lx, lz] = toLocal(R, wx, wz), out = Math.max(Math.abs(lx) - 0.5, -lz - 0.5, lz - 0.5 - front);
        if (out > worst) { worst = out; at = `${type} L${b.level} at ${a}`; }
      }
      // (an open-air place's door, a pavilion's on the courts, say, isn't the way in)
      if (m.door && !def.outdoor && !def.park) {
        doors++;
        const wdx = m.door.dx * Math.cos(a) + m.door.dz * Math.sin(a), wdz = -m.door.dx * Math.sin(a) + m.door.dz * Math.cos(a);
        if (wdx * Math.sin(a) + wdz * Math.cos(a) < 0.7) wrongDoor++;
      }
    }
  }
  ok(tried > 150 && worst < 0.003, `at any angle, every one-plot building stays on its plot and the verge it comes forward into (${tried} tried, at most ${worst.toFixed(4)} over${worst > 0.003 ? ': ' + at : ''})`);
  ok(doors > 100 && !wrongDoor, `and its door faces out of its front (${doors} doors)`);
  // in a town: a curving street, houses along it
  const tw = World.createNew({ N: 48, seed: 61, name: 'Turnham' });
  tw.money = 1e6;
  tw.setSandbox({ unlockAll: true, instantBuild: true });
  const o = openBox(tw, 12, 9, { x: 12, z: 12 }, 1.5);
  levelBox(tw, o.x, o.z, 12, 9);
  street(tw, [[o.x + 0.5, o.z + 4], [o.x + 4, o.z + 3], [o.x + 8, o.z + 5.5], [o.x + 11.5, o.z + 4.5]], 2);
  const e = [...tw.roads.edges.values()].find(e => e.pts.some(([x, z]) => Math.abs(x - o.x - 6) < 0.5 && z > o.z + 3.5));
  const s = e.len * 0.45, p = pointAt(e.pts, e.cum, s), nx = -p[4], nz = p[3];
  // a cottage dropped beside the curve faces it by itself, square to it
  const cx = p[0] + nx * (SETBACK + 0.5), cz = p[1] + nz * (SETBACK + 0.5);
  const cg = { world: tw, demo: false };
  const pr = runCommand(cg, { t: 'place', type: 'house', x: cx, z: cz });
  const hb = pr.building, want = Math.atan2(-nx, -nz);
  ok(pr.ok && Math.abs(wrapAngle(hb.a - want)) < 0.01 && Math.abs(Math.sin(2 * hb.a)) > 0.05 && hb.connected !== undefined && hb.access && hb.access.e === e.id, `a cottage put down beside a curving street turns to face it, square to the curve (${hb ? hb.a.toFixed(3) : pr.reason})`);
  const dp = doorPoint(hb), [dlx, dlz] = toLocal(plotOf(hb), dp.x, dp.z);
  ok(Math.abs(dlx) < 1e-6 && Math.abs(dlz - 0.5) < 1e-6, 'its door step is the middle of its front');
  // inside its turned plot, and not the box round it
  const [ix, iz] = toWorld(ownPlot(hb), 0.45, 0.45), [ox2, oz2] = toWorld(ownPlot(hb), 0.56, 0);
  ok(tw.buildingAt(ix, iz) === hb && tw.buildingAt(ox2, oz2) !== hb, 'what stands where follows its turned plot');
  // placed turned on purpose, and refused turned away from the street
  const s2 = Math.min(e.len - 0.6, s + 1.6), p2 = pointAt(e.pts, e.cum, s2), x2 = p2[0] - p2[4] * (SETBACK + 0.5), z2 = p2[1] + p2[3] * (SETBACK + 0.5), a2 = Math.atan2(p2[4], -p2[3]);
  const askew = runCommand(cg, { t: 'place', type: 'house', x: x2, z: z2, a: a2 + 0.3 });
  ok(askew.ok && Math.abs(wrapAngle(askew.building.a - a2 - 0.3)) < 0.002, `a building can be placed turned a little from square to its street (${askew.reason || askew.building.a})`);
  const away = tw.checkBuild('house', x2 + 3 * p2[3], z2 + 3 * p2[4], { a: a2 + PI / 2 });
  ok(!away.ok && /street|road/i.test(away.reason), `turned to face away from every street, it is refused ("${away.reason}")`);
  // turning: by the command, as far as it still faces a street
  let refits = 0;
  tw.on('building:refit', (b) => { if (b === hb) refits++; });
  const a0 = hb.a;
  ok(runCommand(cg, { t: 'turn', id: hb.id, a: a0 - 0.25 }).ok && Math.abs(wrapAngle(hb.a - a0 + 0.25)) < 0.002 && refits === 1 && hb.access, 'turned a little, it is rebuilt where it stands, still on its street');
  ok(!runCommand(cg, { t: 'turn', id: hb.id, a: a0 + PI }).ok && !runCommand(cg, { t: 'turn', id: hb.id, a: 'west' }).ok, 'turned its back to the street, or by no angle at all, it is refused');
  // a park needs no street: it turns any way
  const gd = near(tw, 'garden', hb, { r: 3, conn: false });
  ok(gd && tw.turnBuilding(gd.id, gd.a + 2.2).ok, 'a garden can be turned any way at all');
  // turning into a neighbour is refused
  const [nbx, nbz] = besideAt(hb, 'house', 1), nb = tw.placeBuilding('house', nbx, nbz, { a: hb.a });
  ok(!nb.ok || !tw.turnBuilding(hb.id, hb.a + 0.6).ok, 'turning it into the plot next door is refused');
  // moved, with its new angle, by the builders
  tw.research.done.push('relocation');
  const dest = findPlot(tw, 'house', { x: o.x + 10, z: o.z + 6 }, { r: 3 });
  const mv = dest && runCommand(cg, { t: 'move', id: askew.building.id, x: dest.x, z: dest.z, a: dest.a });
  ok(mv && mv.ok && Math.abs(wrapAngle(mv.building.a - dest.a)) < 0.002, 'a move takes it to a new spot at a new angle');
  // nothing overlaps, and the angle is saved and loaded
  const faults = [];
  auditTown(tw, (m) => faults.push(m));
  ok(!faults.length, `no plots overlap, turned or not${faults.length ? ': ' + faults.join('; ') : ''}`);
  const back = deserialize(JSON.parse(JSON.stringify(serialize(tw))));
  ok([...tw.buildings.values()].every(b => { const c = back.buildings.get(b.id); return c && c.a === b.a && c.x === b.x && c.z === b.z; }), 'where each building stands and its angle are saved and loaded');
  ok(!runCommand(cg, { t: 'place', type: 'house', x: -3, z: 5 }).ok && !runCommand(cg, { t: 'place', type: 'house', x: 5, z: 5, a: 'north' }).ok, 'a place command off the map, or with no angle at all, is refused');
});

// 3z. every method the UI, game and input code call on themselves exists
// (a missing one only shows up as a frozen game in the browser)
{
  const fsm = await import('node:fs');
  const missing = [];
  const esc = (s) => s.replace(/[$]/g, '[$]');
  for (const f of ['src/ui/ui.js', 'src/game.js', 'src/ui/input.js', 'src/render/worldView.js', 'src/sim/construction.js', 'src/world/world.js', 'src/sim/sim.js', 'src/sim/agents.js', 'src/net/session.js', 'src/net/sync.js', 'src/net/cursors.js', 'src/world/net.js', 'src/sim/transit.js']) {
    const src = fsm.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    const called = new Set([...src.matchAll(/this\.([A-Za-z_$][\w$]*)\(/g)].map(m => m[1]));
    for (const name of called) {
      const n = esc(name);
      const defined = new RegExp('^\\s+(?:static\\s+|async\\s+|get\\s+)?' + n + '\\s*\\(', 'm').test(src) || new RegExp('this\\.' + n + '\\s*=').test(src);
      if (!defined) missing.push(f + ': this.' + name + '()');
    }
  }
  ok(!missing.length, 'no calls to missing methods' + (missing.length ? ': ' + missing.join(', ') : ''));
}

// 4. save round-trip
{
  const data = serialize(w);
  const json = JSON.stringify(data);
  const w2 = deserialize(JSON.parse(json));
  ok(data.version === 2, `saves are version ${data.version}, roads and track as curves`);
  ok(w2.buildings.size === w.buildings.size, `save round-trip buildings (${w.buildings.size}) — ${(json.length / 1024).toFixed(0)} KB`);
  ok(w2.residents.size === w.residents.size, `save round-trip residents (${w.residents.size})`);
  ok(w2.trees.length === w.trees.length, `save round-trip trees (${w.trees.length})`);
  ok(w2.lines.length === w.lines.length, 'save round-trip lines');
  ok(JSON.stringify(w2.research.done) === JSON.stringify(w.research.done), 'save round-trip research');
  const sig = (b) => JSON.stringify([b.type, b.x, b.z, b.a, b.w, b.d, b.look || null, b.leases && b.leases.length ? b.leases : [], b.ext && (b.ext.x0 || b.ext.x1 || b.ext.z0 || b.ext.z1) ? b.ext : null]);
  const diff = [...w.buildings.values()].filter(b => !w2.buildings.get(b.id) || sig(w2.buildings.get(b.id)) !== sig(b));
  ok(!diff.length, `save round-trip plots, angles, styles and land deals${diff.length ? ': ' + diff.slice(0, 2).map(b => sig(b) + ' → ' + (w2.buildings.get(b.id) ? sig(w2.buildings.get(b.id)) : 'gone')).join('; ') : ''}`);
  ok(JSON.stringify(w2.roads.toRec()) === JSON.stringify(w.roads.toRec()) && w2.roads.edges.size === w.roads.edges.size, `save round-trip roads (${w.roads.edges.size} stretches, ${w.roads.nodes.size} junctions and ends)`);
  ok([...w.buildings.values()].every(b => { const c = w2.buildings.get(b.id); return !!c.access === !!b.access && c.connected === b.connected; }), 'and every building finds its way to the street again');
  let same = true;
  for (let i = 0; i < w.terrain.H.length; i++) if (Math.abs(w.terrain.H[i] - w2.terrain.H[i]) > 0.001) same = false;
  ok(same, 'save round-trip heights');
}

// 4b. a town saved by the main game, on its grid of squares, loads here: its
// plots become rectangles facing the four ways, its road squares curves
// through their middles, its fields squares of farmland, and nothing overlaps
await block('4b saves from the grid', async () => {
  const fsm = await import('node:fs');
  const { auditTown } = await import('./audit.js');
  const old = JSON.parse(fsm.readFileSync(new URL('./fixtures/grid-town.json', import.meta.url), 'utf8'));
  ok(old.version === 1 && Array.isArray(old.buildings), `the main game's save (version ${old.version}, ${old.buildings.length} buildings)`);
  const tw = deserialize(JSON.parse(JSON.stringify(old)));
  ok(tw.buildings.size === old.buildings.length, `every building comes over (${tw.buildings.size})`);
  const square = [...tw.buildings.values()].filter(b => Math.abs(Math.sin(2 * b.a)) < 1e-3).length;
  ok(square >= tw.buildings.size - 3, `each standing as it did, facing one of the four ways (${square} of ${tw.buildings.size}; any others turned to reach their street)`);
  const faults = [];
  auditTown(tw, (m) => faults.push(m));
  ok(!faults.length, `nothing overlaps, nor stands on a road${faults.length ? ': ' + faults.slice(0, 5).join('; ') : ''}`);
  const built = [...tw.buildings.values()].filter(b => !BUILDINGS[b.type].park), conn = built.filter(b => b.connected).length;
  ok(conn === built.length, `and reaches its street as it did (${conn} of the ${built.length} that aren't parks on the roads to the way out)`);
  ok(tw.roads.edges.size > 5 && [...tw.roads.edges.values()].every(e => e.level === 2) && tw.connected.size === tw.roads.nodes.size, `the streets come over as curves (${tw.roads.edges.size} stretches), cobbled as they were, all reaching the way out`);
  const oldFields = old.buildings.filter(r => BUILDINGS[r[1]] && BUILDINGS[r[1]].fields).length;
  ok(tw.parcels.size > 0 && [...tw.parcels.values()].every(f => tw.buildings.get(f.farm)) && oldFields > 0, `its fields come over as farmland squares (${tw.parcels.size})`);
  ok(tw.residents.size === (old.residents || []).length && Math.round(tw.money) === Math.round(old.state.money), 'with its people and its money');
  // and saves in the new way, and loads again the same
  const again = serialize(tw), back = deserialize(JSON.parse(JSON.stringify(again)));
  ok(again.version === 2 && back.buildings.size === tw.buildings.size && JSON.stringify(back.roads.toRec()) === JSON.stringify(tw.roads.toRec()), 'saved again, it is a gridless save, and loads the same');
  // a sim runs on it
  const g = listen(back), sim = new Sim(g);
  sim.recompute();
  ok(Number.isFinite(sim.happiness) && back.population > 0, `the sim runs on it (happiness ${Math.round(sim.happiness)})`);
});

// 5. snow: only in winter; a fall lays fresh snow on roads and roofs, and it
// melts away again within the day (the same for everyone from the weather)
{
  const { freshSnowAt, coverAt } = await import('../src/render/sky.js');
  const { seasonOf } = await import('../src/config.js');
  let summer = 0, peak = 0, clear = 0, winterHours = 0;
  for (let day = 1; day <= 48; day++) for (let h = 0; h < 24; h += 0.5) {
    const f = freshSnowAt(77, day, h);
    if (seasonOf(day) !== 3) { summer = Math.max(summer, f, coverAt(day, h)); continue; }
    winterHours++; peak = Math.max(peak, f); if (f < 0.02) clear++;
  }
  ok(summer === 0 && peak > 0.6 && clear > winterHours * 0.3, `fresh snow only in winter: up to ${peak.toFixed(2)} after a fall, gone again ${Math.round((clear / winterHours) * 100)}% of winter hours`);
  // the seasons turn gradually: each holds for its first half, then shades
  // into the next, ending where the next begins
  const { seasonBlend } = await import('../src/render/sky.js');
  const { CONFIG } = await import('../src/config.js');
  const D = CONFIG.DAYS_PER_SEASON;
  let jump = 0;
  for (let t = 0.25; t < 8 * D * 24; t += 0.25) {
    const day = 1 + Math.floor(t / 24), h = t % 24, pd = 1 + Math.floor((t - 0.25) / 24), ph = (t - 0.25) % 24;
    const look = (d, hh) => seasonOf(d) + seasonBlend(d, hh);   // seasons and the turn between, on one scale
    let a = look(pd, ph), b = look(day, h);
    if (b < a - 2) b += 4;   // winter into spring
    jump = Math.max(jump, Math.abs(b - a));
  }
  ok(seasonBlend(1, 12) === 0 && seasonBlend(D / 2, 0) === 0 && seasonBlend(D, 23.9) > 0.97 && jump < 0.03, `seasons hold for half their days, then turn gradually (largest step in a quarter hour ${jump.toFixed(3)})`);
}

// ---- on a slope no building is buried in the hill (world.js floorHeight),
// whichever way it is turned
{
  const { floorHeight, groundUnder } = await import('../src/world/world.js');
  const { rectSamples } = await import('../src/world/geom.js');
  const hw = World.createNew({ N: 48, seed: 174231, name: 'Hillby' }), t = hw.terrain;
  let worst = 0, door = 0, n = 0;
  for (const [type, W, D] of [['house', 1, 1], ['terrace', 2, 1], ['quadrangle', 2, 2]]) {
    for (let z = 3; z < 45; z += 2) for (let x = 3; x < 45; x += 2) for (const a of [0, PI / 2, 0.6, -2.2]) {
      const R = rect(x + 0.3, z + 0.7, a, W / 2, D / 2), g = groundUnder(t, R);
      if (g.water || !(g.maxH > g.minH) || g.maxH - g.minH > 1.1) continue;
      const f = floorHeight(t, type, R, g.minH, g.maxH);
      n++;
      for (const [px, pz] of [...rectSamples(R, 0.25, 0.08), [R.cx, R.cz]]) worst = Math.max(worst, t.heightAt(px, pz) - f);
      const [dx, dz] = toWorld(R, 0, R.hd);
      door = Math.max(door, t.heightAt(dx, dz) - f);
    }
  }
  ok(n > 500 && worst < 0.012 && door < 0.025, `on sloping ground no building's walls are buried, at any angle (${n} plots and turns: the ground stands at most ${worst.toFixed(3)} above the floor, ${door.toFixed(3)} at the door)`);
}

// ---- saves in the browser are packed (src/save/pack.js)
{
  const { pack, unpack, isPacked } = await import('../src/save/pack.js');
  const rnd = (n, max, seed) => { let x = seed, s = ''; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; s += String.fromCharCode(x % max); } return s; };
  const cases = ['', 'a', 'aaaaaaaaaaaaaaaaaaaaaaaa', 'abababababababab', 'Zoë Ñúñez — 🏰 and a lone \ud800 surrogate', rnd(6000, 65536, 1), rnd(150000, 40, 2), rnd(120000, 65536, 3), 'x'.repeat(60000) + rnd(30000, 300, 4)];
  const plain = (p) => { for (let i = 5; i < p.length; i++) { const c = p.charCodeAt(i); if (c < 32 || c > 0x801f) return false; } return true; };
  const bad = cases.filter(c => { const p = pack(c); return !isPacked(p) || unpack(p) !== c || !plain(p); });
  ok(!bad.length, `packing a save round-trips any text, every packed character a plain one (${cases.length} cases${bad.length ? ', failed: ' + bad.map(c => c.length).join(', ') : ''})`);
  const w = World.createNew({ N: 48, seed: 99, name: 'Packby' });
  const text = JSON.stringify(serialize(w)), p = pack(text);
  ok(unpack(p) === text && p.length < text.length * 0.6 && unpack(text) === text, `a town's save packs to ${Math.round(100 * p.length / text.length)}% and back, and an unpacked (older) save reads as it is`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
