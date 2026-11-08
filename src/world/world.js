// World state and the rules for changing it (placing, upgrading, bulldozing).
// Rendering and simulation listen to the events emitted here.
//
// Kinstead without a grid: a building stands on a plot that is a rectangle
// anywhere, at any angle (b.x, b.z its middle, b.a the way its front faces,
// b.w × b.d its width along the street and its depth, in its own frame).
// Roads and railway track are networks of curves (net.js). Nothing is laid
// out on squares: rules ask what is near (an index of plots, road and track
// curves, farm fields and trees) and measure.

import { CONFIG, ROAD_LEVELS, BRIDGE_MULT, TREE_COST, CLEAR_COST, TERRAFORM_COST, ROAD_SALVAGE, dressRefund, streetPart, lookPart, DRESSINGS } from '../config.js';
import { BUILDINGS, unlockOf, RAIL_COST, workNeeded, TECHS, STYLE_TECH, MERGES, LARGE, ESTATE, GRAND, KINDS, REKIND, kindOf, techForLevel, growsInto, plotName, isSmallPark, BURY_COST, FARM_JOIN, PRODUCE, produceOf, hasFields, choosesProduce, CORNER_SHOPS, CIVIC_QUARTER, seatWorth, SEAT_RESTYLE } from '../defs.js';
const STYLE_TECH_OF = (look) => STYLE_TECH[look] || null;
import { generateTerrain } from './terrain.js';
import { rect, grow, toLocal, toWorld, inRect, aabbOf, rectsOverlap, rectSamples, segRectDist, segDist, segCross, Index, spline, simplify, tightest, cumulative, pointAt, polyLength, angleOf, wrapAngle, resample } from './geom.js';
import { Net, edgeHeights, heightOn, wetOn, MIN_EDGE } from './net.js';
import { newTownId } from '../util/text.js';
import { RNG, hash2, makeNoise2D, fbm } from '../util/rng.js';

// Half the width of each level of road (its roadway), and of railway track.
export const HALF = [0, 0.16, 0.215, 0.27];
export const RAIL_HALF = 0.13;
// How far a plot's front may stand back from the edge of the road it faces
// and still be reached from it, and how far back from the roadway any plot
// must keep (the verge and its kerb).
export const REACH = 0.45, VERGE = 0.06;
// How far a plot's front usually stands from the middle of its street: what
// the town's own builders (and the founders) go by, as when the town was
// laid out on squares.
export const SETBACK = 0.5;

// The plot of building b, as a rectangle (geom.js), garden strips bought
// or sold (b.ext, in its own frame: x0 its left, x1 its right, z0 its back,
// z1 its front) included.
export function plotOf(b) {
  const e = b.ext;
  if (!e || !(e.x0 || e.x1 || e.z0 || e.z1)) return rect(b.x, b.z, b.a, b.w / 2, b.d / 2);
  const [cx, cz] = toWorld(rect(b.x, b.z, b.a, 0, 0), (e.x1 - e.x0) / 2, (e.z1 - e.z0) / 2);
  return rect(cx, cz, b.a, b.w / 2 + (e.x0 + e.x1) / 2, b.d / 2 + (e.z0 + e.z1) / 2);
}
// The plot as it is without garden deals (the building's own land).
export const ownPlot = (b) => rect(b.x, b.z, b.a, b.w / 2, b.d / 2);
// A type's own plot, w along the street and d deep: a joined building's is
// a double plot, side by side.
export function sizeOf(type) {
  const def = BUILDINGS[type];
  return def.merged ? [2, 1] : [def.size, def.size];
}

// A farm's own field: the back half of its plot, behind the farmyard (an
// orchard's trees fill its whole plot, so it has none), as a rectangle, or
// null. Farmland is this and the farm's fields beyond the plot.
export function homeField(b) {
  const def = BUILDINGS[b.type];
  if (!def || !def.fields || def.fruit) return null;
  const P = ownPlot(b), [cx, cz] = toWorld(P, 0, -b.d / 4);
  return rect(cx, cz, b.a, b.w / 2, b.d / 4);
}
// A farm's farmland: its fields (parcels), and its own field behind the yard
// once the farm stands (not while it is going up or coming down), as
// rectangles.
export function farmlandOf(w, farm) {
  const land = (w.fieldsOf ? w.fieldsOf(farm.id) : []).map(f => f.rect);
  const h = homeField(farm);
  if (h && (!farm.con || farm.con.kind === 'upgrade')) land.push(h);
  return land;
}
// how far point (x, z) lies in front of building b's front edge (> 0: in front)
export function aheadOf(b, x, z) {
  return toLocal(ownPlot(b), x, z)[1] - b.d / 2;
}

// A building does its job unless it is a fresh building site or being taken
// down. Upgrades and merges carry on behind the scaffolding.
//   b.con = { kind: 'build' | 'upgrade' | 'merge' | 'dismantle', work, done, ... }
export const isOpen = (b) => !b.con || b.con.kind === 'upgrade' || b.con.kind === 'merge';

// A building that has grown onto a neighbouring plot (see World.expandOptions)
// holds half as many people / jobs again.
// restyling a building as it is upgraded costs this much of the upgrade on top
const RESTYLE = 0.3;
// tiles a type's own footprint covers: 1, 2 (joined, 2×1) or 4 (2×2)
const baseAreaOf = (type) => (BUILDINGS[type].merged ? 2 : BUILDINGS[type].size ** 2);
const baseArea = (b) => baseAreaOf(b.type);

export const isExpanded = (b) => b.w * b.d > baseArea(b);
// How high a building's floor sits on its plot (rectangle R, the ground under
// it running from minH to maxH). On a slope it stands on the highest ground
// under its walls (a little in from the plot's edges, where they stand), so
// no wall is buried in the hillside, and never below the ground at its front
// door (so the door stays at street level). Where the hill falls away, what
// is left showing is drawn as a stone lower floor (see footing in
// render/buildings.js). Buildings that must meet track or water exactly, and
// parks, keep to the top.
const WALL_IN = 0.05;
export function floorHeight(terrain, type, R, minH, maxH) {
  const def = BUILDINGS[type];
  if (!def || def.needsRail || def.needsWater || def.park || !(maxH > minH)) return maxH;
  const [fx, fz] = toWorld(R, 0, R.hd);
  const front = terrain.heightAt(fx, fz);
  let walls = -Infinity;
  for (const [x, z] of rectSamples(R, 0.5, WALL_IN)) walls = Math.max(walls, terrain.heightAt(x, z));
  return Math.min(maxH, Math.max(minH, front - 0.02, walls - 0.005));
}
// The lowest and highest ground under a rectangle, and whether any of it is
// water.
export function groundUnder(terrain, R, step = 0.25) {
  let minH = Infinity, maxH = -Infinity, water = false;
  for (const [x, z] of rectSamples(R, step)) {
    const h = terrain.heightAt(x, z);
    minH = Math.min(minH, h); maxH = Math.max(maxH, h);
    if (h < CONFIG.WATER_LEVEL + 0.05) water = true;
  }
  return { minH, maxH, water };
}
export function capOf(b, key) {
  const v = BUILDINGS[b.type].levels[b.level][key] || 0;
  const k = sizeK(b);
  const out = k > 1 ? Math.round(v * k) : v;
  // a farm's fields beyond its plot need hands too, as many as what it grows takes
  if (key === 'jobs' && v && hasFields(b.type)) return Math.round((out + (b.fields || 0) * CONFIG.FIELD_JOBS) * produceOf(b).jobs);
  return out;
}
// The most households a home takes (its level's `households`): a cottage,
// family house or villa is a home for one family, and the bigger houses and
// terraces for a few; flats and shophouses take any number.
export function householdCap(b) {
  const H = BUILDINGS[b.type].levels[b.level].households;
  if (!H) return Infinity;
  const k = sizeK(b);
  return Math.max(1, Math.floor(H * (k > 1 ? k : 1)));
}
// How much bigger than usual a building of this type is on a w × d plot. Its
// capacity, output, upkeep, value and upgrade prices all scale by this.
export function sizeKFor(type, w, d) {
  const def = BUILDINGS[type];
  return Math.max(1, 1 + 0.5 * ((w * d) / (def.merged ? 2 : def.size ** 2) - 1));
}
// A building whose plot has grown but which hasn't been built out across it
// yet (b.spare: the footprint it does cover) is still its old size.
export const sizeK = (b) => (b.spare ? sizeKFor(b.type, b.spare.w, b.spare.d) : sizeKFor(b.type, b.w, b.d));
// b.spare as saved or sent: [w, d, sx, sz] (or { w, d, sx, sz }), only if
// smaller than the plot. sx, sz: which end of the plot the building stands
// at, in its own frame (sx across it, sz from back to front: -1, 0 or 1);
// older saves have neither.
export function spareOf(s, w, d) {
  const [sw, sd, sx, sz] = Array.isArray(s) ? s : s && typeof s === 'object' ? [s.w, s.d, s.sx, s.sz] : [];
  if (!(Number.isInteger(sw) && Number.isInteger(sd) && sw >= 1 && sd >= 1 && sw <= w && sd <= d && sw * sd < w * d)) return undefined;
  const side = (v) => v === -1 || v === 0 || v === 1;
  return side(sx) && side(sz) ? { w: sw, d: sd, sx, sz } : { w: sw, d: sd };
}
// The part of a grown plot a building stands on while it covers only part
// of it (b.spare with its end known), as a rectangle, or null.
export function spareRect(b) {
  const s = b.spare;
  if (!s || s.sx == null) return null;
  const lx = s.sx * (b.w - s.w) / 2, lz = s.sz * (b.d - s.d) / 2;
  const [cx, cz] = toWorld(ownPlot(b), lx, lz);
  return rect(cx, cz, b.a, s.w / 2, s.d / 2);
}
// A building's floor (b.baseY) and the lowest ground under its plot
// (b.minY). On a grown plot it hasn't been built across yet, the floor is
// the one over the part it stands on, so taking land beside or behind it
// neither lifts nor sinks it.
export function setFloor(terrain, b) {
  const g = groundUnder(terrain, ownPlot(b));
  const r = spareRect(b);
  if (!r) { b.baseY = floorHeight(terrain, b.type, ownPlot(b), g.minH, g.maxH); b.minY = g.minH; return; }
  const h = groundUnder(terrain, r);
  b.baseY = floorHeight(terrain, b.type, r, h.minH, h.maxH); b.minY = g.minH;
}
// A level's figures for a building of that size: capacities, outputs, upkeep, price.
const SCALED = ['housing', 'jobs', 'seats', 'supply', 'kw', 'upkeep', 'cost'];
export function scaledLevel(L, k) {
  if (!(k > 1)) return L;
  const out = { ...L };
  for (const key of SCALED) if (L[key]) out[key] = Math.round(L[key] * k);
  return out;
}

// Neighbouring buildings that can be joined into one mixed-use building.
const MERGE_SHOPS = ['market', 'bakery', 'tavern'];
const MERGE_COST = [150, 300, 500];
// A park joined (or rebuilt on a double plot) from a little park with a
// feature of its own keeps it: b.flavor is the most telling of the two
// (not the recipe's own kind: every lake garden has its pond).
const PARK_FEATURE = ['bandstand', 'statue', 'rosegarden', 'pond', 'physic', 'flowers'];
const PARK_BASE = { park: null, lakepark: 'pond', botanic: 'physic' };
export function parkFeature(to, types) {
  if (!(to in PARK_BASE)) return null;
  return PARK_FEATURE.find(t => t !== PARK_BASE[to] && types.includes(t)) || null;
}
function mergeResult(a, o, has = () => true) {
  const one = (x) => BUILDINGS[x.type].size === 1 && !BUILDINGS[x.type].merged;
  if (!one(a) || !one(o)) return null;
  for (const m of MERGES) {
    let base = null, other = null;
    if (m.a.includes(a.type) && m.b.includes(o.type)) { base = a; other = o; }
    else if (m.a.includes(o.type) && m.b.includes(a.type)) { base = o; other = a; }
    if (!base) continue;
    // keep the house's look when a house is involved (unless the recipe's
    // first building leads: a villa taking in a cottage stays a villa)
    if (!m.lead && other.type === 'house' && base.type !== 'house') [base, other] = [other, base];
    const def = BUILDINGS[m.to];
    // the higher of the two levels, but never one the town can't build yet
    let level = Math.min(Math.max(a.level, o.level), def.levels.length - 1);
    while (level > 0 && !has(m.to, level)) level--;
    const flavor = m.to === 'shophouse' || m.to === 'inn' ? (base.type === 'house' || base.type === 'tavern' ? other.type : base.type) : parkFeature(m.to, [a.type, o.type]);
    const cost = Math.round(120 + def.levels[level].cost * 0.3);
    return { type: m.to, base, flavor, level, cost, name: def.levels[level].name };
  }
  return null;
}

// How far a building may come forward into the street in front of it (in
// tiles). Roads are narrower than their tiles, so this is verge, not roadway;
// two buildings facing each other across a street still stay well apart.
export const FRONT = 0.16;

export const TREE = { PINE: 0, ROUND: 1, BIRCH: 2, BUSH: 3, ROCK: 4, PEBBLE: 5 };

export class World {
  constructor(N, seed, terrain) {
    this.N = N;
    this.seed = seed;
    this.terrain = terrain;
    this.roads = new Net('road');
    this.rails = new Net('rail');
    this.parcels = new Map();          // farm fields: id → { id, farm, x, z, a, rect }
    this.lines = [];
    this.sandbox = { infiniteMoney: false, unlockAll: false, freeUpgrades: false, instantBuild: false };
    this.plots = new Index(2);         // the buildings, filed by where their plots reach
    this.fieldIx = new Index(2);
    this.treeIx = new Index(2);
    this.connected = new Set();        // the road nodes joined to the way out of the valley
    this.buildings = new Map();
    this.residents = new Map();
    this.trees = [];
    this.money = CONFIG.START_MONEY;
    this.taxRate = 10;
    this.day = 1;
    this.hours = 7;
    this.nextId = 1;
    this.entry = { node: -1, x: 0, z: 0 };
    this.townName = 'Kinstead';
    this.history = [];
    this.titleIdx = 0;
    this.stats = { visits: 0, visitIncome: 0, todayVisitIncome: 0, arrivals: 0, departures: 0 };
    this.research = { done: [], current: null, progress: 0, bank: 0 };
    this._listeners = {};
  }

  // ------------------------------------------------------------- events
  on(evt, fn) { (this._listeners[evt] ||= []).push(fn); }
  emit(evt, data) { for (const fn of this._listeners[evt] || []) fn(data); }

