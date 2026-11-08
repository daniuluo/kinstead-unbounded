// A network of roads (or of railway track) without a grid: junctions and
// ends (nodes) joined by curves (edges). An edge's curve is `pts`, from its
// node a to its node b, sampled finely enough to draw (straight runs keep
// only their ends), with `cum` the distance along it to each point and
// `len` its length. Each road edge has its own level (1 dirt path, 2
// cobbles, 3 paved), dressing and buried power line; nothing is laid out
// on squares.
//
// Laying a curve (plan / lay): its ends join a road within reach (a node,
// or a point along an edge, which is split there), and wherever it crosses
// another road both are split at a new junction. What laying would do is
// worked out first (plan) without changing anything, so the same plan is
// what the player sees, what the world checks and what it lays.

import { Index, segDist, lastT, segCross, cumulative, pointAt, nearestOn, slice, angleOf, angDiff, polyLength } from './geom.js';

// how near a road's end must come to another road to join it
export const SNAP = 0.4;
// a junction this near one already there is that one
const MERGE = 0.3;
// the shortest stretch of road between two junctions
export const MIN_EDGE = 0.3;
// the shallowest angle two roads may meet at
export const MIN_ANGLE = (25 * Math.PI) / 180;

let segK = 0;

export class Net {
  constructor(kind = 'road') {
    this.kind = kind;
    this.nodes = new Map();
    this.edges = new Map();
    this.nextId = 1;
    this.segs = new Index(2);
    this.nodeIx = new Index(2);
    this.version = 0;   // goes up with every change (for caches)
  }

  // --------------------------------------------------------------- basics
  addNode(x, z, id = null) {
    const n = { id: id ?? this.nextId++, x, z, edges: [] };
    if (n.id >= this.nextId) this.nextId = n.id + 1;
    this.nodes.set(n.id, n);
    this.nodeIx.add(n, [x, z, x, z]);
    this.version++;
    return n;
  }
  _dropNode(n) { this.nodes.delete(n.id); this.nodeIx.remove(n); this.version++; }

