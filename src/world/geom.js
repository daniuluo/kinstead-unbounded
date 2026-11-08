// Plane geometry for a town without a grid: plots as rectangles at any
// angle, roads and track as curves, and a spatial index to find what is
// near a point quickly. Points are [x, z] (world units: one unit is the
// size of a cottage's plot). Angles are as a model's turn about the up axis
// (three.js rotation.y): a plot facing angle a has its front towards
// (sin a, cos a) and its right-hand side, seen from the street, towards
// (-cos a, sin a); its own x axis runs (cos a, -sin a).

export const TAU = Math.PI * 2;
export const wrapAngle = (a) => { a %= TAU; if (a > Math.PI) a -= TAU; if (a < -Math.PI) a += TAU; return a; };
export const angDiff = (a, b) => Math.abs(wrapAngle(a - b));
// the facing angle of a direction (dx, dz)
export const angleOf = (dx, dz) => Math.atan2(dx, dz);

// ------------------------------------------------------------ rectangles
// A plot: centre (cx, cz), facing a, half-width hw along its own x (the
// street front) and half-depth hd along its own z (front to back). ux, uz:
// its front; ex, ez: its own x axis. pts: the corners, front left first,
// anticlockwise seen from above as x right and z down... (any consistent
// order: front-left, front-right, back-right, back-left in its own frame).
export function rect(cx, cz, a, hw, hd) {
  const ux = Math.sin(a), uz = Math.cos(a), ex = Math.cos(a), ez = -Math.sin(a);
  const pts = [[-hw, hd], [hw, hd], [hw, -hd], [-hw, -hd]].map(([lx, lz]) => [cx + lx * ex + lz * ux, cz + lx * ez + lz * uz]);
  return { cx, cz, a, hw, hd, ux, uz, ex, ez, pts };
}
// A rectangle grown by m on every side (or shrunk, m < 0).
export const grow = (r, m) => rect(r.cx, r.cz, r.a, Math.max(0, r.hw + m), Math.max(0, r.hd + m));

// A world point in a rectangle's own frame: [x across, z forward].
export function toLocal(r, x, z) {
  const dx = x - r.cx, dz = z - r.cz;
  return [dx * r.ex + dz * r.ez, dx * r.ux + dz * r.uz];
}
// ...and back.
export function toWorld(r, lx, lz) { return [r.cx + lx * r.ex + lz * r.ux, r.cz + lx * r.ez + lz * r.uz]; }

export function inRect(r, x, z, pad = 0) {
  const [lx, lz] = toLocal(r, x, z);
  return Math.abs(lx) <= r.hw + pad && Math.abs(lz) <= r.hd + pad;
}

// The bounding box [x0, z0, x1, z1] of a rectangle's corners.
export function aabbOf(r, pad = 0) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of r.pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  return [x0 - pad, z0 - pad, x1 + pad, z1 + pad];
}

// Whether two rectangles overlap by more than eps (touching edges don't).
// Separating axes: each one's two axes.
export function rectsOverlap(A, B, eps = 1e-3) {
  for (const R of [A, B]) {
    for (const [ax, az, h] of [[R.ex, R.ez, R.hw], [R.ux, R.uz, R.hd]]) {
      const c = (A.cx - B.cx) * ax + (A.cz - B.cz) * az;
      const ra = R === A ? h : A.hw * Math.abs(A.ex * ax + A.ez * az) + A.hd * Math.abs(A.ux * ax + A.uz * az);
      const rb = R === B ? h : B.hw * Math.abs(B.ex * ax + B.ez * az) + B.hd * Math.abs(B.ux * ax + B.uz * az);
      if (Math.abs(c) >= ra + rb - eps) return false;
    }
  }
  return true;
}

// Distance from a point to a rectangle (0 inside).
export function rectDist(r, x, z) {
  const [lx, lz] = toLocal(r, x, z);
  const qx = Math.max(0, Math.abs(lx) - r.hw), qz = Math.max(0, Math.abs(lz) - r.hd);
  return Math.hypot(qx, qz);
}

// Distance from point p to segment a-b, and how far along it (0..1) the
// nearest point lies.
export function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
  let t = L2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px, qz = az + dz * t - pz;
  _t = t;
  return Math.sqrt(qx * qx + qz * qz);
}
let _t = 0;
export const lastT = () => _t;

// Where segments a-b and c-d cross: [t along ab, u along cd], or null.
export function segCross(ax, az, bx, bz, cx, cz, dx, dz) {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = cx - ax, qz = cz - az;
  const t = (qx * sz - qz * sx) / den, u = (qx * rz - qz * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t, u] : null;
}