  // ------------------------------------------------------------- basics
  inBounds(x, z) { return x >= 0 && z >= 0 && x <= this.N && z <= this.N; }
  waterAt(x, z) { return this.terrain.heightAt(x, z) < CONFIG.WATER_LEVEL + 0.05; }
  // The building whose plot (x, z) is on, or null.
  buildingAt(x, z) {
    for (const b of this.plots.near(x, z, 0)) if (inRect(plotOf(b), x, z)) return b;
    return null;
  }
  // The buildings whose plots reach within r of (x, z).
  buildingsNear(x, z, r) { return this.plots.near(x, z, r).filter(b => segRectDist(plotOf(b), x, z, x, z) <= r); }
  // The road under (x, z) (within its roadway, and pad more): { e, s, d, ... }
  // as Net.nearest, or null.
  roadAt(x, z, pad = 0) {
    const h = this.roads.nearest(x, z, HALF[3] + pad);
    return h && h.d <= HALF[h.e.level] + pad ? h : null;
  }
  railAt(x, z, pad = 0) {
    const h = this.rails.nearest(x, z, RAIL_HALF + pad);
    return h && h.d <= RAIL_HALF + pad ? h : null;
  }
  _file(b) { this.plots.add(b, aabbOf(plotOf(b))); }
  get population() { return this.residents.size; }
  // population used for unlocks (sandbox can unlock everything)
  get unlockPop() { return this.sandbox.unlockAll ? Infinity : this.residents.size; }
  setSandbox(opts) {
    Object.assign(this.sandbox, opts);
    if (this.sandbox.infiniteMoney) this.money = Infinity;
    else if (!Number.isFinite(this.money)) this.money = 100000;
  }

  newId() { return this.nextId++; }

  // ------------------------------------------------------------ research
  hasTech(id) { return !id || this.sandbox.unlockAll || this.research.done.includes(id); }
  techName(id) { return TECHS[id] ? TECHS[id].name : id; }
  canResearch(id) {
    const t = TECHS[id];
    return !!t && !this.research.done.includes(id) && t.needs.every(n => this.research.done.includes(n));
  }
  startResearch(id) {
    if (!this.canResearch(id)) return false;
    const R = this.research;
    if (R.current && R.current !== id) R.bank += R.progress;
    R.current = id;
    R.progress = R.current === id ? R.progress : 0;
    // points banked while idle go straight in
    const use = Math.min(R.bank, TECHS[id].cost);
    R.progress += use; R.bank -= use;
    this._checkResearch();
    return true;
  }
  addResearch(points) {
    const R = this.research;
    if (!R.current) { R.bank += points; return; }
    R.progress += points;
    this._checkResearch();
  }
  _checkResearch() {
    const R = this.research;
    if (!R.current || R.progress < TECHS[R.current].cost) return;
    const id = R.current;
    R.bank += R.progress - TECHS[id].cost;
    R.done.push(id);
    R.current = null; R.progress = 0;
    this.emit('research:done', id);
  }

  // Walkable surface height: the ground, the road (which climbs onto a
  // bridge's deck over water), or the water's surface.
  walkHeight(x, z) {
    const r = this.roadHeight(x, z);
    if (r != null) return r;
    return Math.max(this.terrain.heightAt(x, z) + 0.03, CONFIG.WATER_LEVEL - 0.05);
  }
  // The road's own surface at (x, z) where it isn't the ground's (on a bridge
  // and the ramps up to it), or null.
  roadHeight(x, z) {
    const h = this.roads.nearest(x, z, HALF[3] + 0.05);
    if (!h || h.d > HALF[h.e.level] + 0.05) return null;
    const hy = this._heights(h.e), y = heightOn(hy, h.s);
    const g = this.terrain.heightAt(x, z) + 0.012;
    return Math.abs(y - g) > 0.004 || wetOn(hy, h.s) ? y + 0.008 : null;
  }
  _heights(e) { return edgeHeights(e, this.terrain, bridgeDeckY(), (x, z) => this.waterAt(x, z), RAMP); }

  // ------------------------------------------------------------ buildings
  // The way a plot at (x, z) would face its nearest road (as the player
  // sees it while placing): towards the road, square to it. null with no
  // road within r.
  faceRoad(x, z, r = 2.5) {
    const h = this.roads.nearest(x, z, r);
    if (!h) return null;
    const nx = -h.dz, nz = h.dx, s = (h.x - x) * nx + (h.z - z) * nz >= 0 ? 1 : -1;
    return angleOf(nx * s, nz * s);
  }
  // Where a plot of half-depth hd facing angle a, its front SETBACK from the
  // middle of the road it faces, would stand for a point (x, z) near it:
  // { x, z, a }, or null with no road near (lining up with a street, for the
  // town's own builders, and the player when they want it).
  alongRoad(x, z, hd, r = 2.5) {
    const h = this.roads.nearest(x, z, r);
    if (!h) return null;
    const nx = -h.dz, nz = h.dx, s = (x - h.x) * nx + (z - h.z) * nz >= 0 ? 1 : -1;
    const off = SETBACK + hd;
    return { x: h.x + nx * s * off, z: h.z + nz * s * off, a: angleOf(-nx * s, -nz * s) };
  }

  // The road a plot reaches from its front: the nearest point of any road
  // to the middle of its front edge, if that is within REACH of the road's
  // edge and ahead of the plot: { e (edge id), s, x, z, conn }, or null.
  accessFor(R) {
    const [fx, fz] = toWorld(R, 0, R.hd);
    let best = null;
    for (const { e, d } of this.roads.within(fx, fz, REACH + HALF[3])) {
      if (d - HALF[e.level] > REACH) continue;
      const h = this.roads.nearest(fx, fz, d + 1e-6, (x) => x === e);
      if (!h) continue;
      const ahead = (h.x - fx) * R.ux + (h.z - fz) * R.uz;
      if (ahead < -0.02 || (d > 0.05 && ahead < 0.4 * d)) continue;
      if (!best || d - HALF[e.level] < best.gap) best = { e: e.id, s: h.s, x: h.x, z: h.z, gap: d - HALF[e.level] };
    }
    if (!best) return null;
    const e = this.roads.edges.get(best.e);
    return { e: best.e, s: best.s, x: best.x, z: best.z, conn: this.connected.has(e.a) };
  }

  // Why a plot can't be here (rectangle R), or null: off the map, on
  // another plot, the road, track, farm fields or water, or too steep.
  // except: buildings it may stand over (itself, when moving; those it takes in).
  _plotBlock(R, opts = {}) {
    const N = this.N;
    for (const [x, z] of R.pts) if (x < 0 || z < 0 || x > N || z > N) return 'Out of bounds';
    const box = aabbOf(R);
    for (const o of this.plots.query(box)) {
      if (opts.except && opts.except.includes(o)) continue;
      if (rectsOverlap(R, plotOf(o), 0.004)) return `The ${BUILDINGS[o.type].levels[o.level].name.toLowerCase()} is in the way`;
    }
    const pad = [box[0] - 0.3, box[1] - 0.3, box[2] + 0.3, box[3] + 0.3];
    for (const sg of this.roads.segsIn(pad)) {
      const p = sg.e.pts[sg.i], q = sg.e.pts[sg.i + 1];
      if (segRectDist(R, p[0], p[1], q[0], q[1]) < HALF[sg.e.level] + VERGE) return 'A road is in the way';
    }
    for (const sg of this.rails.segsIn(pad)) {
      const p = sg.e.pts[sg.i], q = sg.e.pts[sg.i + 1];
      if (segRectDist(R, p[0], p[1], q[0], q[1]) < RAIL_HALF + 0.02) return 'Railway track is in the way';
    }
    if (!opts.fields) for (const f of this.fieldIx.query(box)) if (rectsOverlap(R, f.rect, 0.004)) return 'Farm fields: take them out of the farm first';
    return null;
  }

  checkBuild(type, x, z, opts = {}) {
    const def = BUILDINGS[type];
    const [w0, d0] = sizeOf(type);
    const W = opts.w ?? w0, D = opts.d ?? d0;
    const a = opts.a ?? this.faceRoad(x, z) ?? 0;
    const R = rect(x, z, a, W / 2, D / 2);
    const t = this.terrain;
    let reason = null;
    if (!opts.ignoreUnlock && this.unlockPop < unlockOf(type, 0)) reason = `Unlocks at ${unlockOf(type, 0)} villagers`;
    if (!reason && !opts.ignoreUnlock && !this.hasTech(def.tech)) reason = `Research ${this.techName(def.tech)} first`;
    // (one seat of government, whichever it has grown into)
    if (def.unique && !opts.ignoreUnique) for (const b of this.buildings.values()) if (b.type === type || (def.seat && BUILDINGS[b.type].seat)) { reason = 'Only one allowed'; break; }
    if (!reason) reason = this._plotBlock(R, opts);
    let g = { minH: 0, maxH: 0, water: false };
    if (!reason) {
      g = groundUnder(t, R);
      if (g.water) reason = "Can't build on water";
      else if (g.maxH - g.minH > (Math.max(W, D) === 1 ? 0.9 : 1.1)) reason = 'Too steep here';
    }
    const access = reason ? null : this.accessFor(R);
    if (!reason && !def.park && !access) reason = this.faceRoad(x, z, 1.5) == null ? 'Needs a road in front of it' : 'Turn it to face the street (Z / C), close enough to reach it';
    if (!reason && def.needsWater) {
      const ring = rectSamples(grow(R, 0.6), 0.2).filter(([px, pz]) => !inRect(R, px, pz, 0.15));
      if (!ring.some(([px, pz]) => this.waterAt(px, pz))) reason = 'Must be next to water';
    }
    const rail = !reason && def.needsRail ? this.findRail(R) : null;
    if (!reason && def.needsRail && !rail) reason = 'Needs railway track alongside it';
    const trees = reason ? 0 : this._treesIn(grow(R, 0.05)).length;
    const cost = (opts.baseCost ?? def.levels[0].cost) + trees * CLEAR_COST;
    if (!reason && !opts.ignoreMoney && this.money < cost) reason = 'Not enough money';
    return { ok: !reason, reason, cost, access, minH: g.minH, maxH: g.maxH, trees, rail, rect: R, a, w: W, d: D };
  }

  // Track running alongside one of a plot's sides (within reach of it, and
  // more or less along it): { e, s, x, z, k (the side, as seen from the
  // plot's front: 0 in front, 1 its right... in its own frame: 0 +z, 1 +x,
  // 2 -z, 3 -x) }, or null.
  findRail(R) {
    let best = null;
    for (const { e, d } of this.rails.within(R.cx, R.cz, Math.max(R.hw, R.hd) + 0.9)) {
      const h = this.rails.nearest(R.cx, R.cz, d + Math.max(R.hw, R.hd) + 0.9, (x) => x === e);
      if (!h) continue;
      const [lx, lz] = toLocal(R, h.x, h.z);
      const side = Math.abs(lz) / R.hd > Math.abs(lx) / R.hw ? (lz > 0 ? 0 : 2) : lx > 0 ? 1 : 3;
      const gap = side & 1 ? Math.abs(lx) - R.hw : Math.abs(lz) - R.hd;
      if (gap > 0.75 || gap < 0) continue;
      // (along the side: the track's way within 30 degrees of it)
      const [ax, az] = side & 1 ? [R.ux, R.uz] : [R.ex, R.ez];
      if (Math.abs(h.dx * ax + h.dz * az) < 0.86) continue;
      if (!best || gap < best.gap) best = { e: e.id, s: h.s, x: h.x, z: h.z, k: side, gap };
    }
    if (!best) return null;
    delete best.gap;
    return best;
  }

  // New buildings start as a building site (see Construction) unless placed
  // with opts.instant (world generation) or the instant-build sandbox switch.
  placeBuilding(type, x, z, opts = {}) {
    // a planting or a monument of a kind the town can make
    if (opts.flavor && KINDS[type]) {
      const K = KINDS[type][opts.flavor];
      if (!K) return { ok: false, reason: 'There is no such kind' };
      if (!opts.ignoreUnlock && !this.hasTech(K.tech)) return { ok: false, reason: `Research ${this.techName(K.tech)} first` };
    }
    const chk = this.checkBuild(type, x, z, opts);
    if (!chk.ok) return { ok: false, reason: chk.reason };
    const def = BUILDINGS[type];
    const b = this._record(type, x, z, chk, opts);
    this._occupy(b);
    if (!opts.free) this.money -= chk.cost;
    if (!opts.instant && !this.sandbox.instantBuild) b.con = { kind: 'build', work: workNeeded(def.levels[b.level].cost), done: 0 };
    this.buildings.set(b.id, b);
    this._updateFronts(b);
    if (chk.trees) this.emit('trees');
    this.emit('building:add', b);
    return { ok: true, building: b, cost: chk.cost };
  }

  _record(type, x, z, chk, o = {}) {
    const variant = o.variant ?? ((Math.random() * 1e9) | 0);
    const pick = chk.access;
    const r = (v) => Math.round(v * 1000) / 1000;
    const b = {
      id: this.newId(), type, level: o.level || 0, x: r(x), z: r(z), a: r(wrapAngle(chk.a)), w: chk.w, d: chk.d, size: Math.max(chk.w, chk.d), flavor: o.flavor || null, look: o.look || null,
      variant,
      access: pick ? { e: pick.e, s: pick.s, x: pick.x, z: pick.z } : null,
      rail: chk.rail ? { ...chk.rail } : null,
      baseY: floorHeight(this.terrain, type, chk.rect, chk.minH, chk.maxH), minY: chk.minH,
      built: this.day,
      residents: [], workers: [],
      connected: !!(pick && pick.conn),
      happiness: o.happiness ?? 60, factors: o.factors ?? null,
      con: null,
    };
    return b;
  }

  // ------------------------------------------- the street round a building
  // Road near a world point, as far as the edge of its roadway: how far
  // beyond the edge it is (negative on it), or Infinity with none within r.
  _gap(x, z, r = 0.8) {
    let g = Infinity;
    for (const { e, d } of this.roads.within(x, z, r + HALF[3])) g = Math.min(g, d - HALF[e.level]);
    return g;
  }
  // How far a building may come forward into the verge in front of it: the
  // street runs the whole width of its front (or its own part's, `part`),
  // no street trees or hedges stand there, and no neighbour's plot.
  _frontOf(b, part = null) {
    if (!b.access) return 0;
    const R = part || plotOf(b);
    let room = Infinity;
    for (const u of [-0.42, 0, 0.42]) {
      const [x, z] = toWorld(R, u * R.hw * 2, R.hd + 0.02);
      const g = this._gap(x, z, REACH + 0.1);
      if (g > REACH) return 0;
      room = Math.min(room, g);
    }
    const e = this.roads.edges.get(b.access.e);
    if (e && (DRESSINGS[streetPart(e.dress)] || {}).verge) return 0;
    const f = Math.min(FRONT, Math.max(0, room - 0.06));
    if (f < 0.02) return 0;
    const [cx, cz] = toWorld(R, 0, f / 2);
    const out = rect(cx, cz, R.a, R.hw, R.hd + f / 2);
    for (const o of this.plots.query(aabbOf(out))) if (o !== b && rectsOverlap(out, plotOf(o), 0.004)) return 0;
    return Math.round(f * 1000) / 1000;
  }

  // A shop on a street corner: the street it faces turns the corner at one
  // end of its front or both, a road running down that side of it too
  // (b.corner: 1 its left, 2 its right, 3 both, as seen from the street).
  // Such a shop carries its shopfront round onto the side street.
  _cornerOf(b) {
    if (!b.access || !CORNER_SHOPS.has(b.type)) return 0;
    const R = ownPlot(b);
    let m = 0;
    for (const [bit, s] of [[1, -1], [2, 1]]) {
      // (its left as seen from the street is its own -x)
      const [x, z] = toWorld(R, s * (R.hw + 0.2), R.hd - Math.min(0.3, R.hd * 0.5));
      if (this._gap(x, z) < 0.3) m |= bit;
    }
    return m;
  }

