// Headless test for "Merge villages": merges generated towns in every kind of
// arrangement (beside on each side, overlapping, apart, turned, trimmed to fit,
// a town with itself) and checks the result is a sound town: no overlapping
// plots, no dangling references, one town hall, one road network, nothing on
// water, a smooth join, a clean save round-trip, and a simulation that runs.
// Usage: node scripts/merge-test.js [--write dir]   (--write saves the inputs
// and one merged town as .json files, handy for trying them in the browser)

import { World, plotOf, findPlot, groundUnder } from '../src/world/world.js';
import { pieces as netPieces } from '../src/save/mergeParts.js';
import { spline, pointAt, wrapAngle, angDiff } from '../src/world/geom.js';
import { growDemoTown } from '../src/world/demo.js';
import { PathFinder } from '../src/sim/path.js';
import { Sim } from '../src/sim/sim.js';
import { Agents } from '../src/sim/agents.js';
import { Transit } from '../src/sim/transit.js';
import { Construction } from '../src/sim/construction.js';
import { serialize, deserialize } from '../src/save/saves.js';
import { mergeTowns, layoutMerge, besideOffset, reportLines, MERGE_MAX_N, newVillage } from '../src/save/merge.js';
import { BUILDINGS, TECHS, LINE_COLORS } from '../src/defs.js';
import { auditTown } from './audit.js';

let failures = 0, passes = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.error('FAIL', msg); } else passes++; };
const quiet = process.argv.includes('--quiet');
const log = (...a) => { if (!quiet) console.log(...a); };

const scene = { add() {}, remove() {} };
function gameFor(w) {
  const g = {
    world: w, speed: 4, env: { night: 0 }, renderer: { scene, worldToScreen: () => ({ x: 0, y: 0 }) }, view: { smoke: { emit() {} } },
    _ev: {}, on(e, f) { (this._ev[e] ||= []).push(f); }, emit(e, d) { for (const f of this._ev[e] || []) f(d); },
  };
  g.paths = new PathFinder(w);
  g.sim = new Sim(g);
  g.transit = new Transit(g);
  return g;
}

// A lived-in town: grown streets and buildings, founders, a coach line, a
// house being moved and a building site, so ids and references get exercised.
function makeTown(N, seed, name, { day = 1, research = null, bigParks = false, seat = null } = {}) {
  const w = World.createNew({ N, seed, name });
  growDemoTown(w, seed, 1);
  const g = gameFor(w);
  g.sim.seedFounders();
  w.money = 6000;
  const stops = [], FREE = { free: true, ignoreMoney: true, instant: true };
  for (const [fx, fz] of [[0.3, 0.3], [0.7, 0.4], [0.5, 0.7], [0.3, 0.7], [0.7, 0.7]]) {
    if (stops.length >= 3) break;
    const p = findPlot(w, 'coachstop', { x: N * fx, z: N * fz }, { r: N * 0.4, opts: FREE, test: (x, z, a, c) => !c || (c.access && c.access.conn && !stops.some(s => Math.hypot(s.x - x, s.z - z) < 7)) });
    if (!p) continue;
    const r = w.placeBuilding('coachstop', p.x, p.z, { ...FREE, a: p.a });
    if (r.ok && r.building.connected) stops.push(r.building); else if (r.ok) w.removeBuilding(r.building.id, 0);
  }
  if (stops.length >= 2) w.lines.push({ id: w.newId(), mode: 'coach', name: 'Coach Line 1', color: LINE_COLORS[0], stops: stops.map(s => s.id), vehicles: 1 });
  const home = [...w.buildings.values()].find(b => b.type === 'house' && !b.con && b.residents.length);
  if (home) {
    const p = findPlot(w, 'house', { x: home.x + 3, z: home.z + 3 }, { r: 9, opts: { ignoreMoney: true }, test: (x, z, a, c) => Math.hypot(x - home.x, z - home.z) > 1.5 && (!c || (c.access && c.access.conn)) });
    if (p) w.moveBuilding(home.id, p.x, p.z, { a: p.a });
  }
  {
    const p = findPlot(w, 'house', { x: N / 2, z: N / 2 }, { r: N / 2, opts: { ignoreMoney: true } });
    if (p) w.placeBuilding('house', p.x, p.z, { a: p.a });
  }
  // a City Park and a Grand Park, laid out round what they grew from
  if (bigParks) for (const [type, flavor] of [['citypark', 'grandpark#1@1,-1/zoo#0@-1,1'], ['grandpark', 'landscapepark#1@-1,1/rosegarden']]) {
    const p = findPlot(w, type, { x: N / 2, z: N / 2 }, { r: N, opts: { ignoreMoney: true, ignoreUnlock: true } });
    if (p) w.placeBuilding(type, p.x, p.z, { a: p.a, instant: true, ignoreUnlock: true, ignoreMoney: true, free: true, flavor });
  }
  // the town hall grown into a Capitol (or a Parliament), in its own style
  if (seat) {
    const th = [...w.buildings.values()].find(b => b.type === 'townhall');
    w.removeBuilding(th.id, 0);
    const p = findPlot(w, seat, { x: th.x, z: th.z }, { r: N, opts: { ignoreMoney: true, ignoreUnlock: true }, test: (x, z, a, c) => !c || (c.access && c.access.conn) });
    if (p) w.placeBuilding(seat, p.x, p.z, { a: p.a, instant: true, ignoreUnlock: true, ignoreMoney: true, free: true, level: 1, flavor: 'gothic' });
  }
  w.day = day;
  if (research) w.research = { done: research.slice(), current: null, progress: 0, bank: 5 };
  return JSON.parse(JSON.stringify(serialize(w)));
}

