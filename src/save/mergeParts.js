// The parts of merging two towns (merge.js) that deal with plots, roads,
// track, fields and trees without a grid: carrying them across by the turn
// and shift town B is set at, settling clashes by overlap, and joining the
// road networks with new roads routed round what stands in the way.

import { BUILDINGS } from '../defs.js';
import { rect, rectsOverlap, aabbOf, inRect, rectSamples, segRectDist, Index, simplify, spline, pointAt, polyLength, roundAngle } from '../world/geom.js';
import { Net } from '../world/net.js';
import { HALF, RAIL_HALF, VERGE, findPlot, groundUnder, plotOf, ownPlot } from '../world/world.js';

// A building's record carried onto the merged map: its middle moved by the
// town's turn and shift, its angle turned with it (k quarter turns
// clockwise: a facing a becomes a - k quarter turns). Its width, depth,
// garden strips and spare land are in its own frame, so they go as they are.
export function carry(s, b) {
  const [x, z] = s.point(b.x, b.z), r3 = (v) => Math.round(v * 1000) / 1000;
  return { x: r3(x), z: r3(z), a: roundAngle(b.a - (s.k * Math.PI) / 2) };
}
export const recRect = (r) => rect(r.x, r.z, r.a, r.w / 2, r.d / 2);

// Settle overlapping plots: the more valuable stays (an index of those kept
// so far). Returns [kept, losers].
export function settle(order, N, nameOf) {
  const ix = new Index(2), kept = [], losers = [];
  for (const r of order) {
    const R = recRect(r);
    if (R.pts.some(([x, z]) => x < 0 || z < 0 || x > N || z > N)) { losers.push({ r, why: 'fell outside the merged map' }); continue; }
    const clash = ix.query(aabbOf(R)).find(o => rectsOverlap(R, recRect(o), 0.004));
    if (clash) { losers.push({ r, why: `overlapped the ${nameOf(clash)} from ${clash.s.label}` }); continue; }
    ix.add(r, aabbOf(R));
    kept.push(r);
  }
  return [kept, losers, ix];
}

// The two towns' road (or track) networks on the merged map, as one: A's
// as it was, B's laid over it (joining and crossing A's where they meet, as
// a road the player lays would), or set down as it was where that can't be
// done. Edges running through the other town's kept plots, or into deep
// water, are dropped. { net, dropped, entry: { A, B } (the merged node ids
// of each town's way out) }.
export function mergeNets(kind, A, B, plotIx, N, deep) {
  const net = new Net(kind), dropped = { n: 0 }, entry = {};
  const hw = (e) => (kind === 'rail' ? RAIL_HALF : HALF[e.level]);
  // (through a plot of the other town's, or deep water, or off the map)
  const blocked = (s, pts, w) => {
    for (const [x, z] of pts) if (x < 0 || z < 0 || x > N || z > N) return true;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      for (const o of plotIx.query([Math.min(ax, bx) - 0.4, Math.min(az, bz) - 0.4, Math.max(ax, bx) + 0.4, Math.max(az, bz) + 0.4])) {
        if (o.s !== s && segRectDist(recRect(o), ax, az, bx, bz) < w + VERGE - 0.02) return true;
      }
    }
    for (let k = 0; k <= 20; k++) { const p = pointAt(pts, cumOf(pts), (polyLength(pts) * k) / 20); if (deep(p[0], p[1])) return true; }
    return false;
  };
  for (const s of [A, B]) {
    const src = kind === 'rail' ? s.w.rails : s.w.roads, map = new Map();
    const nodeOf = (id) => {
      if (map.has(id)) return map.get(id);
      const n = src.nodes.get(id), [x, z] = s.point(n.x, n.z);
      const there = net.nodeNear(x, z, 1e-3);
      const out = there || net.addNode(x, z);
      map.set(id, out);
      return out;
    };
    for (const e of src.edges.values()) {
      const pts = e.pts.map(([x, z]) => s.point(x, z));
      if (blocked(s, pts, hw(e))) { dropped.n++; continue; }
      const props = { level: e.level, dress: e.dress || 0, buried: e.buried || 0 };
      // B over A: laid as a road would be, so they join where they meet
      if (s === B && net.edges.size) {
        const plan = net.plan(pts);
        if (!plan.reason) {
          const { made } = net.lay(plan, props);
          if (made.length) {
            const a = net.nodes.get(made[0].a), b = net.nodes.get(made[made.length - 1].b);
            if (!map.has(e.a)) map.set(e.a, a);
            if (!map.has(e.b)) map.set(e.b, b);
          }
          continue;
        }
      }
      const a = nodeOf(e.a), b = nodeOf(e.b);
      if (a === b && pts.length < 3) continue;
      net.addEdge(a.id, b.id, pts, props);
    }
    if (kind === 'road' && map.has(s.w.entry.node)) entry[s.tag] = map.get(s.w.entry.node).id;
  }
  for (const n of [...net.nodes.values()]) if (!n.edges.length) net._dropNode(n);
  net.tidy([...net.nodes.keys()], new Set(Object.values(entry)));
  return { net, dropped: dropped.n, entry };
}
const cumOf = (pts) => { const c = [0]; for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); return c; };