  // An edge from node a to node b along pts (pts[0] at a, the last at b).
  addEdge(a, b, pts, props = {}, id = null) {
    const A = this.nodes.get(a), B = this.nodes.get(b);
    const P = pts.map(p => [p[0], p[1]]);
    P[0] = [A.x, A.z]; P[P.length - 1] = [B.x, B.z];
    const e = { id: id ?? this.nextId++, a, b, level: props.level || 1, dress: props.dress || 0, buried: props.buried || 0, pts: P, cum: null, len: 0, segs: [], hy: null };
    if (e.id >= this.nextId) this.nextId = e.id + 1;
    e.cum = cumulative(P); e.len = e.cum[e.cum.length - 1];
    this.edges.set(e.id, e);
    A.edges.push(e.id);
    if (b !== a) B.edges.push(e.id);
    this._file(e);
    this.version++;
    return e;
  }
  _file(e) {
    for (const s of e.segs) this.segs.remove(s);
    e.segs = [];
    for (let i = 0; i + 1 < e.pts.length; i++) {
      const p = e.pts[i], q = e.pts[i + 1], s = { e, i, k: segK++ };
      e.segs.push(s);
      this.segs.add(s, [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])]);
    }
  }
  removeEdge(id) {
    const e = this.edges.get(id);
    if (!e) return null;
    for (const s of e.segs) this.segs.remove(s);
    this.edges.delete(id);
    for (const nid of [e.a, e.b]) {
      const n = this.nodes.get(nid);
      if (n) n.edges = n.edges.filter(x => x !== id);
    }
    this.version++;
    return e;
  }
  // Nodes left with no road go; a node left joining just two edges alike
  // (level, dressing, buried line) joins them into one (keep: nodes that
  // must stay, as the way out of the valley).
  tidy(nids, keep = new Set()) {
    for (const nid of nids) {
      const n = this.nodes.get(nid);
      if (!n || keep.has(nid)) continue;
      if (!n.edges.length) { this._dropNode(n); continue; }
      if (n.edges.length !== 2) continue;
      const [e1, e2] = n.edges.map(id => this.edges.get(id));
      if (e1 === e2 || e1.level !== e2.level || e1.dress !== e2.dress || e1.buried !== e2.buried) continue;
      // (only where they run on smoothly: a corner stays a node)
      const d1 = this.dirAt(e1, nid), d2 = this.dirAt(e2, nid);
      if (Math.PI - angDiff(d1, d2) > 0.35) continue;
      const p1 = e1.a === nid ? e1.pts.slice().reverse() : e1.pts, p2 = e2.a === nid ? e2.pts : e2.pts.slice().reverse();
      const a = e1.a === nid ? e1.b : e1.a, b = e2.a === nid ? e2.b : e2.a;
      if (a === b) continue;
      const props = { level: e1.level, dress: e1.dress, buried: e1.buried };
      this.removeEdge(e1.id); this.removeEdge(e2.id);
      this.addEdge(a, b, p1.concat(p2.slice(1)), props, Math.min(e1.id, e2.id));
      this._dropNode(n);
    }
  }

  // The heading an edge leaves node nid on (as angleOf).
  dirAt(e, nid) {
    const P = e.pts, fwd = e.a === nid;
    const cum = e.cum, L = e.len, s = Math.min(0.25, L / 2);
    const p = pointAt(P, cum, fwd ? s : L - s), q = fwd ? P[0] : P[P.length - 1];
    return angleOf(p[0] - q[0], p[1] - q[1]);
  }
  other(e, nid) { return e.a === nid ? e.b : e.a; }

  // Split edge e at distance s along it: the new node (or the end node, if
  // s is within MERGE of one).
  split(e, s) {
    if (s <= MERGE) return this.nodes.get(e.a);
    if (s >= e.len - MERGE) return this.nodes.get(e.b);
    const p = pointAt(e.pts, e.cum, s), n = this.addNode(p[0], p[1]);
    const props = { level: e.level, dress: e.dress, buried: e.buried };
    const A = slice(e.pts, e.cum, 0, s), B = slice(e.pts, e.cum, s, e.len);
    this.removeEdge(e.id);
    const e1 = this.addEdge(e.a, n.id, A, props, e.id), e2 = this.addEdge(n.id, e.b, B, props);
    this.lastSplit = { from: e.id, into: [e1.id, e2.id], at: s };
    return n;
  }

  // ------------------------------------------------------------- finding
  // The nearest point on any edge to (x, z) within r: { e, d, s, x, z, i,
  // dx, dz (the edge's way there) }, or null. filter(e) may rule edges out.
  nearest(x, z, r = 1, filter = null) {
    let best = null;
    for (const sg of this.segs.near(x, z, r)) {
      const e = sg.e;
      if (filter && !filter(e)) continue;
      const p = e.pts[sg.i], q = e.pts[sg.i + 1], d = segDist(x, z, p[0], p[1], q[0], q[1]);
      if (d > r || (best && d >= best.d)) continue;
      const t = lastT(), L = e.cum[sg.i + 1] - e.cum[sg.i] || 1;
      best = { e, d, s: e.cum[sg.i] + (e.cum[sg.i + 1] - e.cum[sg.i]) * t, x: p[0] + (q[0] - p[0]) * t, z: p[1] + (q[1] - p[1]) * t, i: sg.i, dx: (q[0] - p[0]) / L, dz: (q[1] - p[1]) / L };
    }
    return best;
  }
  nodeNear(x, z, r, filter = null) {
    let best = null, bd = r;
    for (const n of this.nodeIx.near(x, z, r)) {
      const d = Math.hypot(n.x - x, n.z - z);
      if (d <= bd && (!filter || filter(n))) { bd = d; best = n; }
    }
    return best;
  }
  // Every edge with some of it within r of (x, z), and how near: [{ e, d }].
  within(x, z, r) {
    const m = new Map();
    for (const sg of this.segs.near(x, z, r)) {
      const p = sg.e.pts[sg.i], q = sg.e.pts[sg.i + 1], d = segDist(x, z, p[0], p[1], q[0], q[1]);
      if (d <= r && !(m.get(sg.e) <= d)) m.set(sg.e, d);
    }
    return [...m].map(([e, d]) => ({ e, d }));
  }
  // The segments of every edge near a box [x0, z0, x1, z1]: [{ e, i }].
  segsIn(box) { return this.segs.query(box); }

  // Which nodes the network reaches from node `from` (a Set of node ids),
  // and the edges with them.
  reach(from) {
    const seen = new Set(), q = [];
    if (this.nodes.has(from)) { seen.add(from); q.push(from); }
    while (q.length) {
      const n = this.nodes.get(q.pop());
      for (const id of n.edges) {
        const e = this.edges.get(id), o = this.other(e, n.id);
        if (!seen.has(o)) { seen.add(o); q.push(o); }
      }
    }
    return seen;
  }

  // ---------------------------------------------------------- laying out
  // What laying the curve pts would do: where its ends join (j0, j1: { node }
  // an existing node, { edge, s } a point along an edge, or null: a new
  // end), where it crosses other roads (cross: [{ S (along the new curve),
  // edge, s, x, z }]), and the pieces it would be laid in, junction to
  // junction ({ pts, from, to } with from/to as j0/j1). reason: why it can't
  // be laid as it is (too short a piece, too shallow an angle), or null.
  // opts.noJoin: ends left as they are; opts.through: edges it may run on
  // over without crossing them (none by default).
  plan(pts, opts = {}) {
    const out = { pts, j0: null, j1: null, cross: [], pieces: [], reason: null };
    if (pts.length < 2 || polyLength(pts) < MIN_EDGE) { out.reason = 'Too short'; return out; }
    const P = pts.map(p => [p[0], p[1]]);
    // the ends: onto a node, or onto an edge nearby
    const join = (p, other) => {
      if (opts.noJoin) return null;
      const n = this.nodeNear(p[0], p[1], SNAP);
      if (n) return { node: n.id, x: n.x, z: n.z };
      const h = this.nearest(p[0], p[1], SNAP, opts.filter);
      if (!h) return null;
      // (onto the edge's end node, if it is that near one)
      if (h.s <= MERGE) { const n2 = this.nodes.get(h.e.a); return { node: n2.id, x: n2.x, z: n2.z }; }
      if (h.s >= h.e.len - MERGE) { const n2 = this.nodes.get(h.e.b); return { node: n2.id, x: n2.x, z: n2.z }; }
      return { edge: h.e.id, s: h.s, x: h.x, z: h.z };
    };
    out.j0 = join(P[0]);
    out.j1 = join(P[P.length - 1]);
    if (out.j0) P[0] = [out.j0.x, out.j0.z];
    if (out.j1) P[P.length - 1] = [out.j1.x, out.j1.z];
    if (out.j0 && out.j1 && out.j0.node != null && out.j0.node === out.j1.node && polyLength(P) < 2) { out.reason = 'Too short'; return out; }
    const cum = cumulative(P), L = cum[cum.length - 1];
    // where it crosses the edges already there (not at its own ends' joins)
    const hits = [];
    for (let i = 0; i + 1 < P.length; i++) {
      const a = P[i], b = P[i + 1];
      const box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      for (const sg of this.segsIn(box)) {
        const e = sg.e;
        if (opts.filter && !opts.filter(e)) continue;
        const p = e.pts[sg.i], q = e.pts[sg.i + 1];
        const c = segCross(a[0], a[1], b[0], b[1], p[0], p[1], q[0], q[1]);
        if (!c) continue;
        const S = cum[i] + (cum[i + 1] - cum[i]) * c[0], s = e.cum[sg.i] + (e.cum[sg.i + 1] - e.cum[sg.i]) * c[1];
        // (its own ends' joins are not crossings)
        if ((out.j0 && S < MERGE) || (out.j1 && S > L - MERGE)) continue;
        hits.push({ S, edge: e.id, s, x: a[0] + (b[0] - a[0]) * c[0], z: a[1] + (b[1] - a[1]) * c[0] });
      }
    }
    hits.sort((p, q) => p.S - q.S);
    // crossings at the same place (through a junction: every edge there) are one,
    // at the node there when there is one
    const cross = [];
    for (const h of hits) {
      const e = this.edges.get(h.edge);
      const node = h.s <= MERGE ? e.a : h.s >= e.len - MERGE ? e.b : null;
      const last = cross[cross.length - 1];
      if (last && h.S - last.S < MERGE) { if (node != null && last.node == null) Object.assign(last, { node, edge: null }); continue; }
      if (node != null) { const n = this.nodes.get(node); cross.push({ S: h.S, node, x: n.x, z: n.z }); } else cross.push(h);
    }
    // a crossing near a node nearby (not on the edge it crosses) is at that node
    for (const c of cross) {
      if (c.node != null) continue;
      const n = this.nodeNear(c.x, c.z, MERGE);
      if (n) Object.assign(c, { node: n.id, edge: null, x: n.x, z: n.z });
    }
    out.cross = cross;
    // the pieces, from junction to junction
    const stops = [{ S: 0, j: out.j0 }, ...cross.map(c => ({ S: c.S, j: c.node != null ? { node: c.node, x: c.x, z: c.z } : { edge: c.edge, s: c.s, x: c.x, z: c.z } })), { S: L, j: out.j1 }];
    for (let k = 0; k + 1 < stops.length; k++) {
      const s0 = stops[k], s1 = stops[k + 1], piece = slice(P, cum, s0.S, s1.S);
      if (s0.j) piece[0] = [s0.j.x, s0.j.z];
      if (s1.j) piece[piece.length - 1] = [s1.j.x, s1.j.z];
      if (polyLength(piece) < MIN_EDGE) { out.reason = 'Too close to the junction there'; return out; }
      out.pieces.push({ pts: piece, from: s0.j, to: s1.j });
    }
    // the same two junctions joined twice over (an edge that is already there)
    for (const pc of out.pieces) {
      if (pc.from && pc.to && pc.from.node != null && pc.to.node != null) {
        const n = this.nodes.get(pc.from.node);
        for (const id of n.edges) {
          const e = this.edges.get(id);
          if (this.other(e, n.id) === pc.to.node && Math.abs(e.len - polyLength(pc.pts)) < 0.3) { out.reason = 'There is a road there already'; return out; }
        }
      }
    }
    // the angles roads meet at
    out.reason = this._angles(out);
    return out;
  }

  // Why the pieces would meet another road too shallowly, or null.
  _angles(plan) {
    const pc = plan.pieces;
    const dirs = (j) => {
      if (!j) return [];
      if (j.node != null) { const n = this.nodes.get(j.node); return n.edges.map(id => this.dirAt(this.edges.get(id), n.id)); }
      const e = this.edges.get(j.edge), p = pointAt(e.pts, e.cum, j.s), d = angleOf(p[3], p[4]);
      return [d, d + Math.PI];
    };
    const leave = (pts) => { const cum = cumulative(pts), p = pointAt(pts, cum, Math.min(0.25, cum[cum.length - 1] / 2)); return angleOf(p[0] - pts[0][0], p[1] - pts[0][1]); };
    for (let k = 0; k < pc.length; k++) {
      const { pts, from, to } = pc[k];
      for (const [j, d] of [[from, leave(pts)], [to, leave(pts.slice().reverse())]]) {
        for (const o of dirs(j)) if (angDiff(o, d) < MIN_ANGLE) return 'Too shallow an angle to meet the road there';
      }
    }
    return null;
  }

  // Lay a plan (from plan(), unchanged since): the new edges ([edge]), and
  // the edges split to make room ({ from: old id, into: [ids] }).
  lay(plan, props = {}) {
    const made = [], splits = [];
    // (the edges each one the plan names has been split into so far)
    const fam = new Map();
    const nodeOf = (j, p) => {
      if (!j) return this.addNode(p[0], p[1]);
      if (j.node != null) return this.nodes.get(j.node);
      // (an edge split by an earlier piece: the part of it that holds the point)
      let e = this.edges.get(j.edge), s = j.s;
      if ([...fam.values()].includes(j.edge)) {
        const h = this.nearest(j.x, j.z, 0.05, (x) => (fam.get(x.id) ?? x.id) === j.edge);
        if (!h) return this.addNode(p[0], p[1]);
        e = h.e; s = h.s;
      }
      if (!e) return this.addNode(p[0], p[1]);
      this.lastSplit = null;
      const root = fam.get(e.id) ?? e.id;
      const n = this.split(e, s);
      if (this.lastSplit) { splits.push(this.lastSplit); for (const id of this.lastSplit.into) fam.set(id, root); }
      // (any later piece meeting this point again finds the node)
      j.node = n.id;
      return n;
    };
    let prev = null;
    for (const pc of plan.pieces) {
      const a = prev || nodeOf(pc.from, pc.pts[0]);
      const b = nodeOf(pc.to, pc.pts[pc.pts.length - 1]);
      made.push(this.addEdge(a.id, b.id, pc.pts, props));
      prev = b;
    }
    return { made, splits };
  }

  // ------------------------------------------------------------- records
  // As saved or sent: { n: [id, x, z, ...], e: [[id, a, b, level, dress,
  // buried, x0, z0, x1, z1, ...]] } (coordinates to the thousandth).
  toRec() {
    const r = (v) => Math.round(v * 1000) / 1000;
    const n = [];
    for (const v of this.nodes.values()) n.push(v.id, r(v.x), r(v.z));
    const e = [];
    for (const v of this.edges.values()) e.push([v.id, v.a, v.b, v.level, v.dress || 0, v.buried || 0, ...v.pts.flatMap(p => [r(p[0]), r(p[1])])]);
    return { n, e, next: this.nextId };
  }
  static fromRec(rec, kind = 'road') {
    const net = new Net(kind);
    if (!rec || typeof rec !== 'object') return net;
    const n = Array.isArray(rec.n) ? rec.n : [];
    for (let i = 0; i + 2 < n.length; i += 3) if ([n[i], n[i + 1], n[i + 2]].every(Number.isFinite)) net.addNode(n[i + 1], n[i + 2], n[i]);
    for (const v of Array.isArray(rec.e) ? rec.e : []) {
      if (!Array.isArray(v) || v.length < 10) continue;
      const [id, a, b, level, dress, buried, ...xy] = v;
      if (!net.nodes.has(a) || !net.nodes.has(b) || !xy.every(Number.isFinite) || net.edges.has(id)) continue;
      const pts = [];
      for (let i = 0; i + 1 < xy.length; i += 2) pts.push([xy[i], xy[i + 1]]);
      if (pts.length < 2) continue;
      net.addEdge(a, b, pts, { level: Math.max(1, Math.min(3, level | 0)), dress: dress | 0, buried: buried ? 1 : 0 }, id);
    }
    if (Number.isInteger(rec.next) && rec.next > net.nextId) net.nextId = rec.next;
    for (const nd of [...net.nodes.values()]) if (!nd.edges.length) net._dropNode(nd);
    return net;
  }
  clone() { return Net.fromRec(this.toRec(), this.kind); }
}