  // Which of a building's other sides have a road along them (b.sides: 1 its
  // left, 2 its right, 4 its back, as seen from the street in front), so its
  // walls there get windows and a door rather than a blank face.
  _sidesOf(b) {
    if (!b.access) return 0;
    const R = ownPlot(b);
    let m = 0;
    for (const [bit, lx, lz] of [[1, -R.hw - 0.25, 0], [2, R.hw + 0.25, 0], [4, 0, -R.hd - 0.25]]) {
      const [x, z] = toWorld(R, lx, lz);
      if (this._gap(x, z) < 0.3) m |= bit;
    }
    return m;
  }

  // Re-decide every building's street front (after building, demolishing or
  // re-laying roads). The new building itself, if any, is not refitted.
  // The plot comes forward only where the street runs the whole width of it
  // (b.front). While a building stands on part of a grown plot (b.spare),
  // the building itself comes forward as far as its own part's street
  // allows, as it did before the plot grew (b.ownFront). A shop on a corner
  // turns its shopfront round it (b.corner). All of these come from the
  // roads, so none is saved or sent.
  // Only the buildings near a plot that came or went can change (near: that
  // plot, as a rectangle); after the roads change, every one.
  _updateFronts(except = null, near = null) {
    const refit = [];
    if (!near && except && this.buildings.has(except.id) && !this._roadsChanging) near = plotOf(except);
    const list = near ? this.plots.query(aabbOf(near, 2)) : this.buildings.values();
    for (const b of list) {
      const f = this._frontOf(b), r = spareRect(b), own = r ? this._frontOf(b, r) : undefined;
      const cn = this._cornerOf(b), sd = this._sidesOf(b);
      if (f !== (b.front || 0) || own !== b.ownFront || cn !== (b.corner || 0) || sd !== (b.sides || 0)) {
        if (sd) b.sides = sd; else delete b.sides;
        b.front = f;
        if (own === undefined) delete b.ownFront; else b.ownFront = own;
        if (cn) b.corner = cn; else delete b.corner;
        if (b !== except) refit.push(b);
      }
    }
    for (const b of refit) this.emit('building:refit', b);
  }

  // Turn a building on its plot: its plot turns about its middle to face
  // angle a (radians, as b.a). It must still fit and reach its street.
  turnCheck(b, a) {
    if (!b) return { ok: false, reason: 'That building is gone' };
    if (b.con) return { ok: false, reason: 'Construction under way' };
    if (b.spare || (b.leases && b.leases.length)) return { ok: false, reason: 'Not while it has land taken but not built on, or garden bought or sold' };
    const R = rect(b.x, b.z, a, b.w / 2, b.d / 2);
    const why = this._plotBlock(R, { except: [b] });
    if (why) return { ok: false, reason: why };
    const g = groundUnder(this.terrain, R);
    if (g.water) return { ok: false, reason: "Can't build on water" };
    const access = this.accessFor(R);
    if (!access && !BUILDINGS[b.type].park) return { ok: false, reason: 'It would no longer face a street' };
    return { ok: true, rect: R, access, g };
  }
  turnBuilding(id, a) {
    const b = this.buildings.get(id);
    a = wrapAngle(Number(a));
    if (!Number.isFinite(a)) return { ok: false, reason: 'No such turn' };
    const chk = this.turnCheck(b, a);
    if (!chk.ok) return chk;
    b.a = Math.round(a * 1000) / 1000;
    b.access = chk.access ? { e: chk.access.e, s: chk.access.s, x: chk.access.x, z: chk.access.z } : null;
    b.connected = !!(chk.access && chk.access.conn);
    if (BUILDINGS[b.type].needsRail) b.rail = this.findRail(chk.rect);
    b.baseY = floorHeight(this.terrain, b.type, chk.rect, chk.g.minH, chk.g.maxH); b.minY = chk.g.minH;
    const was = plotOf(b);
    this._file(b);
    this._clearTreesIn(grow(chk.rect, 0.22));
    this._updateFronts(null, grow(was, Math.max(b.w, b.d)));
    this.emit('building:refit', b);
    this.emit('trees');
    return { ok: true, building: b };
  }

  _occupy(b) {
    const R = plotOf(b);
    this._unfield(R);
    this._file(b);
    this._clearTreesIn(grow(R, 0.22));
  }

  // Take a building off the map without refunds or rehousing (its people
  // and line stops have already been pointed elsewhere).
  _detach(b) {
    this._dissolveLeases(b);
    this._dropFields(b);
    const R = plotOf(b);
    this.plots.remove(b);
    this.buildings.delete(b.id);
    this.emit('building:remove', b);
    this._updateFronts(null, R);
  }

  // Point everyone and everything that refers to one building at another.
  _retarget(from, to) {
    for (const r of this.residents.values()) {
      if (r.home === from) r.home = to;
      if (r.job === from) r.job = to;
      if (r.at === from) r.at = to;
      if (r.site === from) r.site = null;
      if (r.plan) for (const p of r.plan) if (p.dest === from) p.dest = to;
    }
    let lines = false;
    for (const l of this.lines) {
      const i = l.stops.indexOf(from);
      if (i >= 0) { l.stops[i] = to; lines = true; }
    }
    if (lines) this.emit('lines');
  }

  buildValue(b) {
    const def = BUILDINGS[b.type];
    let v = 0;
    for (let l = 0; l <= b.level; l++) v += def.levels[l].cost;
    return Math.round(v * sizeK(b));
  }

  // Called by Construction when the builders have done all the work.
  finishConstruction(b) {
    const con = b.con;
    if (!con) return;
    if (con.kind === 'demolish') { this.removeBuilding(b.id); return; }
    if (con.kind === 'dismantle') {
      const dest = this.buildings.get(con.dest);
      this._detach(b);
      if (dest && dest.con && dest.con.wait === 'dismantle') {
        dest.con.wait = 'haul';
        this.emit('building:dismantled', { from: b, to: dest });
      }
      return;
    }
    const homes = capOf(b, 'housing');
    if (con.kind === 'upgrade') {
      if (con.toType && BUILDINGS[con.toType]) b.type = con.toType;
      if (con.look !== undefined) b.look = con.look;
      if (con.flavor !== undefined) b.flavor = con.flavor;
      b.level = Math.min(con.to, BUILDINGS[b.type].levels.length - 1);
      this._fill(b, con.extend);
      if (!hasFields(b.type)) this._dropFields(b);
    }
    if (con.kind === 'build') b.built = this.day;
    b.con = null;
    // a cottage rebuilt as something grander takes its garden back
    if (b.type !== 'house') this._dissolveLeases(b, true);
    this.emit('building:change', b);
    this.emit('building:done', { building: b, kind: con.kind, moved: !!con.moved });
    this._shrunk(b, homes);
    if (BUILDINGS[b.type].spacious) this.tryEncroach(b);
  }

  // Built out across the whole plot: extended, or rebuilt as a building whose
  // own footprint is the plot (a Country Mansion on a double plot).
  _fill(b, extend) {
    if (b.spare && (extend || baseArea(b) >= b.w * b.d)) { delete b.spare; setFloor(this.terrain, b); this._updateFronts(b); }
  }

  // A home rebuilt to hold fewer people (a Grand Manor on a double plot
  // becoming a Country Mansion): the households that no longer fit move out,
  // to another home or out of town (see Sim._onShrunk).
  _shrunk(b, homes) {
    if (capOf(b, 'housing') < homes) this.emit('building:shrink', b);
  }

  // The households that would have to leave a home for only `cap` people to
  // live there: the ones that moved in last, whole.
  movingOut(b, cap) {
    const fams = new Map();
    for (const r of this.residents.values()) {
      if (r.home !== b.id) continue;
      if (!fams.has(r.fam ?? r.id)) fams.set(r.fam ?? r.id, []);
      fams.get(r.fam ?? r.id).push(r);
    }
    let n = [...fams.values()].reduce((s, f) => s + f.length, 0);
    const out = [];
    for (const fam of [...fams.values()].reverse()) {
      if (n <= cap) break;
      out.push(...fam);
      n -= fam.length;
    }
    return out;
  }

  // ------------------------------------------------- neighbours in a row
  // The neighbour beside a building on one side of its own plot (side: 'x0'
  // its left in its own frame... as b.ext: x0 -x, x1 +x, z0 behind, z1 in
  // front), when the two stand in line: square to each other (facing the
  // same way, or any quarter turn of it) and sharing that whole side, so
  // land can pass from one to the other as it did between squares. { o,
  // oside (o's side facing b) }, or null.
  _besideOn(b, side) {
    const R = ownPlot(b), ax = side[0] === 'x', sg = side[1] === '1' ? 1 : -1;
    const [px, pz] = toWorld(R, ax ? sg * (R.hw + 0.25) : 0, ax ? 0 : sg * (R.hd + 0.25));
    const o = this.buildingAt(px, pz);
    if (!o || o === b) return null;
    const turn = wrapAngle(o.a - b.a), q = Math.round(turn / (Math.PI / 2));
    if (Math.abs(turn - q * (Math.PI / 2)) > 0.02) return null;
    const O = ownPlot(o);
    // the direction from b into o, in o's frame: which of o's sides faces b
    const vx = ax ? sg * R.ex : sg * R.ux, vz = ax ? sg * R.ez : sg * R.uz;
    const ox = -(vx * O.ex + vz * O.ez), oz = -(vx * O.ux + vz * O.uz);
    const oside = Math.abs(ox) > 0.9 ? (ox > 0 ? 'x1' : 'x0') : oz > 0 ? 'z1' : 'z0';
    // sharing the whole side: o's half-length along it the same, and its middle
    // straight across from b's
    const len = ax ? R.hd : R.hw, olen = oside[0] === 'x' ? O.hd : O.hw;
    const [lx, lz] = toLocal(R, O.cx, O.cz), across = ax ? lz : lx, out = ax ? Math.abs(lx) - R.hw : Math.abs(lz) - R.hd;
    const odep = oside[0] === 'x' ? O.hw : O.hd;
    if (Math.abs(len - olen) > 0.02 || Math.abs(across) > 0.03 || Math.abs(out - odep) > 0.04) return null;
    return { o, oside };
  }

  // ---------------------------------------------------------- land deals
  // A big home (def.spacious) can buy a strip of garden from a cottage or
  // family house next door. Its plot grows by LAND on that side and the
  // seller's shrinks by the same amount, so the two never overlap. The buyer's
  // household pays the seller's household (not the town).
  tryEncroach(b) {
    const LAND = 0.25;
    if (!this.hasTech('surveying')) return [];
    if (!b || !BUILDINGS[b.type].spacious || b.con || b.w !== 1 || b.d !== 1) return [];
    b.leases ||= [];
    const ext = this._ext(b);
    const sold = [];
    for (const side of ['x1', 'x0', 'z1', 'z0']) {
      if (b.leases.length >= 2) break;
      if (ext[side] || side === 'z1') continue;
      // strips on two perpendicular sides would meet in a corner of a third plot
      const perp = side[0] === 'x' ? 'z' : 'x';
      if (ext[perp + '0'] > 0 || ext[perp + '1'] > 0) continue;
      const nb = this._besideOn(b, side);
      if (!nb) continue;
      const { o, oside: opp } = nb;
      if (o.type !== 'house' || o.con || o.w !== 1 || o.d !== 1) continue;
      const oe = this._ext(o);
      // a seller gives up one strip at most, and keeps its street side
      if (oe.x0 < 0 || oe.x1 < 0 || oe.z0 < 0 || oe.z1 < 0 || opp === 'z1') continue;
      const price = 60 + 40 * b.level + (b.type === 'villa' ? 30 : 0);
      ext[side] = LAND;
      oe[opp] = -LAND;
      b.leases.push({ with: o.id, side, amt: LAND, price, buyer: true });
      (o.leases ||= []).push({ with: b.id, side: opp, amt: LAND, price, buyer: false });
      sold.push(o);
      this._file(o);
      this.emit('building:refit', o);
      this.emit('land:sold', { buyer: b, seller: o, price });
    }
    if (sold.length) { this._file(b); this._updateFronts(b); this.emit('building:refit', b); }
    return sold;
  }

  _ext(b) { return (b.ext ||= { x0: 0, x1: 0, z0: 0, z1: 0 }); }

  // Undo every land deal a building is part of (it was demolished, moved,
  // joined or rebuilt as something that no longer fits the deal).
  _dissolveLeases(b, onlySold = false) {
    if (!b.leases || !b.leases.length) return;
    const keep = [];
    for (const l of b.leases) {
      if (onlySold && l.buyer) { keep.push(l); continue; }
      this._ext(b)[l.side] = 0;
      const o = this.buildings.get(l.with);
      if (!o || !o.leases) continue;
      const mine = o.leases.find(x => x.with === b.id);
      o.leases = o.leases.filter(x => x.with !== b.id);
      if (mine) this._ext(o)[mine.side] = 0;
      if (this.plots.of.has(o)) this._file(o);
      if (o !== b) this.emit('building:refit', o);
    }
    b.leases = keep;
    if (this.plots.of.has(b)) this._file(b);
  }

  // Each morning a few big homes look for garden land to buy.
  encroachPass(rng = Math.random) {
    for (const b of [...this.buildings.values()]) {
      if (BUILDINGS[b.type].spacious && !b.con && (b.leases || []).length < 2 && rng() < 0.3) this.tryEncroach(b);
    }
  }