// ---------------------------------------------------------------- routes
// The cheapest way for a new road across the merged map, from any of the
// points `from` to a point where goal(x, z) holds: a search over points half
// a unit apart (only a way to find a route round things: the road laid
// along it is a smooth curve), round plots, over steep ground and deep
// water only when lenient; road already there is cheap to follow. The
// route's points, or null.
const STEP = 0.5;
export function route(w, from, goal, { maxCost = Infinity, lenient = false } = {}) {
  const N = w.N, M = Math.round(N / STEP) + 1, t = w.terrain;
  const idx = (i, j) => j * M + i, X = (i) => i * STEP, cost = new Float32Array(M * M).fill(Infinity), prev = new Int32Array(M * M).fill(-1);
  const heap = new Heap();
  const stepCost = (i, j) => {
    const x = X(i), z = X(j);
    for (const b of w.plots.near(x, z, 0.5)) if (inRect(plotOf(b), x, z, 0.36)) return Infinity;
    if (w.roadAt(x, z)) return 0.3;
    const wet = w.waterAt(x, z), h = t.heightAt(x, z);
    if (wet && h < (lenient ? -1.3 : -0.9)) return Infinity;
    const sl = Math.abs(t.heightAt(x + 0.25, z) - t.heightAt(x - 0.25, z)) + Math.abs(t.heightAt(x, z + 0.25) - t.heightAt(x, z - 0.25));
    if (!wet && sl > (lenient ? 0.8 : 0.42)) return Infinity;
    return STEP * (1 + sl * 6 + (wet ? 5 : 0) + (w.railAt(x, z, 0.05) ? 1 : 0));
  };
  const starts = new Set();
  for (const [x, z] of from) {
    const i = Math.round(x / STEP), j = Math.round(z / STEP);
    if (i < 0 || j < 0 || i >= M || j >= M) continue;
    const k = idx(i, j);
    if (cost[k] === 0) continue;
    cost[k] = 0; starts.add(k); heap.push(0, k);
  }
  while (heap.size) {
    const [c, k] = heap.pop();
    if (c > cost[k]) continue;
    if (c > maxCost) return null;
    const i = k % M, j = (k / M) | 0;
    if (!starts.has(k) && goal(X(i), X(j))) {
      const out = [];
      for (let q = k; q !== -1; q = prev[q]) out.push([X(q % M), X((q / M) | 0)]);
      return out.reverse();
    }
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= M || nj >= M) continue;
      const nk = idx(ni, nj), sc = stepCost(ni, nj);
      if (!Number.isFinite(sc)) continue;
      const nc = c + sc * (di && dj ? Math.SQRT2 : 1);
      if (nc < cost[nk]) { cost[nk] = nc; prev[nk] = k; heap.push(nc, nk); }
    }
  }
  return null;
}

