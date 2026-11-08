// Saves from Kinstead on squares (version 1), made over for the gridless
// town (version 2). Called by deserialize before anything else reads them.
//
// - Roads and track: each run of road tiles between two junctions or ends
//   becomes one curve through the tiles' middles, round a quarter circle
//   where it turned a corner, straight across a corner where it ran
//   diagonally. Junctions and ends become nodes; a change of road level is
//   a node too. Two roads laid side by side as a boulevard stay two roads,
//   not joined across the median. The road out of the valley runs on to the
//   edge of the map, as it always did off it. Dressings and buried lines go
//   with the curves (the commonest dressing along each).
// - Buildings: a plot of w × d tiles at its corner, facing rot, becomes its
//   middle, its angle and its width and depth in its own frame, turned and
//   nudged as it stood (b.pose). Garden strips and land taken but not built
//   on keep their sides, now in the building's own frame.
// - Farm fields: a unit square at each field tile's middle.

import { Net } from '../world/net.js';
import { simplify } from '../world/geom.js';

const SIDES = [[0, -1], [1, 0], [0, 1], [-1, 0]];      // N E S W, as the old roadShape.js
const CORNERS = [[1, -1], [1, 1], [-1, 1], [-1, -1]];  // NE SE SW NW
const CUT = 16;
const DIRS = [[0, 1], [1, 0], [0, -1], [-1, 0]];        // rot → facing

function fromB64(b) {
  const s = atob(b), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
const grid = (b, N) => { const g = new Uint8Array(N * N); if (typeof b === 'string') g.set(fromB64(b).subarray(0, N * N)); return g; };

// The medians of boulevards on the old map (as boulevard.js found them):
// sides of tiles with a median across them (N 1, E 2, S 4, W 8).
function medians(N, roads, rails, water, diag) {
  const out = new Uint8Array(N * N);
  const road = (x, z) => x >= 0 && z >= 0 && x < N && z < N && roads[z * N + x] > 0 && !diag[z * N + x];
  for (const ax of [0, 1]) {
    const has = ax ? (u, v) => road(v, u) : (u, v) => road(u, v);
    const id = ax ? (u, v) => u * N + v : (u, v) => v * N + u;
    const first = ax ? 2 : 4, second = ax ? 8 : 1, other = ax ? 5 : 10;
    for (let u = 0; u < N; u++) for (let v = 0; v < N;) {
      if (!has(u, v)) { v++; continue; }
      let v1 = v;
      while (v1 + 1 < N && has(u, v1 + 1)) v1++;
      const T = v1 - v + 1;
      if (T >= 2) {
        const full = (uu) => { if (uu < 0 || uu >= N) return false; for (let q = v; q <= v1; q++) if (!has(uu, q)) return false; return true; };
        let a = u, b = u;
        while (full(a - 1)) a--;
        while (full(b + 1)) b++;
        if (u > a && u < b && b - a + 1 > T) for (let q = v; q < v1; q++) {
          const i = id(u, q), j = id(u, q + 1);
          if (rails[i] || rails[j] || (out[i] & other) || (out[j] & other)) continue;
          out[i] |= first; out[j] |= second;
        }
      }
      v = v1 + 1;
    }
  }
  void water;
  return out;
}

// The old tile network (grid g of levels, diag bytes, medians) as a Net.
function netOf(N, g, diag, med, entry, props) {
  const net = new Net(props.kind);
  const at = (x, z) => (x >= 0 && z >= 0 && x < N && z < N ? g[z * N + x] : 0);
  const cut = (x, z, k) => (diag[z * N + x] & (CUT << k)) || (() => { const nx = x + SIDES[k][0], nz = z + SIDES[k][1]; return nx >= 0 && nz >= 0 && nx < N && nz < N && (diag[nz * N + nx] & (CUT << ((k + 2) & 3))); })();
  // every tile's links: [nx, nz]
  const links = (x, z) => {
    const out = [];
    for (let k = 0; k < 4; k++) {
      const nx = x + SIDES[k][0], nz = z + SIDES[k][1];
      if (!at(nx, nz) || (med[z * N + x] & (1 << k)) || cut(x, z, k)) continue;
      out.push([nx, nz]);
    }
    for (let k = 0; k < 4; k++) {
      if (!(diag[z * N + x] & (1 << k))) continue;
      const nx = x + CORNERS[k][0], nz = z + CORNERS[k][1];
      if (at(nx, nz) && (diag[nz * N + nx] & (1 << ((k + 2) & 3)))) out.push([nx, nz]);
    }
    return out;
  };
  const L = new Map();
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) if (g[z * N + x]) L.set(z * N + x, links(x, z));
  // nodes: ends, junctions, a change of level, the entry
  const isNode = (i) => {
    const l = L.get(i);
    if (l.length !== 2) return true;
    if (entry != null && i === entry) return true;
    const lv = g[i];
    return l.some(([x, z]) => g[z * N + x] !== lv);
  };
  const nodeOf = new Map();
  const node = (i) => {
    if (!nodeOf.has(i)) nodeOf.set(i, net.addNode((i % N) + 0.5, Math.floor(i / N) + 0.5).id);
    return nodeOf.get(i);
  };
  const done = new Set();   // links walked: 'i>j'
  const walk = (start, first) => {
    const tiles = [start];
    let prev = start, cur = first;
    while (true) {
      tiles.push(cur);
      done.add(prev + '>' + cur); done.add(cur + '>' + prev);
      if (isNode(cur) || cur === start) break;
      const nx = L.get(cur).map(([x, z]) => z * N + x).find(j => j !== prev && !done.has(cur + '>' + j));
      if (nx == null) break;
      prev = cur; cur = nx;
    }
    return tiles;
  };
  const chains = [];
  for (const i of L.keys()) if (isNode(i)) for (const [x, z] of L.get(i)) { const j = z * N + x; if (!done.has(i + '>' + j)) chains.push(walk(i, j)); }
  // loops with no node on them
  for (const i of L.keys()) for (const [x, z] of L.get(i)) { const j = z * N + x; if (!done.has(i + '>' + j)) { nodeOf.has(i) || node(i); chains.push(walk(i, j)); } }
  for (const tiles of chains) {
    if (tiles.length < 2) continue;
    const a = node(tiles[0]), b = node(tiles[tiles.length - 1]);
    if (a === b && tiles.length < 4) continue;
    const pts = curveThrough(tiles.map(i => [i % N, Math.floor(i / N)]));
    const lv = Math.min(...tiles.slice(1, -1).map(i => g[i]).concat(tiles.length === 2 ? [g[tiles[0]], g[tiles[1]]] : []));
    const e = net.addEdge(a, b, pts, { level: Math.max(1, Math.min(3, lv || g[tiles[0]] || 1)) });
    if (props.dress) {
      const inner = tiles.length > 2 ? tiles.slice(1, -1) : tiles, count = new Map();
      for (const i of inner) if (props.dress[i]) count.set(props.dress[i], (count.get(props.dress[i]) || 0) + 1);
      let best = 0, bn = 0;
      for (const [v, n] of count) if (n > bn) { bn = n; best = v; }
      if (bn * 2 >= inner.length) e.dress = best;
      if (props.buried && inner.some(i => props.buried[i])) e.buried = 1;
    }
  }
  return { net, nodeOf };
}

