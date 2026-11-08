// Villagers: daily routines, walking, waiting for transit, and the little
// instanced people you see on the streets.

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { BUILDINGS, TRADES, servicesOf, tradesOf, visitOf } from '../defs.js';
import { doorPoint, plotOf, ownPlot, isOpen } from '../world/world.js';
import { routeLine, routeSamples } from './path.js';
import { toLocal, toWorld } from '../world/geom.js';
import { workArea, LIFT } from '../render/buildings.js';
import { VillagerView, lookOf, dressOf, carryFrom, strideLen } from '../render/villagers.js';
import { traitsOf } from './people.js';
import { plotGrid, plotPath, stepsGrid, stepAt, openAt, reachFrom } from './plotNav.js';
import { GeoBuilder } from '../render/geo.js';
import { MAT } from '../render/materials.js';

// How villagers look and are drawn lives in render/villagers.js.
export { lookOf };

// The kind of outing a building is for, or null if villagers don't visit it
// (homes, workplaces and schools count their own people). A full place sends
// visitors on to another of the same kind.
export function visitKind(def) {
  if (def.park) return def.outdoor ? 'park' : null;
  if (def.shop) return 'shop';
  if (def.leisure) return 'tavern';
  const sv = servicesOf(def);
  if (sv.includes('culture')) return 'chapel';
  if (sv.includes('health')) return 'clinic';
  return null;
}

// How many visitors a place holds at once: so many per tile, and more with
// each upgrade (open-air places grow a little less).
export function visitorCap(b) {
  const def = BUILDINGS[b.type], kind = visitKind(def);
  if (!kind) return Infinity;
  const base = def.visitors || { park: 3, shop: 4, tavern: 6, chapel: 8, clinic: 3 }[kind];
  return Math.max(2, Math.round(base * b.w * b.d * (1 + (kind === 'park' ? 0.3 : 0.5) * b.level)));
}

const _fr = new THREE.Frustum(), _pm = new THREE.Matrix4(), _sp = new THREE.Sphere(), _v = new THREE.Vector3();

// The top of a doorstep above its door's threshold (see door() in
// render/buildings.js).
const STEP_UP = 0.02;
// how far a gondola station's bench seat is above its deck (bench() in
// render/buildings.js)
const G_DECK_SEAT = 0.05;

