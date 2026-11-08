// Merging two saved towns into one. Town B is turned in quarter turns and set
// beside, apart from or over town A on one square map. The ground is blended
// across the join so the two valleys meet without cliffs, rivers are carried
// over where they line up, the road networks are joined into one, and every
// clash is settled automatically: overlapping plots, a second town hall,
// buildings left on water or steep ground, duplicate ids, villagers whose home
// vanished, transit stops that are gone. The result is an ordinary save plus
// a report of what was moved, refunded or removed.
//
// mergeWorlds(worldA, worldB, { rot, x, z, name, seam }) — B's top-left tile
// sits at (x, z) relative to A's after `rot` clockwise quarter turns (seen
// from above, x to the right and z down, as in the 2D view).

import { World, capOf, TREE } from '../world/world.js';
// (being made over for the town without a grid: see the gridless notes)
const fw = (b) => b.w, fd = (b) => b.d;
import { Terrain } from '../world/terrain.js';
import { BUILDINGS, TRANSIT, LINE_COLORS } from '../defs.js';
import { CONFIG } from '../config.js';
import { serialize, deserialize } from './saves.js';
import { RNG, makeNoise2D, fbm, hash2, smoothstep, clamp, lerp } from '../util/rng.js';
import { firstName } from '../util/names.js';
import { Sim } from '../sim/sim.js';
import { starterSave } from '../world/starters.js';
import { turnDiag, linkStroke, tidyDiag, diagCapable } from '../world/diagonal.js';
import { linksOf, CORNERS } from '../world/roadShape.js';

// Largest merged map. Two big valleys side by side are trimmed of empty
// countryside at their outer edges to fit (never of buildings).
export const MERGE_MAX_N = 96;

const WL = CONFIG.WATER_LEVEL;
const FILLER = 0;

// ------------------------------------------------------------ geometry
// k quarter turns clockwise on an N-tile map
function rotTile(x, z, N, k) { for (let i = 0; i < k; i++) { const t = x; x = N - 1 - z; z = t; } return [x, z]; }
function rotPoint(x, z, N, k) { for (let i = 0; i < k; i++) { const t = x; x = N - z; z = t; } return [x, z]; }
function rotRect(x, z, w, d, N, k) {
  for (let i = 0; i < k; i++) { const t = x; x = N - z - d; z = t; const u = w; w = d; d = u; }
  return [x, z, w, d];
}
const SIDE_TURN = { z0: 'x1', x1: 'z1', z1: 'x0', x0: 'z0' };
function rotSide(s, k) { for (let i = 0; i < k; i++) s = SIDE_TURN[s]; return s; }

// B's offset for "beside" arrangements (centred along the shared edge unless `along` is given).
export function besideOffset(NA, NB, side, along = null) {
  const c = along ?? Math.round((NA - NB) / 2);
  if (side === 'left') return { x: -NB, z: c };
  if (side === 'above') return { x: c, z: -NB };
  if (side === 'below') return { x: c, z: NA };
  return { x: NA, z: c };
}

function contentBox(w, ox, oz, k) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const b of w.buildings.values()) {
    const [x, z, bw, bd] = rotRect(b.x, b.z, fw(b), fd(b), w.N, k);
    x0 = Math.min(x0, x + ox); z0 = Math.min(z0, z + oz);
    x1 = Math.max(x1, x + ox + bw); z1 = Math.max(z1, z + oz + bd);
  }
  return x0 === Infinity ? null : { x0, z0, x1, z1 };
}

// Where everything goes on the merged map, and how big it is.
export function layoutMerge(wA, wB, arr = {}) {
  const k = (((arr.rot || 0) % 4) + 4) % 4, NA = wA.N, NB = wB.N;
  const ox = Math.round(arr.x ?? NA), oz = Math.round(arr.z ?? Math.round((NA - NB) / 2));
  const x0 = Math.min(0, ox), z0 = Math.min(0, oz), x1 = Math.max(NA, ox + NB), z1 = Math.max(NA, oz + NB);
  const W = x1 - x0, H = z1 - z0;
  let N = Math.max(W, H);
  let wx = x0 - Math.floor((N - W) / 2), wz = z0 - Math.floor((N - H) / 2);
  const ix = Math.max(0, Math.min(NA, ox + NB) - Math.max(0, ox)), iz = Math.max(0, Math.min(NA, oz + NB) - Math.max(0, oz));
  const overlap = ix * iz;
  const touching = !overlap && ((ix > 0 && (oz === NA || oz + NB === 0)) || (iz > 0 && (ox === NA || ox + NB === 0)));
  const out = { ok: true, k, ox, oz, NA, NB, W, H, overlap, mode: overlap ? 'overlap' : touching ? 'beside' : 'apart', cropped: false };
  if (N > MERGE_MAX_N) {
    const a = contentBox(wA, 0, 0, 0), b = contentBox(wB, ox, oz, k);
    const boxes = [a, b].filter(Boolean);
    const c = boxes.length
      ? { x0: Math.min(...boxes.map(q => q.x0)) - 3, z0: Math.min(...boxes.map(q => q.z0)) - 3, x1: Math.max(...boxes.map(q => q.x1)) + 3, z1: Math.max(...boxes.map(q => q.z1)) + 3 }
      : { x0: (x0 + x1) >> 1, z0: (z0 + z1) >> 1, x1: (x0 + x1) >> 1, z1: (z0 + z1) >> 1 };
    const span = Math.max(c.x1 - c.x0, c.z1 - c.z0);
    if (span > MERGE_MAX_N) {
      return { ...out, N: MERGE_MAX_N, reason: `The two towns' buildings would span ${span} tiles, more than the ${MERGE_MAX_N}×${MERGE_MAX_N} limit. Overlap them more or turn town B.`, ok: false };
    }
    N = MERGE_MAX_N;
    wx = clamp(Math.round((x0 + x1 - N) / 2), c.x1 - N, c.x0);
    wz = clamp(Math.round((z0 + z1 - N) / 2), c.z1 - N, c.z0);
    out.cropped = true;
  }
  return { ...out, N, wx, wz, ax: -wx, az: -wz, bx: ox - wx, bz: oz - wz };
}

// A source town placed on the merged map: its heights turned to match, and
// transforms from its own tiles to merged-map tiles.
function source(w, x, z, k, tag) {
  const N = w.N, S = N + 1, H = new Float32Array(S * S), inv = (4 - k) % 4;
  for (let v = 0; v <= N; v++) for (let u = 0; u <= N; u++) {
    const [px, pz] = rotPoint(u, v, N, inv);
    H[v * S + u] = w.terrain.H[pz * S + px];
  }
  return {
    w, N, x, z, k, tag, H, id: (i) => i,
    // height at a merged-map corner, carried on flat beyond the map's edge
    h(cx, cz) {
      let u = cx - x, v = cz - z;
      u = u < 0 ? 0 : u > N ? N : u; v = v < 0 ? 0 : v > N ? N : v;
      return H[v * S + u];
    },
    hasCorner(cx, cz) { const u = cx - x, v = cz - z; return u >= 0 && v >= 0 && u <= N && v <= N; },
    depth(cx, cz) { return Math.min(cx - x, cz - z, x + N - cx, z + N - cz); },
    tile(tx, tz) { const [u, v] = rotTile(tx, tz, N, k); return [u + x, v + z]; },
    point(px, pz) { const [u, v] = rotPoint(px, pz, N, k); return [u + x, v + z]; },
    rect(rx, rz, rw, rd) { const [u, v, a, b] = rotRect(rx, rz, rw, rd, N, k); return [u + x, v + z, a, b]; },
  };
}

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p; }
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop();
    if (k.length) {
      k[0] = lk; v[0] = lv; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m;
      }
    }
    return top;
  }
}