// Distance from segment a-b to a rectangle (0 if it touches or crosses it).
export function segRectDist(r, ax, az, bx, bz) {
  const [lax, laz] = toLocal(r, ax, az), [lbx, lbz] = toLocal(r, bx, bz);
  const hw = r.hw, hd = r.hd;
  // either end inside
  if (Math.abs(lax) <= hw && Math.abs(laz) <= hd) return 0;
  if (Math.abs(lbx) <= hw && Math.abs(lbz) <= hd) return 0;
  const C = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
  let d = Infinity;
  for (let i = 0; i < 4; i++) {
    const [cx, cz] = C[i], [dx, dz] = C[(i + 1) & 3];
    if (segCross(lax, laz, lbx, lbz, cx, cz, dx, dz)) return 0;
    d = Math.min(d, segDist(cx, cz, lax, laz, lbx, lbz));
  }
  const box = (x, z) => Math.hypot(Math.max(0, Math.abs(x) - hw), Math.max(0, Math.abs(z) - hd));
  return Math.min(d, box(lax, laz), box(lbx, lbz));
}

// Points over a rectangle, about `step` apart, edges and corners included
// (inset by `inset` from its edges).
export function rectSamples(r, step = 0.25, inset = 0) {
  const hw = Math.max(0, r.hw - inset), hd = Math.max(0, r.hd - inset);
  const nx = Math.max(1, Math.ceil((2 * hw) / step)), nz = Math.max(1, Math.ceil((2 * hd) / step)), out = [];
  for (let k = 0; k <= nz; k++) for (let i = 0; i <= nx; i++) out.push(toWorld(r, -hw + (2 * hw * i) / nx, -hd + (2 * hd * k) / nz));
  return out;
}

// --------------------------------------------------------------- polylines
export function polyLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}
export function cumulative(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return cum;
}
// The point at distance s along a polyline (cum from cumulative): [x, z, i
// (the segment), dx, dz (unit direction there)].
export function pointAt(pts, cum, s) {
  const n = pts.length;
  if (n === 1) return [pts[0][0], pts[0][1], 0, 0, 1];
  if (s <= 0) { const [dx, dz] = dirOf(pts, 0); return [pts[0][0], pts[0][1], 0, dx, dz]; }
  const L = cum[n - 1];
  if (s >= L) { const [dx, dz] = dirOf(pts, n - 2); return [pts[n - 1][0], pts[n - 1][1], n - 2, dx, dz]; }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
  const seg = cum[hi] - cum[lo], t = seg > 0 ? (s - cum[lo]) / seg : 0;
  const [dx, dz] = dirOf(pts, lo);
  return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * t, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * t, lo, dx, dz];
}
function dirOf(pts, i) {
  const a = pts[i], b = pts[i + 1] || pts[i];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
}
// The piece of a polyline between s0 and s1 (s1 < s0: run backwards).
export function slice(pts, cum, s0, s1) {
  const back = s1 < s0, a = Math.min(s0, s1), b = Math.max(s0, s1);
  const p0 = pointAt(pts, cum, a), p1 = pointAt(pts, cum, b);
  const out = [[p0[0], p0[1]]];
  for (let i = p0[2] + 1; i <= p1[2]; i++) if (cum[i] > a + 1e-9 && cum[i] < b - 1e-9) out.push([pts[i][0], pts[i][1]]);
  out.push([p1[0], p1[1]]);
  return back ? out.reverse() : out;
}
// Nearest point of a polyline to (x, z): { d, s, x, z, i }.
export function nearestOn(pts, cum, x, z) {
  let best = { d: Infinity, s: 0, x: pts[0][0], z: pts[0][1], i: 0 };
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = segDist(x, z, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    if (d < best.d) {
      const t = _t;
      best = { d, s: cum[i] + (cum[i + 1] - cum[i]) * t, x: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, z: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t, i };
    }
  }
  return best;
}

// Ramer-Douglas-Peucker: drop points within tol of the line through their
// neighbours (keeps the ends).
export function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop();
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]);
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// A smooth curve through control points (centripetal Catmull-Rom), sampled
// about `step` apart, then thinned where it runs straight.
export function spline(ctrl, step = 0.1, tol = 0.002) {
  const P = [];
  for (const p of ctrl) if (!P.length || Math.hypot(p[0] - P[P.length - 1][0], p[1] - P[P.length - 1][1]) > 1e-4) P.push([p[0], p[1]]);
  if (P.length < 3) return P;
  const out = [P[0]];
  const ext = [[2 * P[0][0] - P[1][0], 2 * P[0][1] - P[1][1]], ...P, [2 * P[P.length - 1][0] - P[P.length - 2][0], 2 * P[P.length - 1][1] - P[P.length - 2][1]]];
  const tj = (a, b) => Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])) || 1e-4;
  for (let i = 1; i < ext.length - 2; i++) {
    const p0 = ext[i - 1], p1 = ext[i], p2 = ext[i + 1], p3 = ext[i + 2];
    const t0 = 0, t1 = t0 + tj(p0, p1), t2 = t1 + tj(p1, p2), t3 = t2 + tj(p2, p3);
    const n = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let k = 1; k <= n; k++) {
      const t = t1 + ((t2 - t1) * k) / n;
      const L = (pa, pb, ta, tb) => [(pa[0] * (tb - t) + pb[0] * (t - ta)) / (tb - ta), (pa[1] * (tb - t) + pb[1] * (t - ta)) / (tb - ta)];
      const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
      const B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
      out.push(L(B1, B2, t1, t2));
    }
  }
  return simplify(out, tol);
}

