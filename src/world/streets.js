// The streets of a town without a grid: the shape of the road surface, what
// stands along the roads (lamps, power poles, street trees, hedges, planted
// medians), dressing a street, and editing roads picked in the road panel.
//
// The road surface is a distance field: how far a point is from the middle
// of the nearest road, less that road's half-width (negative on the road).
// Each little straight piece of each road's curve is a capsule; where pieces
// meet at an angle (a junction, a corner) they are blended smoothly, so the
// grass meets the road in a curve there, and where they run on the same way
// (along a curve) they simply join. Everything that asks "is this on the
// road?" reads it: the road mesh, the painted shoulders, door paths, poles,
// walkers.

import { CONFIG, DRESSINGS, ROAD_LEVELS, dressRefund, streetPart, lookPart, withDress } from '../config.js';
import { HALF, doorPoint } from './world.js';
import { pointAt, segDist, lastT, angDiff } from './geom.js';
import { hash2 } from '../util/rng.js';

export const BAND = 0.035;

// ------------------------------------------------------------- the field
// The pieces of road near a box [x0, z0, x1, z1] (reaching r beyond it), as
// capsules: { cx, cz, ux, uz, hl (half its length), hw, L (road level) }.
export function primsIn(w, box, r = HALF[3] + 0.15) {
  const out = [];
  for (const sg of w.roads.segsIn([box[0] - r, box[1] - r, box[2] + r, box[3] + r])) {
    const e = sg.e, p = e.pts[sg.i], q = e.pts[sg.i + 1], dx = q[0] - p[0], dz = q[1] - p[1], len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    out.push({ cx: (p[0] + q[0]) / 2, cz: (p[1] + q[1]) / 2, ux: dx / len, uz: dz / len, hl: len / 2 + 0.003, hw: HALF[e.level], L: e.level, e: e.id });
  }
  return out;
}

const SOFT = 0.1;
const _g = [0, 0];
function primAt(p, px, pz) {
  const dx = px - p.cx, dz = pz - p.cz, a = Math.max(-p.hl, Math.min(p.hl, dx * p.ux + dz * p.uz));
  const ex = dx - a * p.ux, ez = dz - a * p.uz, r = Math.hypot(ex, ez) || 1e-9;
  _g[0] = ex / r; _g[1] = ez / r;
  return r - p.hw;
}
// The field at a point from these pieces: [distance (< 0 on the road), road
// level of the nearest piece]. (The array is reused: read it before the next call.)
const _f = [0, 0];
export function fieldAt(prims, px, pz) {
  let f = 9, fx = 0, fz = 0, best = 9, bl = 0;
  for (const p of prims) {
    const d = primAt(p, px, pz);
    if (d < best) { best = d; bl = p.L; }
    const gx = _g[0], gz = _g[1], m = Math.min(f, d);
    // how sharply the two edges meet: not at all running the same way, fully by 45 degrees
    const k = SOFT * Math.min(1, Math.max(0, (1 - Math.abs(fx * gx + fz * gz)) / 0.29));
    const h = k > 1e-6 ? Math.max(k - Math.abs(f - d), 0) / k : 0;
    if (d < f) { fx = gx; fz = gz; }
    f = m - h * h * k * 0.25;
  }
  _f[0] = f; _f[1] = bl;
  return _f;
}
// The field at a world point.
export function roadField(w, x, z) { return fieldAt(primsIn(w, [x, z, x, z]), x, z); }
// What lies at a point: 0 off the road, 1 roadway, 2 edging stones.
export function surfaceAt(w, x, z, band) {
  const [d, L] = roadField(w, x, z);
  if (d > 0) return 0;
  const kb = band === 0 || L < 2 ? 0 : band ?? BAND;
  return kb && d > -kb ? 2 : 1;
}