// The curve through a run of tiles: their middles, a quarter circle round
// the inside corner where it turns along the grid.
function curveThrough(tiles) {
  const out = [];
  for (let k = 0; k < tiles.length; k++) {
    const [x, z] = tiles[k], c = [x + 0.5, z + 0.5];
    const p = tiles[k - 1], q = tiles[k + 1];
    if (p && q) {
      const d1 = [x - p[0], z - p[1]], d2 = [q[0] - x, q[1] - z];
      const grid1 = !(d1[0] && d1[1]), grid2 = !(d2[0] && d2[1]);
      if (grid1 && grid2 && d1[0] * d2[0] + d1[1] * d2[1] === 0) {
        // round the corner between the edge it comes in by and the one it leaves by
        const ix = c[0] - d1[0] * 0.5, iz = c[1] - d1[1] * 0.5, ox = c[0] + d2[0] * 0.5, oz = c[1] + d2[1] * 0.5;
        const kx = ix + d2[0] * 0.5, kz = iz + d2[1] * 0.5;   // the inside corner
        const a0 = Math.atan2(iz - kz, ix - kx);
        let da = Math.atan2(oz - kz, ox - kx) - a0;
        if (da > Math.PI) da -= 2 * Math.PI;
        if (da < -Math.PI) da += 2 * Math.PI;
        for (let s = 0; s <= 6; s++) out.push([kx + Math.cos(a0 + (da * s) / 6) * 0.5, kz + Math.sin(a0 + (da * s) / 6) * 0.5]);
        continue;
      }
    }
    out.push(c);
  }
  return simplify(out, 0.002);
}