  // ----------------------------------------------------------- expansion
  // The land beside a building's plot, in its own frame: a rectangle from
  // lx0 to lx1 across and lz0 to lz1 back to front (relative to the plot's
  // middle, as toLocal).
  _landRect(b, lx0, lx1, lz0, lz1) {
    const [cx, cz] = toWorld(ownPlot(b), (lx0 + lx1) / 2, (lz0 + lz1) / 2);
    return rect(cx, cz, b.a, (lx1 - lx0) / 2, (lz1 - lz0) / 2);
  }
  // Grow a 1×1 building onto the plot beside or behind it. Empty land is
  // simply taken; a small neighbour is either squeezed (it sells a garden
  // strip and keeps its house) or bought out and demolished. Every option
  // grows the plot by whole plots in its own frame (dir: which way, as
  // { gx0, gx1, gz0, gz1 }, the plot widths it grows by to its left, right,
  // back and front).
  expandOptions(b) {
    const out = [];
    const def = BUILDINGS[b.type];
    if (!b || !this.hasTech('surveying') || this._dryHome(b)) return out;
    const hw = b.w / 2, hd = b.d / 2;
    // a 2×2 park, or a 3×3 one, can grow onto the land round one of its
    // corners into grounds a size bigger (Public Parks); so can the seat of
    // government at its top level (Capital City)
    const n = b.w;
    const grows = def.park ? this.hasTech('publicparks') : def.seat && b.level === def.levels.length - 1 && this.hasTech('capital');
    if (!b.con && !b.spare && grows && n >= 2 && b.d === n && n * n === baseArea(b) && growsInto(b.type, (n + 1) ** 2).length) {
      for (const cz of [-1, 1]) for (const cx of [-1, 1]) {
        // the L of land round that corner: a strip along one side and one along the next
        const strips = [this._landRect(b, cx < 0 ? -hw - 1 : hw, cx < 0 ? -hw : hw + 1, -hd + (cz < 0 ? -1 : 0), hd + (cz > 0 ? 1 : 0)), this._landRect(b, -hw, hw, cz < 0 ? -hd - 1 : hd, cz < 0 ? -hd : hd + 1)];
        const take = this._growLand(b, strips, 1.4);
        if (!take) continue;
        const where = `${cz > 0 ? 'in front of it' : 'behind it'} and to its ${cx > 0 ? 'right' : 'left'}`;
        out.push({ rects: strips.map(R => R.pts), dir: 20 + (cx > 0 ? 1 : 0) + (cz > 0 ? 2 : 0), grow: { gx0: cx < 0 ? 1 : 0, gx1: cx > 0 ? 1 : 0, gz0: cz < 0 ? 1 : 0, gz1: cz > 0 ? 1 : 0 }, kind: 'grand', where, ...take, label: `Take the land ${where} for ${plotName((n + 1) ** 2)}` });
      }
      return out;
    }
    // a double plot can grow into a 2×2 estate onto two plots beside it:
    // empty land or, for a park, the little parks there too
    if (!b.con && b.w * b.d === 2 && this.hasTech('bigplots') && !def.stop && growsInto(b.type, 4).length) {
      const wide = b.w === 2;
      for (const s of [-1, 1]) {
        const R = wide ? this._landRect(b, -hw, hw, s < 0 ? -hd - 1 : hd, s < 0 ? -hd : hd + 1) : this._landRect(b, s < 0 ? -hw - 1 : hw, s < 0 ? -hw : hw + 1, -hd, hd);
        const take = this._growLand(b, [R], 1.2);
        if (!take) continue;
        const where = wide ? (s < 0 ? 'behind it' : 'in front of it') : 'beside it';
        out.push({ rects: [R.pts], dir: 10 + (s + 1), grow: wide ? { gx0: 0, gx1: 0, gz0: s < 0 ? 1 : 0, gz1: s > 0 ? 1 : 0 } : { gx0: s < 0 ? 1 : 0, gx1: s > 0 ? 1 : 0, gz0: 0, gz1: 0 }, kind: 'estate', where, ...take, label: `Take the two plots ${where} for a 2×2 estate` });
      }
      return out;
    }
    const SIDES = [
      { dir: 0, side: 'z1', where: 'in front', R: () => this._landRect(b, -hw, hw, hd, hd + 1), grow: { gx0: 0, gx1: 0, gz0: 0, gz1: 1 } },
      { dir: 1, side: 'x0', where: 'beside', R: () => this._landRect(b, -hw - 1, -hw, -hd, hd), grow: { gx0: 1, gx1: 0, gz0: 0, gz1: 0 } },
      { dir: 2, side: 'z0', where: 'behind', R: () => this._landRect(b, -hw, hw, -hd - 1, -hd), grow: { gx0: 0, gx1: 0, gz0: 1, gz1: 0 } },
      { dir: 3, side: 'x1', where: 'beside', R: () => this._landRect(b, hw, hw + 1, -hd, hd), grow: { gx0: 0, gx1: 1, gz0: 0, gz1: 0 } },
    ];
    // a one-plot park only takes an empty plot beside it (it joins with the
    // parks next door instead)
    if (def.park && !b.con && b.w === 1 && b.d === 1 && def.size === 1 && growsInto(b.type, 2).length) {
      for (const S of SIDES) {
        const take = this._growLand(b, [S.R()], 1.1, false);
        if (take) out.push({ rects: [S.R().pts], dir: S.dir, grow: S.grow, kind: 'land', where: S.where, ...take, label: `Take the empty plot ${S.where}` });
      }
      return out;
    }
    if (!b || b.con || def.merged || def.park || def.stop || b.w !== 1 || b.d !== 1 || def.size !== 1) return out;
    // only where the double plot opens up something bigger to upgrade into
    if (!growsInto(b.type, 2).length) return out;
    const base = CONFIG.PLOT_PRICE;   // the land, whatever stands beside it
    for (const S of SIDES) {
      const R = S.R();
      const nb = this._besideOn(b, S.side), o = nb ? nb.o : null;
      // empty land: in bounds and clear of everything, not too rough
      const take = !o ? this._growLand(b, [R], 1.1, false) : null;
      if (take) { out.push({ rects: [R.pts], dir: S.dir, grow: S.grow, kind: 'land', where: S.where, cost: base + take.cost - CONFIG.PLOT_PRICE, label: `Take the empty plot ${S.where}` }); continue; }
      if (!o || o.con || BUILDINGS[o.type].unique || o.w !== 1 || o.d !== 1) continue;
      // (its own ground must be good enough to build across)
      const lo = Math.min(o.minY, b.minY), hi = Math.max(groundUnder(this.terrain, R).maxH, groundUnder(this.terrain, ownPlot(b)).maxH);
      if (hi - lo > 1.1) continue;
      const oname = BUILDINGS[o.type].levels[o.level].name;
      // squeeze: buy a strip of a cottage's garden (it keeps its house)
      const side = S.side, opp = nb.oside;
      const be = b.ext || {}, oe = o.ext || {};
      const perp = side[0] === 'x' ? 'z' : 'x';
      if (o.type === 'house' && side !== 'z1' && opp !== 'z1' && !be[side] && !(be[perp + '0'] > 0 || be[perp + '1'] > 0) && !(oe.x0 < 0 || oe.x1 < 0 || oe.z0 < 0 || oe.z1 < 0)) {
        out.push({ rects: [R.pts], dir: S.dir, grow: S.grow, kind: 'strip', where: S.where, other: o, side, opp, cost: 60 + 40 * b.level, label: `Buy a strip of the ${oname}'s garden ${S.where}`, warn: `The ${oname} next door gets a smaller garden (its owners are paid)` });
      }
      const comp = this.buildValue(o);   // its owners are paid what their building is worth
      out.push({ rects: [R.pts], dir: S.dir, grow: S.grow, kind: 'takeover', where: S.where, other: o, cost: base + comp, comp, label: `Take over the ${oname} ${S.where}`,
        warn: `The ${oname} will be demolished${o.residents.length ? ` and its ${o.residents.length} resident${o.residents.length > 1 ? 's' : ''} rehoused` : ''} ($${comp} to its owners included)` });
    }
    return out;
  }

  // Land a building can grow onto (rectangles beside its plot): in bounds,
  // clear of roads, track, water and fields and with no building on it
  // (though a park, or the seat's grounds, may take in the little parks
  // there), and the ground over the old plot and the new no rougher than
  // `rough`. { cost, absorb, warn }, or null.
  _growLand(b, rects, rough, absorb = true) {
    const def = BUILDINGS[b.type], taken = [];
    let lo = b.minY, hi = groundUnder(this.terrain, ownPlot(b)).maxH, trees = 0;
    for (const R of rects) {
      // (what stands there: a little park it may take in, or nothing)
      const there = this.plots.query(aabbOf(R)).filter(o => o !== b && rectsOverlap(R, plotOf(o), 0.004));
      for (const o of there) {
        if (!(absorb && (def.park || def.seat) && isSmallPark(o) && !(o.leases || []).length)) return null;
        if (!taken.includes(o)) taken.push(o);
      }
      if (this._plotBlock(R, { except: [b, ...taken] })) return null;
      const g = groundUnder(this.terrain, R);
      if (g.water) return null;
      lo = Math.min(lo, g.minH); hi = Math.max(hi, g.maxH);
      trees += this._treesIn(R).length;
    }
    if (hi - lo > rough) return null;
    const area = rects.reduce((s, R) => s + 4 * R.hw * R.hd, 0) - taken.reduce((s, o) => s + o.w * o.d, 0);
    const names = [...new Set(taken.map(o => BUILDINGS[o.type].levels[o.level].name.toLowerCase()))];
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
    return { cost: Math.round(Math.max(0, area)) * CONFIG.PLOT_PRICE + trees * CLEAR_COST, absorb: taken, warn: taken.length ? `The ${list} there ${taken.length > 1 ? 'become' : 'becomes'} part of the ${def.park ? 'park' : 'grounds'}` : undefined };
  }

  _dryHome(b) {
    return !this.sandbox.freeUpgrades && !!BUILDINGS[b.type].levels[b.level].housing && (b.blockers || []).includes('water');
  }

  expandBuilding(id, dir, kind) {
    const b = this.buildings.get(id);
    if (b && this._dryHome(b)) return { ok: false, reason: 'No running water: homes need it to grow' };
    const opt = b && this.expandOptions(b).find(o => o.dir === dir && o.kind === kind);
    if (!opt) return { ok: false, reason: "Can't expand that way" };
    if (this.money < opt.cost) return { ok: false, reason: 'Not enough money' };
    if (opt.kind === 'strip') {
      const LAND = 0.25;
      this.money -= opt.cost;
      this._ext(b)[opt.side] = LAND;
      this._ext(opt.other)[opt.opp] = -LAND;
      (b.leases ||= []).push({ with: opt.other.id, side: opt.side, amt: LAND, price: opt.cost, buyer: true });
      (opt.other.leases ||= []).push({ with: b.id, side: opt.opp, amt: LAND, price: opt.cost, buyer: false });
      this._file(b); this._file(opt.other);
      this._updateFronts(b);
      this.emit('building:refit', opt.other);
      this.emit('building:refit', b);
      this.emit('land:sold', { buyer: b, seller: opt.other, price: opt.cost });
      return { ok: true, building: b, kind: 'strip' };
    }
    if (opt.other) this.removeBuilding(opt.other.id, 0);
    // the little parks a growing park takes in
    for (const o of opt.absorb || []) this.removeBuilding(o.id, 0);
    this.money -= opt.cost;
    this._dissolveLeases(b);
    // what the building itself covers, and where (it stays where it stands)
    const spare = b.spare || { w: b.w, d: b.d };
    const g = opt.grow, W = b.w + g.gx0 + g.gx1, D = b.d + g.gz0 + g.gz1;
    const [cx, cz] = toWorld(ownPlot(b), (g.gx1 - g.gx0) / 2, (g.gz1 - g.gz0) / 2);
    if (spare.sx == null) {
      // which end of the new plot it stands at, in its own frame
      const sign = (v) => (Math.abs(v) < 0.01 ? 0 : Math.sign(v));
      spare.sx = sign(g.gx0 - g.gx1); spare.sz = sign(g.gz0 - g.gz1);
    }
    b.x = Math.round(cx * 1000) / 1000; b.z = Math.round(cz * 1000) / 1000;
    b.w = W; b.d = D; b.size = Math.max(W, D);
    b.spare = spare;
    const R = ownPlot(b);
    this._unfield(R);
    this._clearTreesIn(grow(R, 0.22));
    this._file(b);
    setFloor(this.terrain, b);
    this._updateFronts(b);
    // the land is the building's now, as a garden; what to build across it
    // (the bigger buildings it opens up, or the same one extended) is the
    // next choice, under Upgrade
    this.emit('trees');
    this.emit('building:change', b);
    return { ok: true, building: b, kind: opt.kind };
  }

  demolishBuilding(id) {
    const b = this.buildings.get(id);
    if (!b) return { ok: false };
    if (b.con && b.con.kind === 'demolish') return { ok: false, reason: 'Already being demolished' };
    if (this.sandbox.instantBuild || (b.con && (b.con.kind === 'build' || b.con.kind === 'dismantle'))) {
      this.removeBuilding(id);
      return { ok: true, instant: true };
    }
    this._dissolveLeases(b);
    b.con = { kind: 'demolish', work: workNeeded(this.buildValue(b), 'demolish'), done: 0 };
    this.emit('building:vacate', b);
    this.emit('building:change', b);
    return { ok: true, building: b };
  }

  // ------------------------------------------------------------- moving
  moveCost(b) { return Math.round(40 + this.buildValue(b) * 0.3); }

  moveCheck(b, x, z, a = null) {
    if (b.con) return { ok: false, reason: 'Construction under way', access: null, cost: 0 };
    if (!this.hasTech('relocation')) return { ok: false, reason: 'Research House Moving first', access: null, cost: 0 };
    return this.checkBuild(b.type, x, z, { w: b.w, d: b.d, a: a ?? undefined, ignoreUnlock: true, ignoreUnique: true, baseCost: this.moveCost(b), except: [b] });
  }

  // Moving = builders take the building down, a cart hauls the materials
  // over, and it goes back up on the new plot. People and line stops move
  // to the new plot straight away.
  moveBuilding(id, x, z, opts = {}) {
    const b = this.buildings.get(id);
    if (!b) return { ok: false, reason: 'That building is gone' };
    const chk = this.moveCheck(b, x, z, opts.a);
    if (!chk.ok) return { ok: false, reason: chk.reason };
    const nb = this._record(b.type, x, z, chk, {
      level: b.level, variant: b.variant, flavor: b.flavor, look: b.look,
      happiness: b.happiness, factors: b.factors,
    });
    if (b.spare) { nb.spare = { ...b.spare }; setFloor(this.terrain, nb); }
    this._occupy(nb);
    this.money -= chk.cost;
    this._retarget(b.id, nb.id);
    this.buildings.set(nb.id, nb);
    this._updateFronts(nb);
    if (this.sandbox.instantBuild) {
      this._detach(b);
      if (chk.trees) this.emit('trees');
      this.emit('building:add', nb);
      return { ok: true, building: nb, cost: chk.cost, instant: true };
    }
    const value = this.buildValue(b);
    nb.con = { kind: 'build', work: workNeeded(value, 'rebuild'), done: 0, wait: 'dismantle', from: b.id, moved: true };
    b.con = { kind: 'dismantle', work: workNeeded(value, 'dismantle'), done: 0, dest: nb.id };
    if (chk.trees) this.emit('trees');
    this.emit('building:add', nb);
    this.emit('building:change', b);
    return { ok: true, building: nb, old: b, cost: chk.cost };
  }

  // ------------------------------------------------------------ merging
  // Two one-plot buildings in a row (side by side, or one behind the other,
  // square to each other) join into one on the double plot they make,
  // facing the way the first one faces (the one in front, of one behind the
  // other).
  mergeOptions(b) {
    const out = this._farmJoins(b);
    if (!this.hasTech('joining')) return out;
    if (!b || b.con || b.w !== 1 || b.d !== 1) return out;
    for (const side of ['x0', 'x1', 'z0', 'z1']) {
      const nb = this._besideOn(b, side), o = nb && nb.o;
      if (!o || o.con || o.w !== 1 || o.d !== 1) continue;
      // (one behind the other: the one in front faces the street, and the
      // one behind must face the same way)
      if (side[0] === 'z' && Math.abs(wrapAngle(o.a - b.a)) > 0.02) continue;
      const m = mergeResult(b, o, (type, level) => this.hasTech(techForLevel(type, level)) && this.unlockPop >= unlockOf(type, level));
      if (!m || !this.hasTech(BUILDINGS[m.type].tech)) continue;
      // people who won't fit in what the two become
      const people = b.residents.length + o.residents.length, room = capOf({ type: m.type, level: m.level, w: 2, d: 1, size: 2 }, 'housing');
      out.push({ other: o, side, ...m, moveOut: Math.max(0, people - room), ok: this.money >= m.cost });
    }
    return out;
  }