// New countryside for parts of the square map neither town covers.
function fillerHeights(N, seed) {
  const S = N + 1, H = new Float32Array(S * S), B = new Float32Array(S * S);
  const nA = makeNoise2D(seed), nB = makeNoise2D(seed + 101);
  for (let cz = 0; cz < S; cz++) for (let cx = 0; cx < S; cx++) {
    const hills = Math.max(0, fbm(nB, cx * 0.03, cz * 0.03, 2) + 0.1);
    H[cz * S + cx] = 0.65 + fbm(nA, cx * 0.045, cz * 0.045, 4) * 0.8 + hills * 1.8;
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let cz = 0; cz < S; cz++) for (let cx = 0; cx < S; cx++) {
      let sum = 0, ws = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, z = cz + dz;
        if (x < 0 || z < 0 || x >= S || z >= S) continue;
        const k = dx === 0 && dz === 0 ? 4 : dx === 0 || dz === 0 ? 2 : 1;
        sum += H[z * S + x] * k; ws += k;
      }
      B[cz * S + cx] = sum / ws;
    }
    H.set(B);
  }
  for (let cz = 0; cz < S; cz++) for (let cx = 0; cx < S; cx++) H[cz * S + cx] += (hash2(cx, cz, seed) - 0.5) * 0.05;
  return H;
}

function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
  let t = L2 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

// ------------------------------------------------------------- merging
// A brand-new village to merge in: an empty valley with its founding
// families, as in a new game, or one of the starter towns.
export function newVillage({ starter = null, seed, N = 48, name }) {
  if (starter) {
    const data = structuredClone(starterSave(starter));
    if (name) data.name = name;
    return data;
  }
  const w = World.createNew({ N, seed, name });
  new Sim({ world: w, speed: 0, emit() {}, on() {} }).seedFounders();
  return serialize(w);
}

export function mergeTowns(dataA, dataB, arr = {}, opts = {}) {
  return mergeWorlds(deserialize(dataA), deserialize(dataB), arr, opts);
}