// How high a walker stands: on the ground or the street, but on the way in
// to a door or out of it, up the steps, the porch and the portico in front
// of it as the model has them (wk.stairsIn / wk.stairsOut, from stepsGrid),
// or where the model isn't known, up on the step and the threshold of the
// door (which on a slope may be well above the street), hopping on to the
// step over the last bit of the way to it and down again on the way out.
export function walkY(w, wk) {
  // a way with its own heights (up a gondola station's stairs or lift, and
  // across its deck: wk.ys, one for each point, null for the ground)
  if (wk.ys) {
    const ya = wk.ys[wk.seg], yb = wk.ys[wk.seg + 1];
    if (ya != null || yb != null) {
      const a = wk.pts[wk.seg], b = wk.pts[wk.seg + 1] || a;
      const y0 = ya ?? w.walkHeight(a[0], a[1]), y1 = yb ?? w.walkHeight(b[0], b[1]);
      return y0 + (y1 - y0) * wk.t;
    }
  }
  const g = w.walkHeight(wk.x, wk.z);
  // leaving an open plot: on its ground (which may stand above the street
  // on a slope) to its edge, then down to the street
  if (wk.plotOut && wk.seg < wk.plotOut) return wk.seg < wk.plotOut - 1 ? wk.plotY : wk.plotY + (g - wk.plotY) * wk.t;
  if (wk.floorIn == null && wk.floorOut == null) return g;
  const n = wk.pts.length, s = wk.seg;
  const st = wk.stairsOut && s < wk.doorOut ? wk.stairsOut : wk.stairsIn && s >= n - wk.doorIn - 2 ? wk.stairsIn : null;
  if (st) return Math.max(g, stepAt(st, wk.x, wk.z));
  // the step, the doorway and the step inside stand at the floor
  const at = (i) => (wk.floorOut != null && i < Math.min(3, wk.doorOut) ? wk.floorOut : wk.floorIn != null && i >= n - Math.min(3, wk.doorIn) ? wk.floorIn : null);
  const ya = at(s), yb = at(s + 1);
  if (ya == null && yb == null) return g;
  if (ya != null && yb != null) return Math.max(g, ya + (yb - ya) * wk.t);
  const a = wk.pts[s], b = wk.pts[s + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const off = yb != null ? (1 - wk.t) * L : wk.t * L;   // how far from the step
  return Math.max(g, (yb ?? ya) - Math.max(0, off - 0.02) * 4);
}

// Where a door's path meets the edge of its plot, straight out from the door
// (a little past it, on the pavement); null when the door is at the front.
function gateOf(B, d) {
  const R = plotOf(B), [lx, lz] = toLocal(R, d.x, d.z);
  const ux = d.dx * R.ex + d.dz * R.ez, uz = d.dx * R.ux + d.dz * R.uz;
  let t = Infinity;
  if (ux > 1e-3) t = Math.min(t, (R.hw - lx) / ux); else if (ux < -1e-3) t = Math.min(t, (-R.hw - lx) / ux);
  if (uz > 1e-3) t = Math.min(t, (R.hd - lz) / uz); else if (uz < -1e-3) t = Math.min(t, (-R.hd - lz) / uz);
  if (!Number.isFinite(t) || t < 0.2) return null;
  t += 0.05;
  return [d.x + d.dx * t, d.z + d.dz * t];
}

// A wander area: [x0, z0, x1, z1] in world space, or across and along the
// frame of the rectangle area[4] (its own x and z) when there is one. The
// world point at (lx, lz) in it.
export function inArea(A, lx, lz) { return A[4] ? toWorld(A[4], lx, lz) : [lx, lz]; }

export class Agents {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    this.walkers = new Set();
    this.plannedDay = -1;
    const scene = game.renderer.scene;
    this.view = new VillagerView(scene, CONFIG.MAX_AGENTS);
    this._grids = new WeakMap();   // a drawn model → the way about its plot (plotNav)
    this._stairs = new WeakMap();  // a drawn model → the steps up to its door
    this._seated = new Map();      // a bench seat at a gondola station → who has it
    this._grid = new Map();        // who stands where, by CELL (see _spread)
    this._doorNext = new Map();    // a building → when the next may come out of its door
    this.lifts = new Map();        // a tall gondola station → its lift (see _runLifts)
    this._liftScan = 0;
    this._in = [];                 // those in the crowd this frame
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.045, 0.065, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ffd84a', transparent: true, opacity: 0.95, depthWrite: false }));
    this.ring.renderOrder = 8;
    this.ring.visible = false;
    scene.add(this.ring);
    this.selected = null;
    for (const r of this.world.residents.values()) this._initResident(r);
    this.lanterns = [];
  }

  _initResident(r) {
    r.loc = 'in';
    r.at = r.home;
    r.plan = [];
    r.pi = 0;
    r.walk = null;
    r.lk = lookOf(r, dressOf(this.world, r));
  }

  dispose() {
    this.view.dispose();
    for (const L of this.lifts.values()) this._dropLift(L);
    this.game.renderer.scene.remove(this.ring);
  }

  // ------------------------------------------------------------- planning
  _candidates(pred) {
    const out = [];
    for (const b of this.world.buildings.values()) if (b.access && b.connected && isOpen(b) && pred(BUILDINGS[b.type], b)) out.push(b);
    return out;
  }

  // Every kind of place a day's plan can lead to, looked up once and kept
  // for the rest of this update (days are only planned in update(), and
  // nothing there opens, closes or links up a building): planning the whole
  // town's day at midnight doesn't search the town for each villager.
  _places() {
    return this._lists ||= {
      shops: this._candidates(d => d.shop),
      // (allotments are for the old to dig, not for a stroll)
      parks: this._candidates(d => d.park && d.outdoor && !d.potter),
      plays: this._candidates(d => d.play),
      allots: this._candidates(d => d.potter),
      taverns: this._candidates(d => d.leisure && !d.park),
      // (a bandstand brings culture to the streets round it, but nobody goes
      // to it to worship)
      chapels: this._candidates(d => servicesOf(d).includes('culture') && !d.park),
      schools: this._candidates(d => servicesOf(d).includes('education')),
      clinics: this._candidates(d => visitKind(d) === 'clinic'),
    };
  }

  _nearest(r, list, k = 3) {
    if (!list.length) return null;
    const home = this.world.buildings.get(r.home);
    if (!home) return list[(Math.random() * list.length) | 0].id;
    const sorted = list.map(b => [b, Math.abs(b.x - home.x) + Math.abs(b.z - home.z) + Math.random() * 4]).sort((a, b) => a[1] - b[1]);
    return sorted[Math.min(sorted.length - 1, (Math.random() * k) | 0)][0].id;
  }

  // A shopping trip is for one trade (TRADES): one the town sells, the
  // everyday ones most often and those only sold far from home less, at one
  // of the nearer shops selling it. So the town's only draper gets its
  // clothes shopping, and a street of bakeries doesn't draw every errand.
  _shopFor(r, shops) {
    if (!shops.length) return null;
    const home = this.world.buildings.get(r.home);
    if (!home) return this._nearest(r, shops);
    const near = new Map();
    for (const b of shops) {
      const d = Math.abs(b.x - home.x) + Math.abs(b.z - home.z);
      for (const t of tradesOf(b)) if (!(near.get(t) <= d)) near.set(t, d);
    }
    const odds = [];
    let sum = 0;
    for (const [t, d] of near) { const p = (TRADES[t] ? TRADES[t].often : 1) / (1 + Math.max(0, d - 6) / 6); odds.push([t, p]); sum += p; }
    let x = Math.random() * sum, want = odds[odds.length - 1][0];
    for (const [t, p] of odds) if ((x -= p) <= 0) { want = t; break; }
    return this._nearest(r, shops.filter(b => tradesOf(b).includes(want)));
  }

  planDay(r, now) {
    const R = Math.random;
    const { shops, parks, plays, allots, taverns, chapels, schools, clinics } = this._places();
    const pick = (list) => this._nearest(r, list), shop = () => this._shopFor(r, shops);
    const plan = [];
    const home = r.home;
    const push = (t, dest) => { if (dest != null) plan.push({ t, dest }); };
    // personality: when they get up, how often they go out and where to
    const T = traitsOf(r), has = (t) => T.includes(t);
    const shopK = has('shopper') ? 1.8 : has('thrifty') ? 0.5 : 1;
    const outK = has('homebody') ? 0.5 : has('social') || has('curious') ? 1.5 : 1;
    const tavK = has('owl') ? 2.5 : has('social') ? 1.8 : has('homebody') ? 0.4 : 1;
    const shift = has('early') ? -0.6 : has('owl') ? 0.6 : 0;
    const leisure = has('outdoorsy') && parks.length ? parks : parks.concat(taverns);
    const pickFar = (list) => has('curious') ? this._nearest(r, list, 8) : pick(list);
    // children mostly head for somewhere to play
    const playPick = () => pickFar(plays.length && R() < 0.75 ? plays : parks);
    if (r.age === 'adult' && r.school != null && this.world.buildings.get(r.school)) {
      // a student: lectures, then the library or the tavern
      push(8 + R() * 1.2, r.school);
      push(15.5 + R() * 1.5, R() < 0.4 * tavK && taverns.length ? pick(taverns) : home);
      if (plan[plan.length - 1].dest !== home) push(21 + R(), home);
    } else if (r.age === 'adult' && r.job != null) {
      const job = this.world.buildings.get(r.job);
      const late = job && BUILDINGS[job.type].leisure;
      const start = late ? 13 + R() * 1.5 : 6.4 + R() * 1.7 + shift;
      const end = late ? 21.5 + R() * 1.2 : 16 + R() * 1.8 + shift + (has('diligent') ? 0.8 : 0);
      push(start, r.job);
      const after = R(), pShop = 0.38 * shopK * outK, pOut = pShop + 0.24 * outK;
      if (!late && after < pShop && shops.length) { push(end, shop()); push(end + 0.7 + R() * 1.2, home); }
      else if (!late && after < pOut && leisure.length) { push(end, pickFar(leisure)); push(end + 1 + R() * 1.6, home); }
      else push(end, home);
      if (!late && has('devout') && chapels.length && R() < 0.5) { push(18.4 + R() * 0.4, pick(chapels)); push(19.4 + R() * 0.4, home); }
      else if (!late && R() < 0.2 * tavK && taverns.length) { push(19.6 + R() + shift, pick(taverns)); push(22 + R() * 1.4 + shift, home); }
    } else if (r.age === 'adult') {
      push(8.5 + R() * 2.5 + shift, R() < Math.min(1, 0.75 * shopK) ? shop() ?? pick(parks) : pickFar(parks) ?? shop());
      push(12 + R(), home);
      if (R() < 0.55 * outK) { push(14.5 + R() * 2, has('devout') ? pick(chapels) ?? pickFar(leisure) : pickFar(leisure)); push(18 + R(), home); }
      if (R() < 0.12 * tavK && taverns.length) { push(19.8 + R(), pick(taverns)); push(22.2 + R(), home); }
    } else if (r.age === 'child') {
      const play = has('playful') ? 0.9 : has('bookish') ? 0.3 : 0.6;
      // pupils go to their own school; the youngest and those without a
      // place stay home and play
      const school = r.school != null && this.world.buildings.get(r.school) ? r.school : null;
      if (school != null) {
        push(7.3 + R() * 0.7, school);
        push(14 + R() * 0.8, R() < play ? playPick() ?? home : home);
        push(17.5 + R(), home);
      } else {
        push(9.5 + R() * 2, playPick());
        push(12.5 + R(), home);
        if (R() < play + 0.2) push(15 + R(), playPick());
        push(18 + R() * 0.5, home);
      }
    } else {
      // the old: chapel, the park, or of a morning their allotment
      const dig = allots.length && !has('devout') && R() < (has('outdoorsy') ? 0.7 : 0.45);
      push(8.4 + R() * 2 + shift, dig ? pick(allots) : has('devout') || R() < 0.6 ? pick(chapels) ?? pick(parks) : pickFar(parks));
      push(11.5 + R(), home);
      if (R() < 0.6 * outK) { push(14 + R() * 2, R() < 0.6 * shopK ? shop() ?? pick(parks) : pickFar(parks)); push(16.6 + R(), home); }
    }
    // now and then a visit to the herbalist or the doctor, in the early
    // afternoon while they're at home anyway (the old go most often)
    const atSchool = r.school != null && this.world.buildings.get(r.school);
    const free = r.age === 'elder' || (!atSchool && (r.age === 'child' || (r.age === 'adult' && r.job == null)));
    if (clinics.length && free && R() < (r.age === 'elder' ? 0.25 : r.age === 'child' ? 0.08 : 0.06)) {
      const t = r.age === 'elder' ? 12.6 + R() * 0.5 : r.age === 'child' ? 13.6 + R() * 0.3 : 13.1 + R() * 0.4;
      push(t, pick(clinics));
      push(t + 0.9 + R() * 0.5, home);
    }
    plan.sort((a, b) => a.t - b.t);
    r.plan = plan.filter((p, i) => i === 0 || p.dest !== plan[i - 1].dest);
    r.pi = 0;
    // catch up if we're mid-day (new game / loaded save)
    if (now != null) {
      while (r.pi < r.plan.length && r.plan[r.pi].t < now) {
        const p = r.plan[r.pi++];
        if (r.loc === 'in' && this.world.buildings.get(p.dest)) {
          const B = this.world.buildings.get(p.dest);
          const d = BUILDINGS[B.type];
          if (!(d.outdoor || (d.outdoorWork && r.job === B.id))) r.at = p.dest;
        }
      }
    }
  }

  newDay() {
    const w = this.world;
    for (const r of w.residents.values()) {
      this.planDay(r, null);
      if (r.loc === 'out' || (r.loc === 'in' && r.at !== r.home)) r.plan.unshift({ t: 0, dest: r.home });
      // dressed for a new job (or a grander home) from this morning
      const d = dressOf(w, r);
      if (r.lk && (r.lk.kind !== d.kind || r.lk.rich !== d.rich)) this.refreshLook(r);
    }
    this.plannedDay = w.day;
  }

  // ------------------------------------------------------------- movement
  go(r, destId) {
    const w = this.world;
    if (r.loc === 'walk' || r.loc === 'wait' || r.loc === 'ride') return;
    if (r.site != null && destId !== r.site) r.site = null;
    let A = w.buildings.get(r.at);
    const B = w.buildings.get(destId);
    if (!A) { r.at = r.home; A = w.buildings.get(r.home); if (r.walk) this._drop(r.walk); r.loc = 'in'; }
    if (!A || !B || A === B) return;
    if (!A.access || !B.access) return;
    const route = this.game.paths.road(A.access, B.access);
    if (!route) return;
    const startPos = r.loc === 'out' && r.walk ? { x: r.walk.x, z: r.walk.z } : null;
    if (r.walk) this._drop(r.walk);
    // (how long the walk takes, climbing counted: see climbCost)
    const walk = walkCost(w, route);
    const plan = r.skipTransit ? null : this.game.transit.plan(A, B, walk);
    if (plan) this.game.transit.tally(plan, walk);
    r.skipTransit = false;
    if (plan) {
      const t1 = this.game.paths.road(A.access, plan.board.access);
      if (t1) {
        this._walk(r, A, plan.board, t1, startPos, () => this.game.transit.wait(r, plan, B.id));
        return;
      }
    }
    this._walk(r, A, B, route, startPos, () => this._arrive(r, B.id));
  }

  // Front door of a building as a short path: a step inside (hidden by the
  // walls), the doorway, the doorstep, and the gate: the edge of the plot
  // straight out from the door, so a door set back behind a forecourt, a
  // portico or a garden is walked up to square on rather than across the
  // corner of a wall. A door that doesn't face the street the building is
  // reached from (down the side of a row on a deep plot, or round a corner)
  // is reached from that street's edge of the plot, round the building to
  // it where its model is known (plotNav). Null for open-air places.
  _doorway(B, r, arriving) {
    const d = B && B.door;
    if (!d || B.open) return null;
    const def = BUILDINGS[B.type];
    if (def.stop || def.outdoor || (def.outdoorWork && r && r.job === B.id) || (B.con && r && r.site === B.id) || !isOpen(B)) return null;
    const inside = [d.x - d.dx * 0.09, d.z - d.dz * 0.09], door = [d.x, d.z], step = [d.x + d.dx * 0.08, d.z + d.dz * 0.08];
    const way = [step, door, inside];
    const gate = gateOf(B, d);
    // (which side of the plot a point lies beyond, in its own frame: its
    // front 's' (+z), back 'n', +x 'e', -x 'w')
    const R = plotOf(B), a = B.access;
    const side = (x, z) => { const [lx, lz] = toLocal(R, x, z); return lx < -R.hw ? 'w' : lx > R.hw ? 'e' : lz < -R.hd ? 'n' : lz > R.hd ? 's' : ''; };
    const as = a && side(a.x, a.z), g = gate && as && side(gate[0], gate[1]) !== as ? this._gridOf(B) : null;
    let round = null, from = null;
    if (g) {
      // in from the street's edge of the plot (and the verge it may come
      // forward into), in line with the door's step
      const f = B.front || 0, X0 = -R.hw, X1 = R.hw, Z0 = -R.hd, Z1 = R.hd + f, cl = (v, lo, hi) => Math.min(hi - 0.06, Math.max(lo + 0.06, v));
      const [sx, sz] = toLocal(R, step[0], step[1]);
      from = toWorld(R, ...(as === 'n' ? [cl(sx, X0, X1), Z0 - 0.03] : as === 's' ? [cl(sx, X0, X1), Z1 + 0.03] : as === 'w' ? [X0 - 0.03, cl(sz, Z0, Z1)] : [X1 + 0.03, cl(sz, Z0, Z1)]));
      // to the open ground straight out from the door (beyond a porch or a
      // portico, whose columns leave no room on the grid), then straight in
      // (or, where even that is shut in, on the grid as drawn, without the room
      // kept round everything)
      for (const gg of [g, g.tight]) {
        let reach = null;
        for (let u = 0; u <= 0.5 && !reach; u += 0.025) if (openAt(gg, step[0] + d.dx * u, step[1] + d.dz * u)) reach = [step[0] + d.dx * u, step[1] + d.dz * u];
        round = reach && plotPath(gg, from[0], from[1], reach[0], reach[1]);
        if (round) break;
      }
    }
    if (round) way.unshift(from, ...round);
    else if (gate) way.unshift(gate);
    return arriving ? way : way.reverse();
  }

  _walk(r, A, B, route, startPos, onArrive) {
    const start = doorPoint(A), end = doorPoint(B);
    const pts = routeLine(this.world.roads, route, r.lk.lane, start, end);
    const out = startPos ? null : this._doorway(A, r, false), into = this._doorway(B, r, true);
    // with a real door the plot-edge point is skipped (the front may stand
    // further forward than the plot edge)
    if (out) { pts.shift(); pts.unshift(...out); }
    if (into) { pts.pop(); pts.push(...into); }
    let plotOut = 0;
    if (startPos) {
      // out of an open plot, round whatever stands in the way
      const g = this._gridOf(A), way = g ? plotPath(g, startPos.x, startPos.z, pts[0][0], pts[0][1]) : null;
      if (way) { way.pop(); pts.unshift(...way); }
      pts.unshift([startPos.x, startPos.z]);
      plotOut = 1 + (way ? way.length : 0);
    }
    const wk = this._makeWalker(r.lk, pts, onArrive);
    wk.plotOut = plotOut;
    wk.plotY = A.baseY + 0.012;
    wk.doorOut = out ? out.length : 0;
    wk.doorIn = into ? into.length : 0;
    wk.doorRef = into ? B.door : null;
    wk.floorOut = out ? A.door.y + STEP_UP : null;
    wk.floorIn = into ? B.door.y + STEP_UP : null;
    wk.stairsOut = out ? this._stairsOf(A) : null;
    wk.stairsIn = into ? this._stairsOf(B) : null;
    wk.dest = B.id;
    // the shopping carried home, and a satchel on the way to and from school
    wk.carry = carryFrom(A, r, this.world.day);
    wk.bag = r.school != null && (A.id === r.school || B.id === r.school);
    // out of a door one after another, a moment apart (a big block's
    // morning rush not held up more than a few seconds for it)
    if (out) {
      const now = this._clock || 0, next = Math.max(now, this._doorNext.get(A.id) || 0);
      wk.delay = Math.min(next - now, 8) + Math.random() * 0.15;
      this._doorNext.set(A.id, now + wk.delay + DOOR_GAP);
    }
    wk.r = r;
    r.walk = wk;
    r.loc = 'walk';
    return wk;
  }

  _makeWalker(lk, pts, onArrive) {
    this._made = (this._made || 0) + 1;
    // every walker has all its fields from the start: one object shape keeps
    // the loops over hundreds of them each frame quick
    const wk = {
      lk, pts, seg: 0, t: 0, x: pts[0][0], z: pts[0][1], y: 0,
      heading: 0, phase: Math.random() * 6, mode: 'path', onArrive, idle: 0, speedK: lk.speed,
      r: null, dest: null, delay: 0, doorOut: 0, doorIn: 0, moving: false, ghost: false, hand: false,
      area: null, ring: false, baseY: 0, working: false, tool: null, target: null, route: null, floorIn: null, floorOut: null, stairsIn: null, stairsOut: null, plotOut: 0, plotY: 0,
      ys: null, standY: null, cabin: null, seat: 0, doorRef: null, sit: false, seatOf: null, side: 0, hold: 0, narrow: false, boarding: false, inView: true,
      carry: null, bag: false, lamp: false, lx: null, ly: null, lz: null, _i: 0, lift: null, liftPts: null, liftWait: 0,
    };
    if (pts.length > 1) wk.heading = Math.atan2(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
    wk._n = this._made;
    this.walkers.add(wk);
    return wk;
  }

  _drop(wk) { this._unseat(wk); this.walkers.delete(wk); if (wk.r && wk.r.walk === wk) wk.r.walk = null; }

  // ------------------------------------------------------------- lifts
  // A tall gondola station's way up (b.stair) rises on the spot, in a glass
  // lift (see gondolaWayUp): its car takes those waiting at its door up to
  // the deck or down to the street, together, four at a time, each at a
  // spot of their own in it (LIFT_SLOTS). Each has its
  // car, parked at the foot to begin with, and the glass round its shaft
  // and the car to draw (the station's model has the shaft's frame); found
  // afresh now and then, as stations are built, rise or come down.
  _syncLifts() {
    const seen = new Set();
    for (const b of this.world.buildings.values()) {
      const st = b.stair;
      if (!st || BUILDINGS[b.type].stop !== 'gondola') continue;
      const i = st.findIndex((p, k) => k > 0 && k + 1 < st.length && Math.abs(st[k + 1].y - p.y) > 0.05 && Math.abs(st[k + 1].x - p.x) + Math.abs(st[k + 1].z - p.z) < 1e-4);
      if (i < 0) continue;
      const p = st[i], y0 = Math.min(p.y, st[i + 1].y), y1 = Math.max(p.y, st[i + 1].y);
      let L = this.lifts.get(b.id);
      if (L && (Math.abs(L.x - p.x) + Math.abs(L.z - p.z) > 1e-4 || Math.abs(L.y0 - y0) + Math.abs(L.y1 - y1) > 1e-4)) { this._dropLift(L); L = null; }
      if (!L) this.lifts.set(b.id, this._makeLift(b.id, p.x, p.z, y0, y1, Math.atan2(p.x - st[i - 1].x, p.z - st[i - 1].z), LIFT.across[b.type] || LIFT.across.gondola));
      seen.add(b.id);
    }
    for (const [id, L] of this.lifts) if (!seen.has(id)) this._dropLift(L);
  }

  // A lift at (x, z) from y0 up to y1, its shaft long along ry (the way in
  // from its street end) and across wide: its car (y, its floor; dir, which
  // way it goes; open, how long its doors stand open yet), those in it,
  // those stepping in, who stands at each spot in it, and who has called it
  // to the foot or the top this frame.
  _makeLift(id, x, z, y0, y1, ry, across) {
    const L = { id, x, z, y0, y1, ry, y: y0, dir: 0, open: 0, riders: [], coming: new Set(), slots: LIFT_SLOTS.map(() => null), call: [false, false], mesh: null, car: null };
    const g = L.mesh = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = ry;
    L.car = new THREE.Mesh(LIFT_CAR[across] || (LIFT_CAR[across] = liftCarModel(across)), MAT.building);
    L.car.position.y = y0;
    L.car.castShadow = true;
    g.add(L.car, new THREE.Mesh(liftGlass(y0 - 0.02, y1 + 0.17, across), MAT.glass));
    this.game.renderer.scene.add(g);
    return L;
  }

  _dropLift(L) {
    this.lifts.delete(L.id);
    this.game.renderer.scene.remove(L.mesh);
    L.mesh.children[1].geometry.dispose();
    for (const wk of [...L.riders, ...L.coming]) { wk.lift = null; wk.liftPts = null; }
  }

  // Whether a walker at a lift's door (the next stretch of their way a ride
  // in it) may step into its car: it stands open at their floor, with a spot
  // free in it, the furthest from the door first, which their way now goes
  // to and rides from; or they call it there.
  _liftIn(wk) {
    if (wk.lift && wk.liftPts === wk.pts) return true;
    const p = wk.pts[wk.seg + 1], y = wk.ys[wk.seg + 1];
    let L = null;
    for (const o of this.lifts.values()) if (Math.abs(o.x - p[0]) + Math.abs(o.z - p[1]) < 1e-3) { L = o; break; }
    // (none known there yet, or not to their floor, the station having
    // risen since they set off; or waited for too long: up the shaft as
    // best they can)
    if (!L || (Math.abs(y - L.y0) > 1e-3 && Math.abs(y - L.y1) > 1e-3) || wk.liftWait > LIFT_PATIENCE) { wk.liftWait = 0; return true; }
    const k = L.slots.indexOf(null);
    if (!L.dir && L.open > 0 && Math.abs(L.y - y) < 1e-3 && k >= 0) {
      L.coming.add(wk);
      L.slots[k] = wk;
      wk.lift = L; wk.liftPts = wk.pts; wk.liftWait = 0;
      const at = [L.x + Math.sin(L.ry) * LIFT_SLOTS[k], L.z + Math.cos(L.ry) * LIFT_SLOTS[k]];
      wk.pts[wk.seg + 1] = at; wk.pts[wk.seg + 2] = at.slice();
      return true;
    }
    L.call[Math.abs(y - L.y1) < Math.abs(y - L.y0) ? 1 : 0] = true;
    return false;
  }

  // Each lift's car: it stands with its doors open at a floor while anyone
  // steps out or in (till its doors close, and for those stepping in), then
  // goes up or down with those in it, who step out at the other end; called
  // empty to whoever waits at the other end; and stands where it is, its
  // doors shut, while nobody wants it. t: game time.
  _runLifts(t) {
    const v = LIFT_SPEED * CONFIG.WALK_SPEED;
    for (const L of this.lifts.values()) {
      // (only those still on their way through it: not dropped, nor sent
      // another way)
      const mine = (wk) => this.walkers.has(wk) && wk.lift === L && wk.liftPts === wk.pts;
      L.riders = L.riders.filter(wk => mine(wk) && liftSeg(wk, wk.seg));
      for (const wk of L.coming) if (!mine(wk)) L.coming.delete(wk);
      for (let k = 0; k < L.slots.length; k++) if (L.slots[k] && !L.riders.includes(L.slots[k]) && !L.coming.has(L.slots[k])) L.slots[k] = null;
      if (L.dir) {
        const goal = L.dir > 0 ? L.y1 : L.y0;
        L.y += L.dir * v * t;
        if ((L.y - goal) * L.dir >= 0) {
          L.y = goal; L.dir = 0; L.open = LIFT_DOORS;
          for (const wk of L.riders) { wk.seg++; wk.t = 0; wk.lift = null; wk.liftPts = null; }
          L.riders.length = 0;
          L.slots.fill(null);
        }
      } else if (L.open > 0) L.open -= t;
      else if (!L.coming.size) {
        const top = Math.abs(L.y - L.y1) < 1e-6 ? 1 : 0;
        if (L.riders.length || L.call[1 - top]) L.dir = top ? -1 : 1;
        else if (L.call[top]) L.open = LIFT_DOORS;
      }
      for (const wk of L.riders) {
        const ya = wk.ys[wk.seg], yb = wk.ys[wk.seg + 1];
        wk.t = Math.max(0, Math.min(1, (L.y - ya) / (yb - ya)));
      }
      L.car.position.y = L.y;
      L.call[0] = L.call[1] = false;
    }
  }

  // ----------------------------------------------------------- the crowd
  // Villagers keep out of each other's way and out of the vehicles': after
  // everyone has moved, any two closer than a body's width (BODY_D) move
  // apart, those walking a street by stepping to one side (wk.side, so they
  // keep their place along it), those standing about in the street by
  // shuffling over (never off it, into a wall), and those sitting, riding,
  // somewhere narrow or about a plot not at all (those strolling or at work
  // go round what stands there, and pick somewhere nobody stands); and
  // anyone in a coach's, a cart's or a train's way, or just ahead of it,
  // steps aside.
  // Only those drawn (crowds thinned on screen leave the rest to themselves).
  // Files everyone by CELL for near() (the vehicles look out for them).
  _spread(t) {
    const grid = this._grid, list = this._in;
    for (const l of grid.values()) l.length = 0;
    list.length = 0;
    for (const wk of this.walkers) {
      if (wk.delay > 0 || wk.mode === 'ride' || wk.shown === false) continue;
      list.push(wk);
      const k = cellKey(wk.x, wk.z);
      let l = grid.get(k);
      if (!l) grid.set(k, l = []);
      l.push(wk);
    }
    if (!t) return;
    const still = (wk) => wk.sit || (wk.mode === 'path' && wk.narrow);
    const hidden = (wk) => inside(wk);
    const W = this.world, road = (x, z) => !!W.roadAt(x, z, 0.02);
    const shove = (wk, px, pz) => {
      if (still(wk)) return;
      if (wk.mode === 'path') {
        // sideways only, as a step to one side of their way
        const a = wk.pts[wk.seg], b = wk.pts[wk.seg + 1] || a, L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L < 1e-6) return;
        const nx = -(b[1] - a[1]) / L, nz = (b[0] - a[0]) / L, d = px * nx + pz * nz;
        const was = wk.side;
        wk.side = Math.max(-SIDE_IN, Math.min(SIDE_OUT, wk.side + d));
        wk.x += nx * (wk.side - was); wk.z += nz * (wk.side - was);
      } else if (road(wk.x, wk.z) && road(wk.x + px, wk.z + pz)) { wk.x += px; wk.z += pz; }   // (on the street, never into a wall)
    };
    for (const a of list) {
      const cx = Math.floor(a.x / CELL), cz = Math.floor(a.z / CELL);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const l = grid.get((cx + dx) * 65536 + (cz + dz));
        if (!l) continue;
        for (const b of l) {
          if (b === a || b._n < a._n || Math.abs(a.y - b.y) > 0.2 || hidden(a) || hidden(b)) continue;
          const rx = b.x - a.x, rz = b.z - a.z, d = Math.hypot(rx, rz);
          if (d >= BODY_D || (still(a) && still(b))) continue;
          const ux = d > 1e-6 ? rx / d : Math.cos(a._n), uz = d > 1e-6 ? rz / d : Math.sin(a._n);
          const o = BODY_D - d, ka = still(a) ? 0 : still(b) ? 1 : 0.5, kb = 1 - ka;
          shove(a, -ux * o * ka, -uz * o * ka);
          shove(b, ux * o * kb, uz * o * kb);
        }
      }
    }
    // out of the way of the vehicles on the ground, and of one coming on
    const bodies = this.game.transit && this.game.transit.bodies;
    if (bodies) for (const o of bodies) {
      if (o.air) continue;
      const mid = (o.f - o.b) / 2, cx = o.x + o.hx * mid, cz = o.z + o.hz * mid, half = (o.f + o.b) / 2;
      for (const wk of this.near(cx + o.hx * 0.12, cz + o.hz * 0.12, half + 0.3)) {
        if (Math.abs(wk.y - o.y) > 0.15 || still(wk)) continue;
        const rx = wk.x - cx, rz = wk.z - cz, along = rx * o.hx + rz * o.hz, lat = rx * o.hz - rz * o.hx;
        const clear = o.w + 0.02;   // (not those on the pavement beside it)
        if (Math.abs(lat) >= clear || along < -half - 0.04 || along > half + 0.2) continue;
        const s = lat >= 0 ? 1 : -1, need = (clear - Math.abs(lat)) * (along > half ? Math.min(1, t * 3) : 1);
        shove(wk, o.hz * s * need, -o.hx * s * need);
      }
    }
  }

  // The walkers (in the crowd this frame) within about r of (x, z).
  near(x, z, r) {
    const out = [], c0 = Math.floor((x - r) / CELL), c1 = Math.floor((x + r) / CELL), d0 = Math.floor((z - r) / CELL), d1 = Math.floor((z + r) / CELL);
    for (let cx = c0; cx <= c1; cx++) for (let cz = d0; cz <= d1; cz++) {
      const l = this._grid.get(cx * 65536 + cz);
      if (l) for (const wk of l) if (Math.abs(wk.x - x) <= r && Math.abs(wk.z - z) <= r) out.push(wk);
    }
    return out;
  }

  // How far a walker can go before closing within a body's width of whoever
  // is walking ahead of it going the same way (or, somewhere narrow, any way
  // but straight at it), from where everyone stood last frame (not minding
  // the people, only the vehicles, if not people).
  _ahead(wk, people = true) {
    const hx = Math.sin(wk.heading), hz = Math.cos(wk.heading);
    let best = Infinity;
    if (people) for (const o of this.near(wk.x + hx * 0.06, wk.z + hz * 0.06, 0.13)) {
      if (o === wk || o.mode === 'ride' || Math.abs(o.y - wk.y) > 0.2) continue;
      // (behind someone walking: on a street, going the same way; somewhere
      // narrow, any way but straight at them, whom they pass; and someone
      // going in waits for someone coming out of the door. Not behind
      // someone standing about: they're nudged aside, see _spread)
      if (o.mode !== 'path') continue;
      const same = Math.sin(o.heading) * hx + Math.cos(o.heading) * hz;
      const giveWay = wk.doorIn && wk.seg >= wk.pts.length - wk.doorIn - 1 && o.doorOut && o.seg < o.doorOut;
      if (!giveWay && (wk.narrow ? same < -0.5 : same <= 0.5)) continue;
      const rx = o.x - wk.x, rz = o.z - wk.z, along = rx * hx + rz * hz, lat = rx * hz - rz * hx;
      // (level with each other, the one who set off first goes first)
      if (along > 0.13 || Math.abs(lat) > 0.05 || along < -0.002 || (along <= 0.002 && o._n > wk._n)) continue;
      best = Math.min(best, along - BODY_D);
    }
    // a vehicle across their way (a coach waiting, a cart coming as they
    // cross): they wait for it to go by, stopping short of it and of the
    // stretch just ahead of one on the move (not those on the pavement
    // beside it, clear of its side)
    for (const o of this._vehiclesNear(wk.x, wk.z)) {
      if (Math.abs(o.y - wk.y) > 0.15) continue;
      const v = o.owner, on = v.state !== 'dwell' && !v.wait ? 0.3 : 0;
      if (!on && wk.hold > CAR_PATIENCE) continue;   // (one stuck in a jam a good while: they go round it)
      const mid = (o.f - o.b) / 2, half = (o.f + o.b) / 2, cx = o.x + o.hx * mid, cz = o.z + o.hz * mid;
      const inBox = (x, z) => { const rx = x - cx, rz = z - cz, u = rx * o.hx + rz * o.hz; return u > -half - BODY_D / 2 && u < half + BODY_D / 2 + on && Math.abs(rx * o.hz - rz * o.hx) < o.w; };
      if (inBox(wk.x, wk.z)) continue;   // (in it already: out the way they're going)
      for (const d of [0.03, 0.07, 0.11]) if (inBox(wk.x + hx * d, wk.z + hz * d)) { best = Math.min(best, d - 0.03); break; }
    }
    return best;
  }

  // The vehicles on the ground near (x, z) (transit.bodies, filed by tile
  // once a frame).
  _vehiclesNear(x, z) {
    const T = this.game.transit, bodies = T && T.bodies;
    if (!bodies) return [];
    if (this._vmapOf !== bodies) {
      this._vmapOf = bodies;
      const m = this._vmap = new Map();
      for (const o of bodies) {
        if (o.air) continue;
        for (let tz = Math.floor(o.z - 0.45); tz <= Math.floor(o.z + 0.45); tz++) for (let tx = Math.floor(o.x - 0.45); tx <= Math.floor(o.x + 0.45); tx++) {
          const k = tx * 65536 + tz;
          let l = m.get(k);
          if (!l) m.set(k, l = []);
          l.push(o);
        }
      }
    }
    return this._vmap.get(Math.floor(x) * 65536 + Math.floor(z)) || [];
  }

  // A free seat on one of a gondola station's benches (stop.seats), or null;
  // near: at an interchange, one by this berth ([x, z]) of its deck.
  _freeSeat(stop, near = null) {
    const free = (stop.seats || []).filter(s => { const o = this._seated.get(s); return (!o || !this.walkers.has(o) || o.seatOf !== s) && (!near || Math.hypot(s.x - near[0], s.z - near[1]) < 0.6); });
    return free.length ? free[(Math.random() * free.length) | 0] : null;
  }

  // Up off a bench (boarding, or gone).
  _unseat(wk) {
    if (wk.seatOf && this._seated.get(wk.seatOf) === wk) this._seated.delete(wk.seatOf);
    wk.seatOf = null;
    wk.sit = false;
  }

  // A walker on its way in to a building whose door has moved since it set
  // off (the building redrawn: a new neighbour, a street laid by it): the
  // way in to the door as it is now, in place of the old one.
  _redoor(wk) {
    const B = this.world.buildings.get(wk.dest);
    if (!B || B.door === wk.doorRef) return;
    wk.doorRef = B.door || null;
    const into = B.door ? this._doorway(B, wk.r, true) : null;
    if (!into) return;
    const keep = wk.pts.length - wk.doorIn;
    wk.pts = wk.pts.slice(0, keep).concat(into);
    if (wk.ys) wk.ys = wk.ys.slice(0, keep).concat(into.map(() => null));
    wk.doorIn = into.length;
    wk.floorIn = B.door.y + STEP_UP;
    wk.stairsIn = this._stairsOf(B);
  }

  // The way about B's open plot round what stands on it (plotNav), from its
  // model as drawn: null headless, on a building site, or with no model.
  _gridOf(B) {
    const it = B && !B.con && this.game.view && this.game.view.items && this.game.view.items.get(B.id);
    const mesh = it && it.mesh;
    if (!mesh || !mesh.geometry) return null;
    let g = this._grids.get(mesh);
    if (g === undefined) {
      g = plotGrid(B, mesh, plotRect(B));
      // (a place whose way in reaches under half of it, its stalls packed wall
      // to wall, say: its visitors keep to the ground they can reach, spread
      // over it, rather than all stand where they came in)
      if (g) { const d = doorPoint(B), r = reachFrom(g, d.x, d.z); if (r.share < 0.5) g.reach = r.pts; }
      this._grids.set(mesh, g);
    }
    return g;
  }

  // The steps up to B's door as its model has them (plotNav stepsGrid): null
  // headless, or with no door or model.
  _stairsOf(B) {
    const it = B && B.door && this.game.view && this.game.view.items && this.game.view.items.get(B.id);
    const mesh = it && it.mesh;
    if (!mesh || !mesh.geometry || !mesh.geometry.attributes || !mesh.geometry.attributes.position) return null;
    let s = this._stairs.get(mesh);
    if (s === undefined) {
      // only the strip from the door out to the street, and nothing more
      // than a step or two above the threshold (a portico's steps, not the
      // head of the door or a porch's roof)
      const d = B.door, L = Math.max(B.w, B.d) + 0.2, ex = d.x + d.dx * L, ez = d.z + d.dz * L;
      s = stepsGrid(B, mesh, Math.min(d.x, ex) - 0.3, Math.min(d.z, ez) - 0.3, Math.max(d.x, ex) + 0.3, Math.max(d.z, ez) + 0.3, Math.max(d.y, B.baseY) + 0.1);
      this._stairs.set(mesh, s);
    }
    return s;
  }

  _arrive(r, destId) {
    const w = this.world;
    const B = w.buildings.get(destId);
    if (!B) { if (r.walk) this._drop(r.walk); r.loc = 'in'; r.at = r.home; return; }
    const def = BUILDINGS[B.type];
    // a visitor who finds the place full turns round (and doesn't pay)
    if (this._visiting(r, B) && Number.isFinite(visitorCap(B)) && (this._occupancy().get(B.id) || 0) > visitorCap(B) && r.walk) {
      this._occ = null;
      r.at = destId;
      // (from a step inside, so out of the door again as anyone comes out)
      r.loc = 'in';
      const was = r.walk, next = this._roomFor(r, null, B);
      this.go(r, next ?? r.home);
      if (r.walk === was) { if (r.walk) this._drop(r.walk); r.at = r.home; }
      return;
    }
    if (def.shop || (def.leisure && !def.park) || (def.park && visitOf(B) && this._visiting(r, B))) {
      const v = this.game.sim.recordVisit(B);
      if (v && r.age !== 'child') r.wealth = Math.round(((r.wealth ?? 60) - v) * 10) / 10;
      if (v) this.game.emit('coins', { x: doorPoint(B).x, y: B.baseY + 0.4, z: doorPoint(B).z, v });
    }
    r.at = destId;
    const site = !!(B.con && r.site === B.id);
    const outdoor = def.outdoor || B.open || (def.outdoorWork && r.job === B.id) || site;
    if (outdoor && r.walk) {
      const wk = r.walk;
      wk.mode = 'wander';
      wk.area = site ? siteArea(B) : B.work || workArea(B) || [-B.w / 2 + 0.15, -B.d / 2 + 0.15, B.w / 2 - 0.15, B.d / 2 - 0.15, ownPlot(B)];
      // a park's visitors stroll between its walks and seats (B.spots, from
      // the model) rather than anywhere on the plot (so not into the pond)
      wk.ring = site;
      wk.baseY = B.baseY + 0.012;
      // the old dig their allotment
      wk.working = (def.outdoorWork && r.job === B.id) || site || (def.potter && r.age === 'elder');
      wk.tool = site ? 'hammer' : B.type === 'orchard' ? 'pick' : 'hoe';
      if (wk.working) wk.carry = null;
      wk.spots = !site && !wk.working && B.spots && B.spots.length ? B.spots : null;
      wk.idle = 0.3;
      wk.target = null;
      wk.route = null;
      wk.floorIn = wk.floorOut = null;
      wk.stairsIn = wk.stairsOut = null;
      wk.plotOut = 0;
      r.loc = 'out';
    } else {
      if (r.walk) this._drop(r.walk);
      r.loc = 'in';
    }
  }

  // ------------------------------------------------------------ crowding
  // Is this villager a visitor there (not living, working, studying or building)?
  _visiting(r, B) { return B.id !== r.home && B.id !== r.job && B.id !== r.school && B.id !== r.site; }

  // Visitors at each place: out in a park, inside a shop, pub, chapel or
  // clinic, or already on their way there.
  _occupancy() {
    if (this._occ) return this._occ;
    const occ = this._occ = new Map();
    const add = (id) => occ.set(id, (occ.get(id) || 0) + 1);
    for (const wk of this.walkers) {
      const r = wk.r;
      if (!r || wk.ghost || wk.working) continue;
      const id = wk.mode === 'wander' ? r.at : wk.mode === 'path' ? wk.dest : null;
      if (id != null && id !== r.home && id !== r.job && id !== r.school) add(id);
    }
    for (const r of this.world.residents.values()) {
      if (r.loc === 'in' && r.at != null && r.at !== r.home && r.at !== r.job && r.at !== r.school) add(r.at);
    }
    return occ;
  }

  visitorsAt(b) { return { now: this._occupancy().get(b.id) || 0, cap: visitorCap(b) }; }

  // Where a villager actually goes: a place that's full sends them to the
  // nearest of the same kind with room, or keeps them at home. (With id null,
  // just look for somewhere else like `full`.)
  _roomFor(r, id, full = null) {
    const w = this.world, B = full || w.buildings.get(id);
    if (!B || !this._visiting(r, B) || visitorCap(B) === Infinity) return id;
    const occ = this._occupancy();
    if (!full && (occ.get(id) || 0) < visitorCap(B)) { occ.set(id, (occ.get(id) || 0) + 1); return id; }
    const kind = visitKind(BUILDINGS[B.type]);
    const from = w.buildings.get(r.at) || w.buildings.get(r.home) || B;
    let best = null, bd = 14;
    for (const o of w.buildings.values()) {
      if (o === B || visitKind(BUILDINGS[o.type]) !== kind || !o.access || !o.connected || !isOpen(o)) continue;
      if ((occ.get(o.id) || 0) >= visitorCap(o)) continue;
      const d = Math.abs(o.x - from.x) + Math.abs(o.z - from.z);
      if (d < bd) { bd = d; best = o; }
    }
    if (best) { occ.set(best.id, (occ.get(best.id) || 0) + 1); return best.id; }
    return r.at === r.home ? null : r.home;
  }

  // Called by transit when a passenger alights; at a gondola station (at:
  // where the cabin stands) out of the cabin, across the deck and down the
  // stairs or the lift to the street. Returns how long stepping out of the
  // cabin takes (it waits for that).
  alight(r, stop, destId, at = null) {
    const w = this.world;
    const B = w.buildings.get(destId), rode = r.walk;
    if (rode) this._drop(rode);
    r.at = stop.id;
    r.loc = 'in';
    if (!B || !stop.access || !B.access) { r.at = r.home; return 0; }
    const route = this.game.paths.road(stop.access, B.access);
    if (!route) { r.at = r.home; return 0; }
    const wk = this._walk(r, stop, B, route, null, () => this._arrive(r, B.id));
    // (from their seat in the cabin; or, not quite in it yet when it set
    // off, from the cabin where it stands now)
    const from = rode && rode.mode === 'ride' ? [rode.x, rode.z] : at ? seatAt(at, 0) : null;
    if (!stop.stair || !stop.deck || !from) return 0;
    const down = stop.stair.slice().reverse();
    wk.pts.unshift(from, ...down.map(p => [p.x, p.z]));
    wk.ys = [stop.deck.y, ...down.map(p => p.y)];
    while (wk.ys.length < wk.pts.length) wk.ys.push(null);
    wk.x = from[0]; wk.z = from[1]; wk.y = stop.deck.y;
    return 0.12 / (CONFIG.WALK_SPEED * wk.speedK);
  }

  // Passenger waiting at a stop for line (visible, standing around). At a
  // gondola station (whose model gives its way up, stop.stair, and its
  // deck), up the stairs or the lift first (not if onDeck, changing lines
  // there), to wait on the deck clear of the cabins' way through
  // (transit.deckSpots), at an interchange by the berth where line calls;
  // they board only once up there (onDeck).
  waitAt(r, stop, line = null, onDeck = false) {
    if (stop.stair && stop.deck && r.walk) {
      // a seat on one of its benches if there's one free (taken from the
      // front), or somewhere to stand, facing the middle (or the berth)
      // where the cabins come in
      const at = line && this.game.transit.berthPoint ? this.game.transit.berthPoint(stop, line) : null;
      const wk = r.walk, d = stop.deck, seat = this._freeSeat(stop, at), [fx, fz] = at || [d.x, d.z];
      let end;
      if (seat) {
        this._seated.set(seat, wk);
        wk.seatOf = seat;
        end = [[seat.x + Math.sin(seat.h) * 0.06, seat.z + Math.cos(seat.h) * 0.06], [seat.x, seat.z]];
      } else {
        const spots = this.game.transit.deckSpots(stop, line);
        end = [spots && spots.length ? spots[(Math.random() * spots.length) | 0] : [d.x, d.z]];
      }
      Object.assign(wk, {
        pts: [[wk.x, wk.z], ...(onDeck ? [] : stop.stair.map(p => [p.x, p.z])), ...end], ys: [onDeck ? d.y : null, ...(onDeck ? [] : stop.stair.map(p => p.y)), ...end.map(() => d.y)],
        seg: 0, t: 0, mode: 'path', delay: 0, doorIn: 0, doorOut: 0, floorIn: null, floorOut: null, stairsIn: null, stairsOut: null, plotOut: 0, standY: null, sit: false,
        onArrive: () => {
          wk.mode = 'wait';
          if (seat && wk.seatOf === seat) { wk.sit = true; wk.standY = wk.y = seat.y; wk.heading = seat.h; }
          else { wk.standY = wk.y = d.y; wk.heading = Math.atan2(fx - wk.x, fz - wk.z); }
        },
      });
      r.loc = 'wait';
      return;
    }
    const p = doorPoint(stop);
    const cx = stop.x, cz = stop.z;
    const wk = r.walk || this._makeWalker(r.lk, [[p.x, p.z]], null);
    wk.r = r;
    r.walk = wk;
    // a seat on the stop's bench if there's one free (taken from the front),
    // or standing about by the stop, looking out for the coach
    const seat = this._freeSeat(stop);
    if (seat) {
      this._seated.set(seat, wk);
      wk.seatOf = seat;
      Object.assign(wk, {
        pts: [[wk.x, wk.z], [seat.x + Math.sin(seat.h) * 0.06, seat.z + Math.cos(seat.h) * 0.06], [seat.x, seat.z]], ys: null,
        seg: 0, t: 0, mode: 'path', delay: 0, doorIn: 0, doorOut: 0, floorIn: null, floorOut: null, stairsIn: null, stairsOut: null, plotOut: 0, standY: null, sit: false,
        onArrive: () => { wk.mode = 'wait'; if (wk.seatOf === seat) { wk.sit = true; wk.standY = wk.y = seat.y; wk.heading = seat.h; } },
      });
      r.loc = 'wait';
      return;
    }
    wk.mode = 'wait';
    wk.standY = null;
    wk.x = p.x + (cx - p.x) * 0.25 + (Math.random() - 0.5) * 0.35;
    wk.z = p.z + (cz - p.z) * 0.25 + (Math.random() - 0.5) * 0.35;
    wk.heading = Math.atan2(p.x - cx, p.z - cz);
    r.loc = 'wait';
  }

  // A passenger changing lines at stop: out of the cabin (at: where it
  // stands, at a gondola station) and across the deck to wait for line, or
  // off the coach to wait by the stop. Returns how long stepping out takes.
  changeAt(r, stop, at, line) {
    const rode = r.walk, from = rode && rode.mode === 'ride' ? [rode.x, rode.z] : at ? seatAt(at, 0) : null;
    if (rode) this._drop(rode);
    r.at = stop.id;
    if (!stop.deck || !stop.stair || !from) { this.waitAt(r, stop, line); return 0; }
    const wk = this._makeWalker(r.lk, [from], null);
    wk.r = r; r.walk = wk; wk.y = wk.standY = stop.deck.y;
    this.waitAt(r, stop, line, true);
    return 0.12 / (CONFIG.WALK_SPEED * wk.speedK);
  }

  // Is a waiting passenger ready to board (up on the deck, at a gondola station)?
  onDeck(r) { return !r.walk || r.walk.mode === 'wait'; }

  // Called by transit as a passenger boards: they're gone from sight; or on
  // a gondola station's deck (at: where the cabin stands, its heading, the
  // cabin v and the passenger's seat in it), across to the cabin and in, to
  // ride in it, seen through its glass. Returns how long
  // the walk across takes (the cabin waits for it).
  board(r, at = null) {
    const wk = r.walk;
    r.loc = 'ride';
    if (!wk || !at || wk.mode !== 'wait' || wk.standY == null) { if (wk) this._drop(wk); return 0; }
    const p = seatAt(at, at.seat), y = wk.sit ? wk.standY - G_DECK_SEAT : wk.standY;   // (up off a bench to the deck)
    this._unseat(wk);
    Object.assign(wk, {
      pts: [[wk.x, wk.z], p], ys: [y, y], seg: 0, t: 0, mode: 'path', doorIn: 0, doorOut: 0, floorIn: null, floorOut: null, boarding: true,
      onArrive: () => { wk.mode = 'ride'; wk.boarding = false; wk.cabin = at.v; wk.seat = at.seat; },
    });
    return Math.hypot(p[0] - wk.x, p[1] - wk.z) / (CONFIG.WALK_SPEED * wk.speedK) + 0.25;
  }

  // New villagers walk in from the road at the map edge.
  arrive(family, home) {
    const w = this.world;
    const e = w.entry;
    for (const r of family) {
      this._initResident(r);
      const route = home.access ? this.game.paths.road({ node: e.node }, home.access) : null;
      if (!route) continue;
      const startEdge = { x: e.x, z: e.z };
      const pts = routeLine(w.roads, route, r.lk.lane, null, doorPoint(home));
      const into = this._doorway(home, r, true);
      if (into) { pts.pop(); pts.push(...into); }
      const delay = Math.random() * 1.5;
      for (let k = 0; k < 2; k++) pts.unshift([startEdge.x, startEdge.z]);
      const wk = this._makeWalker(r.lk, pts, () => { r.loc = 'in'; r.at = home.id; this._drop(wk); this.planDay(r, w.hours); });
      if (into) { wk.doorIn = into.length; wk.floorIn = home.door.y + STEP_UP; wk.stairsIn = this._stairsOf(home); }
      wk.delay = delay;
      wk.r = r;
      r.walk = wk;
      r.loc = 'walk';
      r.at = null;
    }
  }

  // Residents leaving town walk to the map edge and vanish.
  depart(ids, fromBuilding = null) {
    const w = this.world, e = w.entry;
    for (const id of ids) {
      const r = w.residents.get(id);
      if (!r) continue;
      w.residents.delete(id);
      w.stats.departures++;
      if (r.walk) this._drop(r.walk);
      if (this.selected === r) this.select(null);
      this.game.transit.forget(r);
      const from = fromBuilding || w.buildings.get(r.home);
      if (!from || !from.access) continue;
      const route = this.game.paths.road(from.access, { node: e.node });
      if (!route) continue;
      const pts = routeLine(w.roads, route, r.lk.lane, doorPoint(from), null);
      const out = this._doorway(from, r, false);
      if (out) { pts.shift(); pts.unshift(...out); }
      const wk = this._makeWalker(r.lk, pts, () => this._drop(wk));
      if (out) { wk.doorOut = out.length; wk.floorOut = from.door.y + STEP_UP; wk.stairsOut = this._stairsOf(from); }
      wk.ghost = true;
    }
    this.game.sim.dirty = true;
  }

  // A villager changed age group: refresh their size and colours.
  refreshLook(r) {
    r.lk = lookOf(r, dressOf(this.world, r));
    if (r.walk) { r.walk.lk = r.lk; r.walk.speedK = r.lk.speed; }
  }

  // A villager is gone for good (passed away).
  remove(r) {
    if (r.walk) this._drop(r.walk);
    this.game.transit.forget(r);
    if (this.selected === r) this.select(null);
  }

  relocate(r) {
    if (r.walk) this._drop(r.walk);
    this.game.transit.forget(r);
    r.loc = 'in';
    r.at = r.home;
  }

  // ---------------------------------------------------------------- update
  update(dt, gameDt) {
    const w = this.world;
    this._lists = null;
    if (this.plannedDay !== w.day) {
      if (this.plannedDay === -1) { for (const r of w.residents.values()) { if (!r.lk) this._initResident(r); this.planDay(r, w.hours); } this.plannedDay = w.day; }
      else this.newDay();
    }
    const hours = w.hours;
    this._occ = null;
    if (gameDt > 0) {
      for (const r of w.residents.values()) {
        if (!r.lk) this._initResident(r);
        if (r.loc === 'walk' || r.loc === 'wait' || r.loc === 'ride') continue;
        if (r.pi < r.plan.length && hours >= r.plan[r.pi].t) {
          const p = r.plan[r.pi++];
          const dest = this._roomFor(r, p.dest);
          if (dest != null) this.go(r, dest);
        }
      }
    }
    const speed = this.game.speed;
    const move = dt * speed * CONFIG.WALK_SPEED;
    const night = this.game.env.night;
    this.lanterns.length = 0;
    if (--this._liftScan <= 0) { this._liftScan = 30; this._syncLifts(); }
    this._runLifts(dt * speed);
    for (const wk of [...this.walkers]) {
      if (wk.delay > 0) { wk.delay -= dt * speed; continue; }
      wk.lamp = false;
      if (wk.mode === 'path') {
        // in a lift's car (see _runLifts), at their spot in it, facing the
        // way out, carried up or down
        const L = wk.lift && wk.liftPts === wk.pts ? wk.lift : null;
        if (L && liftSeg(wk, wk.seg)) {
          if (!L.riders.includes(wk)) { L.coming.delete(wk); L.riders.push(wk); }
          const [x, z] = wk.pts[wk.seg], out = wk.pts[wk.seg + 2];
          wk.x = x; wk.z = z;
          if (out) wk.heading += angDiff(Math.atan2(out[0] - x, out[1] - z), wk.heading) * Math.min(1, dt * 12);
          wk.y = walkY(w, wk);
          wk.narrow = true; wk.moving = false;
          continue;
        }
        // nearly at the door, and the building has been redrawn since (its
        // door moved): on to where its door is now
        if (wk.doorRef && wk.seg >= wk.pts.length - wk.doorIn - 3 && wk.seg < wk.pts.length - wk.doorIn - 1) this._redoor(wk);
        const atDoor = (wk.doorOut && wk.seg < wk.doorOut - 1) || (wk.doorIn && wk.seg >= wk.pts.length - wk.doorIn - 1);
        // where there's no room to step aside (a doorway, stairs, a deck, the
        // way off a plot) they keep to their line and take their turn
        wk.narrow = atDoor || !!(wk.ys && (wk.ys[wk.seg] != null || wk.ys[wk.seg + 1] != null)) || (wk.plotOut && wk.seg < wk.plotOut);
        let rem = move * wk.speedK * (atDoor ? 0.45 : 1);
        // no nearer than a body's width to whoever is ahead going the same
        // way (or, somewhere narrow, anyone ahead), not for ever, though; and
        // not into a vehicle's way, for as long as it takes
        const limit = inside(wk) ? Infinity : wk.narrow ? HOLD_NARROW : HOLD, people = wk.hold < limit;
        // (nobody sees those out of view; one getting into a cabin goes
        // straight in, as it waits only so long, and one into a lift's car)
        const gap = wk.inView === false || wk.boarding || L ? Infinity : this._ahead(wk, people);
        if (gap < rem) { rem = Math.max(0, gap); if (rem === 0) wk.hold += dt * speed; }
        else if (people) wk.hold = 0;
        else if ((wk.hold += dt * speed) > limit + 1) wk.hold = 0;
        const want = rem;
        let held = false;
        while (rem > 0 && wk.seg < wk.pts.length - 1) {
          // (at a lift's door, in only once its car stands open for them: see
          // _liftIn; and in its car, they ride)
          if (wk.t === 0 && liftSeg(wk, wk.seg + 1) && !this._liftIn(wk)) { held = true; wk.liftWait += dt * speed; break; }
          if (wk.lift && wk.liftPts === wk.pts && liftSeg(wk, wk.seg)) break;
          const a = wk.pts[wk.seg], b = wk.pts[wk.seg + 1];
          const dy = wk.ys && wk.ys[wk.seg] != null && wk.ys[wk.seg + 1] != null ? wk.ys[wk.seg + 1] - wk.ys[wk.seg] : 0;
          const L = Math.hypot(b[0] - a[0], b[1] - a[1], dy);
          // (on the ground, slower uphill: see climbCost)
          const k = dy || L < 1e-6 ? 1 : climbCost((w.walkHeight(b[0], b[1]) - w.walkHeight(a[0], a[1])) / L);
          const left = L * (1 - wk.t) * k;
          if (rem >= left) { rem -= left; wk.seg++; wk.t = 0; }
          else { wk.t += rem / k / Math.max(L, 1e-6); rem = 0; }
        }
        if (wk.seg >= wk.pts.length - 1) {
          const end = wk.pts[wk.pts.length - 1];
          wk.x = end[0]; wk.z = end[1];
          if (wk.onArrive) { const f = wk.onArrive; wk.onArrive = null; f(); }
          else this._drop(wk);
          continue;
        }
        const a = wk.pts[wk.seg], b = wk.pts[wk.seg + 1];
        wk.x = a[0] + (b[0] - a[0]) * wk.t;
        wk.z = a[1] + (b[1] - a[1]) * wk.t;
        // a step to one side to pass someone or let a coach by (wk.side, to
        // their right), eased back to their lane; none where it's narrow
        wk.side *= Math.max(0, 1 - dt * speed * (wk.narrow ? 6 : 0.25));
        if (wk.side) {
          const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          wk.x += (-(b[1] - a[1]) / L) * wk.side;
          wk.z += ((b[0] - a[0]) / L) * wk.side;
        }
        if (Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]) > 1e-4) wk.heading += angDiff(Math.atan2(b[0] - a[0], b[1] - a[1]), wk.heading) * Math.min(1, dt * 12);
        wk.y = walkY(w, wk);
        wk.phase += (want - rem) / strideLen(wk.lk.scale);
        wk.moving = speed > 0 && !held;
      } else if (wk.mode === 'wander') {
        wk.y = wk.baseY;
        if (wk.idle > 0) { wk.idle -= dt * speed; wk.moving = false; if (wk.working && speed) wk.phase += dt * speed * 4; continue; }
        if (!wk.target && wk.route && wk.route.length) wk.target = wk.route.shift();
        if (!wk.target) {
          const A = wk.area, [x0, z0, x1, z1] = A;
          const somewhere = () => {
            if (wk.ring) {
              // builders work their way round the scaffolding
              const wx = x1 - x0, wz = z1 - z0, t = Math.random() * 2 * (wx + wz);
              return inArea(A, ...(t < wx ? [x0 + t, z0] : t < wx + wz ? [x1, z0 + t - wx] : t < 2 * wx + wz ? [x1 - (t - wx - wz), z1] : [x0, z1 - (t - 2 * wx - wz)]));
            }
            if (wk.spots) {
              const p = wk.spots[(Math.random() * wk.spots.length) | 0];
              return [p[0] + (Math.random() - 0.5) * 0.08, p[1] + (Math.random() - 0.5) * 0.08];
            }
            const gr = !wk.working && this._gridOf(wk.r && w.buildings.get(wk.r.at));
            if (gr && gr.reach && gr.reach.length) return gr.reach[(Math.random() * gr.reach.length) | 0];
            return inArea(A, x0 + Math.random() * (x1 - x0), z0 + Math.random() * (z1 - z0));
          };
          // (not where someone stands already, if there's anywhere else)
          const taken = (p) => this.near(p[0], p[1], BODY_D).some(o => o !== wk && Math.hypot(o.x - p[0], o.z - p[1]) < BODY_D);
          const pick = () => { let p = somewhere(); for (let k = 0; k < 3 && taken(p); k++) p = somewhere(); return p; };
          wk.target = pick();
          // the way there round the buildings, sheds and stalls on the plot;
          // somewhere else if there's no way to it (shut in by railings, say)
          const g = wk.ring ? null : this._gridOf(wk.r && w.buildings.get(wk.r.at));
          let way = g ? plotPath(g, wk.x, wk.z, wk.target[0], wk.target[1]) : null;
          for (let k = 0; g && !way && k < 3; k++) { wk.target = pick(); way = plotPath(g, wk.x, wk.z, wk.target[0], wk.target[1]); }
          if (way && way.length) { wk.target = way.shift(); wk.route = way; }
          else if (g) { wk.target = null; wk.idle = 1 + Math.random() * 2; wk.moving = false; continue; }
        }
        const dx = wk.target[0] - wk.x, dz = wk.target[1] - wk.z;
        const d = Math.hypot(dx, dz);
        const step = move * (wk.lk.scale < 0.8 ? 0.9 : 0.45);
        if (d <= step) {
          wk.x = wk.target[0]; wk.z = wk.target[1]; wk.target = null;
          // (a corner on the way: straight on round it)
          if (!(wk.route && wk.route.length)) wk.idle = wk.working ? 1.5 + Math.random() * 3 : 1 + Math.random() * 5;
        } else {
          wk.x += (dx / d) * step; wk.z += (dz / d) * step;
          wk.heading += angDiff(Math.atan2(dx, dz), wk.heading) * Math.min(1, dt * 10);
          wk.phase += step / strideLen(wk.lk.scale);
        }
        wk.moving = speed > 0;
      } else if (wk.mode === 'wait') {
        wk.y = wk.standY ?? w.walkHeight(wk.x, wk.z);
        wk.moving = false;
      } else if (wk.mode === 'ride') {
        // in a gondola cabin, standing on its floor, looking out ahead
        const m = wk.cabin && wk.cabin.meshes && wk.cabin.meshes[0];
        if (m) {
          const p = seatAt({ x: m.position.x, z: m.position.z, heading: m.rotation.y }, wk.seat);
          wk.x = p[0]; wk.z = p[1]; wk.y = this.game.transit.cabinFloor(wk.cabin); wk.heading = m.rotation.y;
        }
        wk.moving = false;
      }
      wk.lamp = night > 0.55 && wk.mode === 'path' && !wk.ghost && wk.lk.scale > 0.8 && ((wk.r?.look ?? 1) & 3) === 0;
      if (wk.lamp) this.lanterns.push(wk);
    }
    this._clock = (this._clock || 0) + dt * speed;
    this._spread(dt * speed);
    this._render(dt);
  }

  // The walkers to draw this frame: those in view, with a tile to spare for
  // their shadows (off-screen villagers cost time and look no different),
  // and of those, as the Performance settings ask (settings.villagers), only
  // some where crowds gather ('crowds', the default), all, about half, or
  // only those near the middle of the view. The selected villager always
  // shows. Sets wk.shown, which their lanterns follow (and wk.inView, in
  // view at all: only those keep out of each other's way, see _ahead).
  _drawList() {
    const out = this._shown || (this._shown = []);
    out.length = 0;
    const g = this.game, cam = g.renderer && g.renderer.camera, mode = (g.settings && g.settings.villagers) || 'crowds';
    if (cam) _fr.setFromProjectionMatrix(_pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const c = cam && g.renderer.rig.target, sel = this.selected;
    const crowd = mode === 'crowds' ? this._crowds() : null;
    for (const wk of this.walkers) {
      let show = wk.inView = !cam || _fr.intersectsSphere(_sp.set(_v.set(wk.x, wk.y, wk.z), 1));
      if (show && mode !== 'all' && !(sel && wk.r === sel)) {
        // the same half of the town every frame (the lane is each villager's own)
        if (mode === 'some') show = (wk.lk.lane * 997) % 1 < 0.5;
        else if (crowd) show = luck(wk) < crowd.shareAt(wk.x, wk.z);
        else if (c) show = Math.hypot(wk.x - c.x, wk.z - c.z) < 12;
      }
      wk.shown = show;
      if (show) out.push(wk);
    }
    return out;
  }

  // How crowded each patch of the town is: in each square of CROWD_CELL
  // tiles, the share of the villagers out there to draw so that about
  // CROWD_MAX show (all of them where there are fewer). It eases towards
  // that a little each frame, so as a crowd gathers or thins villagers fade
  // from view or back one at a time rather than all at once; it blends
  // from one patch to the next (shareAt), so nobody blinks in or out at the
  // edge of one; and as each one's luck is their own, the same ones stay in
  // sight as they walk on.
  _crowds() {
    const C = CONFIG.CROWD_CELL, n = Math.ceil(this.world.N / C);
    let cr = this._crowd;
    if (!cr || cr.n !== n) {
      cr = this._crowd = { n, count: new Uint16Array(n * n), share: new Float32Array(n * n).fill(1) };
      const cl = (v) => Math.min(n - 1, Math.max(0, v));
      cr.at = (wk) => cl(Math.floor(wk.z / C)) * n + cl(Math.floor(wk.x / C));
      cr.shareAt = (x, z) => {
        const fx = x / C - 0.5, fz = z / C - 0.5, i = Math.floor(fx), k = Math.floor(fz), u = fx - i, v = fz - k;
        const S = cr.share, i0 = cl(i), i1 = cl(i + 1), k0 = cl(k) * n, k1 = cl(k + 1) * n;
        return (S[k0 + i0] * (1 - u) + S[k0 + i1] * u) * (1 - v) + (S[k1 + i0] * (1 - u) + S[k1 + i1] * u) * v;
      };
    }
    cr.count.fill(0);
    for (const wk of this.walkers) cr.count[cr.at(wk)]++;
    for (let i = 0; i < cr.share.length; i++) {
      const want = Math.min(1, CONFIG.CROWD_MAX / Math.max(1, cr.count[i]));
      cr.share[i] += (want - cr.share[i]) * 0.05;
    }
    return cr;
  }

  _render(dt) {
    this.view.draw(this._drawList(), this.game.env, this.game.renderer.camera);
    // selection ring
    const sel = this.selected;
    if (sel && sel.walk && this.walkers.has(sel.walk)) {
      this.ring.visible = true;
      this.ring.position.set(sel.walk.x, sel.walk.y + 0.01, sel.walk.z);
      this.ring.scale.setScalar(1 + Math.sin(performance.now() * 0.006) * 0.1);
    } else this.ring.visible = false;
  }

  // ------------------------------------------------------------- picking
  pick(clientX, clientY) {
    let best = null, bd = 16;
    for (const wk of this.walkers) {
      if (!wk.r || wk.ghost || wk.delay > 0) continue;
      _v.set(wk.x, wk.y + 0.08 * wk.lk.scale, wk.z);
      const p = this.game.renderer.worldToScreen(_v);
      if (p.behind) continue;
      const d = Math.hypot(p.x - clientX, p.y - clientY);
      if (d < bd) { bd = d; best = wk.r; }
    }
    return best;
  }

  select(r) {
    this.selected = r;
  }

  positionOf(r) {
    if (r.walk && this.walkers.has(r.walk)) return { x: r.walk.x, y: r.walk.y, z: r.walk.z };
    if (r.loc === 'ride') { const v = this.game.transit.vehicleOf(r); if (v) return v; }
    const b = this.world.buildings.get(r.at ?? r.home);
    if (b) return { x: b.x, y: b.baseY, z: b.z };
    return null;
  }

  activity(r) {
    const w = this.world;
    const name = (id) => { const b = w.buildings.get(id); return b ? BUILDINGS[b.type].levels[b.level].name : 'somewhere'; };
    if (r.loc === 'ride') return `Riding the ${this.game.transit.lineNameOf(r) || 'coach'}`;
    if (r.loc === 'wait') return 'Waiting for transit';
    if (r.loc === 'walk') {
      const dest = r.plan[r.pi - 1]?.dest;
      if (r.at === null) return 'Moving to town';
      if (dest === r.home) return 'Walking home';
      if (dest === r.job) return 'Walking to work';
      return `Walking to the ${name(dest)}`;
    }
    const site = r.site != null ? w.buildings.get(r.site) : null;
    if (site && site.con) {
      const what = site.con.kind === 'dismantle' ? 'Taking down' : site.con.kind === 'demolish' ? 'Demolishing' : site.con.kind === 'upgrade' ? 'Upgrading' : 'Building';
      if (r.loc === 'walk') return 'Heading to a building site';
      if (r.loc === 'out' && r.at === site.id) return `${what} the ${name(site.id)}`;
    }
    if (r.loc === 'out') {
      if (r.at === r.job) return `Working at the ${name(r.at)}`;
      return r.age === 'child' ? `Playing at the ${name(r.at)}` : `Relaxing at the ${name(r.at)}`;
    }
    if (r.at === r.home) return w.hours > 21.5 || w.hours < 6 ? 'Sleeping at home' : 'At home';
    if (r.at === r.job) return `Working at the ${name(r.at)}`;
    const b = w.buildings.get(r.at);
    if (b && BUILDINGS[b.type].service === 'education') return 'At school';
    return `Visiting the ${name(r.at)}`;
  }
}