  mergeBuildings(aId, bId) {
    const a = this.buildings.get(aId), o = this.buildings.get(bId);
    const opt = this.mergeOptions(a).find(m => m.other === o);
    if (!opt) return { ok: false, reason: "These two can't be joined" };
    if (this.money < opt.cost) return { ok: false, reason: 'Not enough money' };
    if (opt.farmJoin) return this._joinFarm(opt);
    // the double plot: side by side, facing the way a faces; one behind the
    // other, facing the way the one in front faces
    const side = opt.side, front = side === 'z1' ? o : a;
    const cx = (a.x + o.x) / 2, cz = (a.z + o.z) / 2, along = side[0] === 'x';
    const R = rect(cx, cz, front.a, along ? 1 : 0.5, along ? 0.5 : 1);
    const g = groundUnder(this.terrain, R);
    if (g.maxH - g.minH > 1.1) return { ok: false, reason: 'The ground is too uneven to join them' };
    const access = this.accessFor(R);
    if (!access) return { ok: false, reason: 'Needs a road alongside' };
    const homes = capOf(a, 'housing') + capOf(o, 'housing');
    // (a double plot one behind the other is 1 wide and 2 deep)
    const nb = this._record(opt.type, cx, cz, { access, rail: null, minH: g.minH, maxH: g.maxH, rect: R, a: front.a, w: along ? 2 : 1, d: along ? 1 : 2 }, {
      level: opt.level, variant: opt.base.variant, flavor: opt.flavor, look: opt.base.look, happiness: opt.base.happiness, factors: opt.base.factors,
    });
    this.money -= opt.cost;
    this._retarget(a.id, nb.id);
    this._retarget(o.id, nb.id);
    this._detach(a);
    this._detach(o);
    this._occupy(nb);
    if (!this.sandbox.instantBuild) nb.con = { kind: 'merge', work: workNeeded(opt.cost * 3, 'merge'), done: 0 };
    this.buildings.set(nb.id, nb);
    this._updateFronts(nb);
    this.emit('building:add', nb);
    this._shrunk(nb, homes);
    return { ok: true, building: nb, cost: opt.cost };
  }

  // A farm and a house beside it (FARM_JOIN), from either side: the farm
  // becomes a homestead at its level, with its fields and produce, and the
  // house's family moves into the farmhouse (the house's plot is freed).
  // Needs no research: any farm can have its farmhouse. Beside: the two
  // plots touch along a side (not just at a corner).
  _farmJoins(b) {
    const out = [];
    if (!b || b.con) return out;
    const J = FARM_JOIN, farmSide = J.from.includes(b.type), houseSide = J.with.includes(b.type) && b.w === 1 && b.d === 1;
    if (!farmSide && !houseSide) return out;
    const R = plotOf(b), seen = new Set();
    for (const o of this.plots.query(aabbOf(grow(R, 0.1)))) {
      if (o === b || o.con || seen.has(o.id)) continue;
      if (!rectsOverlap(grow(R, 0.06), plotOf(o), 0.004) || !this._sideBy(R, plotOf(o))) continue;
      seen.add(o.id);
      const farm = farmSide ? b : o, house = farmSide ? o : b;
      if (!J.from.includes(farm.type) || !J.with.includes(house.type) || house.w !== 1 || house.d !== 1) continue;
      const to = BUILDINGS[J.to], level = Math.min(farm.level, to.levels.length - 1);
      let value = 0;
      for (let l = 0; l <= level; l++) value += to.levels[l].cost;
      const cost = Math.max(0, value - this.buildValue(farm) - this.buildValue(house)) + 60;
      out.push({ other: o, type: J.to, farmJoin: true, farm, house, base: farm, flavor: farm.flavor || null, level, cost, name: to.levels[level].name, ok: this.money >= cost });
    }
    return out;
  }
  // Whether two plots touch along a side (some of a side of one runs along
  // a side of the other, not only a corner against a corner).
  _sideBy(A, B) {
    let n = 0;
    for (const [x, z] of rectSamples(grow(A, 0.04), 0.1)) if (!inRect(A, x, z, 0.02) && inRect(B, x, z, 0.03)) n++;
    return n >= 3;
  }

  _joinFarm(opt) {
    const { farm, house } = opt;
    const people = house.residents.length;
    this.money -= opt.cost;
    this._retarget(house.id, farm.id);
    farm.residents = [...(farm.residents || []), ...house.residents];
    this._detach(house);
    farm.type = opt.type;
    farm.level = opt.level;
    this.emit('building:change', farm);
    this._shrunk(farm, people);
    return { ok: true, building: farm, cost: opt.cost, farmJoin: true };
  }

  // Restore a building from a save without any checks.
  restoreBuilding(rec) {
    const def = BUILDINGS[rec.type];
    if (!def) return;
    const [w0, d0] = sizeOf(rec.type);
    const w = rec.w || w0, d = rec.d || d0;
    const b = {
      id: rec.id, type: rec.type, level: Math.min(rec.level, def.levels.length - 1), x: rec.x, z: rec.z, a: wrapAngle(rec.a || 0), size: Math.max(w, d), w, d,
      flavor: rec.flavor || null, look: rec.look || null, con: rec.con && typeof rec.con === 'object' ? { ...rec.con } : null,
      variant: rec.variant, access: null, rail: null, baseY: 0, minY: 0, built: rec.built || 1,
      residents: [], workers: [], connected: false, happiness: 60, factors: null,
    };
    const spare = spareOf(rec.spare, w, d);
    if (spare) b.spare = spare;
    setFloor(this.terrain, b);
    if (Array.isArray(rec.leases) && rec.leases.length) {
      b.leases = rec.leases.map(l => ({ ...l }));
      const e = this._ext(b);
      for (const l of b.leases) e[l.side] = l.buyer ? l.amt : -l.amt;
    }
    this.buildings.set(b.id, b);
    this._file(b);
  }

  // What a building can become next: its next level, or at the top level
  // the first level of each branch type (e.g. Family House → Villa / Flats).
  upgradeOptions(b) {
    const def = BUILDINGS[b.type];
    const out = def.levels[b.level + 1] ? [{ type: b.type, level: b.level + 1 }] : (def.branches || []).map(type => ({ type, level: 0 }));
    // side paths open up at a particular level (a smithy can become a foundry)
    for (const type of (def.paths && def.paths[b.level]) || []) out.push({ type, level: 0, side: true });
    // schools can always move on to the next stage of education
    for (const type of def.stageNext || []) out.push({ type, level: 0, stage: true });
    // a building that has taken over the plot next door can grow into
    // something bigger
    if (isExpanded(b) && LARGE[b.type]) {
      for (const type of LARGE[b.type]) {
        const L = BUILDINGS[type].levels;
        const level = BUILDINGS[type].cat === 'residential' && type !== 'terrace' ? 0 : Math.min(b.level, L.length - 1);
        out.push({ type, level, large: true });
      }
    }
    // ...and a double-plot building grown into a 2×2 estate can be rebuilt as
    // its estate counterpart, at the level it has reached
    if (b.w * b.d >= 4 && ESTATE[b.type]) {
      for (const type of ESTATE[b.type]) out.push({ type, level: Math.min(b.level, BUILDINGS[type].levels.length - 1), estate: true });
    }
    // ...and a 2×2 park grown into 3×3 grounds (or a 3×3 one into 4×4) laid
    // out afresh across them, round what it was; the seat rebuilt across
    // them as the first level of the grander seat
    if (b.spare && b.w * b.d >= 9 && GRAND[b.type]) {
      for (const type of GRAND[b.type]) if (baseAreaOf(type) === b.w * b.d) out.push({ type, level: def.seat ? 0 : Math.min(b.level, BUILDINGS[type].levels.length - 1), grand: true });
    }
    // ...or the building as it is can be built out across the land it took
    // (not a park: a bigger lawn holds no more scenery; nor the seat, which
    // is rebuilt grander or not at all)
    if (b.spare && !def.park && !def.seat) out.push({ type: b.type, level: b.level, extend: true });
    return out;
  }

  // look: the style chosen for the upgrade (undefined: keep the building's own).
  // A new style means new fronts and roofs, so it costs more than keeping the old one.
  upgradeCheck(b, toType = null, look = undefined) {
    const opts = this.upgradeOptions(b);
    const target = toType === 'extend' ? opts.find(o => o.extend) : opts.find(o => o.type === toType && !o.extend) || opts.find(o => !o.extend) || opts[0];
    if (!target) return { ok: false, reason: 'Fully upgraded', max: true };
    // a building on a grown plot is that much bigger, and so is its upgrade;
    // one not yet built out across it stays its own size unless the new
    // building fills the plot
    const fills = !!target.extend || baseAreaOf(target.type) >= b.w * b.d;
    const k = b.spare && !fills ? sizeKFor(target.type, b.spare.w, b.spare.d) : sizeKFor(target.type, b.w, b.d);
    const next = scaledLevel(BUILDINGS[target.type].levels[target.level], k);
    // extending costs what the building is worth, times how much bigger it gets
    let price = next.cost;
    if (target.extend) {
      let v = 0;
      for (let l = 0; l <= b.level; l++) v += BUILDINGS[b.type].levels[l].cost;
      price = Math.max(20, Math.round(v * (k - sizeK(b))));
    }
    const restyle = look !== undefined && (look || null) !== (b.look || null) ? Math.round(price * RESTYLE) : 0;
    const cost = price + restyle;
    if (b.con) return { ok: false, reason: 'Construction under way', busy: true, next, target, cost, restyle, reqs: [] };
    const unlock = target.extend ? 0 : unlockOf(target.type, target.level);
    const tech = target.extend ? null : techForLevel(target.type, target.level);
    const reqs = [];
    const free = this.sandbox.freeUpgrades;
    if (free) reqs.push({ label: 'Sandbox: no requirements', met: true });
    if (unlock && !free) reqs.push({ label: `${unlock} villagers`, met: this.unlockPop >= unlock });
    if (next.req && !free && !target.extend) {
      if (next.req.happiness) reqs.push({ label: `Happiness ${next.req.happiness}%`, met: (b.happiness || 0) >= next.req.happiness });
      for (const s of ['water', 'health', 'education', 'safety', 'culture']) {
        if (next.req[s]) reqs.push({ label: `${s[0].toUpperCase() + s.slice(1)} coverage`, met: !!(b.factors && b.factors[s]) });
      }
      if (next.req.power) reqs.push({ label: 'Electricity', met: !!b.powered });
    }
    if (tech) reqs.unshift({ label: `Research: ${this.techName(tech)}`, met: this.hasTech(tech), tech });
    // the bigger stages need a double plot: expand onto the plot next door
    // first; estates need a 2×2 plot, grown from a double plot
    if (b.w * b.d < baseAreaOf(target.type)) {
      const grounds = plotName(baseAreaOf(target.type));
      reqs.unshift(BUILDINGS[target.type].grand
        ? { label: `${grounds[0].toUpperCase()}${grounds.slice(1)} — grow the ${BUILDINGS[target.type].seat ? 'seat' : 'park'} onto the land round it first`, met: false, space: true }
        : BUILDINGS[target.type].estate
          ? { label: 'A 2×2 estate — grow the double plot onto the two plots beside it first', met: false, space: true }
          : { label: 'A double plot — expand onto a neighbouring plot first', met: false, space: true });
    }
    reqs.push({ label: restyle ? `$${cost} (with $${restyle} for the new style)` : `$${cost}`, met: this.money >= cost });
    const ok = reqs.every(r => r.met);
    // residents of the households that won't fit in what it becomes
    const homes = capOf({ ...b, type: target.type, level: target.level, spare: fills ? undefined : b.spare }, 'housing');
    const moveOut = (b.residents || []).length > homes ? this.movingOut(b, homes).length : 0;
    return { ok, next, target, cost, restyle, reqs, moveOut, reason: ok ? null : 'Requirements not met' };
  }

  // A home or shop can take on a new style without being upgraded: builders
  // rebuild its fronts and roof, for the same share of what it is worth as a
  // new style costs on an upgrade (RESTYLE).
  restyleCheck(b, look) {
    if (!b) return { ok: false, reason: 'That building is gone' };
    const def = BUILDINGS[b.type];
    if (def.cat !== 'residential' && def.cat !== 'commercial') return { ok: false, reason: "Only homes and shops come in styles" };
    const cost = Math.max(30, Math.round(this.buildValue(b) * RESTYLE));
    if (b.con) return { ok: false, reason: 'Construction under way', cost };
    if ((look || null) === (b.look || null)) return { ok: false, reason: 'It is in that style already', cost };
    if (look && !this.hasTech(STYLE_TECH_OF(look))) return { ok: false, reason: 'Research that style first', cost };
    if (this.money < cost) return { ok: false, reason: 'Not enough money', cost };
    return { ok: true, cost };
  }

  // A planting replanted, or a monument reworked, as another of its kinds
  // (KINDS, kept in b.flavor): builders do it, for a share of what it is
  // worth (REKIND), keeping its level.
  kindCheck(b, key) {
    const K = b && KINDS[b.type];
    if (!K) return { ok: false, reason: 'It only comes in one kind' };
    const cost = BUILDINGS[b.type].seat ? Math.round(seatWorth(b) * SEAT_RESTYLE) : Math.max(20, Math.round(this.buildValue(b) * REKIND));
    if (typeof key !== 'string' || !Object.hasOwn(K, key)) return { ok: false, reason: 'There is no such kind', cost };
    if (b.con) return { ok: false, reason: 'Construction under way', cost };
    if (kindOf(b) === key) return { ok: false, reason: BUILDINGS[b.type].seat ? 'It is in that style already' : `It is ${K[key].name.toLowerCase()} already`, cost };
    if (!this.hasTech(K[key].tech)) return { ok: false, reason: `Research ${this.techName(K[key].tech)} first`, cost };
    if (this.money < cost) return { ok: false, reason: 'Not enough money', cost };
    return { ok: true, cost };
  }

  setKind(id, key) {
    const b = this.buildings.get(id), chk = this.kindCheck(b, key);
    if (!chk.ok) return chk;
    this.money -= chk.cost;
    if (this.sandbox.instantBuild) {
      b.flavor = key;
      this.emit('building:change', b);
      return { ok: true, building: b, cost: chk.cost, instant: true };
    }
    b.con = { kind: 'upgrade', to: b.level, toType: b.type, flavor: key, restyle: true, work: workNeeded(chk.cost, 'upgrade'), done: 0 };
    this.emit('building:change', b);
    return { ok: true, building: b, cost: chk.cost };
  }

  restyleBuilding(id, look) {
    const b = this.buildings.get(id), chk = this.restyleCheck(b, look);
    if (!chk.ok) return chk;
    this.money -= chk.cost;
    if (this.sandbox.instantBuild) {
      b.look = look || null;
      this.emit('building:change', b);
      return { ok: true, building: b, cost: chk.cost, instant: true };
    }
    b.con = { kind: 'upgrade', to: b.level, toType: b.type, look: look || null, restyle: true, work: workNeeded(chk.cost, 'upgrade'), done: 0 };
    this.emit('building:change', b);
    return { ok: true, building: b, cost: chk.cost };
  }