// The source worlds are only read, never changed, so a UI can keep them and
// preview many arrangements (opts.preview skips the final save round-trip).
export function mergeWorlds(wA, wB, arr = {}, opts = {}) {
  const L = layoutMerge(wA, wB, arr);
  if (!L.ok) throw new Error(L.reason);
  const N = L.N, S = N + 1;
  const same = wA.townName === wB.townName;
  const A = source(wA, L.ax, L.az, 0, 1), B = source(wB, L.bx, L.bz, L.k, 2);
  A.label = same ? `${wA.townName} (A)` : wA.townName;
  B.label = same ? `${wB.townName} (B)` : wB.townName;
  const SRC = [null, A, B];
  const rep = {
    N, mode: L.mode, rot: L.k * 90, cropped: L.cropped, names: [A.label, B.label],
    moved: [], refunded: [], removed: [], converted: [], refundTotal: 0,
    roadsDropped: 0, railsDropped: 0, roadsLaid: 0, joined: 0, unjoined: 0, unjoinedTiles: 0, strays: 0, entryLaid: 0,
    renamed: 0, rehomed: 0, released: 0, jobless: 0, linesTrimmed: [], linesRemoved: [],
    countryside: 0, rivers: 0, seam: { width: 0, maxStep: 0, corners: 0 },
  };
  const rng = new RNG((wA.seed ^ (wB.seed * 31) ^ (L.k * 7919) ^ (L.ox * 131) ^ (L.oz * 977)) >>> 0);

  // ---- ids: B's buildings, villagers and lines move up past everything A uses
  let maxA = wA.nextId - 1;
  for (const id of wA.buildings.keys()) maxA = Math.max(maxA, id);
  for (const id of wA.residents.keys()) maxA = Math.max(maxA, id);
  for (const l of wA.lines) maxA = Math.max(maxA, l.id);
  const off = maxA + 1;
  B.id = (i) => i + off;

  // ---- buildings, with overlaps settled: the more valuable plot stays
  const recs = [];
  for (const s of [A, B]) for (const b of s.w.buildings.values()) {
    const [x, z, w, d] = s.rect(b.x, b.z, fw(b), fd(b));
    const con = b.con ? { ...b.con } : null;
    if (con && con.dest != null) con.dest = s.id(con.dest);
    if (con && con.from != null) con.from = s.id(con.from);
    recs.push({
      s, idx: recs.length, id: s.id(b.id), type: b.type, level: b.level, x, z, w, d, rot: ((b.rot || 0) + 3 * s.k) % 4,
      variant: b.variant, built: b.built, flavor: b.flavor || null, look: b.look || null, con,
      spare: b.spare ? (s.k % 2 ? { w: b.spare.d, d: b.spare.w } : { ...b.spare }) : null,
      // (a turn on its plot is from the way it faces, so it turns with its town)
      pose: b.pose ? { ...b.pose } : null,
      leases: (b.leases || []).map(l => ({ ...l, with: s.id(l.with), side: rotSide(l.side, s.k) })),
      value: s.w.buildValue(b), slope0: footSlope(s.w.terrain, b.x, b.z, fw(b), fd(b)), x0: x, z0: z,
    });
  }
  const nameOf = (r) => BUILDINGS[r.type].levels[r.level].name;
  const occ = new Int32Array(N * N).fill(-1);
  const kept = [], losers = [];
  const order = recs.slice().sort((a, b) => b.value - a.value || a.s.tag - b.s.tag || a.id - b.id);
  for (const r of order) {
    if (r.x < 0 || r.z < 0 || r.x + r.w > N || r.z + r.d > N) { losers.push({ r, why: 'fell outside the merged map' }); continue; }
    let clash = -1;
    for (let dz = 0; dz < r.d && clash < 0; dz++) for (let dx = 0; dx < r.w; dx++) {
      const o = occ[(r.z + dz) * N + r.x + dx];
      if (o >= 0) { clash = o; break; }
    }
    if (clash >= 0) { losers.push({ r, why: `overlapped the ${nameOf(recs[clash])} from ${recs[clash].s.label}` }); continue; }
    for (let dz = 0; dz < r.d; dz++) for (let dx = 0; dx < r.w; dx++) occ[(r.z + dz) * N + r.x + dx] = r.idx;
    kept.push(r);
  }
  // one of each unique building (and one seat of government, whatever it
  // has grown into): a second town hall becomes a plaza, a second Capitol a
  // grand park and a second Parliament a city park, on the same ground
  const uniq = {}, keyOf = (r) => (BUILDINGS[r.type].seat ? 'seat' : r.type);
  for (const r of kept.slice().sort((a, b) => b.value - a.value || a.s.tag - b.s.tag)) {
    if (!BUILDINGS[r.type].unique) continue;
    if (!uniq[keyOf(r)]) { uniq[keyOf(r)] = r; continue; }
    const before = nameOf(r), value = r.value, area = r.w * r.d;
    const to = !BUILDINGS[r.type].seat ? null : area >= 16 && !r.spare ? 'citypark' : area >= 9 && !r.spare ? 'grandpark' : 'plaza';
    if (to && BUILDINGS[to]) {
      const why = `${uniq[keyOf(r)].s.label}'s ${nameOf(uniq[keyOf(r)]).toLowerCase()} is kept`;
      r.type = to; r.level = Math.min(r.level, BUILDINGS[to].levels.length - 1);
      r.con = null; r.leases = []; r.look = null; r.flavor = null; r.converted = true;
      let pv = 0;
      for (let l = 0; l <= r.level; l++) pv += BUILDINGS[to].levels[l].cost;
      const back = Math.max(0, value - pv);
      rep.converted.push({ name: before, to: nameOf(r), from: r.s.label, refund: back, why });
      rep.refundTotal += back;
      r.value = pv;
    } else {
      kept.splice(kept.indexOf(r), 1);
      for (let dz = 0; dz < r.d; dz++) for (let dx = 0; dx < r.w; dx++) occ[(r.z + dz) * N + r.x + dx] = -1;
      losers.push({ r, why: `only one ${BUILDINGS[r.type].name} is allowed`, dup: true });
    }
  }
  for (const l of losers) if (BUILDINGS[l.r.type].unique && uniq[keyOf(l.r)]) l.dup = true;

  // ---- roads and track (the other town's buildings win over them)
  const roads = new Uint8Array(N * N), rails = new Uint8Array(N * N);
  // buried power lines, street dressings and diagonal links go with their
  // street (the links turned with their town)
  const buried = new Uint8Array(N * N), dress = new Uint8Array(N * N), diag = new Uint8Array(N * N);
  const roadSeeds = [], dryWay = new Uint8Array(N * N);
  for (const s of [A, B]) {
    const sN = s.N;
    for (let z = 0; z < sN; z++) for (let x = 0; x < sN; x++) {
      const v = s.w.roads[z * sN + x], rv = s.w.rails[z * sN + x];
      if (!v && !rv) continue;
      const [X, Z] = s.tile(x, z);
      if (X < 0 || Z < 0 || X >= N || Z >= N) continue;
      const i = Z * N + X, o = occ[i];
      if (o >= 0 && recs[o].s !== s) { if (v) rep.roadsDropped++; if (rv) rep.railsDropped++; continue; }
      if (v > roads[i]) roads[i] = v;
      if (rv) rails[i] = 1;
      const k = z * sN + x;
      if (v && s.w.buried && s.w.buried[k]) buried[i] = 1;
      if (v && s.w.dress && s.w.dress[k] && !dress[i]) dress[i] = s.w.dress[k];
      if (v && s.w.diag && s.w.diag[k]) diag[i] = turnDiag(s.w.diag[k], s.k);
      // remember which streets and tracks ran on dry ground (not bridges)
      if (!s.w.terrain.isWater(x, z)) dryWay[i] = 1;
      roadSeeds.push(i, s.tag);
    }
  }

  // ---- who owns the ground: each town keeps the land around its own
  // buildings and streets; where they overlap the join runs half-way between
  const own = new Uint8Array(S * S), lab = new Uint8Array(S * S);
  {
    const dist = new Int32Array(S * S).fill(1 << 30);
    const buckets = [];
    const seed = (c, d, t) => {
      if (d < dist[c] || (d === dist[c] && t < lab[c])) { dist[c] = d; lab[c] = t; (buckets[d] ||= []).push(c); }
    };
    for (const r of kept) for (let dz = 0; dz <= r.d; dz++) for (let dx = 0; dx <= r.w; dx++) seed((r.z + dz) * S + r.x + dx, 0, r.s.tag);
    for (let k = 0; k < roadSeeds.length; k += 2) {
      const i = roadSeeds[k], x = i % N, z = (i / N) | 0;
      for (const c of [z * S + x, z * S + x + 1, (z + 1) * S + x, (z + 1) * S + x + 1]) seed(c, 2, roadSeeds[k + 1]);
    }
    for (let d = 0; d < buckets.length; d++) {
      const bk = buckets[d];
      if (!bk) continue;
      for (let q = 0; q < bk.length; q++) {
        const c = bk[q];
        if (dist[c] !== d) continue;
        const t = lab[c], cx = c % S, cz = (c / S) | 0, src = SRC[t];
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nz < 0 || nx > N || nz > N || !src.hasCorner(nx, nz)) continue;
          seed(nz * S + nx, d + (dx && dz ? 3 : 2), t);
        }
      }
      buckets[d] = null;
    }
    for (let cz = 0; cz <= N; cz++) for (let cx = 0; cx <= N; cx++) {
      const c = cz * S + cx, a = A.hasCorner(cx, cz), b = B.hasCorner(cx, cz);
      own[c] = !a && !b ? FILLER : a && !b ? 1 : b && !a ? 2 : lab[c] || (A.depth(cx, cz) >= B.depth(cx, cz) ? 1 : 2);
    }
  }
  for (let c = 0; c < S * S; c++) if (own[c] === FILLER) rep.countryside++;

  // ---- each kept building's corners form a rigid block (blocks of one town
  // that touch join up), so its ground keeps its shape
  const grp = new Int32Array(S * S).fill(-1);
  const parent = recs.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  for (const r of kept) for (let dz = 0; dz <= r.d; dz++) for (let dx = 0; dx <= r.w; dx++) {
    const c = (r.z + dz) * S + r.x + dx;
    if (own[c] !== r.s.tag) continue;
    if (grp[c] < 0) grp[c] = r.idx; else parent[find(grp[c])] = find(r.idx);
  }
  for (let c = 0; c < S * S; c++) if (grp[c] >= 0) grp[c] = find(grp[c]);

  // ---- terrain: each town's heights where it owns the ground, new
  // countryside elsewhere, blended across every join (see blendTerrain)
  const filler = fillerHeights(N, (wA.seed * 7 + wB.seed * 13 + 99) >>> 0);
  const hOf = (t, cx, cz) => (t === FILLER ? filler[cz * S + cx] : SRC[t].h(cx, cz));
  const H = blendTerrain({ N, own, grp, hOf, seam: arr.seam, rep, SRC, ways: roadSeeds, dryWay });
  const terrain = new Terrain(N, H);

  // ---- the merged world
  const w = new World(N, wA.seed, terrain);
  w.townName = (arr.name || '').trim() || wA.townName;
  w.roads.set(roads);
  w.rails.set(rails);
  w.buried.set(buried);
  w.dress.set(dress);
  w.diag.set(diag);
  tidyDiag(w);
  for (let i = 0; i < N * N; i++) {
    if (!roads[i] && !rails[i]) continue;
    const x = i % N, z = (i / N) | 0;
    if (terrain.isWater(x, z) && terrain.tileAvg(x, z) < -0.9) {
      if (roads[i]) rep.roadsDropped++;
      if (rails[i]) rep.railsDropped++;
      w.roads[i] = 0; w.rails[i] = 0;
    }
  }
  // buildings the new ground no longer suits join the ones to be moved
  for (const r of kept.slice()) {
    const why = groundProblem(w, r);
    if (!why) continue;
    kept.splice(kept.indexOf(r), 1);
    losers.push({ r, why });
  }
  for (const r of kept) restore(w, r);
  for (const r of kept.slice()) {
    if (BUILDINGS[r.type].needsRail && !w.findRail(r.x, r.z, r.w, r.d)) { unplace(w, r); kept.splice(kept.indexOf(r), 1); losers.push({ r, why: 'lost its railway track' }); }
  }

  // ---- trees: each town keeps the trees on its own ground; new woods grow
  // in the new countryside
  const tileOwn = (x, z) => {
    const n = [0, 0, 0];
    n[own[z * S + x]]++; n[own[z * S + x + 1]]++; n[own[(z + 1) * S + x]]++; n[own[(z + 1) * S + x + 1]]++;
    return n[1] >= n[2] && n[1] >= n[0] ? 1 : n[2] >= n[0] ? 2 : FILLER;
  };
  const clearTile = (x, z) => w.inBounds(x, z) && !w.roads[z * N + x] && !w.rails[z * N + x] && w.buildingAt[z * N + x] < 0 && !terrain.isWater(x, z);
  for (const s of [A, B]) for (const t of s.w.trees) {
    const [X, Z] = s.point(t.x, t.z), tx = Math.floor(X), tz = Math.floor(Z);
    if (!w.inBounds(tx, tz) || tileOwn(tx, tz) !== s.tag || !clearTile(tx, tz)) continue;
    w.addTree(X, Z, t.k, t.s, t.r);
  }
  growCountryside(w, tileOwn, clearTile, (wA.seed ^ wB.seed) >>> 0);
  for (const b of w.buildings.values()) w._clearTreesNear(b.x, b.z, fw(b), fd(b), 0.22);

  // ---- one road network, with a road out to the edge of the map
  clearCorners(w);
  pickEntry(w, [A, B].map(s => s.tile(s.w.entry.x, s.w.entry.z)), rep);
  w.updateRoadNetwork();
  joinRoads(w, rep);
  // homes and shops left with no street at all get a short lane, if one fits
  for (const r of kept.slice()) {
    if (BUILDINGS[r.type].park || w.findAccess(r.x, r.z, r.w, r.d).length) continue;
    if (laneTo(w, r, rep)) continue;
    unplace(w, r); kept.splice(kept.indexOf(r), 1);
    losers.push({ r, why: 'was cut off from every road' });
  }
  w.updateRoadNetwork();

  // ---- the plots that lost out: nudged to the nearest free plot, or refunded
  losers.sort((a, b) => b.r.value - a.r.value);
  for (const l of losers) {
    const { r, why } = l, nm = nameOf(r), from = r.s.label;
    // two town halls that both lost their plots: only the first is rebuilt
    const dup = l.dup || (BUILDINGS[r.type].unique && [...w.buildings.values()].some(b => b.type === r.type));
    if (r.con && (r.con.kind === 'dismantle' || r.con.kind === 'demolish')) {
      const back = r.con.kind === 'demolish' ? Math.round(r.value * 0.25) : 0;
      rep.removed.push({ name: nm, from, why: `${why} (it was ${r.con.kind === 'demolish' ? 'being demolished' : 'being moved away'})`, refund: back });
      rep.refundTotal += back;
      continue;
    }
    const spot = dup ? null : findPlot(w, r);
    if (spot) {
      Object.assign(r, spot, { leases: [], moved: true });
      restore(w, r);
      for (let dz = 0; dz < r.d; dz++) for (let dx = 0; dx < r.w; dx++) w._clearTrees(r.x + dx, r.z + dz);
      w._clearTreesNear(r.x, r.z, r.w, r.d, 0.22);
      kept.push(r);
      rep.moved.push({ name: nm, from, why, dist: Math.round(Math.hypot(r.x - r.x0, r.z - r.z0)), at: [r.x, r.z] });
    } else {
      rep.refunded.push({ name: nm, from, why: dup ? why : `${why}, and no free plot was near`, refund: r.value });
      rep.refundTotal += r.value;
    }
  }
  w.updateRoadNetwork();
  w.updateRailLinks();

  // ---- land deals survive only between two plots that both stayed put
  const where = new Map(kept.map(r => [r.id, r]));
  for (const r of kept) {
    const b = w.buildings.get(r.id);
    if (!b || r.moved || !r.leases.length) continue;
    const ok = r.leases.filter(l => {
      const o = where.get(l.with);
      return o && !o.moved && o.leases.some(m => m.with === r.id && m.buyer !== l.buyer);
    });
    if (!ok.length) continue;
    b.leases = ok.map(l => ({ ...l }));
    const e = w._ext(b);
    for (const l of b.leases) e[l.side] = l.buyer ? l.amt : -l.amt;
  }
  // a building put up for a move whose old plot is gone uses fresh materials
  for (const b of w.buildings.values()) {
    if (b.con && b.con.wait === 'dismantle' && !w.buildings.has(b.con.from)) b.con.wait = null;
  }

  mergePeople(w, A, B, rng, rep);
  mergeLines(w, A, B, rep);
  mergeState(w, wA, wB, rep);
  w.nextId = Math.max(w.nextId, wA.nextId, wB.nextId + off, ...[...w.buildings.keys(), ...w.residents.keys(), ...w.lines.map(l => l.id)].map(i => i + 1));
  w.updateRoadNetwork();
  w.updateRailLinks();
  // farmland goes with its farm, on ground nothing else took; fields cut off
  // from their farm (one that moved, say) are dropped
  for (const s of [A, B]) {
    if (!s.w.fields) continue;
    for (let z = 0; z < s.N; z++) for (let x = 0; x < s.N; x++) {
      const f = s.w.fields[z * s.N + x];
      if (f < 0) continue;
      const [X, Z] = s.tile(x, z);
      if (!w.inBounds(X, Z)) continue;
      const i = w.idx(X, Z), id = s.id(f), farm = w.buildings.get(id);
      if (!farm || !BUILDINGS[farm.type].fields || w.roads[i] || w.rails[i] || w.buildingAt[i] >= 0 || w.fields[i] >= 0 || w.terrain.isWater(X, Z)) continue;
      w.fields[i] = id;
    }
  }
  w._pruneFields();
  // streets that were taken up keep no buried line or dressing
  for (let i = 0; i < N * N; i++) if (!w.roads[i]) { w.buried[i] = 0; w.dress[i] = 0; }

  const data = serialize(w);
  if (opts.preview) return { data, world: w, report: rep, layout: L };
  return { data, world: deserialize(data), report: rep, layout: L };
}