const maxStep = (t) => {
  let m = 0;
  for (let z = 0; z <= t.N; z++) for (let x = 0; x <= t.N; x++) {
    if (x < t.N) m = Math.max(m, Math.abs(t.ch(x, z) - t.ch(x + 1, z)));
    if (z < t.N) m = Math.max(m, Math.abs(t.ch(x, z) - t.ch(x, z + 1)));
  }
  return m;
};

// the separate pieces of the road network
function roadPieces(w) { return netPieces(w.roads).length; }
// how much road crosses water
function bridged(w) {
  let n = 0;
  for (const e of w.roads.edges.values()) { const hy = w._heights(e); n += hy.wet.reduce((a, v) => a + v, 0) * hy.step; }
  return n;
}

// steepest corner-to-corner step within `band` corners of either town's edge
function seamStep(w, L, band) {
  const t = w.terrain, N = w.N;
  const lines = [];
  for (const [x, z, n] of [[L.ax, L.az, L.NA], [L.bx, L.bz, L.NB]]) lines.push(['x', x], ['x', x + n], ['z', z], ['z', z + n]);
  const near = (cx, cz) => lines.some(([k, v]) => v > 0 && v < N && Math.abs((k === 'x' ? cx : cz) - v) <= band);
  let m = 0;
  for (let cz = 0; cz <= N; cz++) for (let cx = 0; cx <= N; cx++) {
    if (!near(cx, cz)) continue;
    if (cx < N) m = Math.max(m, Math.abs(t.ch(cx, cz) - t.ch(cx + 1, cz)));
    if (cz < N) m = Math.max(m, Math.abs(t.ch(cx, cz) - t.ch(cx, cz + 1)));
  }
  return m;
}