  upgradeBuilding(id, toType = null, look = undefined) {
    if (look && !this.hasTech(STYLE_TECH_OF(look))) look = undefined;
    const b = this.buildings.get(id);
    if (!b) return { ok: false };
    const chk = this.upgradeCheck(b, toType, look);
    if (!chk.ok) return chk;
    this.money -= chk.cost;
    const { type, level } = chk.target;
    const flavor = this._grownFlavor(b, chk.target);
    if (this.sandbox.instantBuild) {
      const homes = capOf(b, 'housing');
      b.type = type;
      b.level = level;
      if (look !== undefined) b.look = look;
      if (flavor !== undefined) b.flavor = flavor;
      this._fill(b, chk.target.extend);
      if (!hasFields(b.type)) this._dropFields(b);
      this.emit('building:change', b);
      this._shrunk(b, homes);
      return { ok: true, building: b, instant: true };
    }
    b.con = { kind: 'upgrade', to: level, toType: type, work: workNeeded(chk.cost, 'upgrade'), done: 0 };
    if (chk.target.extend) b.con.extend = true;
    if (look !== undefined) b.con.look = look;
    if (flavor !== undefined) b.con.flavor = flavor;
    this.emit('building:change', b);
    return { ok: true, building: b };
  }

  // What a park rebuilt on its bigger plot keeps of what it was (b.flavor):
  // grounds are laid out round the 2×2 park they grew from, and a park
  // rebuilt from a little one with a feature of its own keeps the feature.
  // undefined: as it is.
  _grownFlavor(b, target) {
    if (!BUILDINGS[b.type].park) return undefined;
    if (target.grand) {
      // the park it was, at its level, in the corner it stands in (see parkOrigin)
      const at = b.spare && b.spare.sx != null ? `@${b.spare.sx},${b.spare.sz}` : '';
      return `${b.type}#${b.level}${at}${b.flavor ? `/${b.flavor}` : ''}`;
    }
    if (target.large) return parkFeature(target.type, [b.type]);
    return undefined;
  }


  removeBuilding(id, refund = 0.25) {
    const b = this.buildings.get(id);
    if (!b) return;
    // demolishing a building that was being taken down for a move: the new
    // plot gets on with it using fresh materials
    if (b.con && b.con.kind === 'dismantle') {
      const dest = this.buildings.get(b.con.dest);
      if (dest && dest.con && dest.con.wait) dest.con.wait = null;
    }
    this._dissolveLeases(b);
    this._dropFields(b);
    this.plots.remove(b);
    this.buildings.delete(id);
    const def = BUILDINGS[b.type];
    let value = 0;
    for (let l = 0; l <= b.level; l++) value += def.levels[l].cost;
    this.money += Math.round(value * sizeK(b) * refund);
    this.emit('building:remove', b);
    this._updateFronts(null, plotOf(b));
    if (def.stop) {
      let changed = false;
      for (const line of this.lines) {
        const n = line.stops.length;
        line.stops = line.stops.filter(s => s !== id);
        if (line.stops.length !== n) changed = true;
      }
      if (changed) this.emit('lines');
    }
  }

  // ------------------------------------------------------- laying curves
  // The curve a stroke the player drew lays: the points (ctrl) fitted with a
  // smooth curve (or straight, two of them).
  static curveOf(ctrl) {
    const P = (Array.isArray(ctrl) ? ctrl : []).filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map(p => [p[0], p[1]]);
    if (P.length < 3) return P;
    return spline(P, 0.1, 0.002);
  }