// --------------------------------------------------------------- terrain
function footSlope(t, x, z, w, d) {
  let lo = Infinity, hi = -Infinity;
  for (let dz = 0; dz < d; dz++) for (let dx = 0; dx < w; dx++) { lo = Math.min(lo, t.tileMin(x + dx, z + dz)); hi = Math.max(hi, t.tileMax(x + dx, z + dz)); }
  return hi - lo;
}

// Gradient-domain blend: inside a band around every join the new heights
// keep each town's own slopes and bumps, while the difference in level
// between the two sides is spread smoothly across the band (a Poisson solve).
// Buildings in the band float up or down as rigid blocks; buildings outside
// it keep their ground exactly. Rivers and lakes that reach a join are then
// carried across to water on the other side, or out to the edge of the map.
function blendTerrain({ N, own, grp, hOf, seam, rep, SRC, ways, dryWay }) {
  const S = N + 1, M = S * S;
  const G = new Float32Array(M);
  for (let c = 0; c < M; c++) G[c] = hOf(own[c], c % S, (c / S) | 0);
  // distance (in corners) from the nearest join
  const bd = new Int32Array(M).fill(1 << 30);
  const q = [];
  const jumps = [];
  for (let c = 0; c < M; c++) {
    const cx = c % S, cz = (c / S) | 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx > N || nz > N) continue;
      const o = own[nz * S + nx];
      if (o !== own[c]) { if (bd[c]) { bd[c] = 0; q.push(c); } if (dx > 0 || dz > 0) jumps.push(Math.abs(G[c] - hOf(o, cx, cz))); }
    }
  }
  jumps.sort((a, b) => a - b);
  const j90 = jumps.length ? jumps[Math.floor(jumps.length * 0.9)] : 0;
  const K = seam ? clamp(Math.round(seam), 2, 16) : clamp(Math.round(3 + j90 / 0.3), 4, 12);
  rep.seam.width = K;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi], cx = c % S, cz = (c / S) | 0, d = bd[c] + 1;
    if (d > K + 1) continue;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx > N || nz > N) continue;
      const n = nz * S + nx;
      if (bd[n] > d) { bd[n] = d; q.push(n); }
    }
  }
  const H = G.slice();
  // desired height step from corner c to its neighbour n: the owner's own
  // slope, or across a join the average of both sides' slopes
  const guide = (c, n) => {
    const a = own[c], b = own[n], cx = c % S, cz = (c / S) | 0, nx = n % S, nz = (n / S) | 0;
    const ga = hOf(a, nx, nz) - hOf(a, cx, cz);
    return a === b ? ga : 0.5 * (ga + hOf(b, nx, nz) - hOf(b, cx, cz));
  };
  const nbrs = (c) => {
    const cx = c % S, cz = (c / S) | 0, out = [];
    if (cx > 0) out.push(c - 1); if (cx < N) out.push(c + 1); if (cz > 0) out.push(c - S); if (cz < N) out.push(c + S);
    return out;
  };
  // rigid blocks: fixed if any corner lies outside the band, else floating
  const blocks = new Map();
  for (let c = 0; c < M; c++) if (grp[c] >= 0) { let g = blocks.get(grp[c]); if (!g) blocks.set(grp[c], g = { cs: [], fixed: false, D: 0 }); g.cs.push(c); if (bd[c] > K) g.fixed = true; }
  const floats = [...blocks.values()].filter(g => !g.fixed);
  const free = [];
  for (let c = 0; c < M; c++) if (bd[c] <= K && grp[c] < 0) free.push(c);
  const prep = (c) => { const ns = nbrs(c); let k = 0; for (const n of ns) k += guide(c, n); return { c, ns, k }; };
  const F = free.map(prep);
  for (const g of floats) {
    g.P = g.cs.map(prep);
    let lo = Infinity;
    for (const c of g.cs) lo = Math.min(lo, G[c]);
    g.minD = WL + 0.12 - lo; // a building never sinks into the water
  }
  rep.seam.corners = free.length;
  const omega = 1.8;
  for (let it = 0; it < 4000; it++) {
    let md = 0;
    for (const p of F) {
      let s = 0;
      for (const n of p.ns) s += H[n];
      const v = (s - p.k) / p.ns.length, nv = H[p.c] + omega * (v - H[p.c]);
      md = Math.max(md, Math.abs(nv - H[p.c]));
      H[p.c] = nv;
    }
    for (const g of floats) {
      let acc = 0;
      for (const p of g.P) { let s = 0; for (const n of p.ns) s += H[n]; acc += (s - p.k) / p.ns.length - G[p.c]; }
      const D = Math.max(g.minD, acc / g.P.length);
      md = Math.max(md, Math.abs(D - g.D));
      g.D = D;
      for (const c of g.cs) H[c] = G[c] + D;
    }
    if (md < 2e-5 && it > 10) break;
  }

  // ---- rivers and lakes across the join
  const prot = new Float32Array(M).fill(1);
  {
    const dist = new Int32Array(M).fill(99), qq = [];
    for (let c = 0; c < M; c++) if (grp[c] >= 0) { dist[c] = 0; qq.push(c); }
    for (let qi = 0; qi < qq.length; qi++) {
      const c = qq[qi], cx = c % S, cz = (c / S) | 0;
      if (dist[c] >= 7) continue;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx > N || nz > N) continue;
        const n = nz * S + nx;
        if (dist[n] > dist[c] + 1) { dist[n] = dist[c] + 1; qq.push(n); }
      }
    }
    for (let c = 0; c < M; c++) prot[c] = smoothstep(1, 6, dist[c]);
  }
  const mouths = [];
  {
    const seen = new Uint8Array(M);
    const wet = (c) => own[c] !== FILLER && bd[c] === 0 && G[c] < WL - 0.15;
    for (let c0 = 0; c0 < M; c0++) {
      if (seen[c0] || !wet(c0)) continue;
      const s = own[c0], list = [c0];
      seen[c0] = 1;
      let sx = 0, sz = 0, nx = 0, nz = 0;
      const faces = [0, 0, 0];
      for (let qi = 0; qi < list.length; qi++) {
        const c = list[qi], cx = c % S, cz = (c / S) | 0;
        sx += cx; sz += cz;
        for (const n of nbrs(c)) if (own[n] !== s) { faces[own[n]]++; nx += (n % S) - cx; nz += ((n / S) | 0) - cz; }
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const ax = cx + dx, az = cz + dz;
          if (ax < 0 || az < 0 || ax > N || az > N) continue;
          const n = az * S + ax;
          if (!seen[n] && own[n] === s && wet(n)) { seen[n] = 1; list.push(n); }
        }
      }
      const len = Math.hypot(nx, nz);
      if (len < 1e-6 || list.length < 2) continue;
      const t = faces.indexOf(Math.max(...faces));
      mouths.push({ s, t, x: sx / list.length, z: sz / list.length, nx: nx / len, nz: nz / len, size: list.length });
    }
  }
  // a river bed with banks no steeper than BANK per tile, softly meeting the
  // ground around it (a gorge through hills, a shallow dip across meadows)
  const BED = -0.75, BANK = 0.35, touched = new Uint8Array(M), bridged = new Uint8Array(M);
  // streets and tracks: a river carried on alone keeps clear of them
  const wayProt = new Float32Array(M).fill(1);
  {
    const dist = new Int32Array(M).fill(99), qq = [];
    for (let k = 0; k < ways.length; k += 2) {
      const i = ways[k], x = i % N, z = (i / N) | 0;
      for (const c of [z * S + x, z * S + x + 1, (z + 1) * S + x, (z + 1) * S + x + 1]) if (dist[c]) { dist[c] = 0; qq.push(c); }
    }
    for (let qi = 0; qi < qq.length; qi++) {
      const c = qq[qi], cx = c % S, cz = (c / S) | 0;
      if (dist[c] >= 4) continue;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx > N || nz > N) continue;
        const n = nz * S + nx;
        if (dist[n] > dist[c] + 1) { dist[n] = dist[c] + 1; qq.push(n); }
      }
    }
    for (let c = 0; c < M; c++) wayProt[c] = Math.min(prot[c], smoothstep(0.5, 3, dist[c]));
  }
  const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
  const carve = (pts, hw, guard, mark = null) => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of pts) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
    let top = BED;
    for (let cz = Math.max(0, Math.floor(z0 - 4)); cz <= Math.min(N, Math.ceil(z1 + 4)); cz++) for (let cx = Math.max(0, Math.floor(x0 - 4)); cx <= Math.min(N, Math.ceil(x1 + 4)); cx++) top = Math.max(top, H[cz * S + cx]);
    const R = Math.min(22, hw + (top - BED) / BANK + 1.5);
    for (let cz = Math.max(0, Math.floor(z0 - R)); cz <= Math.min(N, Math.ceil(z1 + R)); cz++) {
      for (let cx = Math.max(0, Math.floor(x0 - R)); cx <= Math.min(N, Math.ceil(x1 + R)); cx++) {
        const c = cz * S + cx;
        if (!guard[c]) continue;
        let d = Infinity;
        for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(cx, cz, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
        if (d > R) continue;
        const bank = BED + BANK * Math.max(0, d - hw);
        const v = smin(H[c], bank, 0.3);
        if (v < H[c]) { H[c] = lerp(H[c], v, guard[c]); touched[c] = 1; if (mark && d < hw + 2) mark[c] = 1; }
      }
    }
  };
  const used = new Set();
  const pairs = [];
  for (const a of mouths) for (const b of mouths) {
    if (a.s !== 1 || b.s !== 2 || a.t !== 2 || b.t !== 1) continue;
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    if (d <= Math.max(12, 1.6 * K)) pairs.push([d, a, b]);
  }
  pairs.sort((p, q2) => p[0] - q2[0]);
  for (const [d, a, b] of pairs) {
    if (used.has(a) || used.has(b)) continue;
    used.add(a); used.add(b);
    const m = Math.max(3, (d + K) / 2), back = K * 0.6;
    const P0 = [a.x - a.nx * back, a.z - a.nz * back], P1 = [a.x + a.nx * m * 0.6, a.z + a.nz * m * 0.6];
    const P3 = [b.x - b.nx * back, b.z - b.nz * back], P2 = [b.x + b.nx * m * 0.6, b.z + b.nz * m * 0.6];
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24, u = 1 - t;
      pts.push([u * u * u * P0[0] + 3 * u * u * t * P1[0] + 3 * u * t * t * P2[0] + t * t * t * P3[0], u * u * u * P0[1] + 3 * u * u * t * P1[1] + 3 * u * t * t * P2[1] + t * t * t * P3[1]]);
    }
    carve(pts, clamp(Math.min(a.size, b.size) * 0.45, 1.2, 2.6), prot, bridged);
    rep.rivers++;
  }
  // a river with nothing to meet runs on through new countryside to the edge
  // of the map, or ends in a pool before it reaches the other town
  for (const m of mouths) {
    if (used.has(m)) continue;
    const pts = [];
    const px = -m.nz, pz = m.nx, ph = (m.x * 0.37 + m.z * 0.61) % 6.28;
    for (let t = -K * 0.6; t < 3 * N; t += 0.5) {
      const wig = Math.sin(t * 0.22 + ph) * Math.min(2, Math.max(0, t) * 0.25);
      const x = m.x + m.nx * t + px * wig, z = m.z + m.nz * t + pz * wig;
      pts.push([x, z]);
      if (x < -1 || z < -1 || x > N + 1 || z > N + 1) break;
      const cx = clamp(Math.round(x), 0, N), cz = clamp(Math.round(z), 0, N), c = cz * S + cx;
      if (t > 0 && own[c] !== m.s && own[c] !== FILLER && bd[c] > K * 0.5) break;
      if (t > 0 && wayProt[c] < 0.5) break;
    }
    if (pts.length < 3) continue;
    carve(pts, clamp(m.size * 0.45, 1.1, 2.4), wayProt);
    if (m.t === FILLER) rep.rivers++;
  }
  // a street or track that ran on dry ground but now sits in shallow water
  // (and is not where a river was joined up) gets a low embankment
  const bank = new Uint8Array(M);
  for (let i = 0; i < N * N; i++) {
    if (!dryWay[i]) continue;
    const x = i % N, z = (i / N) | 0, cs = [z * S + x, z * S + x + 1, (z + 1) * S + x, (z + 1) * S + x + 1];
    const avg = (H[cs[0]] + H[cs[1]] + H[cs[2]] + H[cs[3]]) / 4;
    if (avg >= WL + 0.05 || avg < WL - 0.45 || cs.some(c => bridged[c])) continue;
    for (const c of cs) if (grp[c] < 0 && H[c] < WL + 0.09) { H[c] = WL + 0.09; bank[c] = 1; }
  }
  // last, ease any step left steeper than the steepest in either valley
  // (where a carved bank meets a building's ground, or two plateaus meet)
  let lim = 0.55;
  for (const src of SRC) if (src) {
    const sS = src.N + 1;
    for (let i = 0; i < sS * sS; i++) {
      if (i % sS < src.N) lim = Math.max(lim, Math.abs(src.H[i] - src.H[i + 1]));
      if (i + sS < sS * sS) lim = Math.max(lim, Math.abs(src.H[i] - src.H[i + sS]));
    }
  }
  lim = Math.min(lim, 0.75);
  const movable = (c) => grp[c] < 0 && !bank[c] && (bd[c] <= K + 2 || touched[c]);
  for (let it = 0; it < 300; it++) {
    let worst = 0;
    for (let c = 0; c < M; c++) {
      const cx = c % S;
      for (const n of [cx < N ? c + 1 : -1, c + S < M ? c + S : -1]) {
        if (n < 0) continue;
        const dh = H[n] - H[c], ex = Math.abs(dh) - lim;
        if (ex <= 1e-4) continue;
        const mc = movable(c), mn = movable(n);
        if (!mc && !mn) continue;
        worst = Math.max(worst, ex);
        const sgn = Math.sign(dh), part = mc && mn ? ex / 2 : ex;
        if (mc) H[c] += sgn * part;
        if (mn) H[n] -= sgn * part;
      }
    }
    if (worst < 1e-3) break;
  }
  // keep shallow shores from fighting with the water plane
  for (let c = 0; c < M; c++) {
    if (grp[c] >= 0 || bank[c]) continue;
    if (Math.abs(H[c] - WL) < 0.03) H[c] = WL + (H[c] < WL ? -0.04 : 0.04);
  }
  let step = 0;
  for (let c = 0; c < M; c++) {
    if (bd[c] > K) continue;
    const cx = c % S;
    if (cx < N) step = Math.max(step, Math.abs(H[c] - H[c + 1]));
    if (c + S < M) step = Math.max(step, Math.abs(H[c] - H[c + S]));
  }
  rep.seam.maxStep = Math.round(step * 1000) / 1000;
  return H;
}