// A building's plot, with the verge of the street in front that it may
// come forward into (b.front), as [x0, z0, x1, z1].
function plotRect(B) {
  const R = plotOf(B), f = B.front || 0;
  if (!f) return R;
  const [cx, cz] = toWorld(R, 0, f / 2);
  return { ...R, cx, cz, hd: R.hd + f / 2 };
}

// Where builders walk on a building site: a ring just inside the plot edge
// (in the plot's own frame: see inArea).
export function siteArea(B) {
  const R = ownPlot(B);
  return [-R.hw + 0.1, -R.hd + 0.1, R.hw - 0.1, R.hd - 0.1, R];
}

// How long a walk along a route takes, its climbs counted (see climbCost),
// in units of an easy walk the length of a cottage's plot.
export function walkCost(w, route) {
  const S = routeSamples(w.roads, route, 1);
  let c = 0;
  for (let i = 1; i < S.length; i++) {
    const L = Math.hypot(S[i][0] - S[i - 1][0], S[i][1] - S[i - 1][1]);
    c += L * climbCost((w.walkHeight(S[i][0], S[i][1]) - w.walkHeight(S[i - 1][0], S[i - 1][1])) / (L || 1));
  }
  return c;
}

// The crowd (see Agents._spread): a villager is about BODY_D across; they're
// filed by CELL; a step aside goes up to SIDE_IN towards the middle of the
// road (no further: the coaches and carts go by there) or SIDE_OUT towards
// its edge.
const BODY_D = 0.064, CELL = 0.25, SIDE_IN = 0.02, SIDE_OUT = 0.03;
// how long one villager takes to clear a doorway (a body's width at the slow
// pace through a door), so the next one out waits that long
const DOOR_GAP = 1.1;