  // What laying a curve of road (level) or track (rail) through ctrl would
  // do: the network's plan (net.js) and the town's rules on top of it.
  // { ok, reason, cost, plan, pts, len, water (how much is bridge) }.
  _checkCurve(net, ctrl, level, rail) {
    const out = { ok: false, reason: null, cost: 0, plan: null, pts: null, len: 0, water: 0 };
    const pts = World.curveOf(ctrl);
    out.pts = pts;
    if (pts.length < 2) { out.reason = 'Too short'; return out; }
    const N = this.N, hw = rail ? RAIL_HALF : HALF[level];
    if (!rail && !(ROAD_LEVELS[level])) { out.reason = 'No such road'; return out; }
    if (!rail && this.unlockPop < ROAD_LEVELS[level].unlock) { out.reason = `Unlocks at ${ROAD_LEVELS[level].unlock} villagers`; return out; }
    if (rail && this.unlockPop < 25) { out.reason = 'Railways unlock at 25 villagers'; return out; }
    if (rail && !this.hasTech('railways')) { out.reason = 'Research Railways first'; return out; }
    if (pts.some(([x, z]) => x < 0.05 || z < 0.05 || x > N - 0.05 || z > N - 0.05)) { out.reason = 'Out of bounds'; return out; }
    if (tightest(pts, 0.2) < (rail ? 0.9 : 0.32)) { out.reason = rail ? 'Track can\'t bend that tightly' : 'Too tight a bend'; return out; }
    const plan = net.plan(pts);
    out.plan = plan;
    if (plan.reason) { out.reason = plan.reason; return out; }
    // every point along it, a little apart, and where it meets the roads (or
    // track) already there
    const all = resample(plan.pieces.flatMap((p, i) => (i ? p.pts.slice(1) : p.pts)), 0.1);
    const joins = [plan.j0, plan.j1, ...plan.cross].filter(Boolean).map(j => [j.x, j.z]);
    const nearJoin = (x, z, r) => joins.some(([jx, jz]) => Math.hypot(jx - x, jz - z) < r);
    // over buildings, fields and the other network
    for (let i = 0; i + 1 < all.length; i++) {
      const [ax, az] = all[i], [bx, bz] = all[i + 1];
      const box = [Math.min(ax, bx) - 0.6, Math.min(az, bz) - 0.6, Math.max(ax, bx) + 0.6, Math.max(az, bz) + 0.6];
      for (const o of this.plots.query(box)) {
        if (segRectDist(plotOf(o), ax, az, bx, bz) < hw + VERGE - 0.02) { out.reason = `The ${BUILDINGS[o.type].levels[o.level].name.toLowerCase()} is in the way`; return out; }
      }
      for (const f of this.fieldIx.query(box)) if (segRectDist(f.rect, ax, az, bx, bz) < hw) { out.reason = 'Farm fields are in the way: take them out of the farm first'; return out; }
    }
    // the other network: crossed at a good angle, never run along
    const other = rail ? this.roads : this.rails;
    const crossAt = [];
    for (let i = 0; i + 1 < all.length; i++) {
      const [ax, az] = all[i], [bx, bz] = all[i + 1];
      for (const sg of other.segsIn([Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz)])) {
        const p = sg.e.pts[sg.i], q = sg.e.pts[sg.i + 1];
        if (!segCross(ax, az, bx, bz, p[0], p[1], q[0], q[1])) continue;
        const L1 = Math.hypot(bx - ax, bz - az), L2 = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const c = Math.abs(((bx - ax) * (q[0] - p[0]) + (bz - az) * (q[1] - p[1])) / (L1 * L2 || 1));
        if (c > Math.cos((40 * Math.PI) / 180)) { out.reason = rail ? 'Track must cross a road nearer square' : 'A road must cross the track nearer square'; return out; }
        crossAt.push([(ax + bx) / 2, (az + bz) / 2]);
      }
    }
    const oh = rail ? HALF[3] : RAIL_HALF;
    for (const [x, z] of all) {
      if (crossAt.some(([cx, cz]) => Math.hypot(cx - x, cz - z) < hw + oh + 0.35)) continue;
      const h = other.nearest(x, z, hw + oh + 0.1);
      if (h) { out.reason = rail ? 'A road is in the way' : 'Railway track is in the way'; return out; }
    }
    // alongside roads (or track) of its own kind, too near to be apart
    for (const [x, z] of all) {
      if (nearJoin(x, z, hw + HALF[3] + 0.3)) continue;
      for (const { e, d } of net.within(x, z, hw + HALF[3] + 0.12)) {
        if (d < hw + (rail ? RAIL_HALF : HALF[e.level]) + 0.1) { out.reason = rail ? 'Too close alongside other track' : 'Too close alongside another road'; return out; }
      }
    }
    // the ground: steep, deep water, junctions on water
    let wet = 0;
    for (let i = 0; i < all.length; i++) {
      const [x, z] = all[i];
      if (this.waterAt(x, z)) {
        wet++;
        if (this.terrain.heightAt(x, z) < -0.9 && !(rail && false)) { out.reason = 'Water too deep'; return out; }
      }
      if (i >= 5) {
        const [px, pz] = all[i - 5];
        const dh = Math.abs(Math.max(this.terrain.heightAt(x, z), 0) - Math.max(this.terrain.heightAt(px, pz), 0));
        if (!this.waterAt(x, z) && !this.waterAt(px, pz) && dh > (rail ? 0.3 : 0.45)) { out.reason = rail ? 'Too steep for track' : 'Too steep for a road'; return out; }
      }
    }
    for (const [x, z] of joins) if (this.waterAt(x, z)) { out.reason = 'Junctions can\'t stand on water'; return out; }
    for (const pc of plan.pieces) for (const p of [pc.pts[0], pc.pts[pc.pts.length - 1]]) if (this.waterAt(p[0], p[1])) { out.reason = 'A road can\'t end on water'; return out; }
    const len = polyLength(all), step = len / Math.max(1, all.length - 1);
    out.len = len;
    out.water = wet * step;
    const per = rail ? RAIL_COST : ROAD_LEVELS[level].cost;
    const trees = this._treesAlong(all, hw + 0.1).length;
    out.cost = Math.round((len - out.water) * per + out.water * per * BRIDGE_MULT + trees * CLEAR_COST);
    out.trees = trees;
    out.all = all;
    if (!this.sandbox.infiniteMoney && this.money < out.cost) { out.reason = 'Not enough money'; out.ok = false; return out; }
    out.ok = true;
    return out;
  }

  // ---------------------------------------------------------------- rails
  checkRail(ctrl) { return this._checkCurve(this.rails, ctrl, 1, true); }
  placeRail(ctrl) {
    const c = this.checkRail(ctrl);
    if (!c.ok) return { placed: 0, spent: 0, failed: c.reason };
    this.rails.lay(c.plan, { level: 1 });
    this.money -= c.cost;
    this._clearTreesAlong(c.all, RAIL_HALF + 0.2);
    this.updateRailLinks();
    this.emit('trees');
    return { placed: 1, spent: c.cost, failed: null };
  }
  removeRailEdge(id) {
    const e = this.rails.edges.get(id);
    if (!e) return false;
    this.rails.removeEdge(id);
    this.rails.tidy([e.a, e.b]);
    this.updateRailLinks();
    return true;
  }

  updateRailLinks() {
    for (const b of this.buildings.values()) {
      if (!BUILDINGS[b.type].needsRail) continue;
      const r = this.findRail(ownPlot(b));
      const changed = !!r !== !!b.rail || (r && b.rail && (r.e !== b.rail.e || Math.abs(r.s - b.rail.s) > 1e-6));
      b.rail = r;
      if (changed) this.emit('building:change', b);
    }
    this.emit('rails');
  }

  // ---------------------------------------------------------------- roads
  checkRoad(ctrl, level) { return this._checkCurve(this.roads, ctrl, level, false); }

  // Lay a curve of road at this level through the points the player drew.
  placeRoad(ctrl, level) {
    const c = this.checkRoad(ctrl, level);
    if (!c.ok) return { placed: 0, spent: 0, failed: c.reason };
    const { made } = this.roads.lay(c.plan, { level });
    this.money -= c.cost;
    this._clearTreesAlong(c.all, HALF[level] + 0.12);
    this.updateRoadNetwork();
    this.emit('trees');
    return { placed: made.length, spent: c.cost, failed: null, edges: made.map(e => e.id) };
  }

  // What upgrading (or downgrading) these road edges to `level` costs:
  // the difference in price over their length (a bridge three times over),
  // a quarter back going down. { ok, reason, cost, edges }.
  levelCheck(ids, level) {
    if (!ROAD_LEVELS[level]) return { ok: false, reason: 'No such road', cost: 0, edges: [] };
    if (this.unlockPop < ROAD_LEVELS[level].unlock) return { ok: false, reason: `Unlocks at ${ROAD_LEVELS[level].unlock} villagers`, cost: 0, edges: [] };
    let cost = 0;
    const edges = [];
    for (const id of ids) {
      const e = this.roads.edges.get(id);
      if (!e || e.level === level) continue;
      const hy = this._heights(e), wet = hy.wet.reduce((s, v) => s + v, 0) * hy.step;
      const k = (e.len - wet) + wet * BRIDGE_MULT, d = (ROAD_LEVELS[level].cost - ROAD_LEVELS[e.level].cost) * k;
      cost += d > 0 ? d : d * ROAD_SALVAGE;
      edges.push(e);
    }
    cost = Math.round(cost);
    if (!edges.length) return { ok: false, reason: 'Already that road', cost: 0, edges };
    if (cost > 0 && this.money < cost) return { ok: false, reason: 'Not enough money', cost, edges };
    return { ok: true, cost, edges };
  }
  setLevel(ids, level) {
    const c = this.levelCheck(ids, level);
    if (!c.ok) return c;
    this.money -= c.cost;
    for (const e of c.edges) {
      e.level = level;
      // (a dressing the new road can't have goes, a quarter back)
      for (const part of [streetPart(e.dress), lookPart(e.dress)]) {
        const D = DRESSINGS[part];
        if (D && D.minLevel && level < D.minLevel) { this.money += dressRefund(part); e.dress = part === streetPart(e.dress) ? e.dress & ~15 : e.dress & 15; }
      }
    }
    this.roads.version++;
    this.updateRoadNetwork();
    return { ok: true, cost: c.cost, n: c.edges.length };
  }

  // What taking up this road edge pays back: a quarter of what it cost, and
  // of its dressings. The road out of the valley stays.
  removeCheck(id) {
    const e = this.roads.edges.get(id);
    if (!e) return { ok: false, reason: 'That road is gone' };
    if (e.a === this.entry.node || e.b === this.entry.node) return { ok: false, reason: 'The road to the outside world must stay' };
    const hy = this._heights(e), wet = hy.wet.reduce((s, v) => s + v, 0) * hy.step;
    const refund = Math.round(ROAD_LEVELS[e.level].cost * ((e.len - wet) + wet * BRIDGE_MULT) * ROAD_SALVAGE + (dressRefund(streetPart(e.dress)) + dressRefund(lookPart(e.dress))) * Math.max(1, Math.round(e.len)));
    return { ok: true, refund, e };
  }
  removeRoadEdge(id) {
    const c = this.removeCheck(id);
    if (!c.ok) return c.reason;
    this.roads.removeEdge(id);
    this.roads.tidy([c.e.a, c.e.b], new Set([this.entry.node]));
    this.money += c.refund;
    this.updateRoadNetwork();
    return true;
  }

  // ---------------------------------------------------- buried power lines
  // Lay the power lines under the given road edges (Underground Cables):
  // their poles and wires come down, and the street looks the better for it.
  buryCost(ids) {
    let n = 0;
    for (const id of ids) { const e = this.roads.edges.get(id); if (e && !e.buried) n += Math.max(1, Math.round(e.len)); }
    return n * BURY_COST;
  }
  buryLines(ids) {
    if (!this.hasTech('cables')) return { ok: false, reason: `Research ${this.techName('cables')} first` };
    const todo = ids.map(id => this.roads.edges.get(id)).filter(e => e && !e.buried);
    if (!todo.length) return { ok: false, reason: 'Those lines are already underground' };
    const cost = this.buryCost(todo.map(e => e.id));
    if (this.money < cost) return { ok: false, reason: 'Not enough money' };
    this.money -= cost;
    for (const e of todo) e.buried = 1;
    this.roads.version++;
    this.emit('lines');
    return { ok: true, n: todo.length, cost };
  }

  // Which roads reach the way out of the valley, and every building's way
  // to the street (a building keeps the road it had, if it still reaches it).
  updateRoadNetwork() {
    this.connected = this.roads.reach(this.entry.node);
    for (const b of this.buildings.values()) {
      const acc = this.accessFor(ownPlot(b)) || (b.ext ? this.accessFor(plotOf(b)) : null);
      b.access = acc ? { e: acc.e, s: acc.s, x: acc.x, z: acc.z } : null;
      b.connected = !!(acc && acc.conn);
    }
    for (const e of this.roads.edges.values()) e.hy = null;
    this.emit('roads');
    this._roadsChanging = true;
    this._updateFronts();
    this._roadsChanging = false;
  }
  // Whether a road edge reaches the way out of the valley.
  edgeConnected(id) { const e = this.roads.edges.get(id); return !!e && this.connected.has(e.a); }

  // -------------------------------------------------------------- terrain
  // Raising, lowering or flattening the ground: the four points of the
  // terrain's mesh round (x, z). Not right by a building.
  checkTerraform(x, z) {
    if (!this.inBounds(x, z)) return { ok: false, reason: 'Out of bounds' };
    for (const b of this.plots.near(x, z, 1.6)) if (segRectDist(plotOf(b), x, z, x, z) < 1.1) return { ok: false, reason: 'Too close to a building' };
    if (this.money < TERRAFORM_COST) return { ok: false, reason: 'Not enough money' };
    return { ok: true, cost: TERRAFORM_COST };
  }

  terraform(x, z, mode) {
    const c = this.checkTerraform(x, z);
    if (!c.ok) return c;
    const t = this.terrain, tx = Math.min(this.N - 1, Math.max(0, Math.floor(x))), tz = Math.min(this.N - 1, Math.max(0, Math.floor(z)));
    const corners = [[tx, tz], [tx + 1, tz], [tx, tz + 1], [tx + 1, tz + 1]];
    if (mode === 'flatten') {
      const avg = corners.reduce((s, [cx, cz]) => s + t.ch(cx, cz), 0) / 4;
      for (const [cx, cz] of corners) t.setCh(cx, cz, avg);
    } else {
      const d = mode === 'raise' ? 0.25 : -0.25;
      for (const [cx, cz] of corners) t.setCh(cx, cz, Math.max(-1.2, Math.min(4.5, t.ch(cx, cz) + d)));
    }
    this.money -= c.cost;
    this.updateRoadNetwork();
    this.emit('terrain', { x0: tx - 1, z0: tz - 1, x1: tx + 1, z1: tz + 1 });
    return { ok: true, cost: c.cost };
  }

  // ---------------------------------------------------------------- trees
  _treesIn(R) { return this.treeIx.query(aabbOf(R)).filter(tr => inRect(R, tr.x, tr.z)); }
  _treesAlong(pts, r) {
    const out = new Set();
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      for (const tr of this.treeIx.query([Math.min(ax, bx) - r, Math.min(az, bz) - r, Math.max(ax, bx) + r, Math.max(az, bz) + r])) {
        if (segDist(tr.x, tr.z, ax, az, bx, bz) < r) out.add(tr);
      }
    }
    return [...out];
  }
  _dropTrees(list) {
    if (!list.length) return 0;
    const gone = new Set(list);
    for (const tr of list) this.treeIx.remove(tr);
    this.trees = this.trees.filter(tr => !gone.has(tr));
    return list.length;
  }
  // Trees growing right up against a new wall, road or track would poke through it.
  _clearTreesIn(R) { return this._dropTrees(this._treesIn(R)); }
  _clearTreesAlong(pts, r) { return this._dropTrees(this._treesAlong(pts, r)); }
  _clearTreesNear(x, z, r) { return this._dropTrees(this.treeIx.near(x, z, r).filter(tr => Math.hypot(tr.x - x, tr.z - z) < r)); }
  treesNear(x, z, r) { return this.treeIx.near(x, z, r).filter(tr => Math.hypot(tr.x - x, tr.z - z) < r); }

  addTree(x, z, k, s, r) {
    if (!this.inBounds(x, z)) return;
    const tr = { x, z, k, s, r };
    this.trees.push(tr);
    this.treeIx.add(tr, [x, z, x, z]);
  }

  // A tree right where the player points: on open ground (not water, a
  // plot, a road, track or a field), and not in the middle of a thicket.
  checkPlant(x, z) {
    if (!this.inBounds(x, z)) return { ok: false, reason: 'Out of bounds' };
    if (this.waterAt(x, z)) return { ok: false, reason: "Trees don't grow in water" };
    if (this.buildingAt(x, z) || this.roadAt(x, z, 0.08) || this.railAt(x, z, 0.08) || this.fieldAt(x, z)) return { ok: false, reason: 'Occupied' };
    if (this.treesNear(x, z, 0.5).length >= 4) return { ok: false, reason: 'No room for more trees' };
    if (this.money < TREE_COST) return { ok: false, reason: 'Not enough money' };
    return { ok: true, cost: TREE_COST };
  }

  plantTree(x, z) {
    const c = this.checkPlant(x, z);
    if (!c.ok) return c;
    const r = Math.random;
    const h = this.terrain.heightAt(x, z);
    const k = h > 1.6 ? (r() < 0.7 ? TREE.PINE : TREE.ROUND) : [TREE.ROUND, TREE.ROUND, TREE.BIRCH, TREE.PINE][(r() * 4) | 0];
    this.addTree(x, z, k, 0.75 + r() * 0.5, r() * Math.PI * 2);
    this.money -= c.cost;
    this.emit('trees');
    return { ok: true, cost: c.cost };
  }

  // ---------------------------------------------------------- bulldozing
  // Whatever is at (x, z): a building (a crew pulls it down), road or track
  // (that stretch, junction to junction, is taken up), a field, or trees.
  bulldoze(x, z) {
    if (!this.inBounds(x, z)) return { ok: false };
    const b = this.buildingAt(x, z);
    if (b) { const r = this.demolishBuilding(b.id); return { ok: r.ok, what: 'building', building: b, reason: r.reason }; }
    const rl = this.railAt(x, z, 0.06);
    const rd = this.roadAt(x, z, 0.06);
    if (rl && (!rd || rl.d < rd.d)) { this.removeRailEdge(rl.e.id); return { ok: true, what: 'rail' }; }
    if (rd) {
      const r = this.removeRoadEdge(rd.e.id);
      if (r !== true) return { ok: false, reason: r };
      return { ok: true, what: 'road' };
    }
    const f = this.fieldAt(x, z);
    if (f) { const r = this.setFields(f.farm, [[f.x, f.z, f.a]], false); return { ok: r.ok, what: 'fields', reason: r.reason }; }
    const trees = this.treesNear(x, z, 0.4);
    if (trees.length) {
      const cost = trees.length * CLEAR_COST;
      if (this.money < cost) return { ok: false, reason: 'Not enough money' };
      this.money -= cost;
      this._dropTrees(trees);
      this.emit('trees');
      return { ok: true, what: 'trees', cost };
    }
    return { ok: false };
  }

  // Everything in a box [x0, z0, x1, z1]: buildings with their middles in
  // it, stretches of road and track with their middles in it, fields and
  // trees. { ok, n, reason }.
  bulldozeBox(box) {
    const [x0, z0, x1, z1] = box, inBox = (x, z) => x >= x0 && x <= x1 && z >= z0 && z <= z1;
    let n = 0, reason = null;
    const did = (r) => { if (r && (r.ok || r === true)) n++; else if (r && r.reason) reason ||= r.reason; else if (typeof r === 'string') reason ||= r; };
    for (const b of [...this.buildings.values()]) if (inBox(b.x, b.z)) did(this.demolishBuilding(b.id));
    const mid = (e) => pointAt(e.pts, e.cum, e.len / 2);
    for (const e of [...this.rails.edges.values()]) { const m = mid(e); if (inBox(m[0], m[1]) && this.rails.edges.has(e.id)) did(this.removeRailEdge(e.id)); }
    for (const e of [...this.roads.edges.values()]) { if (!this.roads.edges.has(e.id)) continue; const m = mid(e); if (inBox(m[0], m[1])) did(this.removeRoadEdge(e.id)); }
    const fs = [...this.parcels.values()].filter(f => inBox(f.x, f.z));
    const byFarm = new Map();
    for (const f of fs) { if (!byFarm.has(f.farm)) byFarm.set(f.farm, []); byFarm.get(f.farm).push([f.x, f.z, f.a]); }
    for (const [farm, list] of byFarm) did(this.setFields(farm, list, false));
    const trees = this.treeIx.query(box).filter(tr => inBox(tr.x, tr.z));
    if (trees.length) {
      const cost = trees.length * CLEAR_COST;
      if (this.money >= cost) { this.money -= cost; this._dropTrees(trees); this.emit('trees'); n++; } else reason ||= 'Not enough money';
    }
    return { ok: n > 0, n, reason };
  }

  // ------------------------------------------------------------ farmland
  // A farm works fields beyond its own plot: plots of farmland (a unit
  // square each, at any angle) touching the plot or its other fields, as
  // many as its level allows (FIELD_MAX). Each is ploughed and fenced for
  // FIELD_COST (and any trees cleared), adds FIELD_JOBS jobs (capOf), and
  // gives a quarter back when taken out.
  fieldMax(b) { return b && hasFields(b.type) ? CONFIG.FIELD_MAX[Math.min(b.level + (BUILDINGS[b.type].fieldsFrom || 0), CONFIG.FIELD_MAX.length - 1)] : 0; }
  fieldsOf(id) { return [...this.parcels.values()].filter(f => f.farm === id); }
  fieldAt(x, z) { for (const f of this.fieldIx.near(x, z, 0)) if (inRect(f.rect, x, z)) return f; return null; }

  // Why a field at (x, z) facing a can't be one of farm b's, or null.
  _fieldBlock(b, R) {
    for (const [x, z] of R.pts) if (!this.inBounds(x, z)) return 'Out of bounds';
    for (const f of this.fieldIx.query(aabbOf(R))) if (rectsOverlap(R, f.rect, 0.01)) return f.farm === b.id ? 'Already one of its fields' : "Another farm's field";
    const why = this._plotBlock(R, { fields: true });
    if (why) return /road/i.test(why) ? 'A road' : /track/i.test(why) ? 'Railway track' : /bounds/i.test(why) ? 'Out of bounds' : 'A building';
    const g = groundUnder(this.terrain, R);
    if (g.water) return 'Water';
    if (g.maxH - g.minH > 0.6) return 'Too steep to plough';
    if (aheadOf(b, R.cx, R.cz) > 0) return 'Fields go behind and beside it, not between it and the road';
    return null;
  }

  // What adding (add) or taking out these fields would do for farm id
  // (list: [x, z, a] for each, its middle and the way it lies): { tiles:
  // [{ x, z, a, rect, reason }], n (fields that change), cost, refund, max,
  // have, short }. New fields must touch the farm or its fields, or other
  // new fields that do, nearest first, up to its limit.
  planFields(id, list, add = true) {
    const b = this.buildings.get(id);
    const plan = { tiles: [], n: 0, cost: 0, refund: 0, max: this.fieldMax(b), have: b ? b.fields || 0 : 0, short: null };
    if (!b || !hasFields(b.type)) { plan.short = 'Only a farm has fields'; return plan; }
    if (b.con && b.con.kind !== 'upgrade') { plan.short = 'Not until the farm is built'; return plan; }
    for (const p of list) {
      if (!Array.isArray(p) || ![p[0], p[1]].every(Number.isFinite)) continue;
      const [x, z] = p, a = Number.isFinite(p[2]) ? p[2] : b.a;
      plan.tiles.push({ x, z, a, rect: rect(x, z, a, 0.5, 0.5), reason: null, i: plan.tiles.length });
    }
    if (!add) {
      for (const t of plan.tiles) {
        const f = this.fieldAt(t.x, t.z);
        if (!f || f.farm !== id) { t.reason = 'Not one of its fields'; continue; }
        t.field = f;
        plan.n++; plan.refund += Math.round(CONFIG.FIELD_COST * 0.25);
      }
      return plan;
    }
    for (const t of plan.tiles) t.reason = this._fieldBlock(b, t.rect);
    // (new fields mustn't overlap each other either)
    const open = plan.tiles.filter(t => !t.reason);
    for (let i = 0; i < open.length; i++) for (let j = 0; j < i; j++) if (!open[j].reason && rectsOverlap(open[i].rect, open[j].rect, 0.01)) { open[i].reason = 'Overlaps another new field'; break; }
    const free = open.filter(t => !t.reason);
    const own = [plotOf(b), ...this.fieldsOf(id).map(f => f.rect)];
    const touches = (R, list) => list.some(Q => rectsOverlap(grow(R, 0.05), Q, 0.004));
    const queue = free.filter(t => touches(t.rect, own)).sort((p, q) => aheadOf(b, p.x, p.z) - aheadOf(b, q.x, q.z));
    const reached = new Set(queue), take = [];
    const room = Math.max(0, plan.max - plan.have);
    while (queue.length && take.length < room) {
      const t = queue.shift();
      take.push(t);
      for (const u of free) if (!reached.has(u) && touches(u.rect, [t.rect])) { reached.add(u); queue.push(u); }
    }
    const taken = new Set(take);
    for (const t of plan.tiles) {
      if (t.reason || taken.has(t)) continue;
      t.reason = reached.has(t) || room === 0 ? `It can work ${plan.max} fields at most` : 'Must touch the farm or its fields';
    }
    for (const t of take) { plan.n++; plan.cost += CONFIG.FIELD_COST + this._treesIn(t.rect).length * CLEAR_COST; }
    if (plan.n && plan.cost > this.money) plan.short = 'Not enough money';
    return plan;
  }

  setFields(id, list, add = true) {
    const plan = this.planFields(id, list, add);
    if (plan.short) return { ok: false, reason: plan.short };
    if (!plan.n) return { ok: false, reason: (plan.tiles.find(t => t.reason) || {}).reason || 'No fields there' };
    for (const t of plan.tiles) {
      if (t.reason) continue;
      if (add) this._addField(id, t.x, t.z, t.a);
      else if (t.field) this._removeField(t.field);
    }
    if (add) for (const t of plan.tiles) if (!t.reason) this._clearTreesIn(t.rect);
    this.money += plan.refund - plan.cost;
    this._countFields();
    if (add) this.emit('trees');
    this.emit('fields');
    return { ok: true, n: plan.n, cost: plan.cost, refund: plan.refund, skipped: plan.tiles.length - plan.n };
  }
  _addField(farm, x, z, a, id = null) {
    const r = (v) => Math.round(v * 1000) / 1000;
    const f = { id: id ?? this.newId(), farm, x: r(x), z: r(z), a: r(wrapAngle(a)) };
    f.rect = rect(f.x, f.z, f.a, 0.5, 0.5);
    this.parcels.set(f.id, f);
    this.fieldIx.add(f, aabbOf(f.rect));
    return f;
  }
  _removeField(f) { this.parcels.delete(f.id); this.fieldIx.remove(f); }

  setProduce(id, key) {
    const b = this.buildings.get(id);
    if (!b || !hasFields(b.type)) return { ok: false, reason: 'Only a farm grows crops or keeps livestock' };
    if (!choosesProduce(b.type)) return { ok: false, reason: 'An orchard grows fruit' };
    if (typeof key !== 'string' || !Object.hasOwn(PRODUCE, key)) return { ok: false, reason: "A farm can't do that" };
    const flavor = key === 'mixed' ? null : key;
    if ((b.flavor || null) === flavor) return { ok: false, reason: `It already does: ${PRODUCE[key].name.toLowerCase()}` };
    b.flavor = flavor;
    this.emit('building:change', b);
    this.emit('fields');
    return { ok: true, produce: key };
  }

  // Each farm's count of fields (b.fields); fields of a building that is no
  // farm are dropped.
  _countFields() {
    for (const b of this.buildings.values()) if (hasFields(b.type)) b.fields = 0;
    for (const f of [...this.parcels.values()]) {
      const b = this.buildings.get(f.farm);
      if (!b || !hasFields(b.type)) { this._removeField(f); continue; }
      b.fields++;
    }
  }

  // A farm's fields must reach its plot (through its other fields), up to
  // its limit, nearest first; any others go (after a town merge, say).
  _pruneFields() {
    const keep = new Set();
    for (const b of this.buildings.values()) {
      if (!hasFields(b.type)) continue;
      const max = this.fieldMax(b), mine = this.fieldsOf(b.id);
      const reached = [plotOf(b)];
      let grew = true;
      while (grew && keep.size < Infinity) {
        grew = false;
        for (const f of mine) {
          if (keep.has(f) || mine.filter(x => keep.has(x)).length >= max) continue;
          if (reached.some(Q => rectsOverlap(grow(f.rect, 0.05), Q, 0.004))) { keep.add(f); reached.push(f.rect); grew = true; }
        }
      }
    }
    for (const f of [...this.parcels.values()]) if (!keep.has(f)) this._removeField(f);
    this._countFields();
  }

  // A plot laid over farm fields takes them out of their farms.
  _unfield(R) {
    const gone = this.fieldIx.query(aabbOf(R)).filter(f => rectsOverlap(R, f.rect, 0.004));
    if (!gone.length) return;
    for (const f of gone) this._removeField(f);
    this._countFields();
    this.emit('fields');
  }

  _dropFields(b) {
    const mine = this.fieldsOf(b.id);
    if (!mine.length) return;
    for (const f of mine) this._removeField(f);
    this._countFields();
    b.fields = 0;
    this.emit('fields');
  }

  // ------------------------------------------------------------ creation
  static createNew({ N = 48, seed, name, sandbox = null, relief = 'gentle' }) {
    const { terrain, start, entryPath } = generateTerrain(N, seed, relief);
    const w = new World(N, seed, terrain);
    w.townName = name || 'Kinstead';
    w.townId = newTownId();
    if (sandbox) w.setSandbox(sandbox);
    w._layEntry(entryPath);
    w._layFoundingStreets(start);
    w.updateRoadNetwork();
    w.generateNature(start);
    w._placeFoundingBuildings(start);
    w.updateRoadNetwork();
    return w;
  }

  // The road out of the valley: from the edge of the map to where the town
  // begins, along the way the land allows (the terrain's path, smoothed
  // into a winding lane). Its end at the map's edge is the way out.
  _layEntry(path) {
    const N = this.N, P = path.map(([x, z]) => [x + 0.5, z + 0.5]).reverse();
    // (out to the very edge of the map)
    const [ex, ez] = P[0], d = [ex - 0.5 < 1 ? -1 : ex > N - 1.5 ? 1 : 0, ez - 0.5 < 1 ? -1 : ez > N - 1.5 ? 1 : 0];
    P.unshift([d[0] < 0 ? 0 : d[0] > 0 ? N : ex, d[1] < 0 ? 0 : d[1] > 0 ? N : ez]);
    let pts = simplify(P, 0.6);
    pts = pts.length > 2 ? spline(pts, 0.1, 0.002) : pts;
    const a = this.roads.addNode(pts[0][0], pts[0][1]), b = this.roads.addNode(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    this.roads.addEdge(a.id, b.id, pts, { level: 1 });
    this.entry = { node: a.id, x: a.x, z: a.z };
    this._founding = { at: b, path: pts };
    // the town's own frame (for the founding streets and the starters'
    // build scripts): from the founding crossroads, the way out along the
    // road in, and across it (across: to the side the scripts call right,
    // as they did when towns were laid out on squares: the main road's
    // square direction (dx, dz) had (dz, dx) on its right)
    const [px, pz] = pts[Math.max(0, pts.length - 6)], dl = Math.hypot(px - b.x, pz - b.z) || 1;
    const out = [(px - b.x) / dl, (pz - b.z) / dl];
    const sq = Math.abs(out[0]) > Math.abs(out[1]) ? [Math.sign(out[0]), 0] : [0, Math.sign(out[1])];
    const r1 = [-out[1], out[0]], want = [sq[1], sq[0]];
    const across = r1[0] * want[0] + r1[1] * want[1] > 0 ? r1 : [out[1], -out[0]];
    this._frame = { x: b.x, z: b.z, out, across };
  }

  // The first streets: across the road in at the town's start, and on from it.
  _layFoundingStreets(start) {
    const n = this._founding.at, F = this._frame;
    const dir = [-F.out[0], -F.out[1]], perp = F.across;
    const lay = (d, len) => {
      // as far as the ground allows, a unit at a time
      let k = len;
      while (k >= 1) {
        const c = this.roads.plan([[n.x, n.z], [n.x + d[0] * k, n.z + d[1] * k]]);
        const end = [n.x + d[0] * k, n.z + d[1] * k];
        const steep = resample([[n.x, n.z], end], 0.5).some(([x, z], i, a) => i && (this.waterAt(x, z) || Math.abs(this.terrain.heightAt(x, z) - this.terrain.heightAt(a[i - 1][0], a[i - 1][1])) > 0.3));
        if (!c.reason && !steep && end[0] > 0.5 && end[1] > 0.5 && end[0] < this.N - 0.5 && end[1] < this.N - 0.5) { this.roads.lay(c, { level: 1 }); return; }
        k--;
      }
    };
    lay(perp, 4.5);
    lay([-perp[0], -perp[1]], 4.5);
    lay(dir, 3.5);
    void start;
  }

  _placeFoundingBuildings(start) {
    const opts = { free: true, ignoreMoney: true, ignoreUnlock: true, instant: true };
    const near = { x: this._founding.at.x, z: this._founding.at.z };
    for (const type of ['townhall', 'well', 'builder', 'house', 'house', 'market']) {
      const spot = findPlot(this, type, near, { opts });
      if (spot) this.placeBuilding(type, spot.x, spot.z, { ...opts, a: spot.a });
    }
    void start;
  }

  generateNature(start) {
    const N = this.N, t = this.terrain;
    const rng = new RNG(this.seed + 404);
    const nF = makeNoise2D(this.seed + 303);
    const nK = makeNoise2D(this.seed + 505);
    const open = (x, z) => !this.roadAt(x, z, 0.15) && !this.buildingAt(x, z) && !this.waterAt(x, z);
    const put = (x, z, k, s, r) => { if (open(x, z)) this.addTree(x, z, k, s, r); };
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        if (t.isWater(x, z)) continue;
        const h = t.tileAvg(x, z), slope = t.slope(x, z);
        const forest = fbm(nF, x * 0.085, z * 0.085, 3);
        const dStart = start ? Math.hypot(x - start.x, z - start.z) : 99;
        const nearStart = dStart < 8;
        let p = forest > 0.12 ? 0.5 + forest : 0.035;
        if (nearStart) p *= dStart < 5 ? 0 : 0.2;
        if (rng.chance(p)) {
          const count = forest > 0.35 && !nearStart ? rng.int(2, 3) : 1;
          for (let k = 0; k < count; k++) {
            const pinePref = h > 1.6 ? 0.8 : (nK(x * 0.1, z * 0.1) > 0.2 ? 0.6 : 0.15);
            const kind = rng.chance(pinePref) ? TREE.PINE : (rng.chance(0.2) ? TREE.BIRCH : TREE.ROUND);
            put(x + rng.float(0.15, 0.85), z + rng.float(0.15, 0.85), kind, rng.float(0.7, 1.25), rng.float(0, 6.28));
          }
        } else if (!nearStart && h < 0.35 && rng.chance(0.18)) {
          put(x + rng.float(0.2, 0.8), z + rng.float(0.2, 0.8), TREE.BUSH, rng.float(0.7, 1.2), rng.float(0, 6.28));
        }
        if ((slope > 0.45 || h > 2.2) && rng.chance(0.3)) {
          put(x + rng.float(0.2, 0.8), z + rng.float(0.2, 0.8), TREE.ROCK, rng.float(0.6, 1.4), rng.float(0, 6.28));
        } else if (!nearStart && rng.chance(0.02)) {
          put(x + rng.float(0.2, 0.8), z + rng.float(0.2, 0.8), rng.chance(0.5) ? TREE.ROCK : TREE.PEBBLE, rng.float(0.5, 1), rng.float(0, 6.28));
        }
        if (!nearStart && rng.chance(0.05)) {
          put(x + rng.float(0.2, 0.8), z + rng.float(0.2, 0.8), TREE.BUSH, rng.float(0.6, 1), rng.float(0, 6.28));
        }
      }
    }
  }
}

