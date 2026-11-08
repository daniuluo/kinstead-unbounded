// Building sites. New buildings, upgrades, merges and moves are put up by
// builders from the Builder's Yard: they walk out to a site, work round the
// scaffolding, and the job only advances while someone is there. Hired hands
// from the village start every site straight away and keep at it until the
// town's builders arrive (in a town with no builders, they do it all); plots
// off the road (gardens, flower beds) are planted by volunteers.

import { BUILDINGS } from '../defs.js';
import { isOpen } from '../world/world.js';
import { lookOf, siteArea, inArea } from './agents.js';
import { doorPoint } from '../world/world.js';

const DAY_START = 6.5, DAY_END = 18;
const HIRED_RATE = 0.55;   // each hired hand, against 1–1.5 for a town builder

// Which site the builders go to first: one the player put first (its
// priority switch), then the oldest order.
const firstUp = (a, b) => (b.con.priority ? 1 : 0) - (a.con.priority ? 1 : 0) || (a._queued ?? Infinity) - (b._queued ?? Infinity);

// How many builders fit on a site at once.
export function crewCap(b) { return Math.min(8, 2 + 2 * b.w * b.d); }

export class Construction {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    this.hands = new Map();   // site id → hired-hand walkers
    this.crew = new Map();    // site id → { assigned, onSite, rate, hired }
    this.hasBuilders = false;
    this._dispatchT = 0;
    // a materials cart that was on the road when the game was saved has arrived
    for (const b of this.world.buildings.values()) if (b.con && b.con.wait === 'haul') b.con.wait = null;
    this.world.on('building:remove', (b) => this._clearHands(b.id));
    this.world.on('building:dismantled', ({ from, to }) => {
      const arrived = () => { if (to.con && to.con.wait === 'haul') to.con.wait = null; };
      if (!this.game.transit.haul(from, to, arrived)) arrived();
    });
  }

  _now() { return this.world.day * 24 + this.world.hours; }

  // Everything the inspector shows about a site.
  status(b) {
    const c = this.crew.get(b.id) || { assigned: 0, onSite: 0, rate: 0, hired: 0 };
    const con = b.con;
    const p = con ? Math.min(1, con.done / Math.max(con.work, 1e-6)) : 1;
    return { ...c, progress: p, cap: crewCap(b), hasBuilders: this.hasBuilders, eta: con && c.rate > 0 ? (con.work - con.done) / c.rate : null };
  }

  update(dt, gameHours) {
    const w = this.world, ag = this.game.agents;
    const hours = w.hours;
    const daytime = hours >= DAY_START && hours < DAY_END;
    const sites = [];
    this.crew.clear();
    for (const b of w.buildings.values()) {
      if (!b.con) { b._queued = null; continue; }
      // jobs are served in the order they were ordered, not by building
      if (b._queued == null || b._queuedFor !== b.con) { b._queued = this._now(); b._queuedFor = b.con; }
      sites.push(b);
      this.crew.set(b.id, { assigned: 0, onSite: 0, rate: 0, hired: 0 });
    }

    // who is building where
    const idle = [];
    let builders = 0;
    for (const r of w.residents.values()) {
      const yard = r.job != null ? w.buildings.get(r.job) : null;
      if (!yard || !BUILDINGS[yard.type].builders || !isOpen(yard)) { r.site = null; continue; }
      builders++;
      if (r.site != null) {
        const s = w.buildings.get(r.site);
        const c = s && s.con && !s.con.wait ? this.crew.get(s.id) : null;
        if (c) {
          c.assigned++;
          if (r.loc === 'out' && r.at === s.id) { c.onSite++; c.rate += BUILDINGS[yard.type].levels[yard.level].rate || 1; }
          continue;
        }
        r.site = null;
      }
      if (r.loc === 'in' && r.at === r.job) idle.push(r);
      else if (r.loc === 'out' && r.at !== r.job && w.buildings.get(r.at)?.con) ag.go(r, r.job);
    }
    this.hasBuilders = builders > 0;

    // send idle builders out, oldest site first
    this._dispatchT -= gameHours;
    if (daytime && idle.length && sites.length && this._dispatchT <= 0) {
      this._dispatchT = 0.15;
      const now = this._now();
      const open = sites.filter(s => !s.con.wait && s.access && s.connected && !(s._unreach > now)).sort(firstUp);
      for (const r of idle) {
        const next = r.plan[r.pi];
        if (next && next.t - hours < 0.75) continue;   // about to knock off for the day
        const s = open.find(s => this.crew.get(s.id).assigned < crewCap(s));
        if (!s) break;
        r.site = s.id;
        if (s.id === r.at) {
          // already standing at it (their own yard being upgraded): step outside and start
          const p = doorPoint(s);
          if (r.walk) ag._drop(r.walk);
          r.walk = ag._makeWalker(r.lk, [[p.x, p.z]], null);
          r.walk.r = r;
          ag._arrive(r, s.id);
          this.crew.get(s.id).assigned++;
          continue;
        }
        ag.go(r, s.id);
        if (r.loc === 'walk') this.crew.get(s.id).assigned++;
        else { r.site = null; s._unreach = now + 2; }
      }
    }

    // progress
    for (const s of sites) {
      const con = s.con, c = this.crew.get(s.id);
      if (con.wait) { this._clearHands(s.id); s._crew = 0; continue; }
      // until the town's builders are on site (or where there are none), hired
      // hands get on with it, so a job never waits for the walk out from the yard
      const hands = daytime && (!this.hasBuilders || !s.access || !c.onSite) ? (s.size > 1 ? 3 : 2) : 0;
      this._setHands(s, hands);
      c.hired = hands;
      c.rate += hands * HIRED_RATE;
      s._crew = c.onSite + hands;
      if (gameHours > 0 && c.rate > 0) {
        con.done += gameHours * c.rate;
        if (con.done >= con.work) this._finish(s);
      }
    }
  }

  _finish(s) {
    const w = this.world, ag = this.game.agents;
    this._clearHands(s.id);
    // the crew walks straight on to the next site that needs hands (oldest
    // first) rather than back to the yard; with nothing waiting, or the end of
    // the day near, they go back to the yard. Either way they leave before the
    // site turns into a building (or vanishes).
    const hours = w.hours, now = this._now();
    const daytime = hours >= DAY_START && hours < DAY_END;
    const open = daytime ? [...w.buildings.values()]
      .filter(o => o !== s && o.con && !o.con.wait && o.access && o.connected && !(o._unreach > now))
      .sort(firstUp) : [];
    for (const r of w.residents.values()) {
      if (r.site !== s.id) continue;
      r.site = null;
      if (r.loc !== 'out' || r.at !== s.id) continue;
      const nx = r.plan && r.plan[r.pi];
      const next = nx && nx.t - hours < 0.75 ? null : open.find(o => (this.crew.get(o.id)?.assigned ?? 0) < crewCap(o));
      if (next) {
        ag.go(r, next.id);
        if (r.loc === 'walk') { r.site = next.id; const c = this.crew.get(next.id); if (c) c.assigned++; continue; }
      }
      ag.go(r, r.job ?? r.home);
    }
    w.finishConstruction(s);
  }

  _setHands(s, n) {
    let list = this.hands.get(s.id);
    if (!list && !n) return;
    if (!list) { list = []; this.hands.set(s.id, list); }
    const ag = this.game.agents;
    while (list.length < n) {
      const lk = lookOf({ look: (Math.random() * 1e9) | 0, age: 'adult' }, { kind: 'builder' });
      const area = siteArea(s);
      const wk = ag._makeWalker(lk, [inArea(area, area[0] + Math.random() * (area[2] - area[0]), area[3])], null);
      Object.assign(wk, { mode: 'wander', area, ring: true, baseY: s.baseY + 0.012, working: true, idle: Math.random() * 2, target: null, hand: true });
      list.push(wk);
    }
    while (list.length > n) ag._drop(list.pop());
    if (!list.length) this.hands.delete(s.id);
  }

  _clearHands(id) {
    const list = this.hands.get(id);
    if (!list) return;
    for (const wk of list) this.game.agents._drop(wk);
    this.hands.delete(id);
  }
}