// Points evenly `step` apart along a polyline (the ends included).
export function resample(pts, step) {
  const cum = cumulative(pts), L = cum[cum.length - 1], n = Math.max(1, Math.round(L / step)), out = [];
  for (let k = 0; k <= n; k++) { const p = pointAt(pts, cum, (L * k) / n); out.push([p[0], p[1]]); }
  return out;
}

// The tightest bend of a polyline: the smallest radius of the circle
// through three points about `span` apart along it (Infinity if straight).
export function tightest(pts, span = 0.25) {
  const cum = cumulative(pts), L = cum[cum.length - 1];
  if (L < span * 2) return Infinity;
  let r = Infinity;
  for (let s = span; s <= L - span + 1e-9; s += span / 2) {
    const a = pointAt(pts, cum, s - span), b = pointAt(pts, cum, s), c = pointAt(pts, cum, s + span);
    r = Math.min(r, circumR(a, b, c));
  }
  return r;
}
export function circumR(a, b, c) {
  const ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]), ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const cross = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  return cross < 1e-9 ? Infinity : (ab * bc * ca) / (2 * cross);
}

// A polyline moved `off` to its right (seen going along it: (-dz, dx)),
// mitred at its bends (capped where a bend is sharp).
export function offsetLine(pts, off) {
  if (!off || pts.length < 2) return pts.map(p => [p[0], p[1]]);
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[i], c = pts[Math.min(n - 1, i + 1)];
    let d1 = [b[0] - a[0], b[1] - a[1]], d2 = [c[0] - b[0], c[1] - b[1]];
    const l1 = Math.hypot(d1[0], d1[1]), l2 = Math.hypot(d2[0], d2[1]);
    if (l1 < 1e-9) d1 = d2; if (l2 < 1e-9) d2 = d1;
    const L1 = Math.hypot(d1[0], d1[1]) || 1, L2 = Math.hypot(d2[0], d2[1]) || 1;
    const r1 = [-d1[1] / L1, d1[0] / L1], r2 = [-d2[1] / L2, d2[0] / L2];
    let mx = r1[0] + r2[0], mz = r1[1] + r2[1];
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { out.push([b[0] + r1[0] * off, b[1] + r1[1] * off]); continue; }
    mx /= ml; mz /= ml;
    const k = Math.min(2, 1 / Math.max(0.5, mx * r1[0] + mz * r1[1]));
    out.push([b[0] + mx * off * k, b[1] + mz * off * k]);
  }
  return out;
}

// ------------------------------------------------------------ the index
// Things filed by the 2-unit squares their bounding boxes reach, to find
// what is near a point or a box without looking at everything. Only a way
// to look things up quickly: nothing in the town keeps to its squares.
export class Index {
  constructor(cell = 2) { this.c = cell; this.m = new Map(); this.of = new Map(); }
  _keys(b) {
    const c = this.c, out = [];
    for (let z = Math.floor(b[1] / c); z <= Math.floor(b[3] / c); z++) for (let x = Math.floor(b[0] / c); x <= Math.floor(b[2] / c); x++) out.push(x * 65536 + z);
    return out;
  }
  add(item, box) {
    this.remove(item);
    const ks = this._keys(box);
    for (const k of ks) { let l = this.m.get(k); if (!l) this.m.set(k, l = []); l.push(item); }
    this.of.set(item, ks);
  }
  remove(item) {
    const ks = this.of.get(item);
    if (!ks) return;
    for (const k of ks) { const l = this.m.get(k); if (!l) continue; const i = l.indexOf(item); if (i >= 0) l.splice(i, 1); if (!l.length) this.m.delete(k); }
    this.of.delete(item);
  }
  clear() { this.m.clear(); this.of.clear(); }
  // everything filed within box [x0, z0, x1, z1] (each once)
  query(box) {
    const c = this.c, out = [], seen = new Set();
    for (let z = Math.floor(box[1] / c); z <= Math.floor(box[3] / c); z++) for (let x = Math.floor(box[0] / c); x <= Math.floor(box[2] / c); x++) {
      const l = this.m.get(x * 65536 + z);
      if (l) for (const it of l) if (!seen.has(it)) { seen.add(it); out.push(it); }
    }
    return out;
  }
  near(x, z, r) { return this.query([x - r, z - r, x + r, z + r]); }
}