// ------------------------------------------------------------ buildings
function restore(w, r) {
  w.restoreBuilding({ id: r.id, type: r.type, level: r.level, x: r.x, z: r.z, variant: r.variant, rot: r.rot, built: r.built, w: r.w, d: r.d, flavor: r.flavor, con: r.con, look: r.look, spare: r.spare, pose: r.pose });
}

function unplace(w, r) {
  for (let dz = 0; dz < r.d; dz++) for (let dx = 0; dx < r.w; dx++) w.buildingAt[w.idx(r.x + dx, r.z + dz)] = -1;
  w.buildings.delete(r.id);
}

// Why a plot no longer works on the blended ground (null if it is fine).
function groundProblem(w, r) {
  const t = w.terrain;
  let lo = Infinity, hi = -Infinity;
  for (let dz = 0; dz < r.d; dz++) for (let dx = 0; dx < r.w; dx++) {
    const x = r.x + dx, z = r.z + dz, i = w.idx(x, z);
    if (t.isWater(x, z)) return 'ended up in water';
    if (w.roads[i] || w.rails[i]) return 'had a road or track run through it';
    lo = Math.min(lo, t.tileMin(x, z)); hi = Math.max(hi, t.tileMax(x, z));
  }
  const lim = Math.max(r.w, r.d) === 1 ? 0.9 : 1.1;
  if (hi - lo > Math.max(lim, r.slope0 + 0.05)) return 'ended up on ground too steep to stand on';
  if (BUILDINGS[r.type].needsWater) {
    let wet = false;
    for (let k = -1; k <= r.w && !wet; k++) wet = [[r.x + k, r.z - 1], [r.x + k, r.z + r.d]].some(([x, z]) => w.inBounds(x, z) && t.isWater(x, z));
    for (let k = 0; k < r.d && !wet; k++) wet = [[r.x - 1, r.z + k], [r.x + r.w, r.z + k]].some(([x, z]) => w.inBounds(x, z) && t.isWater(x, z));
    if (!wet) return 'is no longer beside water';
  }
  return null;
}