export function bridgeDeckY() { return CONFIG.WATER_LEVEL + 0.2; }
// length of the approach ramp onto a bridge
export const RAMP = 0.5;

// Point on the middle of a building's front, where it meets the verge.
export function doorPoint(b) {
  const R = plotOf(b);
  const [x, z] = toWorld(R, 0, R.hd);
  return { x, z };
}

export function buildingCenter(b) {
  return { x: b.x, z: b.z };
}

// The seat of government (the town hall, or the Capitol or Parliament it
// grew into), or null.
export function seatOf(w) {
  for (const b of w.buildings.values()) if (BUILDINGS[b.type].seat) return b;
  return null;
}
// The civic quarter round the seat: the civic buildings (def.civic) open and
// on the roads with their middle within CIVIC_QUARTER.reach of the seat's,
// nearest first, the kinds of them there, and what they add to the town's
// taxes (CIVIC_QUARTER.tax a kind). { seat, members: [{ b, d }], kinds, tax }
export function civicQuarter(w, seat = seatOf(w)) {
  const out = { seat, members: [], kinds: [], tax: 0 };
  if (!seat || !isOpen(seat)) return out;
  const s = buildingCenter(seat);
  for (const b of w.buildings.values()) {
    if (!BUILDINGS[b.type].civic || !isOpen(b) || !b.connected) continue;
    const c = buildingCenter(b), d = Math.hypot(c.x - s.x, c.z - s.z);
    if (d <= CIVIC_QUARTER.reach) out.members.push({ b, d });
  }
  out.members.sort((p, q) => p.d - q.d || p.b.id - q.b.id);
  out.kinds = [...new Set(out.members.map(m => m.b.type))];
  out.tax = out.kinds.length * CIVIC_QUARTER.tax;
  return out;
}

// ------------------------------------------------------------ finding plots
// Somewhere for a building of this type near a point, its front SETBACK
// from the middle of a street and facing it (as the town's own builders lay
// out a street): the free spot nearest `near` along the roads within
// opts.r of it (or the best by opts.score(x, z), lower first), { x, z, a,
// chk }, or null. opts.opts: what checkBuild is told (free, ignoreMoney...);
// opts.w, opts.d: the plot's size; opts.step: how finely the roads are
// searched along; opts.test(x, z, a, chk): a further say (before the check,
// chk null; and after it).
export function findPlot(w, type, near, opts = {}) {
  const [w0, d0] = sizeOf(type);
  const W = opts.w ?? w0, D = opts.d ?? d0, r = opts.r ?? 9, step = opts.step ?? 0.125;
  const cands = [];
  for (const e of w.roads.edges.values()) {
    // (only edges coming within r)
    let close = false;
    for (const p of e.pts) if (Math.hypot(p[0] - near.x, p[1] - near.z) < r + 1) { close = true; break; }
    if (!close && !(e.pts.length === 2 && segDist(near.x, near.z, e.pts[0][0], e.pts[0][1], e.pts[1][0], e.pts[1][1]) < r)) continue;
    // (a building that must stand by the water may stand further back, as
    // far as it can and still reach the street, and turned a little: the
    // bank seldom runs along the road)
    const wet = BUILDINGS[type].needsWater;
    const offs = wet ? [0, 0.12, 0.24, 0.36] : [0], turns = wet ? [0, 0.35, -0.35] : [0];
    for (let s = Math.min(W / 2 + 0.3, e.len / 2); s <= e.len - Math.min(W / 2 + 0.3, e.len / 2) + 1e-9; s += step) {
      const p = pointAt(e.pts, e.cum, s), nx = -p[4], nz = p[3];
      for (const sd of [1, -1]) for (const extra of offs) for (const t of turns) {
        const off = SETBACK + D / 2 + extra;
        const x = p[0] + nx * sd * off, z = p[1] + nz * sd * off;
        const dd = Math.hypot(x - near.x, z - near.z);
        if (dd > r) continue;
        cands.push({ x, z, a: angleOf(-nx * sd, -nz * sd) + t, d: (opts.score ? opts.score(x, z) : dd) + Math.abs(t) + extra });
      }
    }
  }
  // and past the end of a road, facing back up it (a cul-de-sac's end: only
  // for a building that must stand by the water, or when asked, opts.ends,
  // as it would stop the road going on)
  if (BUILDINGS[type].needsWater || opts.ends) for (const n of w.roads.nodes.values()) {
    if (n.edges.length !== 1 || n.id === w.entry.node) continue;
    const e = w.roads.edges.get(n.edges[0]), a = w.roads.dirAt(e, n.id) + Math.PI, ux = Math.sin(a), uz = Math.cos(a);
    for (const extra of BUILDINGS[type].needsWater ? [0, 0.12, 0.24, 0.36] : [0]) {
      const off = SETBACK + D / 2 + extra, x = n.x + ux * off, z = n.z + uz * off, dd = Math.hypot(x - near.x, z - near.z);
      if (dd <= r) cands.push({ x, z, a: angleOf(-ux, -uz), d: (opts.score ? opts.score(x, z) : dd) + extra });
    }
  }
  cands.sort((p, q) => p.d - q.d);
  const o = { ...(opts.opts || {}), w: W, d: D };
  for (const c of cands) {
    if (opts.test && !opts.test(c.x, c.z, c.a, null)) continue;
    // (quickly: not on a plot there already)
    if (w.buildingAt(c.x, c.z)) continue;
    const chk = w.checkBuild(type, c.x, c.z, { ...o, a: c.a });
    if (chk.ok && (!opts.test || opts.test(c.x, c.z, c.a, chk))) return { x: Math.round(c.x * 1000) / 1000, z: Math.round(c.z * 1000) / 1000, a: Math.round(c.a * 1000) / 1000, chk };
  }
  return null;
}
