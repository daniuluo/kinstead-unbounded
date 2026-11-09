// Finding the way along the road network (net.js), with a small cache.
//
// A place on the network is { e (edge id), s (how far along it) }, as a
// building's way to its street (b.access), or { node }. A way from one to
// another (a Route) is the stretches of edge it runs along in turn,
// { pieces: [{ e, s0, s1 }] } (s1 < s0: against the edge's own way), its
// length, and the nodes it passes. Shortest by length (Dijkstra: towns have
// a few hundred junctions at most).
//
// routeLine turns a route into the line someone walks or drives: the roads'
// own curves end to end, moved over to the right-hand side of the road,
// mitred where it turns at a junction and round the end where it turns
// back on itself.

import { slice, cumulative, pointAt } from '../world/geom.js';

export class PathFinder {
  constructor(world) {
    this.world = world;
    this.cache = new Map();
    const clear = () => this.cache.clear();
    world.on('roads', clear);
    world.on('rails', clear);
  }

  road(a, b) { return this._find(this.world.roads, 'r', a, b); }
  rail(a, b) { return this._find(this.world.rails, 'l', a, b); }

  // (a place as the edges and nodes it reaches first: [[node, cost, piece]])
  _starts(net, p) {
    if (!p) return null;
    if (p.node != null) return net.nodes.has(p.node) ? [[p.node, 0, null]] : null;
    const e = net.edges.get(p.e);
    if (!e) return null;
    const s = Math.max(0, Math.min(e.len, p.s));
    return [[e.a, s, { e: e.id, s0: s, s1: 0 }], [e.b, e.len - s, { e: e.id, s0: s, s1: e.len }]];
  }

  _find(net, tag, a, b) {
    if (!a || !b) return null;
    const key = tag + (a.node != null ? 'n' + a.node : a.e + ':' + Math.round(a.s * 100)) + '>' + (b.node != null ? 'n' + b.node : b.e + ':' + Math.round(b.s * 100));
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const S = this._starts(net, a), G = this._starts(net, b);
    if (!S || !G) return this._keep(key, null);
    let best = null;
    // the same edge: straight along it
    if (a.e != null && a.e === b.e) {
      const e = net.edges.get(a.e);
      best = { cost: Math.abs(b.s - a.s), pieces: [{ e: e.id, s0: a.s, s1: b.s }], nodes: [] };
    }
    // a node to node search from the starts
    const dist = new Map(), prev = new Map(), heap = new Heap();
    for (const [n, c, pc] of S) if (!(dist.get(n) <= c)) { dist.set(n, c); prev.set(n, { from: null, pc }); heap.push(c, n); }
    const goal = new Map();
    for (const [n, c, pc] of G) goal.set(n, goal.has(n) ? (goal.get(n).c <= c ? goal.get(n) : { c, pc }) : { c, pc });
    const done = new Set();
    while (heap.size) {
      const [d, n] = heap.pop();
      if (done.has(n) || d > dist.get(n)) continue;
      done.add(n);
      if (best && d >= best.cost) break;
      const g = goal.get(n);
      if (g && (!best || d + g.c < best.cost)) {
        // trace back
        const pieces = [], nodes = [];
        let k = n;
        while (k != null) { const p = prev.get(k); nodes.push(k); if (p.pc) pieces.push(p.pc); k = p.from; }
        pieces.reverse(); nodes.reverse();
        if (g.pc) pieces.push({ e: g.pc.e, s0: g.pc.s1, s1: g.pc.s0 });
        best = { cost: d + g.c, pieces, nodes };
      }
      const N = net.nodes.get(n);
      for (const id of N.edges) {
        const e = net.edges.get(id), o = net.other(e, n), nd = d + e.len;
        if (done.has(o) || nd >= (dist.get(o) ?? Infinity)) continue;
        dist.set(o, nd);
        prev.set(o, { from: n, pc: e.a === n ? { e: id, s0: 0, s1: e.len } : { e: id, s0: e.len, s1: 0 } });
        heap.push(nd, o);
      }
    }
    if (!best) return this._keep(key, null);
    // (no stretch of nothing: a piece from the end of an edge to the same end)
    best.pieces = best.pieces.filter(p => Math.abs(p.s1 - p.s0) > 1e-6);
    best.len = best.cost;
    best.net = net;
    return this._keep(key, best);
  }