function checkMerge(label, dA, dB, arr, { simDays = 0 } = {}) {
  const wA = deserialize(dA), wB = deserialize(dB);
  const L = layoutMerge(wA, wB, arr);
  if (!L.ok) { ok(false, `${label}: layout refused (${L.reason})`); return null; }
  const t0 = Date.now();
  const { data, world: w, report: rep } = mergeTowns(dA, dB, arr);
  const ms = Date.now() - t0;
  const g = gameFor(w);
  g.sim.recompute();
  const probs = [];
  auditTown(w, (m) => probs.push(m));
  ok(!probs.length, `${label}: town invariants hold${probs.length ? ' — ' + probs.slice(0, 4).join('; ') : ''}`);
  ok(w.N === L.N && w.N <= MERGE_MAX_N, `${label}: map is ${w.N}×${w.N}`);
  // ids: buildings, villagers and lines share one counter, so no id is used twice
  const ids = [...w.buildings.keys(), ...w.residents.keys(), ...w.lines.map(l => l.id)];
  ok(new Set(ids).size === ids.length, `${label}: every id is unique`);
  ok(ids.every(i => i < w.nextId), `${label}: next id is past every id in use`);
  ok([...w.buildings.values()].filter(b => BUILDINGS[b.type].unique).length <= 1, `${label}: at most one town hall`);
  // every building is still there, or the report says where it went
  const gone = wA.buildings.size + wB.buildings.size - w.buildings.size;
  ok(gone === rep.refunded.length + rep.removed.length, `${label}: buildings add up (${gone} gone, ${rep.refunded.length} refunded, ${rep.removed.length} dropped)`);
  // the ground suits every building
  const wet = [...w.buildings.values()].filter(b => groundUnder(w.terrain, plotOf(b)).water);
  ok(!wet.length, `${label}: no building stands in water${wet.length ? ` (${wet.map(b => b.type).join(', ')})` : ''}`);
  const steep = [...w.buildings.values()].filter(b => { const g = groundUnder(w.terrain, plotOf(b)); return g.maxH - g.minH > 1.3; });
  ok(!steep.length, `${label}: no building on a cliff`);
  // one road network, reaching the edge of the map, that every building uses
  const pieces = roadPieces(w);
  ok(pieces === 1, `${label}: one road network (${pieces} piece${pieces === 1 ? '' : 's'})`);
  const e = w.entry, at = (v) => v <= 0.02 || v >= w.N - 0.02;
  ok(w.roads.nodes.has(e.node) && (at(e.x) || at(e.z)), `${label}: the road out of town starts at the map edge (${e.x.toFixed(1)},${e.z.toFixed(1)})`);
  const cut = [...w.buildings.values()].filter(b => !BUILDINGS[b.type].park && !b.connected);
  ok(!cut.length, `${label}: every building reaches the road network${cut.length ? ` (${cut.length} cut off: ${cut.slice(0, 3).map(b => b.type + '@' + b.x.toFixed(1) + ',' + b.z.toFixed(1)).join(' ')})` : ''}`);
  // a smooth join: no step steeper than the steepest in either valley, at the
  // edges of the two maps or anywhere else (overlaps join inside the overlap)
  const natural = Math.max(maxStep(wA.terrain), maxStep(wB.terrain), 0.75);
  const step = seamStep(w, L, rep.seam.width + 1), anywhere = maxStep(w.terrain);
  ok(step <= natural + 0.05, `${label}: smooth join at the map edges (steepest step ${step.toFixed(2)}, valleys ${natural.toFixed(2)})`);
  ok(anywhere <= natural + 0.05, `${label}: no cliff anywhere on the merged map (steepest step ${anywhere.toFixed(2)})`);
  // streets stay on dry ground: no more bridges than both towns had, plus a
  // few where joined-up rivers cross a road
  ok(bridged(w) <= bridged(wA) + bridged(wB) + 6 * rep.rivers + rep.roadsLaid + 1, `${label}: roads were not flooded (${bridged(w).toFixed(1)} of bridge, towns had ${bridged(wA).toFixed(1)} + ${bridged(wB).toFixed(1)})`);
  // people: everyone has a real home, nobody was lost without being counted
  const homeless = [...w.residents.values()].filter(r => r.home == null || !BUILDINGS[w.buildings.get(r.home)?.type]?.levels[w.buildings.get(r.home).level].housing);
  ok(!homeless.length, `${label}: every villager has a home`);
  ok(w.residents.size === wA.residents.size + wB.residents.size - rep.released, `${label}: villagers add up (${wA.residents.size} + ${wB.residents.size} − ${rep.released} moved away)`);
  const names = [...w.residents.values()].map(r => `${r.first} ${r.last}`);
  ok(new Set(names).size === names.length, `${label}: no two villagers share a name`);
  // lines, research, money, calendar
  ok(w.lines.every(l => l.stops.length >= 2 && l.stops.every(s => w.buildings.has(s))), `${label}: transit lines only stop at real stops`);
  ok(new Set(w.lines.map(l => l.name)).size === w.lines.length, `${label}: transit line names are unique`);
  const union = new Set([...wA.research.done, ...wB.research.done]);
  ok(w.research.done.length === union.size && [...union].every(t => w.research.done.includes(t)), `${label}: research is the union of both towns (${union.size})`);
  ok(Math.abs(w.money - (wA.money + wB.money + rep.refundTotal)) <= 1, `${label}: money is summed plus refunds`);
  ok(w.day === Math.max(wA.day, wB.day), `${label}: calendar is the later town's (day ${w.day})`);
  // move pairs and sites still point at real buildings
  ok([...w.buildings.values()].every(b => !b.con || b.con.wait !== 'dismantle' || w.buildings.has(b.con.from)), `${label}: buildings being moved still have their old plot`);
  // it saves and loads back the same
  const w2 = deserialize(JSON.parse(JSON.stringify(data)));
  ok(w2.buildings.size === w.buildings.size && w2.residents.size === w.residents.size && w2.lines.length === w.lines.length && w2.N === w.N, `${label}: save round-trip`);
  // and the town runs
  if (simDays) {
    g.agents = new Agents(g);
    g.construction = new Construction(g);
    g.transit.rebuild();
    g.transit.planCarts();
    const end = w.day + simDays;
    let frames = 0;
    while (w.day < end && frames < 30000) { const dt = g.sim.update(0.1); g.agents.update(0.1, dt); g.construction.update(0.1, dt); g.transit.update(0.1); frames++; }
    const p2 = [];
    auditTown(w, (m) => p2.push(m));
    ok(w.day >= end && !p2.length, `${label}: ran ${simDays} day${simDays > 1 ? 's' : ''} after merging${p2.length ? ' — ' + p2.slice(0, 3).join('; ') : ''}`);
  }
  log(`  ${label.padEnd(26)} ${String(ms).padStart(4)} ms · ${w.N}×${w.N} · ${w.buildings.size} buildings · ${w.residents.size} villagers · seam ${rep.seam.width} (${step.toFixed(2)}) · moved ${rep.moved.length} · refunded ${rep.refunded.length} · roads +${rep.roadsLaid + rep.entryLaid} · rivers ${rep.rivers}`);
  return { w, rep, data };
}