// Nearest free plot where the building is allowed and reaches a road
// joined to the town (parks need no road).
function findPlot(w, r) {
  const def = BUILDINGS[r.type];
  const shapes = r.w === r.d ? [[r.w, r.d]] : [[r.w, r.d], [r.d, r.w]];
  for (let rad = 1; rad <= 18; rad++) {
    let best = null, bd = Infinity;
    for (let dz = -rad; dz <= rad; dz++) for (let dx = -rad; dx <= rad; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== rad) continue;
      const x = r.x0 + dx, z = r.z0 + dz, d = Math.hypot(dx, dz);
      if (d >= bd) continue;
      for (const [W, D] of shapes) {
        const c = w.checkBuild(r.type, x, z, { w: W, d: D, ignoreUnlock: true, ignoreUnique: true, ignoreMoney: true });
        if (!c.ok || (!def.park && !c.access.some(a => a.conn))) continue;
        best = { x, z, w: W, d: D, rot: c.access.length ? c.access[0].rot : r.rot }; bd = d;
        break;
      }
    }
    if (best) return best;
  }
  return null;
}

// --------------------------------------------------------------- roads
function pickEntry(w, cands, rep) {
  const N = w.N;
  const edge = (x, z) => x === 0 || z === 0 || x === N - 1 || z === N - 1;
  for (const [x, z] of cands) if (w.inBounds(x, z) && w.roads[w.idx(x, z)] && edge(x, z)) { w.entry = { x, z }; return; }
  // any street that already reaches the edge, nearest the town hall
  let hall = null;
  for (const b of w.buildings.values()) if (BUILDINGS[b.type].seat) hall = b;
  const fx = hall ? hall.x : N / 2, fz = hall ? hall.z : N / 2;
  let best = null, bd = Infinity;
  for (let k = 0; k < N; k++) for (const [x, z] of [[k, 0], [k, N - 1], [0, k], [N - 1, k]]) {
    if (!w.roads[w.idx(x, z)]) continue;
    const d = Math.hypot(x - fx, z - fz);
    if (d < bd) { bd = d; best = { x, z }; }
  }
  if (best) { w.entry = best; return; }
  // otherwise lay a new road out to the nearest edge
  const starts = [];
  for (let i = 0; i < N * N; i++) if (w.roads[i]) starts.push(i);
  const path = starts.length ? cheapestPath(w, starts, (i) => edge(i % N, (i / N) | 0)) : null;
  if (path) {
    const fresh = new Set();
    for (const i of path) if (!w.roads[i]) { w.roads[i] = 1; fresh.add(i); w._clearTrees(i % N, (i / N) | 0); rep.entryLaid++; }
    laid(w, path, fresh);
    const e = path[path.length - 1];
    w.entry = { x: e % N, z: (e / N) | 0 };
  } else {
    w.entry = { x: Math.floor(fx), z: Math.floor(fz) };
  }
}

// Cheapest buildable road from any start tile to a tile where goal(i) holds
// (bridges cost more, buildings block, steep ground and deep water too).
function cheapestPath(w, starts, goal, maxCost = Infinity, lenient = false) {
  const N = w.N, t = w.terrain;
  const cost = new Float32Array(N * N).fill(Infinity), prev = new Int32Array(N * N).fill(-1);
  const heap = new MinHeap();
  const isStart = new Uint8Array(N * N);
  for (const s of starts) { cost[s] = 0; isStart[s] = 1; heap.push(0, s); }
  const step = (x, z) => {
    const i = z * N + x;
    if (w.buildingAt[i] >= 0) return Infinity;
    if (w.roads[i]) return 0.6;
    const water = t.isWater(x, z);
    if (water && t.tileAvg(x, z) < (lenient ? -1.3 : -0.9)) return Infinity;
    if (!water && t.slope(x, z) > (lenient ? 1.6 : 0.85)) return Infinity;
    return 1 + t.slope(x, z) * 3 + (water ? 5 : 0) + (w.rails[i] ? 1 : 0) + w.treeCount[i] * 0.2;
  };
  while (heap.size) {
    const i = heap.pop();
    const ci = cost[i];
    if (ci > maxCost) return null;
    if (!isStart[i] && goal(i)) {
      const path = [];
      for (let k = i; k !== -1; k = prev[k]) path.push(k);
      return path.reverse();
    }
    const x = i % N, z = (i / N) | 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
      const ni = nz * N + nx, c = ci + step(nx, nz);
      if (c < cost[ni]) { cost[ni] = c; prev[ni] = i; heap.push(c, ni); }
    }
  }
  return null;
}