// Turn a world-axis side ('x0' -x, 'x1' +x, 'z0' -z, 'z1' +z) of a plot
// facing rot into the building's own frame (x0 its -x, x1 +x, z0 behind,
// z1 in front).
function localSide(side, rot) {
  const v = { x0: [-1, 0], x1: [1, 0], z0: [0, -1], z1: [0, 1] }[side];
  const a = (rot * Math.PI) / 2, ex = [Math.cos(a), -Math.sin(a)], uz = [Math.sin(a), Math.cos(a)];
  const lx = v[0] * ex[0] + v[1] * ex[1], lz = v[0] * uz[0] + v[1] * uz[1];
  return Math.abs(lx) > 0.5 ? (lx > 0 ? 'x1' : 'x0') : lz > 0 ? 'z1' : 'z0';
}

export function fromGrid(data) {
  const N = data.N;
  const roads = grid(data.roads, N), rails = grid(data.rails, N), diag = grid(data.diag, N);
  const dress = grid(data.dress, N), buried = grid(data.buried, N), none = new Uint8Array(N * N);
  // (diagonals only between road tiles both linked; cut sides as they were)
  const diagTile = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) if (diag[i] & 15) diagTile[i] = 1;
  const med = medians(N, roads, rails, null, diagTile);
  const e0 = data.state && data.state.entry ? data.state.entry : { x: 0, z: 0 };
  const ei = roads[e0.z * N + e0.x] ? e0.z * N + e0.x : null;
  const R = netOf(N, roads, diag, med, ei, { kind: 'road', dress, buried });
  const rnet = R.net;
  // the road out: on from the entry tile to the edge of the map
  let entry = { node: -1, x: e0.x + 0.5, z: e0.z + 0.5 };
  if (ei != null) {
    const n = R.nodeOf.get(ei) ?? rnet.addNode(e0.x + 0.5, e0.z + 0.5).id;
    const d = [e0.x === 0 ? -1 : e0.x === N - 1 ? 1 : 0, e0.z === 0 ? -1 : e0.z === N - 1 ? 1 : 0];
    if (!d[0] && !d[1]) d[Math.min(e0.x, N - 1 - e0.x) < Math.min(e0.z, N - 1 - e0.z) ? 0 : 1] = 1;
    const ex = d[0] < 0 ? 0 : d[0] > 0 ? N : e0.x + 0.5, ez = d[1] < 0 ? 0 : d[1] > 0 ? N : e0.z + 0.5;
    const out = rnet.addNode(ex, ez);
    rnet.addEdge(out.id, n, [[ex, ez], [e0.x + 0.5, e0.z + 0.5]], { level: roads[ei] || 1 });
    entry = { node: out.id, x: ex, z: ez };
    rnet.tidy([n], new Set([out.id]));
  }
  rnet.tidy([...rnet.nodes.keys()], new Set([entry.node]));
  const L = netOf(N, rails, none, none, null, { kind: 'rail' });
  L.net.tidy([...L.net.nodes.keys()]);
  // buildings
  const buildings = [];
  for (const rec of data.buildings || []) {
    let [id, type, level, x, z, variant, rot, built, bw, bd, flavor, con, leases, look, spare, pose] = rec;
    bw = bw || 1; bd = bd || 1; rot = (rot | 0) & 3;
    const odd = rot & 1, lw = odd ? bd : bw, ld = odd ? bw : bd;
    let a = (rot * Math.PI) / 2, cx = x + bw / 2, cz = z + bd / 2;
    if (Array.isArray(pose) && pose.every(Number.isFinite)) {
      const [pa, px, pz] = pose, co = Math.cos(a), si = Math.sin(a);
      cx += px * co + pz * si; cz += -px * si + pz * co; a += pa;
    }
    const ls = Array.isArray(leases) ? leases.map(l => ({ ...l, side: localSide(l.side, rot) })) : null;
    let sp = null;
    if (Array.isArray(spare)) { const [sw, sd, sx, sz] = spare; sp = [odd ? sd : sw, odd ? sw : sd, ...(sx != null ? [sx, sz] : [])]; }
    const r = (v) => Math.round(v * 1000) / 1000;
    buildings.push([id, type, level, r(cx), r(cz), variant, r(a), built, lw, ld, flavor, con, ls, look, sp]);
  }
  // farm fields: a unit square at each tile
  const fields = [];
  let fid = (data.state && data.state.nextId) || 1;
  for (const [farm, ...tiles] of Array.isArray(data.fields) ? data.fields : []) {
    for (const i of tiles) if (Number.isInteger(i) && i >= 0 && i < N * N) fields.push([fid++, farm, (i % N) + 0.5, Math.floor(i / N) + 0.5, 0]);
  }
  const out = { ...data, version: 2, roads: rnet.toRec(), rails: L.net.toRec(), buildings, fields, refaced: true };
  delete out.diag; delete out.dress; delete out.buried;
  out.state = { ...data.state, entry, nextId: Math.max(fid, (data.state && data.state.nextId) || 1) };
  return out;
}

void DIRS;