// Lay a new road (free: what the merge lays is part of joining the towns)
// along a route's points, as a smooth curve; where the whole won't go, in
// shorter pieces. How many units were laid.
export function layRoute(w, pts, level = 1) {
  let laid = 0;
  // (never through a plot: the curve is smoothed, and may cut a corner)
  const clear = (curve) => {
    for (let i = 0; i + 1 < curve.length; i++) {
      const [ax, az] = curve[i], [bx, bz] = curve[i + 1];
      for (const o of w.plots.query([Math.min(ax, bx) - 0.5, Math.min(az, bz) - 0.5, Math.max(ax, bx) + 0.5, Math.max(az, bz) + 0.5])) {
        if (segRectDist(plotOf(o), ax, az, bx, bz) < HALF[level] + VERGE) return false;
      }
    }
    return true;
  };
  const go = (P) => {
    if (P.length < 2 || polyLength(P) < 0.35) return;
    let curve = P.length > 2 ? spline(simplify(P, 0.2), 0.1, 0.002) : P;
    if (!clear(curve)) curve = simplify(P, 0.02);
    const plan = clear(curve) ? w.roads.plan(curve) : { reason: 'in the way' };
    if (!plan.reason) {
      const { made } = w.roads.lay(plan, { level });
      laid += made.reduce((s, e) => s + e.len, 0);
      w._clearTreesAlong(curve, HALF[level] + 0.12);
      return;
    }
    if (P.length < 3) return;
    const m = P.length >> 1;
    go(P.slice(0, m + 1)); go(P.slice(m));
  };
  go(simplify(pts, 0.05));
  return laid;
}

// The pieces of the road network that don't touch each other: arrays of node ids.
export function pieces(net) {
  const seen = new Set(), out = [];
  for (const id of net.nodes.keys()) {
    if (seen.has(id)) continue;
    const part = [...net.reach(id)];
    for (const n of part) seen.add(n);
    out.push(part);
  }
  return out;
}
// Points every half unit along the edges of a piece of road.
export function piecePoints(net, nodes) {
  const set = new Set(nodes), out = [];
  for (const e of net.edges.values()) {
    if (!set.has(e.a)) continue;
    for (let s = 0; s <= e.len + 1e-9; s += STEP) { const p = pointAt(e.pts, e.cum, s); out.push([p[0], p[1]]); }
  }
  return out;
}

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p; }
  }
  pop() {
    const k = this.k, v = this.v, top = [k[0], v[0]], lk = k.pop(), lv = v.pop();
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

// Why a plot no longer works on the blended ground (null if it is fine).
export function groundProblem(w, r) {
  const R = recRect(r), g = groundUnder(w.terrain, R);
  if (g.water) return 'ended up in water';
  const why = w._plotBlock(R, { except: [w.buildings.get(r.id)].filter(Boolean), fields: true });
  if (why && /road|track/i.test(why)) return 'had a road or track run through it';
  const lim = Math.max(r.w, r.d) === 1 ? 0.9 : 1.1;
  if (g.maxH - g.minH > Math.max(lim, r.slope0 + 0.05)) return 'ended up on ground too steep to stand on';
  if (BUILDINGS[r.type].needsWater) {
    const ring = rectSamples(rect(R.cx, R.cz, R.a, R.hw + 0.6, R.hd + 0.6), 0.2).filter(([x, z]) => !inRect(R, x, z, 0.15));
    if (!ring.some(([x, z]) => w.waterAt(x, z))) return 'is no longer beside water';
  }
  return null;
}

// The nearest free plot for a building that lost out, reaching a road
// joined to the town (parks need no road): { x, z, a, w, d }, or null.
export function freePlot(w, r) {
  const def = BUILDINGS[r.type];
  const sizes = r.w === r.d ? [[r.w, r.d]] : [[r.w, r.d], [r.d, r.w]];
  for (const [W, D] of sizes) {
    const p = findPlot(w, r.type, { x: r.x0, z: r.z0 }, { w: W, d: D, r: 18, opts: { ignoreUnlock: true, ignoreUnique: true, ignoreMoney: true }, test: (x, z, a, chk) => !chk || def.park || !!(chk.access && chk.access.conn) });
    if (p) return { x: p.x, z: p.z, a: p.a, w: W, d: D };
  }
  return null;
}

export { ownPlot };
