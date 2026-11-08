// Grows a lived-in village automatically — used behind the title screen
// (and by the tests): lanes wandering out from the streets already there,
// each bending a little as it goes, and buildings lined up along them.

import { RNG } from '../util/rng.js';
import { BUILDINGS, TECHS } from '../defs.js';
import { pointAt, angleOf } from './geom.js';
import { sizeOf, SETBACK } from './world.js';

const FREE = { free: true, ignoreMoney: true, ignoreUnlock: true, instant: true };

export function growDemoTown(world, seed, size = 1) {
  const rng = new RNG(seed);
  world.research.done = Object.keys(TECHS);
  const N = world.N;
  let start = null;
  for (const b of world.buildings.values()) if (BUILDINGS[b.type].seat) start = { x: b.x, z: b.z };
  start ||= { x: N / 2, z: N / 2 };
  const R = 9 + 4 * size;
  const money = world.money;
  world.money = Infinity;

  // streets: out from a point along a street there already, square to it,
  // bending gently
  const near = () => [...world.roads.edges.values()].filter(e => e.pts.some(p => Math.hypot(p[0] - start.x, p[1] - start.z) < R));
  for (let k = 0; k < 26 * size; k++) {
    const es = near();
    if (!es.length) break;
    const e = rng.pick(es);
    if (e.len < 1.4) continue;
    const s = rng.float(0.7, e.len - 0.7), p = pointAt(e.pts, e.cum, s);
    if (Math.hypot(p[0] - start.x, p[1] - start.z) > R) continue;
    const side = rng.chance(0.5) ? 1 : -1, nx = -p[4] * side, nz = p[3] * side;
    const len = rng.float(3, 7), bend = rng.float(-0.35, 0.35);
    const mid = [p[0] + nx * len * 0.5 + p[3] * bend * len * 0.3, p[1] + nz * len * 0.5 + p[4] * bend * len * 0.3];
    const end = [p[0] + (nx * Math.cos(bend) + p[3] * Math.sin(bend)) * len, p[1] + (nz * Math.cos(bend) + p[4] * Math.sin(bend)) * len];
    const lvl = Math.hypot(p[0] - start.x, p[1] - start.z) < 5 ? 2 : 1;
    world.placeRoad([[p[0], p[1]], mid, end], lvl);
  }
  // cobble the streets near the centre
  const centre = [...world.roads.edges.values()].filter(e => { const m = pointAt(e.pts, e.cum, e.len / 2); return Math.hypot(m[0] - start.x, m[1] - start.z) < 4.5 && e.level < 2; }).map(e => e.id);
  if (centre.length) world.setLevel(centre, 2);
  world.updateRoadNetwork();

  // buildings along the streets, nearest the middle first
  const weights = [
    ['house', 30], ['villa', 2], ['flats', 2], ['market', 3], ['bakery', 2], ['tavern', 2], ['farm', 3], ['lumber', 2], ['fishery', 2],
    ['workshop', 2], ['builder', 1], ['well', 3], ['windgen', 1], ['clinic', 1], ['school', 1], ['watch', 1], ['chapel', 1], ['garden', 4],
    ['plaza', 1], ['flowers', 2], ['statue', 1], ['coachstop', 1],
  ];
  const total = weights.reduce((s, w) => s + w[1], 0);
  const pickType = () => { let r = rng.next() * total; for (const [k, w] of weights) { if ((r -= w) <= 0) return k; } return 'house'; };
  const count = {};
  const edges = near().map(e => { const m = pointAt(e.pts, e.cum, e.len / 2); return { e, d: Math.hypot(m[0] - start.x, m[1] - start.z) }; }).sort((a, b) => a.d - b.d);
  for (const { e } of edges) for (const side of [1, -1]) {
    for (let s = 0.4; s < e.len - 0.4;) {
      const p = pointAt(e.pts, e.cum, s), d = Math.hypot(p[0] - start.x, p[1] - start.z);
      if (d > R) { s += 0.5; continue; }
      let type = pickType();
      if (d > R - 3 && rng.chance(0.5)) type = rng.chance(0.5) ? 'farm' : 'house';
      const def = BUILDINGS[type];
      if ((type === 'clinic' || type === 'school' || type === 'chapel' || type === 'plaza' || type === 'statue') && count[type]) { s += 0.25; continue; }
      if (def.size === 2 && rng.chance(0.4)) { s += 0.25; continue; }
      const [W, D] = sizeOf(type), q = pointAt(e.pts, e.cum, Math.min(e.len, s + W / 2));
      const nx = -q[4] * side, nz = q[3] * side, off = SETBACK + D / 2;
      const x = q[0] + nx * off, z = q[1] + nz * off;
      const maxL = def.levels.length - 1;
      const level = type === 'house' ? Math.min(maxL, d < 6 ? rng.int(1, 2) : rng.int(0, 1)) : Math.min(maxL, rng.int(0, maxL));
      const r = world.placeBuilding(type, x, z, { ...FREE, level, a: angleOf(-nx, -nz) });
      if (r.ok) { count[type] = (count[type] || 0) + 1; s += W + 0.02; } else s += 0.25;
    }
  }

  // join a few neighbours into terraces and shophouses
  const instant = world.sandbox.instantBuild;
  world.sandbox.instantBuild = true;
  for (const b of [...world.buildings.values()]) {
    if (!world.buildings.has(b.id) || !rng.chance(0.3)) continue;
    const opts = world.mergeOptions(b);
    if (opts.length) world.mergeBuildings(b.id, rng.pick(opts).other.id);
  }
  world.encroachPass(() => rng.next());
  world.money = money;
  world.sandbox.instantBuild = instant;
}