  _keep(key, v) {
    if (this.cache.size > 4000) this.cache.clear();
    this.cache.set(key, v);
    return v;
  }
}

// The middle of the road along a route, end to end (no offset): [[x, z]].
export function routeCentre(net, route) {
  const out = [];
  for (const p of route.pieces) {
    const e = net.edges.get(p.e);
    if (!e) continue;
    const part = slice(e.pts, e.cum, p.s0, p.s1);
    for (const q of part) {
      const last = out[out.length - 1];
      if (!last || Math.abs(last[0] - q[0]) + Math.abs(last[1] - q[1]) > 1e-6) out.push(q);
    }
  }
  return out;
}

// The way someone goes along a route, `offset` to the right of the road's
// middle (negative: the left), from start and to end ({ x, z }) if given.
// wet(x, z): whether a point off the road is over water; where a walker's
// way along the verge would be (a road along the shore), they keep to the
// road's edge instead.
export function routeLine(net, route, offset = 0, start = null, end = null, wet = null) {
  let C = route ? routeCentre(net, route) : [];
  let pts = offsetPath(C, offset);
  if (wet && offset && pts.some(([x, z]) => wet(x, z))) {
    // (a point at least every tenth of a unit, so no step skips over the water)
    const D = [];
    C.forEach((p, i) => {
      if (i) { const q = C[i - 1], n = Math.ceil(Math.hypot(p[0] - q[0], p[1] - q[1]) / 0.1); for (let k = 1; k < n; k++) D.push([q[0] + ((p[0] - q[0]) * k) / n, q[1] + ((p[1] - q[1]) * k) / n]); }
      D.push(p);
    });
    C = D;
    pts = offsetPath(C, offset);
    const inner = offsetPath(C, Math.sign(offset) * Math.min(Math.abs(offset), 0.19));
    if (inner.length === pts.length) {
      // (a point over the water, or either end of a step whose middle is)
      const off = pts.map(([x, z]) => wet(x, z));
      for (let i = 0; i + 1 < pts.length; i++) if (wet((pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2)) off[i] = off[i + 1] = true;
      // (and where even that is, round a sharp corner on the shore, the middle of the road)
      const mid = offsetPath(C, Math.sign(offset) * 0.02);
      for (let i = 0; i < pts.length; i++) if (off[i]) pts[i] = wet(inner[i][0], inner[i][1]) && mid.length === pts.length ? mid[i] : inner[i];
    }
  }
  if (start) pts.unshift([start.x, start.z]);
  if (end) pts.push([end.x, end.z]);
  return pts;
}

// A line moved `off` to its right, mitred at its bends (the mitre capped
// where a turn is sharp) and round the far side where it turns back.
export function offsetPath(C, off) {
  const n = C.length;
  if (!off || n < 2) return C.map(p => [p[0], p[1]]);
  const out = [];
  const dir = (a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1; return [dx / L, dz / L]; };
  for (let i = 0; i < n; i++) {
    const p = C[i];
    const d1 = i > 0 ? dir(C[i - 1], p) : dir(p, C[1]);
    const d2 = i < n - 1 ? dir(p, C[i + 1]) : d1;
    const r1 = [-d1[1], d1[0]], r2 = [-d2[1], d2[0]];
    const dot = d1[0] * d2[0] + d1[1] * d2[1];
    if (dot < -0.9) {
      // turning back: round the end, beyond it (the far side from the right)
      // (a half circle from its right to its left, through the point beyond the end)
      const steps = 6, R = Math.abs(off);
      for (let k = 0; k <= steps; k++) {
        const t = (Math.PI * k) / steps, c = Math.cos(t), s = Math.sin(t);
        out.push([p[0] + r1[0] * off * c + d1[0] * R * s, p[1] + r1[1] * off * c + d1[1] * R * s]);
      }
      continue;
    }
    let mx = r1[0] + r2[0], mz = r1[1] + r2[1];
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml; mz /= ml;
    const k = Math.min(2.2, 1 / Math.max(0.4, mx * r1[0] + mz * r1[1]));
    out.push([p[0] + mx * off * k, p[1] + mz * off * k]);
  }
  return out;
}

// A line without the points that stand nearer than d to the one before (a
// road's last point a whisker short of the junction it ends at): moved over
// to one side (offsetPath), the bend at such a point would swing it about
// across a step much shorter than it moves. Its ends stay.
export function thin(C, d = 0.05) {
  if (C.length < 3) return C.map(p => [p[0], p[1]]);
  const out = [[C[0][0], C[0][1]]];
  for (let i = 1; i < C.length; i++) {
    const p = C[i], q = out[out.length - 1];
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= d) out.push([p[0], p[1]]);
    else if (i === C.length - 1) { if (out.length > 1) out[out.length - 1] = [p[0], p[1]]; else out.push([p[0], p[1]]); }
  }
  return out;
}