// The heights along an edge (every `step`), for walkers and wheels: the
// ground, or the deck where it crosses water, with a ramp up to it from
// each bank. Cached on the edge until the network or the ground changes.
export const PROFILE_STEP = 0.1;
export function edgeHeights(e, terrain, deck, water, ramp = 0.5) {
  if (e.hy && e.hy.len === e.len) return e.hy;
  const n = Math.max(1, Math.ceil(e.len / PROFILE_STEP)), ys = new Float32Array(n + 1), wet = new Uint8Array(n + 1);
  for (let k = 0; k <= n; k++) {
    const p = pointAt(e.pts, e.cum, (e.len * k) / n);
    wet[k] = water(p[0], p[1]) ? 1 : 0;
    ys[k] = terrain.heightAt(p[0], p[1]);
  }
  // the bank's height near the water climbs to the deck
  const step = e.len / n, R = Math.max(1, Math.round(ramp / step));
  const out = new Float32Array(n + 1);
  for (let k = 0; k <= n; k++) {
    if (wet[k]) { out[k] = deck; continue; }
    let near = Infinity;
    for (let j = Math.max(0, k - R); j <= Math.min(n, k + R); j++) if (wet[j]) near = Math.min(near, Math.abs(j - k) * step);
    const g = ys[k] + 0.012;
    if (near < ramp) { const t = near / ramp, sm = t * t * (3 - 2 * t); out[k] = deck + (g - deck) * sm; } else out[k] = g;
  }
  e.hy = { len: e.len, step, ys: out, wet };
  return e.hy;
}
// An edge's height at distance s along it.
export function heightOn(hy, s) {
  const k = Math.max(0, Math.min(hy.ys.length - 1, s / hy.step)), i = Math.floor(k), f = k - i;
  return i + 1 < hy.ys.length ? hy.ys[i] * (1 - f) + hy.ys[i + 1] * f : hy.ys[i];
}
// Whether an edge crosses water at distance s along it.
export function wetOn(hy, s) { return !!hy.wet[Math.max(0, Math.min(hy.wet.length - 1, Math.round(s / hy.step)))]; }