// A diagonal of one town may now pass the corner of a building of the other
// that can't turn to face it: that link goes (both tiles stay road).
function clearCorners(w) {
  const N = w.N, D = w.diag;
  let n = 0;
  for (let i = 0; i < N * N; i++) {
    if (!(D[i] & 15)) continue;
    const x = i % N, z = (i / N) | 0;
    for (let k = 0; k < 4; k++) {
      const [dx, dz] = CORNERS[k];
      if (!(D[i] & (1 << k)) || !w.inBounds(x + dx, z + dz)) continue;
      if (![[x + dx, z], [x, z + dz]].some(([ox, oz]) => { const b = w.buildingOn(ox, oz); return b && !diagCapable(b); })) continue;
      D[i] &= ~(1 << k);
      D[(z + dz) * N + x + dx] &= ~(1 << ((k + 2) & 3));
      n++;
    }
  }
  if (n) tidyDiag(w);
}

// A road just laid along a path of tiles (each next to the last) joins the
// streets it runs into, even a diagonal's tile cut off from the road beside.
function laid(w, path, fresh) {
  const N = w.N;
  linkStroke(w, path.map(i => [i % N, (i / N) | 0]), fresh);
}

function roadPieces(w) {
  const N = w.N, comp = new Int32Array(N * N).fill(-1), pieces = [];
  for (let s = 0; s < N * N; s++) {
    if (!w.roads[s] || comp[s] >= 0) continue;
    const id = pieces.length, tiles = [s];
    comp[s] = id;
    for (let q = 0; q < tiles.length; q++) {
      const i = tiles[q], x = i % N, z = (i / N) | 0;
      // along the grid (not where a diagonal passes by, cut off) and diagonally
      for (const [nx, nz] of linksOf(w, x, z)) {
        const ni = nz * N + nx;
        if (comp[ni] < 0) { comp[ni] = id; tiles.push(ni); }
      }
    }
    pieces.push(tiles);
  }
  return { comp, pieces };
}

// Join every separate piece of road to the network that reaches the edge of
// the map, laying the cheapest new road between them. Stray scraps with no
// buildings on them are cleared instead.
function joinRoads(w, rep) {
  const N = w.N;
  let { comp, pieces } = roadPieces(w);
  const main = comp[w.idx(w.entry.x, w.entry.z)];
  if (main < 0) return;
  const served = new Set();
  for (const b of w.buildings.values()) for (const a of w.findAccess(b.x, b.z, fw(b), fd(b))) served.add(comp[w.idx(a.x, a.z)]);
  for (let p = 0; p < pieces.length; p++) {
    if (p === main || served.has(p) || pieces[p].length >= 3) continue;
    for (const i of pieces[p]) { w.roads[i] = 0; comp[i] = -1; }
    rep.strays += pieces[p].length;
    pieces[p] = null;
  }
  const inMain = new Uint8Array(N * N);
  let net = [];
  for (const i of pieces[main]) { inMain[i] = 1; net.push(i); }
  const left = new Set(pieces.map((t, p) => (t && p !== main ? p : -1)).filter(p => p >= 0));
  let lenient = false;
  while (left.size) {
    const path = cheapestPath(w, net, (i) => w.roads[i] && !inMain[i] && left.has(comp[i]), Infinity, lenient);
    // nothing buildable reaches it: try again allowing steeper banks and deeper bridges
    if (!path && !lenient) { lenient = true; continue; }
    if (!path) break;
    const hit = comp[path[path.length - 1]];
    const lvl = Math.max(1, Math.min(w.roads[path[0]] || 1, w.roads[path[path.length - 1]] || 1));
    const fresh = new Set();
    for (const i of path) {
      if (!w.roads[i]) { w.roads[i] = lvl; fresh.add(i); w._clearTrees(i % N, (i / N) | 0); rep.roadsLaid++; }
      if (!inMain[i]) { inMain[i] = 1; net.push(i); }
    }
    laid(w, path, fresh);
    for (const i of pieces[hit]) if (!inMain[i]) { inMain[i] = 1; net.push(i); }
    left.delete(hit);
    rep.joined++;
  }
  // pieces boxed in by buildings go; anything they served gets a lane or moves
  for (const p of left) for (const i of pieces[p]) { w.roads[i] = 0; rep.unjoinedTiles++; }
  rep.unjoined = left.size;
  w.updateRoadNetwork();
}

// A short lane from the town's streets to a building that lost its road.
function laneTo(w, r, rep) {
  const N = w.N, net = [];
  for (let i = 0; i < N * N; i++) if (w.roads[i] && w.connected[i]) net.push(i);
  if (!net.length) return false;
  const ring = new Set(), side = [];
  for (let k = 0; k < r.w; k++) side.push([r.x + k, r.z - 1], [r.x + k, r.z + r.d]);
  for (let k = 0; k < r.d; k++) side.push([r.x - 1, r.z + k], [r.x + r.w, r.z + k]);
  for (const [x, z] of side) if (w.inBounds(x, z)) ring.add(w.idx(x, z));
  const path = cheapestPath(w, net, (i) => ring.has(i), 18);
  if (!path) return false;
  const fresh = new Set();
  for (const i of path) if (!w.roads[i]) { w.roads[i] = 1; fresh.add(i); w._clearTrees(i % N, (i / N) | 0); rep.roadsLaid++; }
  laid(w, path, fresh);
  w.updateRoadNetwork();
  return true;
}

// ---------------------------------------------------------- countryside
function growCountryside(w, tileOwn, clear, seed) {
  const N = w.N, t = w.terrain, rng = new RNG(seed + 404);
  const nF = makeNoise2D(seed + 303);
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    if (tileOwn(x, z) !== FILLER || !clear(x, z)) continue;
    const h = t.tileAvg(x, z), slope = t.slope(x, z), forest = fbm(nF, x * 0.085, z * 0.085, 3);
    if (rng.chance(forest > 0.12 ? 0.5 + forest : 0.035)) {
      const n = forest > 0.35 ? rng.int(2, 3) : 1;
      for (let k = 0; k < n; k++) {
        const kind = rng.chance(h > 1.6 ? 0.8 : 0.35) ? TREE.PINE : rng.chance(0.2) ? TREE.BIRCH : TREE.ROUND;
        w.addTree(x + rng.float(0.15, 0.85), z + rng.float(0.15, 0.85), kind, rng.float(0.7, 1.25), rng.float(0, 6.28));
      }
    } else if (h < 0.35 && rng.chance(0.18)) {
      w.addTree(x + rng.float(0.2, 0.8), z + rng.float(0.2, 0.8), TREE.BUSH, rng.float(0.7, 1.2), rng.float(0, 6.28));
    }
    if ((slope > 0.45 || h > 2.2) && rng.chance(0.3)) w.addTree(x + rng.float(0.2, 0.8), z + rng.float(0.2, 0.8), TREE.ROCK, rng.float(0.6, 1.4), rng.float(0, 6.28));
    else if (rng.chance(0.02)) w.addTree(x + rng.float(0.2, 0.8), z + rng.float(0.2, 0.8), rng.chance(0.5) ? TREE.ROCK : TREE.PEBBLE, rng.float(0.5, 1), rng.float(0, 6.28));
  }
}