// A line (an offsetPath) with the little loops taken out that moving it to
// the inside of a tight curve ties in it, where the curve's points stand
// closer together than it moves over (they'd step back on themselves):
// where one step crosses one of the next few, it goes straight from the
// one to the other, where they cross.
export function untangle(pts, ahead = 16) {
  const out = pts.map(p => [p[0], p[1]]);
  for (let i = 0; i + 3 < out.length; i++) {
    const [ax, az] = out[i], [bx, bz] = out[i + 1];
    for (let j = Math.min(out.length - 2, i + ahead); j >= i + 2; j--) {
      const [cx, cz] = out[j], [dx, dz] = out[j + 1];
      const den = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx);
      if (Math.abs(den) < 1e-12) continue;
      const t = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / den, u = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / den;
      if (t > 0 && t < 1 && u > 0 && u < 1) { out.splice(i + 1, j - i, [ax + (bx - ax) * t, az + (bz - az) * t]); break; }
    }
  }
  return out;
}

// Round off sharp corners with a short quadratic curve (for coaches and trains).
export function smoothPolyline(pts, radius = 0.35, steps = 4) {
  if (pts.length < 3) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i], [cx, cz] = pts[i + 1];
    const l1 = Math.hypot(bx - ax, bz - az), l2 = Math.hypot(cx - bx, cz - bz);
    const cross = (bx - ax) * (cz - bz) - (bz - az) * (cx - bx);
    if (Math.abs(cross) < 1e-6 * l1 * l2 || l1 < 1e-6 || l2 < 1e-6) { out.push(pts[i]); continue; }
    // (a gentle bend in a curve needs no rounding)
    const dot = ((bx - ax) * (cx - bx) + (bz - az) * (cz - bz)) / (l1 * l2);
    if (dot > 0.995) { out.push(pts[i]); continue; }
    const r = Math.min(radius, l1 / 2, l2 / 2);
    const p0 = [bx - ((bx - ax) / l1) * r, bz - ((bz - az) / l1) * r];
    const p2 = [bx + ((cx - bx) / l2) * r, bz + ((cz - bz) / l2) * r];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps, u = 1 - t;
      out.push([u * u * p0[0] + 2 * u * t * bx + t * t * p2[0], u * u * p0[1] + 2 * u * t * bz + t * t * p2[1]]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export function polyLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

// Points every `step` along a route's middle, for what it climbs:
// [[x, z]] (the ends included).
export function routeSamples(net, route, step = 1) {
  const C = routeCentre(net, route);
  if (C.length < 2) return C;
  const cum = cumulative(C), L = cum[cum.length - 1], n = Math.max(1, Math.round(L / step)), out = [];
  for (let k = 0; k <= n; k++) { const p = pointAt(C, cum, (L * k) / n); out.push([p[0], p[1]]); }
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
