// Town invariants checked by the headless tests (playtest.js, starters.js,
// merge-test.js): plots never overlap (land deals and street fronts
// included) or reach onto a road or track, the index of plots agrees with
// them, the road network is in order (every edge runs from its node to its
// node, the way out of the valley is a node), villagers, transit lines and
// land deals point at real buildings, capacities hold, building sites keep
// moving, nothing turns into NaN; there is one seat of government.

import { isOpen, capOf, spareRect, plotOf, HALF, RAIL_HALF, VERGE } from '../src/world/world.js';
import { rect, toWorld, rectsOverlap, segRectDist, inRect, aabbOf, grow } from '../src/world/geom.js';
import { BUILDINGS } from '../src/defs.js';
import { DRESSINGS, streetPart } from '../src/config.js';

// A building's plot with the verge of the street it may come forward into
// (b.front), as a rectangle.
function standing(b) {
  const R = plotOf(b), f = b.front || 0;
  if (!f) return R;
  const [cx, cz] = toWorld(R, 0, f / 2);
  return rect(cx, cz, R.a, R.hw, R.hd + f / 2);
}

// The invariants of a town at rest; calls problem(msg) per fault.
export function auditTown(w, problem) {
  // plots never overlap, nor reach onto roads or track; the index agrees
  const rects = [];
  for (const b of w.buildings.values()) {
    if (![b.x, b.z, b.a, b.w, b.d].every(Number.isFinite)) { problem(`${b.type} #${b.id} has no proper plot`); continue; }
    rects.push([standing(b), b]);
    // a building on part of a grown plot may stand forward of the plot
    const r = spareRect(b), o = b.ownFront || 0;
    if (r && o > (b.front || 0)) { const [cx, cz] = toWorld(r, 0, o / 2); rects.push([rect(cx, cz, r.a, r.hw, r.hd + o / 2), b]); }
    const R = plotOf(b);
    if (!w.plots.of.has(b) || !w.plots.query(aabbOf(R)).includes(b)) problem(`the index of plots has lost ${b.type} #${b.id}`);
    for (const sg of w.roads.segsIn(aabbOf(R, 0.4))) {
      const p = sg.e.pts[sg.i], q = sg.e.pts[sg.i + 1];
      if (segRectDist(R, p[0], p[1], q[0], q[1]) < HALF[sg.e.level] + VERGE - 0.01) { problem(`${b.type} #${b.id} sits on a road`); break; }
    }
    for (const sg of w.rails.segsIn(aabbOf(R, 0.3))) {
      const p = sg.e.pts[sg.i], q = sg.e.pts[sg.i + 1];
      if (segRectDist(R, p[0], p[1], q[0], q[1]) < RAIL_HALF) { problem(`${b.type} #${b.id} sits on track`); break; }
    }
  }
  // (each against those near it: a town can hold thousands of plots)
  const byB = new Map();
  for (const [R, b] of rects) { if (!byB.has(b)) byB.set(b, []); byB.get(b).push(R); }
  for (const [R, a] of rects) {
    for (const c of w.plots.query(aabbOf(R, 0.3))) {
      if (c === a || c.id < a.id || !byB.has(c)) continue;
      if (byB.get(c).some(C => rectsOverlap(R, C, 0.004))) { problem(`plots overlap: ${a.type} #${a.id} and ${c.type} #${c.id}`); break; }
    }
  }
  for (const b of w.plots.of.keys()) if (!w.buildings.has(b.id) || w.buildings.get(b.id) !== b) { problem(`the index of plots holds a missing ${b.type} #${b.id}`); break; }
  // the road network is in order
  for (const net of [w.roads, w.rails]) {
    for (const e of net.edges.values()) {
      const A = net.nodes.get(e.a), B = net.nodes.get(e.b);
      if (!A || !B) { problem(`${net.kind} edge ${e.id} runs to a missing node`); continue; }
      if (Math.hypot(e.pts[0][0] - A.x, e.pts[0][1] - A.z) > 1e-6 || Math.hypot(e.pts[e.pts.length - 1][0] - B.x, e.pts[e.pts.length - 1][1] - B.z) > 1e-6) problem(`${net.kind} edge ${e.id} doesn't run from its node to its node`);
      if (!A.edges.includes(e.id) || !B.edges.includes(e.id)) problem(`${net.kind} edge ${e.id} isn't known to its nodes`);
      if (!e.pts.every(p => p.every(Number.isFinite))) problem(`${net.kind} edge ${e.id} has no proper curve`);
    }
    for (const n of net.nodes.values()) for (const id of n.edges) if (!net.edges.has(id)) { problem(`${net.kind} node ${n.id} lists a missing edge`); break; }
  }
  if (!w.roads.nodes.has(w.entry.node)) problem('the road out of the valley is gone');
  // every dressing suits its street
  for (const e of w.roads.edges.values()) {
    const D = DRESSINGS[streetPart(e.dress)];
    if (D && D.minLevel && e.level < D.minLevel) problem(`a ${D.name.toLowerCase()} on a road it doesn't suit (edge ${e.id})`);
  }
  // one seat of government, on grounds of its own size once rebuilt
  const seats = [...w.buildings.values()].filter(b => BUILDINGS[b.type].seat);
  if (seats.length > 1) problem(`${seats.length} seats of government: ${seats.map(b => `${b.type} #${b.id}`).join(', ')}`);
  for (const b of seats) if (!b.spare && b.w * b.d !== BUILDINGS[b.type].size ** 2) problem(`${b.type} #${b.id} stands on ${b.w}×${b.d} grounds`);
  // people, lines and land deals point at real places
  for (const r of w.residents.values()) {
    if (r.home != null && !w.buildings.has(r.home)) problem(`${r.first} ${r.last} lives in a missing building`);
    if (r.job != null && !w.buildings.has(r.job)) problem(`${r.first} ${r.last} works at a missing building`);
    if (r.job != null && r.school != null) problem(`${r.first} ${r.last} both works and studies`);
    if (!Number.isFinite(r.years) || !Number.isFinite(r.wealth ?? 0)) problem(`${r.first} has a broken age or savings`);
  }
  for (const l of w.lines) for (const s of l.stops) if (!w.buildings.has(s)) { problem(`${l.name} stops at a missing building`); break; }
  for (const b of w.buildings.values()) for (const l of b.leases || []) {
    const o = w.buildings.get(l.with);
    if (!o || !(o.leases || []).some(m => m.with === b.id)) problem(`${b.type} #${b.id} has a land deal with a missing or unaware neighbour`);
  }
  // farmland belongs to a farm, on open ground, within its limit, counted right
  const per = new Map();
  let stray = 0, under = null;
  for (const f of w.parcels.values()) {
    const b = w.buildings.get(f.farm);
    if (!b || !BUILDINGS[b.type].fields) { stray++; continue; }
    if (!under && w._plotBlock(grow(f.rect, -0.01), { fields: true })) under = b;
    per.set(f.farm, (per.get(f.farm) || 0) + 1);
  }
  if (stray) problem(`${stray} field(s) belong to no farm`);
  if (under) problem(`a field of ${under.type} #${under.id} is under a building, road or track`);
  for (const b of w.buildings.values()) {
    if (!BUILDINGS[b.type].fields) continue;
    const n = per.get(b.id) || 0;
    if ((b.fields || 0) !== n) problem(`${b.type} #${b.id} thinks it has ${b.fields || 0} fields, but has ${n}`);
    if (n > w.fieldMax(b)) problem(`${b.type} #${b.id} works ${n} fields, more than its ${w.fieldMax(b)}`);
  }
  // nobody is over capacity
  for (const b of w.buildings.values()) {
    if (!isOpen(b)) continue;
    const L = BUILDINGS[b.type].levels[b.level];
    if (L.housing && b.residents.length > capOf(b, 'housing') + 6) problem(`${L.name} #${b.id} overcrowded: ${b.residents.length}/${capOf(b, 'housing')}`);
    if (b.workers.length > capOf(b, 'jobs')) problem(`${L.name} #${b.id} has too many workers`);
    if (L.seats && (b.pupils || []).length > capOf(b, 'seats')) problem(`${L.name} #${b.id} has too many pupils`);
  }
  void inRect;
}

// Returns audit(day) for a running game, which reports each broken invariant
// via problem(day, msg).
export function makeAudit(game, problem) {
  const audit = (day) => {
    const w = game.world;
    auditTown(w, (msg) => problem(day, msg));
    // the oldest open site must keep moving while there are builders
    const C = game.construction;
    const open = [...w.buildings.values()].filter(b => b.con && !b.con.wait && b.access && b.connected).sort((a, b) => a._queued - b._queued);
    const head = open[0];
    if (head) {
      const key = `${head.id}:${head.con.kind}:${Math.floor((head.con.done / head.con.work) * 20)}`;
      if (audit.head !== key) { audit.head = key; audit.headSince = day; }
      else if (day - audit.headSince > 3 && C.hasBuilders) problem(day, `the oldest site (${head.type} #${head.id}, ${head.con.kind}) has not moved for ${day - audit.headSince} days`);
    }
    if (Number.isNaN(w.money)) problem(day, 'money is not a number');
    for (const wk of game.agents.walkers) if (!Number.isFinite(wk.x) || !Number.isFinite(wk.z)) { problem(day, 'a walker has no position'); break; }
    for (const a of game.animals.list) if (!Number.isFinite(a.x)) { problem(day, 'an animal has no position'); break; }
  };
  return audit;
}