// ---------------------------------------------------------- along a road
// Whether a node is a junction (other than two roads meet) or a corner.
export function isKnot(w, n) {
  if (n.edges.length !== 2) return n.edges.length > 2;
  const [a, b] = n.edges.map(id => w.roads.edges.get(id));
  return Math.PI - angDiff(w.roads.dirAt(a, n.id), w.roads.dirAt(b, n.id)) > 0.5;
}
// Spots every `step` along an edge, each side of it, `off` out from its
// middle: [{ x, z, s, side, dx, dz (the road's way there) }], skipping its
// ends near junctions and corners, and where the road crosses water.
export function alongEdge(w, e, step, off, from = 0.5, sides = [1, -1]) {
  const out = [], hy = w._heights(e), A = w.roads.nodes.get(e.a), B = w.roads.nodes.get(e.b);
  const m0 = A && isKnot(w, A) ? from + 0.25 : from, m1 = B && isKnot(w, B) ? from + 0.25 : from;
  for (let s = m0; s <= e.len - m1 + 1e-9; s += step) {
    const k = Math.round(s / hy.step);
    if (hy.wet[Math.max(0, Math.min(hy.wet.length - 1, k))]) continue;
    // (nor on a ramp up to a bridge)
    const p = pointAt(e.pts, e.cum, s);
    if (Math.abs(hy.ys[Math.max(0, Math.min(hy.ys.length - 1, k))] - (w.terrain.heightAt(p[0], p[1]) + 0.012)) > 0.004) continue;
    for (const side of sides) out.push({ x: p[0] - p[4] * side * off, z: p[1] + p[3] * side * off, s, side, dx: p[3], dz: p[4] });
  }
  return out;
}
// Is a verge spot clear: off every road's surface (r room round it), off
// every plot and the water, away from front doors (gap).
function verge(w, x, z, r, doors, gap) {
  if (w.waterAt(x, z) || w.buildingAt(x, z)) return false;
  if (roadField(w, x, z)[0] < r) return false;
  if (w.railAt(x, z, 0.1)) return false;
  for (const [dx, dz] of doors) if (Math.hypot(dx - x, dz - z) < gap) return false;
  return true;
}

// The power poles along the streets, once the town makes electricity: one
// every POLE along each road (not one whose line is buried), on its verge,
// wired to the next along the same road. [{ x, z, e, s, next (index of the
// one it is wired to, or -1) }]
export const POLE = 2;
export function poleSpots(w) {
  const out = [];
  const doors = doorList(w);
  for (const e of w.roads.edges.values()) {
    if (e.buried) continue;
    const off = HALF[e.level] + 0.13;
    let last = -1;
    for (const p of alongEdge(w, e, POLE, off, 0.6, [hash2(e.id, 1, 3) < 0.5 ? 1 : -1])) {
      if (!verge(w, p.x, p.z, 0.07, doors, 0.12)) { last = -1; continue; }
      const i = out.length;
      out.push({ x: p.x, z: p.z, e: e.id, s: p.s, next: -1 });
      if (last >= 0 && Math.abs(out[last].s - p.s - (-POLE)) < 1e-6 + POLE * 0.01) out[last].next = i;
      last = i;
    }
  }
  return out;
}
// Where each building's front door path meets the street (its door, or the
// middle of its front): [[x, z]].
function doorList(w) {
  const out = [];
  for (const b of w.buildings.values()) if (b.access) { const p = b.door || doorPoint(b); out.push([p.x, p.z], [b.access.x, b.access.z]); }
  return out;
}

// The street lamp a plain cobbled or paved street has every few units along
// it (a lamp-lit street has its own instead): [{ x, z }].
export function plainLamps(w) {
  const out = [], doors = doorList(w);
  for (const e of w.roads.edges.values()) {
    if (e.level < 2 || keyOf(e.dress) === 'lamps') continue;
    for (const p of alongEdge(w, e, 3.1, HALF[e.level] + 0.1, 1.2, [hash2(e.id, 2, 5) < 0.5 ? -1 : 1])) {
      if (hash2(Math.floor(p.x * 3), Math.floor(p.z * 3), 91) >= 0.7) continue;
      if (verge(w, p.x, p.z, 0.05, doors, 0.15)) out.push({ x: p.x, z: p.z });
    }
  }
  return out;
}

// the key of an edge's street dressing (from its dress byte), or null
export const keyOf = (v) => (DRESSINGS[streetPart(v)] ? DRESSINGS[streetPart(v)].key : null);

