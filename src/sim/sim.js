// Town simulation: time, economy, services, happiness, jobs and migration.

import { CONFIG, ROAD_LEVELS, TITLES, titleFor, seasonOf, DRESSINGS, BOULEVARD, streetPart, lookPart } from '../config.js';
import { BUILDINGS, SERVICES, TRANSIT, servicesOf, needsOf, hasFields, produceOf, researchOf, visitOf } from '../defs.js';
import { RNG, hash2 } from '../util/rng.js';
import { isOpen, capOf, sizeK, householdCap, seatOf, civicQuarter, plotOf } from '../world/world.js';
import { grow, inRect, aabbOf, pointAt } from '../world/geom.js';
import { firstName, lastName } from '../util/names.js';
import { settleDay, startingWealth, yearsOf, eduOf, arrivingEdu, YEAR_DAYS, stageForAge, hasTrait, familyOf, householdsIn } from './people.js';

const SERVICE_KEYS = Object.keys(SERVICES);

// Does a home take another household? (Flats take any number, so there is
// no need to count the ones in.)
const takesHousehold = (w, b) => { const H = householdCap(b); return H === Infinity || householdsIn(w, b) < H; };

// The town's coverage, appeal and pollution are kept as maps of the ground,
// a value for each unit square (as the terrain's mesh is): fields sampled
// where each building stands, not squares anything is built on. A
// building's own value is the one under its middle (cellOf).
export const cellOf = (N, x, z) => Math.min(N - 1, Math.max(0, Math.floor(z))) * N + Math.min(N - 1, Math.max(0, Math.floor(x)));
// (unused: kept so older imports of discOf still find it)
const DISCS = new Map();
export function discOf(w, d, R) {
  const key = (R * 64 + w) * 64 + d;
  let m = DISCS.get(key);
  if (m) return m;
  const cx = w / 2, cz = d / 2, z0 = Math.floor(cz - R - 1), l = [];
  for (let z = z0; z <= Math.ceil(cz + R); z++) {
    for (let x = Math.floor(cx - R - 1); x <= Math.ceil(cx + R); x++) l.push([x, z, Math.hypot(x + 0.5 - cx, z + 0.5 - cz)]);
  }
  l.sort((a, b) => a[2] - b[2]);
  m = { n: l.length, dx: Int16Array.from(l, e => e[0]), dz: Int16Array.from(l, e => e[1]), d: Float64Array.from(l, e => e[2]), rows: [] };
  // and row by row (nearest first in each): for the nearest p tiles of a
  // row, the span they cover and whether they fill it (lie side by side)
  const rows = [];
  for (const e of l) (rows[e[1] - z0] ||= []).push(e);
  for (const row of rows) {
    const z = row[0][1], k = row.length;
    const span = new Int16Array(2 * (k + 1)), ok = new Uint8Array(k + 1);
    let lo = Infinity, hi = -Infinity;
    row.forEach((e, p) => { lo = Math.min(lo, e[0]); hi = Math.max(hi, e[0]); span[2 * p + 2] = lo; span[2 * p + 3] = hi; ok[p + 1] = hi - lo === p ? 1 : 0; });
    m.rows.push({ dz: z, n: k, d: Float64Array.from(row, e => e[2]), dx: Int16Array.from(row, e => e[0]), span, ok });
  }
  DISCS.set(key, m);
  return m;
}