// ------------------------------------------------------------ the towns
const T = {
  a: makeTown(48, 101, 'Amberford', { research: ['commerce', 'surveying', 'joining'] }),
  b: makeTown(48, 202, 'Bramblewick', { day: 23, research: ['commerce', 'hydraulics'] }),
  c: makeTown(32, 303, 'Cloverdale', { day: 9 }),
  d: makeTown(64, 404, 'Dunmere', { day: 40 }),
  // brand-new villages, as merged in from the game: an empty valley and a starter town
  e: newVillage({ seed: 777, N: 48, name: 'Freshby' }),
  s: newVillage({ starter: 'mill', name: 'Millstead' }),
};
log('towns:', Object.entries(T).map(([k, d]) => `${k}=${d.name} ${d.N}×${d.N} (${d.buildings.length} buildings, ${d.residents.length} villagers)`).join(' · '));

const runs = [];
for (const side of ['right', 'left', 'below', 'above']) runs.push([`beside ${side}`, 'a', 'b', { ...besideOffset(48, 48, side), rot: 0 }, 1]);
for (let rot = 1; rot < 4; rot++) runs.push([`beside right, turned ${rot * 90}°`, 'a', 'b', { ...besideOffset(48, 48, 'right'), rot }, 0]);
runs.push(['overlap 28,6', 'a', 'b', { x: 28, z: 6, rot: 0 }, 1]);
runs.push(['overlap 20,6 turned 180°', 'a', 'b', { x: 20, z: 6, rot: 2 }, 0]);
runs.push(['overlap -14,-10 turned 90°', 'a', 'b', { x: -14, z: -10, rot: 1 }, 0]);
runs.push(['overlap right on top', 'a', 'b', { x: 0, z: 0, rot: 0 }, 1]);
runs.push(['apart with a gap', 'a', 'c', { x: 54, z: 10, rot: 3 }, 0]);
runs.push(['small inside big', 'd', 'c', { x: 4, z: 4, rot: 1 }, 1]);
runs.push(['big beside, trimmed', 'd', 'a', { ...besideOffset(64, 48, 'below'), rot: 0 }, 0]);
runs.push(['a town with itself', 'a', 'a', { x: 30, z: 4, rot: 0 }, 0]);
runs.push(['a brand-new village beside', 'a', 'e', { ...besideOffset(48, 48, 'above'), rot: 0 }, 1]);
runs.push(['a starter town overlapping', 'a', 's', { x: 20, z: 10, rot: 1 }, 1]);