// Where everything along the dressed streets stands:
// { trees: [{x, z, s, r}], hedges: [{x, z, r}], lamps: [{x, z}],
//   medians: [{ pts: [[x, z]] }], shrubs: [{x, z, r}] }
export function dressSpots(w) {
  const out = { trees: [], hedges: [], lamps: [], medians: [], shrubs: [] };
  const doors = doorList(w);
  const poles = new Set(poleSpots(w).map(p => `${Math.round(p.x * 20)},${Math.round(p.z * 20)}`));
  const nearPole = (x, z) => { for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (poles.has(`${Math.round(x * 20) + dx},${Math.round(z * 20) + dz}`)) return true; return false; };
  for (const e of w.roads.edges.values()) {
    const key = keyOf(e.dress);
    if (!key) continue;
    const hw = HALF[e.level];
    if (key === 'trees') {
      for (const p of alongEdge(w, e, 0.5, hw + 0.1, 0.3)) {
        if (!verge(w, p.x, p.z, 0.04, doors, 0.2) || nearPole(p.x, p.z)) continue;
        out.trees.push({ x: p.x, z: p.z, s: 0.55 + hash2(Math.floor(p.x * 9), Math.floor(p.z * 9), 21) * 0.12, r: hash2(Math.floor(p.z * 9), Math.floor(p.x * 9), 22) * 6.28 });
      }
    } else if (key === 'hedges') {
      for (const p of alongEdge(w, e, 0.075, hw + 0.065, 0.2)) {
        if (!verge(w, p.x, p.z, 0.02, doors, 0.13) || nearPole(p.x, p.z)) continue;
        out.hedges.push({ x: p.x, z: p.z, r: hash2(Math.floor(p.x * 40), Math.floor(p.z * 40), 23) * 6.28 });
      }
    } else if (key === 'lamps') {
      let side = 1;
      for (const p of alongEdge(w, e, 1, Math.max(0.31, hw + 0.04), 0.4, [1, -1])) {
        if (p.side !== side) continue;
        side = -side;
        if (verge(w, p.x, p.z, 0.02, doors, 0.14)) out.lamps.push({ x: p.x, z: p.z });
      }
    } else if (key === 'median' && e.level >= 3) {
      // through the middle of a paved street, between the junctions at its ends
      const pts = alongEdge(w, e, 0.125, 0, 0.45, [1]).map(p => [p.x, p.z]);
      if (pts.length >= 2) out.medians.push({ pts });
      for (const p of alongEdge(w, e, 0.25, 0, 0.55, [1])) out.shrubs.push({ x: p.x, z: p.z, r: hash2(Math.floor(p.x * 9), Math.floor(p.z * 9), 24) * 6.28 });
    }
  }
  return out;
}

// --------------------------------------------------------------- dressing
// What dressing these road edges with `kind` would do (0 takes dressings
// away), priced by length (a unit of road at a time). { kind, look, tiles:
// [{ e, from, cost, refund, reason }], n (edges that change), cost, refund,
// blocked: [{ reason, n }], back, short }.
export function planDress(w, ids, kind, look = false) {
  const D = DRESSINGS[kind] || null, seen = new Set(), tiles = [], blocked = new Map();
  if (D) look = !!D.blvd;
  let n = 0, cost = 0, refund = 0;
  const block = (t, reason) => { t.reason = reason; blocked.set(reason, (blocked.get(reason) || 0) + 1); };
  for (const id of ids) {
    const e = w.roads.edges.get(id);
    if (!e || seen.has(id)) continue;
    seen.add(id);
    const units = Math.max(1, Math.round(e.len));
    const from = look ? lookPart(e.dress) : streetPart(e.dress), t = { e: id, from, cost: 0, refund: 0, reason: null };
    tiles.push(t);
    if (!D) { if (!from) block(t, 'Nothing to take away'); }
    else if (from === kind) block(t, `Already a ${D.name.toLowerCase()}`);
    else if (D.blvd) block(t, 'Boulevards are for towns on squares: dress the street instead');
    else if (D.minLevel && e.level < D.minLevel) block(t, D.minLevel >= 3 ? 'Only on paved streets' : 'Not on dirt paths');
    else if (w.unlockPop < D.unlock) block(t, `Unlocks at ${D.unlock} villagers`);
    else if (D.tech && !w.hasTech(D.tech)) block(t, `Research ${w.techName(D.tech)} first`);
    if (t.reason) continue;
    t.cost = D ? D.cost * units : 0;
    t.refund = dressRefund(from) * units;
    n++; cost += t.cost; refund += t.refund;
  }
  // buildings standing forward onto streets that get trees or hedges step back
  const back = [];
  if (D && D.verge && n) {
    const on = new Set(tiles.filter(t => !t.reason).map(t => t.e));
    for (const b of w.buildings.values()) if (b.front > 0 && b.access && on.has(b.access.e)) back.push(b.id);
  }
  const plan = { kind, look, tiles, n, cost, refund, back, blocked: [...blocked].map(([reason, k]) => ({ reason, n: k })), short: null };
  if (n && cost - refund > w.money) plan.short = 'Not enough money';
  return plan;
}