export class Sim {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    const N = this.world.N;
    this.coverage = {};
    for (const s of SERVICE_KEYS) this.coverage[s] = new Uint8Array(N * N);
    this.appeal = new Float32Array(N * N);
    this.pollution = new Float32Array(N * N);
    this._ti = new Int32Array(0);
    this._td = new Float64Array(0);
    this.budget = { income: {}, expense: {}, net: 0 };
    this.demand = { r: 0.5, c: 0.5, i: 0.5 };
    this.jobs = { total: 0, filled: 0 };
    this.housing = { cap: 0, used: 0 };
    this.happiness = 60;
    this.arrivals = [];
    this.rng = new RNG((Math.random() * 1e9) | 0);
    this.dirty = true;
    this._hourAcc = 0;
    const mark = () => { this.dirty = true; };
    for (const e of ['building:add', 'building:remove', 'building:change', 'building:refit', 'roads', 'trees', 'rails', 'lines', 'dress', 'fields']) this.world.on(e, mark);
    this.world.on('building:remove', (b) => this._onRemoved(b));
    this.world.on('building:vacate', (b) => { this.dirty = true; this._onRemoved(b); });
    this.world.on('building:shrink', (b) => this._onShrunk(b));
  }

  get speed() { return this.game.speed; }

  // ------------------------------------------------------------------ time
  update(dt) {
    const w = this.world;
    if (this.dirty) this.recompute();
    const speed = this.speed;
    if (!speed) return 0;
    const dh = (dt * speed * 24) / CONFIG.DAY_SECONDS;
    const prevH = w.hours;
    w.hours += dh;
    this._hourAcc += dh;
    while (this._hourAcc >= 1) { this._hourAcc -= 1; this.hourly(); }
    // scheduled arrivals
    for (let i = this.arrivals.length - 1; i >= 0; i--) {
      const a = this.arrivals[i];
      if (a.day === w.day && w.hours >= a.t) { this.arrivals.splice(i, 1); this._arrive(a); }
    }
    if (w.hours >= 24) {
      w.hours -= 24;
      w.day++;
      this.daily();
    }
    if (prevH < 12 && w.hours >= 12) this.game.emit('noon');
    return dh;
  }

  hourly() {
    const w = this.world;
    w.money += this.budget.net / 24;
  }

  daily() {
    const w = this.world;
    this.recompute();
    w.history.push({ day: w.day - 1, pop: w.population, money: Number.isFinite(w.money) ? Math.round(w.money) : null, happy: Math.round(this.happiness), net: Math.round(this.budget.net + w.stats.todayVisitIncome) });
    if (w.history.length > 400) w.history.shift();
    w.stats.todayVisitIncome = 0;
    const life = this.ageDay();
    if (life.born.length) this.game.emit('born', life.born);
    if (life.died.length) this.game.emit('died', life.died);
    settleDay(w);
    w.addResearch(this.researchRate());
    w.encroachPass(() => this.rng.next());
    this.planMigration();
    this.game.emit('day', w.day);
    const s = seasonOf(w.day), ps = seasonOf(w.day - 1);
    if (s !== ps) this.game.emit('season', s);
  }

  // ------------------------------------------------------------ recompute
  recompute() {
    this.dirty = false;
    this._links();
    this.assignSchools();
    this.assignJobs();
    // after the jobs: what works depends on who is there to work it
    this._coverage();
    this._happiness();
    this._budget();
    this._demand();
    this._milestones();
  }

  _links() {
    const w = this.world;
    for (const b of w.buildings.values()) { b.residents = []; b.workers = []; }
    for (const r of w.residents.values()) {
      const h = r.home != null ? w.buildings.get(r.home) : null;
      if (h) h.residents.push(r.id); else r.home = null;
      const j = r.job != null ? w.buildings.get(r.job) : null;
      if (j) j.workers.push(r.id); else r.job = null;
    }
  }

  _coverage() {
    const w = this.world, N = w.N;
    for (const s of SERVICE_KEYS) this.coverage[s].fill(0);
    this.appeal.fill(0);
    this.pollution.fill(0);
    // Utilities. Power: generators (and their crews) feed every
    // road-connected building through the street wires. Water: wells and
    // pumps can only draw for so many people. Short on either and some
    // buildings go without.
    let wSup = 0, pGen = 0, pDem = 0;
    for (const b of w.buildings.values()) {
      if (!isOpen(b) || !b.connected) continue;
      const def = BUILDINGS[b.type], L = def.levels[b.level];
      if (L.kw) pGen += L.kw * sizeK(b) * this.staffOf(b);
      else if (!def.park) pDem += 0.5 + 0.2 * capOf(b, 'housing') + 0.25 * capOf(b, 'jobs');
    }
    pGen = Math.round(pGen);
    this.powerShare = pGen ? Math.min(1, pDem ? pGen / pDem : 1) : 0;
    const P = this.coverage.power;
    for (const b of w.buildings.values()) {
      const L = BUILDINGS[b.type].levels[b.level];
      b.powered = !!(isOpen(b) && b.connected && this.powerShare > 0 && (L.kw || hash2(b.id, 11, 5) < this.powerShare));
      if (!b.powered) continue;
      this._mark(P, grow(plotOf(b), 1));
    }
    // Water: wells, towers and pumps (some need power and hands too) feed
    // the mains under the streets, which reach every road-connected building
    for (const b of w.buildings.values()) {
      const def = BUILDINGS[b.type];
      if (!servicesOf(def).includes('water') || !isOpen(b) || !b.connected) continue;
      wSup += this.supplyOf(b);
    }
    wSup = Math.round(wSup);
    this.utility = { water: { supply: wSup, demand: w.population }, power: { gen: pGen, demand: Math.round(pDem) } };
    this.waterShare = w.population ? Math.min(1, wSup / w.population) : 1;
    // what every building can do with what it has, then the services,
    // scenery and smoke that come of it
    for (const b of w.buildings.values()) this._working(b);
    // the mains (for the water overlay): every connected street, and the
    // buildings with running water
    const Wc = this.coverage.water;
    if (wSup > 0) for (const e of w.roads.edges.values()) if (w.connected.has(e.a)) this._along(e, 0.5, (i) => { Wc[i] = 1; });
    for (const b of w.buildings.values()) {
      if (b.wet !== 2) continue;
      this._mark(Wc, plotOf(b));
    }
    const A = this.appeal, Pol = this.pollution;
    for (const b of w.buildings.values()) {
      if (!isOpen(b)) continue;
      const def = BUILDINGS[b.type], L = def.levels[b.level];
      const reach = this.reachOf(b), sv = servicesOf(def).filter(s => s !== 'water');
      if (b.connected && reach && sv.length) this._cover(b, reach, sv.map(s => this.coverage[s]));
      // a grand monument brings culture to the streets round it too
      if (b.connected && L.culture && b.working > 0) this._cover(b, L.culture, [this.coverage.culture]);
      // a park's fountain may be off; homes and orchards keep their looks
      const look = def.park ? b.working : 1;
      if ((def.park || L.appeal) && look > 0) {
        const n = this._within(b, L.radius), ti = this._ti, td = this._td, a = L.appeal * look, out = L.radius + 1;
        for (let k = 0; k < n; k++) A[ti[k]] += a * (1 - td[k] / out);
      }
      // stopped works smoke far less
      const fumes = 16 * (0.3 + 0.7 * Math.min(1, b.working));
      if (L.pollution) {
        const n = this._within(b, L.pollution), ti = this._ti, td = this._td, out = L.pollution + 1;
        for (let k = 0; k < n; k++) Pol[ti[k]] += fumes * (1 - td[k] / out);
      }
    }
    this._lights();
    // streets with their power lines underground look tidier
    // (a unit of street at a time, over the ground either side of it)
    const beside = (e, a) => this._along(e, 1, (i) => {
      const x = i % N, z = (i / N) | 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, nz = z + dz;
        if (nx >= 0 && nz >= 0 && nx < N && nz < N) this.appeal[nz * N + nx] += a;
      }
    });
    for (const e of w.roads.edges.values()) if (e.buried) beside(e, 0.8);
    // dressed streets cheer the homes and shops beside them (lamps only
    // as much as the town can light them), and a boulevard a little before
    // it has any look of its own
    for (const e of w.roads.edges.values()) {
      const v = e.dress, D = DRESSINGS[streetPart(v)], E = DRESSINGS[lookPart(v)];
      if (!D && !E) continue;
      const a = (D ? D.appeal * (D.key === 'lamps' ? 0.4 + 0.6 * (this.lampShare ?? 0) : 1) : 0) + (E ? E.appeal : 0);
      beside(e, a);
    }
    void BOULEVARD;
    // trees and water make places pleasant
    const TC = this._tc && this._tc.length === N * N ? this._tc.fill(0) : (this._tc = new Uint8Array(N * N));
    for (const tr of w.trees) { const i = cellOf(N, tr.x, tr.z); if (TC[i] < 255) TC[i]++; }
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
      const tc = TC[z * N + x];
      if (tc) {
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, nz = z + dz;
          if (nx >= 0 && nz >= 0 && nx < N && nz < N) this.appeal[nz * N + nx] += Math.min(3, tc) * (dx || dz ? 0.35 : 0.6);
        }
      }
    }
  }

  // The squares of ground whose middles lie within r of building b's
  // middle, into this._ti (index) and this._td (distance); returns how many.
  _within(b, r) {
    if (!(r >= 0)) return 0;
    const N = this.world.N, cx = b.x, cz = b.z;
    const x0 = Math.max(0, Math.floor(cx - r - 0.5)), x1 = Math.min(N - 1, Math.ceil(cx + r)), z0 = Math.max(0, Math.floor(cz - r - 0.5)), z1 = Math.min(N - 1, Math.ceil(cz + r));
    const most = Math.max(0, (x1 - x0 + 1) * (z1 - z0 + 1));
    if (this._ti.length < most) { this._ti = new Int32Array(most); this._td = new Float64Array(most); }
    const ti = this._ti, td = this._td;
    let n = 0;
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, z + 0.5 - cz);
      if (d <= r) { ti[n] = z * N + x; td[n] = d; n++; }
    }
    return n;
  }

  // Mark the same squares in each of the maps (coverage).
  _cover(b, r, maps) {
    const n = this._within(b, r), ti = this._ti;
    for (const C of maps) for (let k = 0; k < n; k++) C[ti[k]] = 1;
  }

  // Mark the squares of ground a rectangle covers (their middles in it).
  _mark(C, R) {
    const N = this.world.N, [x0, z0, x1, z1] = aabbOf(R);
    for (let z = Math.max(0, Math.floor(z0)); z <= Math.min(N - 1, Math.floor(z1)); z++) for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(N - 1, Math.floor(x1)); x++) {
      if (inRect(R, x + 0.5, z + 0.5, 0.5)) C[z * N + x] = 1;
    }
  }
  // Call fn with the index of the square under each point every step along
  // a road edge (each square once).
  _along(e, step, fn) {
    const N = this.world.N, seen = new Set();
    for (let s = 0; s <= e.len + 1e-9; s += step) {
      const p = pointAt(e.pts, e.cum, s), i = cellOf(N, p[0], p[1]);
      if (!seen.has(i)) { seen.add(i); fn(i); }
    }
  }

  // People a well, tower or pump draws water for: less without its crew
  // (a tower still holds some) or the power its pumps need.
  supplyOf(b) {
    const L = BUILDINGS[b.type].levels[b.level], np = needsOf(b.type, b.level).power;
    return (L.supply || 0) * sizeK(b) * (0.3 + 0.7 * this.staffOf(b)) * (np && !b.powered ? np.without : 1);
  }

  // Share of a workplace's jobs that are filled (1 for buildings with no jobs).
  staffOf(b) {
    const jobs = capOf(b, 'jobs');
    return jobs ? Math.min(1, b.workers.length / jobs) : 1;
  }

  // Running water at a building: 0 not on the mains (not connected to the
  // town's roads, or no well or pump in town), 1 on the mains but the town's
  // water runs short here, 2 running water.
  waterAt(b) {
    if (!b.connected || !this.utility || !this.utility.water.supply) return 0;
    return hash2(b.id, 3, 9) < this.waterShare ? 2 : 1;
  }

  // How well a building can do its job, b.working (1 fully, 0 stopped), and
  // what holds it back, b.blockers: 'road', 'workers', 'power', 'water'.
  // Production, income, service reach, school places, utility output,
  // upgrades and the lights in the world all go by this (see NEEDS).
  _working(b) {
    const def = BUILDINGS[b.type], L = def.levels[b.level];
    const bl = b.blockers = [];
    b.staff = this.staffOf(b);
    b.wet = this.waterAt(b);
    if (!isOpen(b)) { b.working = 0; return; }
    if (!b.connected && (b.access || !def.park)) { b.working = 0; bl.push('road'); return; }
    let k = 1;
    const need = needsOf(b.type, b.level);
    if (capOf(b, 'jobs') && need.staff) {
      if (b.staff < 0.5) bl.push('workers');
      k *= b.staff;
    }
    if (need.power && !b.powered) { bl.push('power'); k *= need.power.without; }
    // homes need running water to grow; some trades and services to work
    if ((need.water || L.housing) && b.wet < 2) { bl.push('water'); if (need.water) k *= need.water.without; }
    b.working = k;
  }

  // How far a service reaches: all of its radius when it is fully staffed
  // and supplied, down to half as it struggles, nothing once it stops.
  reachOf(b) {
    const L = BUILDINGS[b.type].levels[b.level], k = b.working ?? 1;
    return L.radius && k > 0 ? L.radius * (0.5 + 0.5 * Math.min(1, k)) : 0;
  }

  // School places: as many as its teachers can manage (and a university
  // without power has fewer laboratories to offer).
  seatsOf(b) {
    const np = needsOf(b.type, b.level).power;
    return Math.ceil(capOf(b, 'seats') * this.staffOf(b) * (np && b.powered === false ? np.without : 1));
  }

  // Street lamps run on electricity: all lit when the town has enough, some
  // when it is short, none without. Tells the view when that changes.
  _lights() {
    const share = Math.round(this.powerShare * 20) / 20;
    if (share === this.lampShare) return;
    this.lampShare = share;
    this.world.emit('power', this);
  }

  lampLit(x, z) {
    const s = this.lampShare ?? 0;
    return s >= 1 || (s > 0 && hash2(Math.floor(x * 4), Math.floor(z * 4), 13) < s);
  }

  _happiness() {
    const w = this.world, N = w.N;
    const tax = w.taxRate;
    let total = 0, count = 0;
    // the open buildings a home may have nearby, found once: shops and pubs,
    // places to play, stops. near(): is one of them (not the home itself)
    // within radius of the home's middle, or for a place to play, does its
    // own reach (its level's radius) take the home in?
    const shops = [], play = [], stops = [], potter = [];
    for (const o of w.buildings.values()) {
      if (!isOpen(o)) continue;
      const def = BUILDINGS[o.type];
      if (!(def.shop || def.leisure || def.play || def.stop || def.potter)) continue;
      const at = { o, x: o.x, z: o.z, r: (def.levels[o.level].radius || 0) + 0.5 };
      if (def.shop || def.leisure) shops.push(at);
      if (def.play) play.push(at);
      if (def.potter) potter.push(at);
      if (def.stop) stops.push(at);
    }
    const near = (list, b, radius) => {
      const cx = b.x, cz = b.z;
      for (const p of list) if (p.o !== b && Math.hypot(p.x - cx, p.z - cz) <= (radius ?? p.r)) return true;
      return false;
    };
    for (const b of w.buildings.values()) {
      const def = BUILDINGS[b.type];
      if (!def.levels[b.level].housing) continue;
      const i = cellOf(N, b.x, b.z);
      const f = {};
      let h = 42;
      for (const s of SERVICE_KEYS) f[s] = !!this.coverage[s][i];
      // water comes through the mains; when it runs short some homes go dry
      f.water = b.wet === 2;
      if (b.wet === 1) f.dry = true;
      f.power = !!b.powered;
      // every contribution is recorded as [key, points, best possible] for the UI
      const parts = f.parts = [['base', 42, 42]];
      const add = (key, v, max) => { parts.push([key, Math.round(v * 10) / 10, max]); h += v; };
      add('water', f.water ? 10 : 0, 10);
      add('health', f.health ? 9 : 0, 9);
      add('education', f.education ? 8 : 0, 8);
      add('safety', f.safety ? 7 : 0, 7);
      add('culture', f.culture ? 6 : 0, 6);
      add('power', f.power ? 4 : 0, 4);
      f.appeal = Math.min(16, this.appeal[i] * 0.8);
      add('appeal', f.appeal, 16);
      f.shops = near(shops, b, 7);
      add('shops', f.shops ? 5 : 0, 5);
      // somewhere for the children to play, for homes with children
      if (b.residents.some(id => { const r = w.residents.get(id); return r && r.age === 'child'; })) {
        f.play = near(play, b);
        add('play', f.play ? 4 : 0, 4);
      }
      // ...and an allotment to dig, for homes with elders
      if (b.residents.some(id => { const r = w.residents.get(id); return r && r.age === 'elder'; })) {
        f.potter = near(potter, b);
        add('potter', f.potter ? 3 : 0, 3);
      }
      f.transit = near(stops, b, 4);
      add('transit', f.transit ? 3 : 0, 3);
      f.pollution = Math.min(22, this.pollution[i]);
      add('pollution', -f.pollution, 0);
      // land deals: a bigger garden, or money in the bank for the seller
      f.land = b.leases && b.leases.length ? (b.leases.some(l => l.buyer) ? 'buyer' : 'seller') : null;
      if (f.land) add('land', f.land === 'buyer' ? 3 : 2, 3);
      f.tax = tax > 10 ? -(tax - 10) * 1.6 : (10 - tax) * 0.8;
      add('tax', f.tax, 8);
      let adults = 0, unemployed = 0;
      for (const rid of b.residents) {
        const r = w.residents.get(rid);
        if (r && r.age === 'adult' && r.school == null) { adults++; if (!r.job) unemployed++; }
      }
      f.unemployed = adults ? unemployed / adults : 0;
      f.crowded = b.residents.length > capOf(b, 'housing');
      add('crowded', f.crowded ? -6 : 0, 0);
      add('jobs', -f.unemployed * 14, 0);
      f.connected = b.connected;
      add('road', b.connected ? 0 : -25, 0);
      b.happiness = Math.max(0, Math.min(100, Math.round(h)));
      b.factors = f;
      total += b.happiness * b.residents.length;
      count += b.residents.length;
    }
    this.happiness = count ? total / count : 60;
    for (const r of w.residents.values()) {
      const h = r.home != null ? w.buildings.get(r.home) : null;
      r.mood = h ? h.happiness + (r.age === 'adult' ? (r.job ? 4 : r.school != null ? 0 : -8) : 0) : 30;
    }
  }

  // Research points per day, and where they come from: town halls, schools,
  // chapels and the like (by level, and only while working), plus one point
  // for every 60 villagers.
  researchSources() {
    const w = this.world, by = new Map();
    for (const b of w.buildings.values()) {
      // (a grand park keeps the research of the botanic gardens it grew from)
      const src = researchOf(b);
      if (!src || !isOpen(b) || !b.connected) continue;
      const p = Math.round(src * sizeK(b) * Math.min(1, b.working ?? 1));
      if (p <= 0) continue;
      const name = BUILDINGS[b.type].levels[b.level].name;
      if (!by.has(name)) by.set(name, { name, n: 0, points: 0 });
      const e = by.get(name);
      e.n++; e.points += p;
    }
    const out = [...by.values()].sort((a, b) => b.points - a.points);
    const v = Math.floor(w.population / 60);
    if (v) out.push({ name: 'Villagers', n: 0, points: v });
    return out;
  }
  researchRate() { return this.researchSources().reduce((n, s) => n + s.points, 0); }

  // Pupils fill the nearest schools with room; the oldest children get
  // places first (they're closest to finishing).
  assignSchools() {
    const w = this.world;
    const schools = [...w.buildings.values()].filter(b => BUILDINGS[b.type].levels[b.level].seats && isOpen(b) && b.connected);
    // places for as many as the teachers can manage, and the stage each teaches
    const left = schools.map(s => this.seatsOf(s));
    const stage = schools.map(s => BUILDINGS[s.type].levels[s.level].teaches || 1);
    for (const s of schools) s.pupils = [];
    // children go to the stage that fits their age; some young adults go on
    // to college or university instead of working
    const want = [];
    for (const r of w.residents.values()) {
      const y = yearsOf(r);
      if (r.age === 'child') { const st = stageForAge(y); if (st) want.push([r, st]); else r.school = null; continue; }
      const keen = hash2(r.id, 41, 3) < (hasTrait(r, 'bookish') ? 0.8 : 0.5);
      const still = r.school != null && w.buildings.get(r.school);
      if (r.age === 'adult' && (still || (keen && r.job == null))) {
        if (eduOf(r) === 3 && y < 24) { want.push([r, 4]); continue; }
        if (eduOf(r) === 4 && y >= 21 && y < 32) { want.push([r, 5]); continue; }
      }
      r.school = null;
    }
    // students who already have a place keep it; then the oldest first
    want.sort((a, b) => (b[0].school != null) - (a[0].school != null) || yearsOf(b[0]) - yearsOf(a[0]));
    const stats = { kids: 0, placed: 0, seats: left.reduce((n, k) => n + k, 0), short: [0, 0, 0, 0, 0, 0], students: 0 };
    for (const [r, st] of want) {
      if (r.age === 'child') stats.kids++;
      const home = r.home != null ? w.buildings.get(r.home) : null;
      const prev = r.school;
      r.school = null;
      if (!home) continue;
      let k = -1, bd = Infinity;
      for (let j = 0; j < schools.length; j++) {
        if (stage[j] !== st || !left[j]) continue;
        const s = schools[j];
        const d = (s.id === prev ? -100 : 0) + Math.abs(s.x - home.x) + Math.abs(s.z - home.z);
        if (d < bd) { bd = d; k = j; }
      }
      if (k < 0) { if (r.age === 'child') stats.short[st]++; continue; }
      const best = schools[k];
      left[k]--;
      best.pupils.push(r.id);
      r.school = best.id;
      if (r.age === 'child') stats.placed++; else { stats.students++; if (r.job != null) r.job = null; }
    }
    this.schooling = stats;
  }

  // A day of life: everyone ages; at each birthday children learn at their
  // school, grow up at 18, retire at 65; the old may pass away and young
  // couples may have a baby.
  ageDay() {
    const w = this.world, rng = this.rng, ag = this.game.agents;
    const born = [], died = [];
    // everyone by household (fam, or their own id), in the order they're
    // listed: made when first needed, then kept up to date as babies arrive
    // and grown-up children move out. The names already taken, likewise.
    const key = (o) => o.fam ?? o.id;
    let fams = null, names = null;
    const famOf = (r) => {
      if (!fams) {
        fams = new Map();
        for (const o of w.residents.values()) { const l = fams.get(key(o)); if (l) l.push(o); else fams.set(key(o), [o]); }
      }
      return fams.get(key(r));
    };
    for (const r of [...w.residents.values()]) {
      const before = Math.floor(yearsOf(r));
      r.years = yearsOf(r) + 1 / YEAR_DAYS;
      const y = Math.floor(r.years);
      if (y === before) continue;
      eduOf(r);
      // a year at school: finish a stage after enough years at it
      const s = r.school != null ? w.buildings.get(r.school) : null;
      if (s) {
        const st = BUILDINGS[s.type].levels[s.level].teaches || 1;
        r.edYrs = r.edYrs || {};
        r.edYrs[st] = (r.edYrs[st] || 0) + 1;
        const need = { 1: 4, 2: 2, 3: 3, 4: 3, 5: 2 }[st];
        if (r.edYrs[st] >= need && eduOf(r) === st - 1) {
          r.edu = st;
          if (st >= 4) { r.school = null; this.game.emit('graduated', { r, st }); }
        }
      }
      if (r.age === 'child') {
        if (y >= 18) {
          r.age = 'adult'; r.school = null; r.wealth = 0; ag?.refreshLook(r);
          // grown-up children often move out to a home of their own (they keep the family name)
          const home = r.home != null ? w.buildings.get(r.home) : null;
          const crowded = home && home.residents.length >= capOf(home, 'housing');
          if (crowded || rng.chance(0.4)) {
            const to = this._vacantWhere(v => v !== home && v.residents.length < capOf(v, 'housing'));
            if (to) {
              if (home) home.residents.splice(home.residents.indexOf(r.id), 1);
              const was = key(r);
              r.home = to.id; r.fam = r.id;
              if (fams && was !== r.id) {
                const l = fams.get(was);
                l.splice(l.indexOf(r), 1);
                // a household of their own (anyone already in it, from an odd old save, in order)
                fams.set(r.id, fams.get(r.id)?.length ? [...w.residents.values()].filter(o => key(o) === r.id) : [r]);
              }
              to.residents.push(r.id);
              ag?.relocate(r);
              this.dirty = true;
            }
          }
        }
      } else if (r.age === 'adult') {
        if (y >= 65) { r.age = 'elder'; r.job = null; ag?.refreshLook(r); }
        else if (y >= 20 && y <= 42 && r.home != null) {
          const home = w.buildings.get(r.home);
          const fam = famOf(r);
          // a growing family can squeeze one more in (crowded homes are less
          // happy), but not without running water
          const room = home && isOpen(home) && home.residents.length < capOf(home, 'housing') + 1 && (home.wet ?? 2) === 2;
          // one chance a year per household, taken by its youngest grown-up
          const youngest = fam.filter(o => o.age === 'adult').sort((a, b) => yearsOf(a) - yearsOf(b))[0];
          if (room && youngest === r && fam.length < 8 && rng.chance(0.16)) {
            names ||= this.namesInUse();
            const baby = { id: w.newId(), first: firstName(rng, names.first), last: r.last, age: 'child', years: 0, edu: 0, home: r.home, job: null, look: (rng.next() * 1e9) | 0, mood: 60, fam: r.fam ?? r.id, wealth: 0 };
            w.residents.set(baby.id, baby);
            names.first.add(baby.first); names.last.add(baby.last);
            fam.push(baby);
            home.residents.push(baby.id);
            born.push(baby);
          }
        }
      } else if (y >= 72 && rng.chance(Math.min(0.5, (y - 70) * 0.03))) died.push(r);
    }
    for (const r of died) {
      ag?.remove(r);
      w.residents.delete(r.id);
      // children left with no grown-up at home go to live with relatives elsewhere
      const kin = [...w.residents.values()].filter(o => o.home === r.home);
      if (kin.length && kin.every(o => o.age === 'child')) ag?.depart(kin.map(o => o.id));
    }
    if (born.length || died.length) this.dirty = true;
    return { born, died };
  }

  jobsOf(b) { return isOpen(b) ? capOf(b, 'jobs') : 0; }

  assignJobs() {
    const w = this.world;
    const open = [];
    let total = 0, filled = 0;
    this.jobsNeedingSkill = 0;
    for (const b of w.buildings.values()) {
      const j = this.jobsOf(b);
      // a building with no jobs (any more) lets its old workers go
      if (!j) { for (const rid of b.workers) { const r = w.residents.get(rid); if (r) r.job = null; } b.workers = []; continue; }
      total += j;
      const need = BUILDINGS[b.type].levels[b.level].edu || 0;
      // workers without the schooling this job now needs are let go
      if (need) for (const rid of [...b.workers]) { const r = w.residents.get(rid); if (r && eduOf(r) < need) { b.workers.splice(b.workers.indexOf(rid), 1); r.job = null; } }
      // drop surplus workers after a downgrade / disconnection
      while (b.workers.length > j || (!b.connected && b.workers.length)) {
        const rid = b.workers.pop();
        const r = w.residents.get(rid);
        if (r) r.job = null;
      }
      filled += b.workers.length;
      if (b.connected && b.workers.length < j) open.push(b);
    }
    // each open workplace's jobs, the schooling they need, and whether it
    // builds (none of which changes while people are hired)
    const jobs = open.map(b => this.jobsOf(b)), skill = open.map(b => BUILDINGS[b.type].levels[b.level].edu || 0), yard = open.map(b => !!BUILDINGS[b.type].builders);
    if (open.length) {
      for (const r of w.residents.values()) {
        if (r.age !== 'adult' || r.job || r.home == null || r.school != null) continue;
        const home = w.buildings.get(r.home);
        if (!home || !home.connected) continue;
        let best = null, bd = Infinity, edu = -1;
        for (let k = 0; k < open.length; k++) {
          const b = open[k];
          if (b.workers.length >= jobs[k]) continue;
          if (edu < 0) edu = eduOf(r);
          if (edu < skill[k]) continue;
          // builders are hired first: nothing gets built without them; then
          // places with nobody at all, so as few as possible stand idle
          const d = Math.abs(b.x - home.x) + Math.abs(b.z - home.z) + this.rng.next() * 3 - (yard[k] ? 1000 : 0) - (b.workers.length ? 0 : 12);
          if (d < bd) { bd = d; best = b; }
        }
        if (!best) continue;
        r.job = best.id;
        best.workers.push(r.id);
        filled++;
      }
    }
    open.forEach((b, k) => { if (b.workers.length < jobs[k] && skill[k]) this.jobsNeedingSkill += jobs[k] - b.workers.length; });
    this.jobs = { total, filled };
  }

  _budget() {
    const w = this.world;
    const inc = { taxes: 0, commerce: 0, industry: 0 };
    const exp = { services: 0, buildings: 0, roads: 0, transit: 0 };
    // the seat's own bonus, and its civic quarter's
    const seat = seatOf(w), quarter = civicQuarter(w, seat);
    const bonus = (seat ? BUILDINGS[seat.type].levels[seat.level].taxBonus || 0 : 0) + quarter.tax;
    const tk = (w.taxRate / 10) * (1 + bonus);
    for (const r of w.residents.values()) {
      const home = r.home != null ? w.buildings.get(r.home) : null;
      const hk = home ? (BUILDINGS[home.type].levels[home.level].tax ?? 1 + 0.25 * home.level) : 1;
      if (r.age === 'adult') inc.taxes += (r.job ? 6 * hk : 1) * tk;
      else if (r.age === 'elder') inc.taxes += 1.5 * tk;
    }
    for (const b of w.buildings.values()) {
      if (!isOpen(b)) continue;
      const def = BUILDINGS[b.type], L = def.levels[b.level];
      const v = this.incomeOf(b);
      if (v) { if (def.cat === 'industry') inc.industry += v; else inc.commerce += v; }
      if (L.upkeep) {
        if (def.cat === 'services' || def.cat === 'transit') exp.services += Math.round(L.upkeep * sizeK(b));
        else exp.buildings += Math.round(L.upkeep * sizeK(b));
      }
    }
    // (a road's upkeep, and its dressing's, by its length)
    for (const e of w.roads.edges.values()) exp.roads += e.len * (ROAD_LEVELS[e.level].upkeep + (e.dress ? (DRESSINGS[streetPart(e.dress)]?.upkeep || 0) + (DRESSINGS[lookPart(e.dress)]?.upkeep || 0) : 0));
    for (const e of w.rails.edges.values()) exp.roads += e.len * 0.25;
    for (const line of w.lines) exp.transit += TRANSIT[line.mode].upkeep * line.vehicles;
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    this.budget = { income: inc, expense: exp, net: sum(inc) - sum(exp), totalIn: sum(inc), totalOut: sum(exp) };
  }

  // A workplace's takings per day: jobs × pay × how well it works (its
  // staff, power and water), a little more with electric light and tools.
  incomeOf(b) {
    const def = BUILDINGS[b.type], L = def.levels[b.level];
    if (!L.income || !isOpen(b)) return 0;
    let v = capOf(b, 'jobs') * Math.min(1, b.working ?? 1) * L.income * (b.powered ? 1.15 : 1) * (hasFields(b.type) ? produceOf(b).income : 1);
    if (def.nearTrees && v) v *= 0.6 + Math.min(1, this._treesNear(b, 3) / 18) * 0.8;
    return v;
  }

  _treesNear(b, r) {
    const R = grow(plotOf(b), r);
    return this.world.treeIx.query(aabbOf(R)).filter(tr => inRect(R, tr.x, tr.z)).length;
  }

  _demand() {
    const w = this.world;
    let cap = 0, used = 0, open = 0, comm = 0, ind = 0, adults = 0;
    for (const b of w.buildings.values()) {
      if (!isOpen(b)) continue;
      const def = BUILDINGS[b.type], L = def.levels[b.level];
      if (L.housing) { cap += capOf(b, 'housing'); used += b.residents.length; if (takesHousehold(w, b)) open += capOf(b, 'housing') - b.residents.length; }
      if (def.cat === 'commercial') comm += capOf(b, 'jobs');
      if (def.cat === 'industry') ind += capOf(b, 'jobs');
    }
    for (const r of w.residents.values()) if (r.age === 'adult') adults++;
    this.housing = { cap, used, open };   // open: room where a new household can move in
    const pop = w.population;
    const freeJobs = this.jobs.total - this.jobs.filled;
    const vacancy = open;
    const cl = (v) => Math.max(0, Math.min(1, v));
    this.demand = {
      r: cl(0.5 + (freeJobs - vacancy) / 16 + (this.happiness - 55) / 120),
      c: cl(0.5 + (pop * 0.13 + 2 - comm) / 10),
      i: cl(0.5 + (adults * 0.5 - ind) / 12),
    };
  }

  _milestones() {
    const w = this.world;
    const t = titleFor(w.population);
    const idx = TITLES.indexOf(t);
    if (idx > w.titleIdx) {
      w.titleIdx = idx;
      this.game.emit('milestone', t);
    }
  }

  // ------------------------------------------------------------ migration
  vacantHomes() {
    const w = this.world, out = [];
    for (const b of w.buildings.values()) {
      const L = BUILDINGS[b.type].levels[b.level];
      if (L.housing && b.connected && isOpen(b) && b.residents.length < capOf(b, 'housing') && takesHousehold(w, b)) out.push(b);
    }
    return out;
  }

  // The first of vacantHomes() that pred accepts (without listing them all).
  _vacantWhere(pred) {
    const w = this.world;
    for (const b of w.buildings.values()) {
      const L = BUILDINGS[b.type].levels[b.level];
      if (L.housing && b.connected && isOpen(b) && b.residents.length < capOf(b, 'housing') && takesHousehold(w, b) && pred(b)) return b;
    }
    return undefined;
  }

  planMigration() {
    const w = this.world, rng = this.rng;
    this._settleHouseholds();
    const vac = this.vacantHomes().filter(b => b.happiness >= 38);
    const freeJobs = this.jobs.total - this.jobs.filled;
    const attract = Math.max(0, Math.min(1, (this.happiness - 38) / 40)) * 0.6 + (freeJobs > 0 ? 0.45 : 0.08);
    // each newcomer household takes a home of its own, so more of them come
    let n = Math.min(vac.length, Math.round(rng.next() * 0.8 + vac.length * attract * CONFIG.ARRIVE_RATE), CONFIG.ARRIVE_MAX);
    if (w.population < 8 && vac.length) n = Math.max(n, 1);
    for (let k = 0; k < n; k++) {
      const b = vac[k % vac.length];
      this.arrivals.push({ day: w.day, t: rng.float(7.5, 17.5), home: b.id });
    }
    // unhappy households may leave
    for (const b of w.buildings.values()) {
      if (!BUILDINGS[b.type].levels[b.level].housing || !b.residents.length) continue;
      if (b.happiness < 28 && rng.chance(0.35)) {
        const leaving = b.residents.slice(0, Math.max(1, Math.ceil(b.residents.length / 2)));
        this.game.agents.depart(leaving);
        this.game.emit('departed', { building: b, count: leaving.length });
      }
    }
  }

  // Names already taken, so newcomers get fresh ones (relatives still share a surname).
  namesInUse() {
    const first = new Set(), last = new Set();
    for (const r of this.world.residents.values()) { first.add(r.first); last.add(r.last); }
    return { first, last };
  }

  makeFamily(home, maxSize) {
    const w = this.world, rng = this.rng;
    const used = this.namesInUse();
    const last = lastName(rng, used.last);
    const fam = [];
    // a single-family home takes one big family that all but fills it (a
    // cottage three, a family house five or six, a villa six to eight);
    // flats take anyone
    const H = householdCap(home);
    let size;
    if (Number.isFinite(H)) {
      const S = Math.min(8, Math.max(2, Math.round(capOf(home, 'housing') / H)));
      const hi = Math.max(1, Math.min(S, maxSize)), lo = Math.min(hi, Math.max(2, Math.ceil(S * 0.75)));
      size = rng.int(lo, hi);
    } else size = Math.max(1, Math.min(maxSize, rng.chance(0.25) ? 1 : rng.int(2, 4)));
    for (let k = 0; k < size; k++) {
      let age = 'adult';
      // past the first two: children, and in a big family grown-up sons and
      // daughters, a brother or sister, a grandparent
      if (k >= 2) age = rng.chance(size >= 4 ? CONFIG.FAMILY_KIDS_BIG : CONFIG.FAMILY_KIDS) ? 'child' : rng.chance(0.65) ? 'adult' : 'elder';
      else if (k === 1 && rng.chance(0.15)) age = 'elder';
      if (size === 1 && rng.chance(0.25)) age = 'elder';
      const r = { id: w.newId(), first: firstName(rng, used.first), last, age, home: home.id, job: null, look: (rng.next() * 1e9) | 0, mood: 60 };
      r.years = age === 'child' ? rng.int(0, 16) : age === 'elder' ? rng.int(65, 82) : rng.int(19, 58);
      r.edu = age === 'child' ? (r.years >= 12 ? 1 : 0) : arrivingEdu(w, rng);
      r.fam = fam.length ? fam[0].id : r.id;
      r.wealth = startingWealth(r, home);
      w.residents.set(r.id, r);
      home.residents.push(r.id);
      used.first.add(r.first);
      fam.push(r);
    }
    return fam;
  }

  _arrive(a) {
    const w = this.world;
    const b = w.buildings.get(a.home);
    if (!b || !b.connected || !isOpen(b)) return;
    const L = BUILDINGS[b.type].levels[b.level];
    const room = capOf(b, 'housing') - b.residents.length;
    if (room <= 0 || householdsIn(w, b) >= householdCap(b)) return;
    const fam = this.makeFamily(b, room);
    w.stats.arrivals += fam.length;
    this.dirty = true;
    this.game.agents.arrive(fam, b);
    this.game.emit('arrived', { building: b, family: fam });
  }

  seedFounders() {
    const w = this.world;
    for (const b of w.buildings.values()) {
      if (BUILDINGS[b.type].levels[b.level].housing) this.makeFamily(b, 3);
    }
    this.recompute();
  }

  _onRemoved(b) {
    const w = this.world;
    const homeless = [];
    for (const r of w.residents.values()) {
      if (r.job === b.id) r.job = null;
      if (r.home === b.id) homeless.push(r);
    }
    if (!homeless.length) return;
    this._links();
    this._rehouse(homeless, b);
  }

  // A home now holds fewer people than live there: the households that moved
  // in last move out until the rest fit.
  _onShrunk(b) {
    const out = this.world.movingOut(b, capOf(b, 'housing'));
    if (!out.length) return;
    this._links();
    const gone = new Set(out.map(r => r.id));
    b.residents = b.residents.filter(id => !gone.has(id));
    this._rehouse(out, b);
  }

  // Find each household a home with room for it; failing that, its members
  // go one by one into flats with room, or leave town.
  _rehouse(people, from) {
    const leaving = [], fams = new Map();
    for (const r of people) { const f = familyOf(r); if (!fams.has(f)) fams.set(f, []); fams.get(f).push(r); }
    for (const fam of fams.values()) {
      const to = this._vacantWhere(v => v !== from && v.residents.length + fam.length <= capOf(v, 'housing'));
      if (to) { for (const r of fam) this._moveIn(r, to, from); continue; }
      for (const r of fam) {
        const h = this._vacantWhere(v => v !== from && !Number.isFinite(householdCap(v)));
        if (h) this._moveIn(r, h, from); else leaving.push(r.id);
      }
    }
    if (leaving.length) this.game.agents.depart(leaving, from);
    this.dirty = true;
  }

  _moveIn(r, to, from) {
    r.home = to.id;
    to.residents.push(r.id);
    this.game.agents.relocate(r, from);
  }

  // A single-family home with more households than it takes (in a town from
  // before homes had a limit): the household that came last moves on to a
  // home with room for it, a few a day; with nowhere in town to go, now and
  // then one moves away to find a home of its own.
  _settleHouseholds() {
    const w = this.world;
    let moved = 0, gone = false;
    for (const b of w.buildings.values()) {
      if (moved >= 3) break;
      const H = householdCap(b);
      if (!Number.isFinite(H) || householdsIn(w, b) <= H) continue;
      const fams = new Map();
      for (const id of b.residents) {
        const r = w.residents.get(id);
        if (!r) continue;
        const f = familyOf(r);
        if (!fams.has(f)) fams.set(f, []);
        fams.get(f).push(r);
      }
      const last = [...fams.values()].sort((x, y) => Math.max(...y.map(r => r.id)) - Math.max(...x.map(r => r.id)))[0];
      const to = this._vacantWhere(v => v !== b && v.residents.length + last.length <= capOf(v, 'housing'));
      if (!to) {
        if (!gone && this.rng.chance(0.2)) { gone = true; this.game.agents.depart(last.map(r => r.id), b); this.dirty = true; }
        continue;
      }
      const ids = new Set(last.map(r => r.id));
      b.residents = b.residents.filter(id => !ids.has(id));
      for (const r of last) this._moveIn(r, to, b);
      moved++;
      this.dirty = true;
    }
  }

  // What a shop or tavern takes from a visit, as a share of its full price:
  // nothing with nobody serving, less without water, and much less after
  // dark when it needs electric light and has none.
  visitShare(b) {
    if (b.working === 0) return 0;
    const need = needsOf(b.type, b.level), h = this.world.hours;
    let k = 1;
    if (need.water && b.wet < 2) k *= need.water.without;
    if (need.power && need.power.use === 'lights' && b.powered === false && (h >= 18.5 || h < 6)) k *= 0.4;
    return k;
  }

  recordVisit(b, fare = null) {
    const w = this.world;
    let v = fare ?? visitOf(b);
    if (fare == null && v) v = Math.round(v * this.visitShare(b));
    if (!v) return 0;
    w.money += v;
    w.stats.visits++;
    w.stats.visitIncome += v;
    w.stats.todayVisitIncome += v;
    return v;
  }
}