// ---------------------------------------------------------------- people
function mergePeople(w, A, B, rng, rep) {
  const full = new Set(), first = new Set();
  const isHome = (b) => b && BUILDINGS[b.type].levels[b.level].housing;
  const homeless = [];
  for (const s of [A, B]) {
    for (const r0 of s.w.residents.values()) {
      const r = { ...r0, id: s.id(r0.id) };
      if (r.home != null) r.home = s.id(r.home);
      if (r.job != null) r.job = s.id(r.job);
      if (r.fam != null) r.fam = s.id(r.fam);
      if (r.edYrs && typeof r.edYrs === 'object') r.edYrs = { ...r.edYrs };
      // the usual rule for newcomers: nobody shares a whole name
      if (full.has(`${r.first} ${r.last}`)) {
        for (let k = 0; k < 40 && full.has(`${r.first} ${r.last}`); k++) r.first = firstName(rng, first);
        rep.renamed++;
      }
      full.add(`${r.first} ${r.last}`); first.add(r.first);
      if (r.job != null) {
        const j = w.buildings.get(r.job);
        if (!j || !BUILDINGS[j.type].levels[j.level].jobs) { r.job = null; rep.jobless++; }
      }
      w.residents.set(r.id, r);
      if (r.home != null && !isHome(w.buildings.get(r.home))) {
        const was = s.w.buildings.get(r0.home);
        const [x, z] = was ? s.point(was.x, was.z) : [w.N / 2, w.N / 2];
        homeless.push({ r, key: r.home, x, z });
      }
    }
  }
  if (!homeless.length) return;
  // households stay together where a home has room for all of them
  const room = new Map();
  for (const b of w.buildings.values()) {
    if (!isHome(b) || (b.con && b.con.kind !== 'upgrade' && b.con.kind !== 'merge')) continue;
    room.set(b.id, capOf(b, 'housing'));
  }
  for (const r of w.residents.values()) if (room.has(r.home)) room.set(r.home, room.get(r.home) - 1);
  const homes = [...room.keys()].map(id => w.buildings.get(id));
  const groups = new Map();
  for (const h of homeless) { let g = groups.get(h.key); if (!g) groups.set(h.key, g = []); g.push(h); }
  for (const g of groups.values()) {
    const { x, z } = g[0];
    const near = homes.slice().sort((a, b) => (b.connected - a.connected) || Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
    const all = near.find(b => room.get(b.id) >= g.length);
    for (const h of g) {
      const to = all || near.find(b => room.get(b.id) > 0);
      if (to) { h.r.home = to.id; room.set(to.id, room.get(to.id) - 1); rep.rehomed++; }
      else { w.residents.delete(h.r.id); rep.released++; }
    }
  }
}

// ----------------------------------------------------------------- lines
function mergeLines(w, A, B, rep) {
  const names = new Set(), colors = new Set();
  for (const s of [A, B]) for (const l of s.w.lines) {
    const stops = l.stops.map(s.id).filter(id => w.buildings.has(id));
    const lost = l.stops.length - stops.length;
    if (stops.length < 2) {
      const back = (TRANSIT[l.mode]?.vehicleCost || 0) * (l.vehicles || 1);
      rep.linesRemoved.push({ name: l.name, from: s.label, refund: back });
      rep.refundTotal += back;
      continue;
    }
    const line = { id: s.id(l.id), mode: l.mode, name: l.name, color: l.color, stops, vehicles: l.vehicles };
    if (names.has(line.name)) {
      const base = TRANSIT[line.mode]?.lineName || 'Coach Line';
      let n = 1;
      while (names.has(`${base} ${n}`)) n++;
      line.name = `${base} ${n}`;
    }
    if (colors.has(line.color)) line.color = LINE_COLORS.find(c => !colors.has(c)) || line.color;
    names.add(line.name); colors.add(line.color);
    if (lost) rep.linesTrimmed.push({ name: line.name, from: s.label, stops: lost });
    w.lines.push(line);
  }
}

// ------------------------------------------------------- money and time
function mergeState(w, wA, wB, rep) {
  const later = wB.day > wA.day || (wB.day === wA.day && wB.hours > wA.hours) ? wB : wA;
  w.day = later.day;
  w.hours = later.hours;
  w.taxRate = wA.taxRate;
  w.titleIdx = Math.max(wA.titleIdx || 0, wB.titleIdx || 0);
  const fin = Number.isFinite(wA.money) && Number.isFinite(wB.money);
  w.money = fin ? Math.round(wA.money + wB.money + rep.refundTotal) : Infinity;
  const sb = {};
  for (const k of Object.keys(w.sandbox)) sb[k] = !!(wA.sandbox[k] || wB.sandbox[k]);
  w.setSandbox(sb);
  if (!fin && !sb.infiniteMoney) w.money = 100000;
  for (const k of Object.keys(w.stats)) w.stats[k] = (wA.stats[k] || 0) + (wB.stats[k] || 0);
  // research: everything either town discovered; the project under way carries on
  const RA = wA.research, RB = wB.research;
  const done = [...new Set([...RA.done, ...RB.done])];
  let current = null, progress = 0, bank = (RA.bank || 0) + (RB.bank || 0);
  for (const R of [RA, RB]) {
    if (!R.current || done.includes(R.current)) { bank += R.current ? R.progress || 0 : 0; continue; }
    if (!current) { current = R.current; progress = R.progress || 0; }
    else if (R.current === current) progress = Math.max(progress, R.progress || 0);
    else bank += R.progress || 0;
  }
  w.research = { done, current, progress, bank };
  rep.research = { a: RA.done.length, b: RB.done.length, total: done.length };
  rep.money = { a: wA.money, b: wB.money, total: w.money };
  rep.day = { a: wA.day, b: wB.day, total: w.day };
  // daily history: both towns added together, day by day
  const by = new Map();
  for (const h of [...(wA.history || []), ...(wB.history || [])]) {
    const e = by.get(h.day);
    if (!e) { by.set(h.day, { ...h }); continue; }
    e.happy = Math.round((e.happy * e.pop + h.happy * h.pop) / Math.max(1, e.pop + h.pop));
    e.pop += h.pop;
    e.money = e.money == null || h.money == null ? null : e.money + h.money;
    e.net = (e.net || 0) + (h.net || 0);
  }
  w.history = [...by.values()].sort((a, b) => a.day - b.day).slice(-400);
}

// ------------------------------------------------------------ summaries
// One line per kind of change (with a Material Symbols icon name), for the
// arrangement screen and the report.
export function reportLines(rep) {
  const out = [];
  const n = (k, one, many = one + 's') => `${k} ${k === 1 ? one : many}`;
  const money = (v) => (Number.isFinite(v) ? `$${Math.round(v).toLocaleString('en-US')}` : '∞');
  out.push(['map', `Merged map: ${rep.N}×${rep.N}${rep.cropped ? ' (empty countryside trimmed at the outer edges)' : ''}${rep.countryside > rep.N ? ' · new countryside fills the gaps' : ''}`]);
  out.push(['landscape', `Ground blended across a ${rep.seam.width}-tile band each side of the join${rep.rivers ? ` · ${n(rep.rivers, 'river')} carried across` : ''}`]);
  if (rep.moved.length) out.push(['local_shipping', `${n(rep.moved.length, 'building')} moved to the nearest free plot`]);
  if (rep.converted.length) out.push(['swap_horiz', rep.converted.map(c => `the ${c.from} ${c.name} becomes a ${c.to}`).join('; ')]);
  if (rep.refunded.length) out.push(['payments', `${n(rep.refunded.length, 'building')} refunded (${money(rep.refunded.reduce((s, r) => s + r.refund, 0))})`]);
  if (rep.removed.length) out.push(['cleaning_services', `${n(rep.removed.length, 'half-finished job')} dropped`]);
  const roadBits = [];
  if (rep.joined) roadBits.push(`${n(rep.joined, 'road network')} joined on`);
  if (rep.roadsLaid + rep.entryLaid) roadBits.push(`${n(rep.roadsLaid + rep.entryLaid, 'tile')} of new road`);
  if (rep.roadsDropped) roadBits.push(`${n(rep.roadsDropped, 'road tile')} under buildings or deep water removed`);
  if (rep.railsDropped) roadBits.push(`${n(rep.railsDropped, 'track tile')} removed`);
  if (rep.strays) roadBits.push(`${n(rep.strays, 'stray road tile')} cleared`);
  if (rep.unjoined) roadBits.push(`${n(rep.unjoined, 'road piece')} boxed in by buildings removed`);
  out.push(['add_road', roadBits.length ? roadBits.join(' · ') : 'Roads already meet — nothing to join']);
  const people = [];
  if (rep.rehomed) people.push(`${rep.rehomed} rehomed`);
  if (rep.released) people.push(`${rep.released} moved away (no room)`);
  if (rep.jobless) people.push(`${rep.jobless} looking for new work`);
  if (rep.renamed) people.push(`${rep.renamed} renamed so no two share a name`);
  if (people.length) out.push(['groups', `Villagers: ${people.join(' · ')}`]);
  if (rep.linesTrimmed.length || rep.linesRemoved.length) {
    out.push(['directions_bus', [...rep.linesTrimmed.map(l => `${l.name} lost ${n(l.stops, 'stop')}`), ...rep.linesRemoved.map(l => `${l.name} (${l.from}) closed`)].join(' · ')]);
  }
  if (rep.research) out.push(['science', `Research: ${n(rep.research.total, 'project')} known (${rep.research.a} + ${rep.research.b}, shared ones counted once)`]);
  if (rep.money) out.push(['savings', `Treasury: ${money(rep.money.a)} + ${money(rep.money.b)}${rep.refundTotal ? ` + ${money(rep.refundTotal)} refunds` : ''} = ${money(rep.money.total)}`]);
  if (rep.day) out.push(['calendar_month', `Calendar: day ${rep.day.total} (the later of day ${rep.day.a} and day ${rep.day.b})`]);
  return out;
}