export function applyDress(w, ids, kind, look = false) {
  if (!Number.isInteger(kind) || kind < 0 || kind >= DRESSINGS.length) return { ok: false, reason: "That action isn't valid" };
  const plan = planDress(w, ids, kind, !!look);
  if (!plan.n) return { ok: false, reason: plan.blocked.length ? plan.blocked[0].reason : 'No road there' };
  if (plan.short) return { ok: false, reason: plan.short };
  for (const t of plan.tiles) if (!t.reason) { const e = w.roads.edges.get(t.e); e.dress = withDress(e.dress, kind, plan.look); }
  w.money += plan.refund - plan.cost;
  w.roads.version++;
  w._updateFronts();   // trees and hedges send buildings standing forward back
  w.emit('dress');
  const skipped = plan.tiles.length - plan.n;
  return { ok: true, n: plan.n, spent: plan.cost, refund: plan.refund, failed: skipped ? plan.blocked[0].reason : null, skipped };
}

// ---------------------------------------------------------- road editing
export const ROAD_OPS = ['up', 'down', 'remove'];
// What upgrading, downgrading or taking up these road edges would do:
// { op, edges, n, cost, refund, blocked: [{ reason, n }], short }.
export function planRoadEdit(w, ids, op, opts = {}) {
  const out = { op, edges: [], n: 0, cost: 0, refund: 0, blocked: [], short: null, lost: [], cut: [], lines: [], detour: [], back: [], bridges: 0, undressed: 0, unlooked: 0 };
  out.tiles = [];
  const blocked = new Map(), block = (r) => blocked.set(r, (blocked.get(r) || 0) + 1);
  const es = [...new Set(ids)].map(id => w.roads.edges.get(id)).filter(Boolean);
  if (op === 'remove') {
    for (const e of es) {
      const c = w.removeCheck(e.id);
      if (!c.ok) { block(c.reason); continue; }
      out.edges.push(e.id); out.n++; out.refund += c.refund;
    }
  } else if (op === 'up' || op === 'down') {
    // by level: each edge one level up (or down)
    const by = new Map();
    for (const e of es) {
      const to = e.level + (op === 'up' ? 1 : -1);
      if (to < 1 || to > 3) { block(op === 'up' ? 'Already paved' : 'Already a dirt path'); continue; }
      if (op === 'up' && w.unlockPop < ROAD_LEVELS[to].unlock) { block(`Unlocks at ${ROAD_LEVELS[to].unlock} villagers`); continue; }
      if (!by.has(to)) by.set(to, []);
      by.get(to).push(e.id);
    }
    for (const [to, list] of by) {
      const c = w.levelCheck(list, to);
      if (!c.edges.length) continue;
      out.edges.push(...c.edges.map(e => e.id)); out.n += c.edges.length;
      if (c.cost > 0) out.cost += c.cost; else out.refund += -c.cost;
    }
  }
  out.blocked = [...blocked].map(([reason, n]) => ({ reason, n }));
  for (const id of out.edges) {
    const e = w.roads.edges.get(id), hy = w._heights(e);
    if (hy.wet.some(Boolean)) out.bridges++;
    if (op === 'remove' && e.dress) out.undressed++;
    if (op === 'down' && keyOf(e.dress) === 'median' && e.level - 1 < 3) out.undressed++;
  }
  if (op === 'remove' && out.n) {
    // who would lose their road, and who would be cut off from the way out
    const gone = new Set(out.edges), net = w.roads.clone();
    for (const id of gone) net.removeEdge(id);
    const reach = net.reach(w.entry.node);
    for (const b of w.buildings.values()) {
      if (!b.access) continue;
      if (gone.has(b.access.e)) out.lost.push(b.id);
      else if (b.connected) { const e = net.edges.get(b.access.e); if (e && !reach.has(e.a)) out.cut.push(b.id); }
      if (b.front > 0 && gone.has(b.access.e)) out.back.push(b.id);
    }
    // the coach lines that run along them
    for (const l of w.lines) {
      if (l.mode !== 'coach') continue;
      const R = opts.paths && l.stops.length >= 2;
      if (!R) continue;
      const stops = l.stops.map(s => w.buildings.get(s)).filter(Boolean);
      let along = false;
      for (let i = 0; i < stops.length; i++) {
        const a = stops[i].access, b = stops[(i + 1) % stops.length].access;
        const r = a && b ? opts.paths.road(a, b) : null;
        if (r && r.pieces.some(p => gone.has(p.e))) along = true;
      }
      if (!along) continue;
      // with them gone: is there still a way from each stop to the next (a
      // stop that loses its own road has none)?
      const ends = (s) => { const e = s.access && net.edges.get(s.access.e); return e ? [e.a, e.b] : null; };
      let broken = false;
      for (let i = 0; i < stops.length && !broken; i++) {
        const a = ends(stops[i]), b = ends(stops[(i + 1) % stops.length]);
        if (!a || !b) { broken = true; break; }
        const r = net.reach(a[0]);
        if (!b.some(n => r.has(n))) broken = true;
      }
      if (broken) out.lines.push(l.id); else out.detour.push(l.id);
    }
  }
  if (out.cost - out.refund > w.money) out.short = 'Not enough money';
  return out;
}
export function applyRoadEdit(w, ids, op) {
  if (!ROAD_OPS.includes(op)) return { ok: false, reason: "That action isn't valid" };
  const plan = planRoadEdit(w, ids, op);
  if (!plan.n) return { ok: false, reason: plan.blocked.length ? plan.blocked[0].reason : 'No road there' };
  if (plan.short) return { ok: false, reason: plan.short };
  if (op === 'remove') {
    let refund = 0;
    for (const id of plan.edges) { const c = w.removeCheck(id); if (c.ok) { refund += c.refund; w.removeRoadEdge(id); } }
    return { ok: true, n: plan.n, refund, skipped: ids.length - plan.n };
  }
  const by = new Map();
  for (const id of plan.edges) { const e = w.roads.edges.get(id), to = e.level + (op === 'up' ? 1 : -1); if (!by.has(to)) by.set(to, []); by.get(to).push(id); }
  let cost = 0;
  for (const [to, list] of by) { const r = w.setLevel(list, to); if (r.ok) cost += r.cost; }
  return { ok: true, n: plan.n, cost: Math.max(0, cost), refund: Math.max(0, -cost), skipped: ids.length - plan.n };
}