// How much longer a step takes on ground rising g for every unit along (as a
// multiple of a step on the flat): by Naismith's rule, each unit climbed as
// long as CONFIG.CLIMB along the flat; a steep way down a little slower too.
export const climbCost = (g) => 1 + CONFIG.CLIMB * Math.max(0, g) + 0.6 * Math.max(0, -g - 0.15);
// how long a villager waits at the kerb for a vehicle standing in a queue
// across their way before going round it (one on the move, as long as it takes)
const CAR_PATIENCE = 30;
// how long a villager waits behind someone before walking on regardless: on
// a street, and somewhere narrow (a doorway's queue keeps moving, if slowly)
const HOLD = 6, HOLD_NARROW = 25;
// A gondola station's lift (see _runLifts): how fast its car goes, in
// walking speeds; how long its doors stand open, in game seconds; and where
// those in it stand, in a row along it from its far end (from its middle,
// the way in from its street end), as many as it holds, a body's width and
// more apart
const LIFT_SPEED = 4, LIFT_DOORS = 1.2, LIFT_SLOTS = [0.135, 0.045, -0.045, -0.135];
// (how long one waits at a lift's door, in game seconds, before going up the
// shaft regardless: should it never come)
const LIFT_PATIENCE = 120;
// Is stretch i of a walker's way a ride in a lift (straight up or down, on
// the spot)?
const liftSeg = (wk, i) => !!wk.ys && i >= 0 && i + 1 < wk.pts.length && wk.ys[i] != null && wk.ys[i + 1] != null && Math.abs(wk.ys[i + 1] - wk.ys[i]) > 0.05 && Math.abs(wk.pts[i + 1][0] - wk.pts[i][0]) + Math.abs(wk.pts[i + 1][1] - wk.pts[i][1]) < 1e-4;
// A lift's car (across wide, LIFT.long along it): a floor, a slim post at
// each corner and halfway along each side, and a roof with two lights under
// it, lit all night (its glass is the shaft's); and the glass round its
// shaft, from its pit (y0) to the top of its frame (y1)
const LIFT_CAR = {};
function liftCarModel(across) {
  const gb = new GeoBuilder(), a = across / 2 - 0.008, l = LIFT.long / 2 - 0.008;
  gb.box(0, -0.014, 0, 2 * a, 0.014, 2 * l, '#5d6266');
  for (const sx of [-1, 1]) for (const sz of [-1, 0, 1]) gb.box(sx * (a - 0.004), 0, sz * (l - 0.004), 0.008, 0.17, 0.008, '#c4cacd');
  gb.box(0, 0.17, 0, 2 * a + 0.004, 0.014, 2 * l + 0.004, '#e3e5e4');
  gb.glow(1.7, 1.2, 0.55, 3.1);
  for (const sz of [-1, 1]) gb.box(0, 0.162, sz * l / 2, a, 0.008, l * 0.6, '#ffe9b8');
  gb.noGlow();
  return gb.build();
}
function liftGlass(y0, y1, across) {
  const gb = new GeoBuilder(), a = across / 2, l = LIFT.long / 2;
  for (const sd of [-1, 1]) {
    gb.box(0, y0, sd * l, 2 * a - 0.012, y1 - y0, 0.003, '#ffffff');
    gb.box(sd * a, y0, 0, 0.003, y1 - y0, 2 * l - 0.012, '#ffffff');
  }
  return gb.build();
}
const cellKey = (x, z) => Math.floor(x / CELL) * 65536 + Math.floor(z / CELL);
// Is a walker still inside a building's walls (the step between a door and
// the inside, in or out)?
const inside = (wk) => wk.mode === 'path' && ((wk.doorOut && wk.seg === 0) || (wk.doorIn && wk.seg >= wk.pts.length - 2));

// Where a rider stands in a gondola cabin at (at.x, at.z) heading at.heading:
// two across and three deep, seat 0 and 1 in the middle, then the front,
// then the back.
function seatAt(at, seat) {
  const sx = seat % 2 ? 0.037 : -0.037, sz = [0, 0.075, -0.075][Math.floor(seat / 2) % 3], h = at.heading || 0;
  return [at.x + sx * Math.cos(h) + sz * Math.sin(h), at.z - sx * Math.sin(h) + sz * Math.cos(h)];
}

// A villager's own luck, from 0 to 1, the same every frame (the departing,
// who are no longer residents, go by their lane).
function luck(wk) {
  const v = wk.r ? wk.r.id * 0.6180339887 : wk.lk.lane * 997;
  return v - Math.floor(v);
}

function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