const t0 = Date.now();
let rivers = 0, moved = 0, refunded = 0;
let sample = null;
for (const [label, a, b, arr, days] of runs) {
  const r = checkMerge(label, T[a], T[b], arr, { simDays: days });
  if (!r) continue;
  rivers += r.rep.rivers; moved += r.rep.moved.length; refunded += r.rep.refunded.length;
  if (label === 'overlap 28,6') sample = r;
}
// a town's 3×3 and 4×4 parks come through a merge whole, turned with their
// town, laid out round what they grew from
{
  const P = makeTown(48, 101, 'Parkhurst', { bigParks: true });
  const big = (d) => d.buildings.filter(r => BUILDINGS[r[1]].grand).map(r => `${r[1]}:${r[8]}×${r[9]}:${r[10]}`).sort();
  const before = big(P);
  for (const [label, arr] of [['big parks beside', { ...besideOffset(48, 48, 'right'), rot: 0 }], ['big parks turned 90°', { ...besideOffset(48, 48, 'left'), rot: 1 }]]) {
    const r = checkMerge(label, T.b, P, arr);
    if (!r) continue;
    const after = big(r.data);
    ok(before.length === 2 && JSON.stringify(after) === JSON.stringify(before), `${label}: the City Park and the Grand Park come through whole (${after.join(', ')})`);
  }
}
// one seat of government: a Capitol merged with a town hall is kept (it is
// worth more) and the town hall becomes a plaza; two Capitols, and the
// second becomes a grand park on its 3×3 grounds, the money back
{
  const K = makeTown(48, 101, 'Kingsmead', { seat: 'capitol' });
  const seats = (d) => d.buildings.filter(r => BUILDINGS[r[1]].seat).map(r => `${r[1]}:${r[8]}×${r[9]}:${r[10]}`);
  ok(seats(K).length === 1 && /^capitol:3×3:gothic/.test(seats(K)[0]), `a town whose seat is a Gothic Capitol (${seats(K).join(', ')})`);
  for (const [label, A, B, arr, to] of [['a Capitol beside a town hall', T.b, K, { ...besideOffset(48, 48, 'right'), rot: 0 }, 'plaza'], ['a Capitol beside itself, turned', K, K, { ...besideOffset(48, 48, 'below'), rot: 1 }, 'grandpark']]) {
    const r = checkMerge(label, A, B, arr);
    if (!r) continue;
    const s = seats(r.data), conv = r.rep.converted.find(c => c.to === BUILDINGS[to].levels[0].name || c.to === BUILDINGS[to].levels[BUILDINGS[to].levels.length - 1].name);
    ok(s.length === 1 && /^capitol:3×3:gothic/.test(s[0]) && conv && conv.refund > 0, `${label}: one seat of government, the Capitol, kept; the other becomes a ${conv ? conv.to : '?'} (${conv ? '$' + conv.refund + ' back: ' + conv.why : 'not converted'})`);
  }
}
// rivers that reach the join a few tiles apart flow on into the other valley
{
  const rA = makeTown(48, 1, 'Riverby'), rB = makeTown(48, 46, 'Fordwick');
  const r = checkMerge('rivers meet at the join', rA, rB, { x: 48, z: 0, rot: 0 });
  if (r) {
    const wA = deserialize(rA), wB = deserialize(rB), w = r.w, N = w.N, L = layoutMerge(wA, wB, { x: 48, z: 0 });
    const wetMid = (src, x) => { const zs = []; for (let z = 0; z < src.N; z++) if (src.terrain.isWater(x, z)) zs.push(z); return zs.length ? zs[zs.length >> 1] : null; };
    const za = wetMid(wA, 42), zb = wetMid(wB, 5);
    const from = [L.ax + 42, L.az + za], to = [L.bx + 5, L.bz + zb];
    const seen = new Uint8Array(N * N), q = [from[1] * N + from[0]];
    seen[q[0]] = 1;
    for (let k = 0; k < q.length; k++) {
      const i = q[k], x = i % N, z = (i / N) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz, ni = nz * N + nx;
        if (nx >= 0 && nz >= 0 && nx < N && nz < N && !seen[ni] && w.terrain.isWater(nx, nz)) { seen[ni] = 1; q.push(ni); }
      }
    }
    ok(za != null && zb != null && w.terrain.isWater(...from) && seen[to[1] * N + to[0]], `the river flows on across the join (z ${za} → ${zb}, ${r.rep.rivers} carried across)`);
  }
}
// buried power lines and street dressings stay with their streets
{
  const wA = deserialize(T.a);
  let k = 0;
  for (const e of wA.roads.edges.values()) { e.buried = k & 1; e.dress = 1 + (k % 2); k++; }
  const dA = JSON.parse(JSON.stringify(serialize(wA)));
  const arr = { ...besideOffset(48, 48, 'right'), rot: 0 };
  const r = checkMerge('dressed streets beside', dA, T.b, arr);
  if (r) {
    const w = r.w, L = layoutMerge(wA, deserialize(T.b), arr);
    let kept = 0, wrong = 0;
    for (const e of wA.roads.edges.values()) {
      const p = pointAt(e.pts, e.cum, e.len / 2), h = w.roads.nearest(p[0] + L.ax, p[1] + L.az, 0.02);
      if (!h) continue;
      if ((h.e.buried || 0) === e.buried && h.e.dress === e.dress) kept++; else wrong++;
    }
    ok(kept > 6 && !wrong, `buried lines and dressings go with their streets (${kept} kept, ${wrong} changed)`);
  }
}
// a curving street and buildings standing at odd angles come through a
// merge, beside and turned: the curve as it was (turned with its town), the
// buildings turned with it
{
  const wA = deserialize(T.a), N = wA.N;
  wA.money = 1e5;
  // a long curving street from the town's middle, and houses along it at all angles
  let laid = null;
  const hall = [...wA.buildings.values()].find(b => BUILDINGS[b.type].seat);
  for (let k = 0; k < 16 && !laid; k++) {
    const a0 = (k * Math.PI) / 8, h = wA.roads.nearest(hall.x + Math.cos(a0) * 4, hall.z + Math.sin(a0) * 4, 3);
    if (!h) continue;
    const s0 = [h.x, h.z], ctrl = [s0, [s0[0] + Math.cos(a0) * 3 + 1, s0[1] + Math.sin(a0) * 3 - 1], [s0[0] + Math.cos(a0) * 6 - 1, s0[1] + Math.sin(a0) * 6 + 1.5], [s0[0] + Math.cos(a0) * 9, s0[1] + Math.sin(a0) * 9]];
    const r = wA.placeRoad(ctrl, 1);
    if (r.placed) laid = r;
  }
  const turned = [];
  for (let i = 0; i < 12 && turned.length < 5; i++) {
    const p = findPlot(wA, 'house', { x: N / 2 + (i % 4) * 3 - 4, z: N / 2 + Math.floor(i / 4) * 3 - 3 }, { r: N, opts: { ignoreMoney: true } });
    if (!p) continue;
    const a = p.a + ((i % 3) - 1) * 0.3, r = wA.placeBuilding('house', p.x, p.z, { a, instant: true, free: true });
    if (r.ok) turned.push(r.building);
  }
  ok(laid && turned.length >= 3, `a town with a curving street and houses at odd angles (${turned.length})`);
  const dA = JSON.parse(JSON.stringify(serialize(wA)));
  const curveLen = (w) => [...w.roads.edges.values()].reduce((a, e) => a + e.len, 0);
  for (const [label, arr, k] of [['curves beside', { ...besideOffset(48, 48, 'right'), rot: 0 }, 0], ['curves turned 90°', { ...besideOffset(48, 48, 'left'), rot: 1 }, 1]]) {
    const r = checkMerge(label, T.b, dA, arr);
    if (!r) continue;
    const off = r.rep && r.w ? [...r.w.buildings.keys()] : [];
    void off;
    // each turned house, found in the merged town by where it went and how it faces
    const L = layoutMerge(deserialize(T.b), wA, arr);
    let same = 0;
    for (const b of turned) {
      let [x, z] = [b.x, b.z];
      for (let q = 0; q < k; q++) { const t = x; x = wA.N - z; z = t; }
      x += L.bx; z += L.bz;
      const o = [...r.w.buildings.values()].find(o2 => o2.type === 'house' && Math.hypot(o2.x - x, o2.z - z) < 0.01);
      if (o && angDiff(o.a, wrapAngle(b.a - (k * Math.PI) / 2)) < 1e-3) same++;
    }
    ok(same === turned.length, `${label}: buildings at odd angles stay where they were, turned with their town (${same} of ${turned.length})`);
    ok(curveLen(r.w) >= curveLen(deserialize(T.b)) + curveLen(wA) - 2, `${label}: the curving streets come through whole (${curveLen(r.w).toFixed(1)} of road)`);
  }
}
// something must actually have been settled across all those arrangements
ok(moved > 0 && refunded >= 0, `overlapping plots were moved (${moved}) or refunded (${refunded})`);
ok(runs.some(([l]) => l.startsWith('beside')), 'every side was tried');
// an arrangement too wide for one map is refused with a reason, not merged badly
{
  const big = makeTown(80, 505, 'Eastwold'), big2 = makeTown(80, 606, 'Westwold');
  const L = layoutMerge(deserialize(big), deserialize(big2), { x: 80, z: 0, rot: 0 });
  ok(!L.ok && /limit/.test(L.reason), `two 80×80 valleys side by side are refused (${L.reason || 'accepted'})`);
  let threw = false;
  try { mergeTowns(big, big2, { x: 80, z: 0 }); } catch { threw = true; }
  ok(threw, 'merging them anyway throws instead of producing a broken town');
}
log(`\n  rivers carried across: ${rivers}`);
if (sample && !quiet) for (const [icon, text] of reportLines(sample.rep)) console.log('   ', icon, text);

const wi = process.argv.indexOf('--write');
if (wi > 0) {
  const fs = await import('node:fs');
  const dir = process.argv[wi + 1] || '.';
  fs.mkdirSync(dir, { recursive: true });
  for (const [k, d] of Object.entries(T)) fs.writeFileSync(`${dir}/${d.name.toLowerCase()}.kinstead.json`, JSON.stringify(d));
  if (sample) fs.writeFileSync(`${dir}/merged.kinstead.json`, JSON.stringify(sample.data));
  log(`  wrote saves to ${dir}`);
}

console.log(`\n${passes} checks passed, ${failures} failed · ${runs.length} merges in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(failures ? 1 : 0);