// ------------------------------------------------------------- selection
// The road edge nearest a point within r, or null.
export function edgeAt(w, x, z, r = 0.35) { const h = w.roads.nearest(x, z, HALF[3] + r); return h && h.d <= HALF[h.e.level] + r ? h.e : null; }
// The road edges with some of them in a box [x0, z0, x1, z1] (ids).
export function edgesInBox(w, box) {
  const out = new Set();
  for (const sg of w.roads.segsIn(box)) {
    const p = sg.e.pts[sg.i], q = sg.e.pts[sg.i + 1];
    for (let k = 0; k <= 4; k++) {
      const x = p[0] + ((q[0] - p[0]) * k) / 4, z = p[1] + ((q[1] - p[1]) * k) / 4;
      if (x >= box[0] && x <= box[2] && z >= box[1] && z <= box[3]) { out.add(sg.e.id); break; }
    }
  }
  return [...out];
}
// The street an edge is part of: on through each junction along the road
// that carries on straightest (within 35 degrees), both ways. Edge ids.
export function streetOf(w, id) {
  const net = w.roads, first = net.edges.get(id);
  if (!first) return [];
  const out = [first.id], seen = new Set(out);
  for (const end of [first.a, first.b]) {
    let e = first, n = end;
    for (let k = 0; k < 200; k++) {
      const node = net.nodes.get(n), hin = net.dirAt(e, n) + Math.PI;
      let best = null, bd = 0.62;
      for (const o of node.edges) {
        if (seen.has(o)) continue;
        const f = net.edges.get(o), d = angDiff(net.dirAt(f, n), hin);
        if (d < bd) { bd = d; best = f; }
      }
      if (!best) break;
      seen.add(best.id); out.push(best.id);
      e = best; n = net.other(best, n);
    }
  }
  return out;
}
// The length of road in a set of edges (rounded to the unit, as priced).
export const lengthOf = (w, ids) => ids.reduce((s, id) => s + (w.roads.edges.get(id) ? w.roads.edges.get(id).len : 0), 0);

void segDist; void lastT; void CONFIG;
