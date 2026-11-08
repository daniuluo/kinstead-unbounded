// The City starter: a town decades along, laid out whole rather than grown
// from a short build script like the villages. A grid of streets round the
// town hall (paved avenues, cobbled side streets); a civic core with the
// seat (the Civic Palace, or grown into a Capitol or a Parliament across a
// civic block: def.seat) and the law courts, museum and opera house of its
// civic quarter, a market hall, the exchange, a department store and a
// cathedral close; a high street ring with every trade; homes beyond, dense
// in the middle (flats, apartments, shophouses) and thinning out to
// terraces, family houses and villas; works, power and water on the side the
// road leaves by, with farms past them; a harbour if there's water.
//
// Every building goes through the normal World rules (with the population
// unlocks waived: the town has long since passed them, and has every piece
// of research). Then the services are filled in wherever homes would go
// without them, just enough homes are built for the jobs, and families move
// into every home. The real Sim then runs a few days so jobs, school places,
// happiness and the budget settle as they would in play.
//
// def.dense (the Metropolis): the whole valley, every lot as full as it can
// be. The streets cover it to the edges (cross streets further apart), homes
// are all mansion blocks, apartments and mansion courts (some 36 people a
// plot), places of work the densest there are (offices, banks, market halls,
// department stores), families move in as each home goes up and schools
// follow the children, there are fewer gardens and stops, and the power
// comes from steam. Its options: radius (null: the whole valley), xEvery (the
// cross streets), workforce, skilled, parks, fill, stopGap.

import { World, capOf, householdCap, isOpen } from './world.js';
const fw = (b) => b.w, fd = (b) => b.d;
import { BUILDINGS, TECHS, GRAND, servicesOf } from '../defs.js';
import { stageForAge } from '../sim/people.js';
import { RNG, hash2 } from '../util/rng.js';
import { headlessGame } from './starters.js';

const TOP = (type) => BUILDINGS[type].levels.length - 1;
// small parks a late arrival (a school, a power station) may be built in place of
const SMALL = new Set(['garden', 'flowers', 'statue', 'courts']);
const LOOKS = ['brick', 'stone', 'plaster', 'painted', 'brick', 'stone', 'timber', 'clapboard'];

export function growCity(def, { onDay } = {}) {
  const { N, seed } = def;
  const dense = !!def.dense;
  let R = def.radius;
  const log = [], notes = [];   // log: what went wrong; notes: what there was no room for
  const w = World.createNew({ N, seed, name: def.town });
  w.townId = ('starter' + def.id).replace(/[^a-z0-9]/g, '').slice(0, 24);
  // a town this far along has done all its research
  w.research.done = Object.keys(TECHS);
  w.research.current = null;
  w.research.bank = 0;
  w.money = 1e8;
  // (and long since passed every unlock: waived while it is laid out)
  w.sandbox.unlockAll = true;
  const rng = new RNG(seed ^ 0x2f6b1d3);
  const game = headlessGame(w);
  const sim = game.sim;
  sim.rng = new RNG(seed ^ 0x5eed);

  const th = [...w.buildings.values()].find(b => b.type === 'townhall');
  const cx = th.x + 1, cz = th.z + 1;
  // the Metropolis reaches every corner of the valley
  if (dense && !R) R = Math.hypot(Math.max(cx - 3, N - 3 - cx), Math.max(cz - 3, N - 3 - cz)) + 0.5;
  // the founders' cottages, well and stall make way for the city
  for (const b of [...w.buildings.values()]) if (b !== th) w.removeBuilding(b.id, 0);
  th.level = TOP('townhall');
  th.variant = (rng.next() * 1e9) | 0;
  th.look = 'stone';

  const dist = (x, z) => Math.hypot(x + 0.5 - cx, z + 0.5 - cz);
  const inside = (x, z) => x >= 3 && z >= 3 && x < N - 3 && z < N - 3 && dist(x, z) <= R;
  // the streets (and the works) carry on a little past the town on the side the road leaves by
  const OUT = 6;
  // the works go on the side the road leaves the valley by
  const out = Math.atan2(w.entry.z - cz, w.entry.x - cx);
  const away = (x, z) => { const a = Math.atan2(z + 0.5 - cz, x + 0.5 - cx); return Math.abs(((a - out + Math.PI * 3) % (Math.PI * 2)) - Math.PI); };
  // (in the Metropolis: a strip along the edge of the valley the road comes in by)
  const ex = w.entry.x, ez = w.entry.z;
  const edgeD = (x, z) => (ex <= 0 ? x : ex >= N - 1 ? N - 1 - x : ez <= 0 ? z : N - 1 - z);
  const BAND = def.worksBand || 12;
  const works = dense ? (x, z) => edgeD(x, z) < BAND : (x, z) => dist(x, z) >= R * 0.55 && away(x, z) < 0.62;

  // ---- streets: along x every third row, across every ninth column (or xEvery)
  // A city with a grander seat (def.seat) leaves out the street between the
  // town hall's block and the next for eight plots, a civic block the seat
  // grows across, with the civic buildings beside it
  const CB = def.seat ? { x0: th.x, x1: th.x + 7, z0: th.z, z1: th.z + 4 } : null;
  const civicBlock = (x, z) => !!CB && x >= CB.x0 && x <= CB.x1 && z >= CB.z0 && z <= CB.z1;
  const XE = def.xEvery || 9;
  const zStreet = (z) => (((z - (th.z - 1)) % 3) + 3) % 3 === 0;
  const xStreet = (x) => (((x - (th.x - 1)) % XE) + XE) % XE === 0;
  const avenue = (x, z) => (zStreet(z) && ((((z - (th.z - 1)) / 3) % 3) + 3) % 3 === 0) || (xStreet(x) && ((((x - (th.x - 1)) / XE) % 2) + 2) % 2 === 0);
  const paved = [], cobbled = [];
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    const beyond = x >= 3 && z >= 3 && x < N - 3 && z < N - 3 && dist(x, z) <= R + OUT && away(x, z) < 0.75;
    if (!(inside(x, z) || beyond) || !(zStreet(z) || xStreet(x)) || w.terrain.isWater(x, z) || civicBlock(x, z)) continue;
    (avenue(x, z) ? paved : cobbled).push([x, z]);
  }
  w.placeRoads(paved, 3);
  w.placeRoads(cobbled, 2);
  // the old way in is paved as far as the edge of town
  const entryRoad = [];
  for (let i = 0; i < N * N; i++) if (w.roads[i] === 1 && dist(i % N, (i / N) | 0) <= R + 2) entryRoad.push([i % N, (i / N) | 0]);
  w.placeRoads(entryRoad, 3);
  // (the founders' lanes are taken up from the civic block)
  if (CB) for (let z = CB.z0; z <= CB.z1; z++) for (let x = CB.x0; x <= CB.x1; x++) if (w.roadAt(x, z)) w.removeRoad(x, z);
  // streets cut off from the rest (by water or a steep bank) are taken up again
  for (let i = 0; i < N * N; i++) if (w.roads[i] && !w.connected[i]) w.removeRoad(i % N, (i / N) | 0);

  // ---- the seat grows across the civic block, a size at a time, into the
  // Capitol or the Parliament (def.seat), in its style (def.seatStyle)
  if (def.seat) {
    const keep = { ...w.sandbox };
    Object.assign(w.sandbox, { freeUpgrades: true, instantBuild: true });
    for (let k = 0; k < 8 && !(th.type === def.seat && th.level === TOP(def.seat)); k++) {
      if (th.level < TOP(th.type)) { w.upgradeBuilding(th.id); continue; }
      const o = w.expandOptions(th).filter(e => e.kind === 'grand').sort((a, b) => b.dir - a.dir)[0];
      if (!o || !w.expandBuilding(th.id, o.dir, 'grand').ok || !w.upgradeBuilding(th.id, GRAND[th.type][0]).ok) { log.push(`the town hall could not grow into the ${def.seat}`); break; }
    }
    Object.assign(w.sandbox, keep);
    th.flavor = def.seatStyle || null;
  }

  // ---- placing buildings
  const variant = () => (rng.next() * 1e9) | 0;
  let onPlaced = null;   // (b) after each building goes up (set below)
  const place = (type, x, z, o = {}) => {
    const d = BUILDINGS[type];
    const sizes = o.size ? [o.size] : d.merged ? (rng.chance(0.5) ? [[2, 1], [1, 2]] : [[1, 2], [2, 1]]) : [[d.size, d.size]];
    for (const [W, D] of sizes) {
      const c = w.checkBuild(type, x, z, { w: W, d: D, ignoreUnlock: true });
      if (!c.ok) continue;
      const k = c.access.findIndex(a => a.conn);
      if (k < 0) continue;
      const r = w.placeBuilding(type, x, z, {
        w: W, d: D, ignoreUnlock: true, instant: true, level: o.level ?? TOP(type), look: o.look ?? null, flavor: o.flavor ?? null,
        variant: variant(), accessIndex: Math.max(0, k),
      });
      if (r.ok) { if (onPlaced) onPlaced(r.building); return r.building; }
    }
    return null;
  };
  // the best free spot for a building, by score (lower is better), among
  // the tiles that pass `where`
  const spots = [];
  for (let z = 2; z < N - 2; z++) for (let x = 2; x < N - 2; x++) spots.push([x, z]);
  const putBest = (type, score, o = {}) => {
    const cands = [];
    for (const [x, z] of spots) {
      if (w.buildingOn(x, z) || w.roadAt(x, z)) continue;
      const s = score(x, z);
      if (s !== null && Number.isFinite(s)) cands.push([s + hash2(x, z, seed) * 0.4, x, z]);
    }
    cands.sort((a, b) => a[0] - b[0]);
    for (const [, x, z] of cands) { const b = place(type, x, z, o); if (b) return b; }
    // late in the day a garden, a bed of flowers or a statue can make way
    const small = [...w.buildings.values()].filter(b => SMALL.has(b.type)).map(b => [score(b.x, b.z), b]).filter(([s]) => s !== null && Number.isFinite(s)).sort((p, q) => p[0] - q[0]);
    for (const [, g] of small.slice(0, 12)) {
      const { x, z } = g;
      w.removeBuilding(g.id, 0);
      covDirty = true;
      retally();
      const b = place(type, x, z, o) || place(type, x - 1, z, o) || place(type, x, z - 1, o) || place(type, x - 1, z - 1, o);
      if (b) return b;
      place(g.type, x, z);
    }
    notes.push(`no room for ${type}`);
    return null;
  };
  const near = (ax, az, keep = () => true) => (x, z) => (keep(x, z) ? Math.hypot(x - ax, z - az) : null);
  const ring = (lo, hi, extra = () => 0) => (x, z) => { const d = dist(x, z); return d >= lo && d <= hi && !works(x, z) ? d + extra(x, z) : null; };

  // ---- the civic core
  const core = (n, type, o) => { for (let i = 0; i < n; i++) putBest(type, ring(0, 8.5), o); };
  // (a civic quarter round the seat first, in the civic block if there is one)
  if (def.seat) for (const type of ['museum', 'lawcourts', 'operahouse']) putBest(type, (x, z) => (civicBlock(x, z) ? dist(x, z) : null)) || core(1, type);
  else for (const type of ['museum', 'lawcourts', 'operahouse']) core(1, type);
  // ...and the rest of the civic block: a square on the street, then
  // monuments and flower beds
  let square = null;
  if (CB) for (let z = CB.z0; z < CB.z1 && !square; z++) for (let x = CB.x0; x < CB.x1 && !square; x++) square = place('plaza', x, z);
  if (CB) for (let z = CB.z0; z <= CB.z1; z++) for (let x = CB.x0; x <= CB.x1; x++) {
    if (w.buildingOn(x, z) || w.roadAt(x, z)) continue;
    const mon = hash2(x, z, seed + 3) < 0.4;
    place(mon ? 'statue' : 'flowers', x, z, { flavor: mon ? rng.pick(['column', 'rider', 'obelisk', 'founder', 'fountain']) : rng.pick(['bedding', 'topiary', 'planters', 'tree']) });
  }
  if (!square) core(1, 'plaza');
  core(1, 'markethall');
  core(1, 'cathedralclose', { look: 'stone' });
  core(1, 'deptstore');
  core(1, 'exchange', { look: 'stone' });
  core(2, 'bank', { look: 'stone' });
  core(1, 'postoffice');
  core(1, 'library', { look: 'stone' });
  core(1, 'musichall');
  core(3, 'offices');
  core(2, 'statue');

  // ---- works, power and water, on the way out of town
  // (the Metropolis's power stations and works go to the far edge of its strip)
  const worksAt = dense ? (x, z) => (works(x, z) ? edgeD(x, z) : null) : (x, z) => (works(x, z) && dist(x, z) <= R + OUT ? dist(x, z) : null);
  // the wind farm: out past the works, where the wind comes off the hills
  const windAt = (x, z) => (dist(x, z) > R - 1 && dist(x, z) <= R + OUT && away(x, z) < 0.8 ? -dist(x, z) : null);
  for (const [n, type] of [[1, 'powerplant'], [6, 'workshop'], [1, 'foundry'], [1, 'papermill'], [2, 'joinery'], [1, 'timberworks'], [1, 'contractor'], [2, 'builder']]) {
    for (let i = 0; i < n; i++) putBest(type, worksAt);
  }
  // lumber in the woods and farms in the fields past the town, along the roads out
  // (the Metropolis has no fields left)
  for (let i = 0; i < (dense ? 0 : 2); i++) putBest('lumber', (x, z) => { const d = dist(x, z); return d > R - 4 && d < R + 6 ? -Math.min(30, treesAround(w, x, z, 3)) + d * 0.2 : null; });
  for (let i = 0; i < (dense ? 0 : 4); i++) putBest('farm', (x, z) => { const d = dist(x, z); return d > R - 3 && d < R + 8 && away(x, z) < 1.6 ? d : null; });
  // the harbour and pumps on the water, if it's near
  for (let i = 0; i < (dense ? 0 : 2); i++) putBest('fishery', (x, z) => (dist(x, z) < R + 4 ? dist(x, z) : null));
  for (let i = 0; i < 4; i++) putBest('pump', (x, z) => (dist(x, z) < R + 4 ? dist(x, z) : null));

  // ---- the high street: every trade round the middle, and a few offices
  const trades = ['grocer', 'butcher', 'bakery', 'draper', 'chemist', 'stationer', 'coffeehouse', 'ironmonger', 'cobbler', 'tavern', 'market'];
  for (const t of trades) putBest(t, ring(5, 12.5));
  putBest('arcade', ring(5, 12.5));
  putBest('inn', ring(6, 14));
  putBest('teagarden', ring(6, 14));
  for (let i = 0; i < 4; i++) putBest('offices', ring(6, 13));
  for (let i = 0; i < 6; i++) putBest('shophouse', ring(7, 14), { flavor: trades[i % 8] });

  // ---- homes, services and shops, a few homes at a time until the jobs are taken
  const jobs = () => { let n = 0; for (const b of w.buildings.values()) n += capOf(b, 'jobs'); return n; };
  const housing = () => { let n = 0; for (const b of w.buildings.values()) n += capOf(b, 'housing'); return n; };
  // homes by how far out: dense in the middle, family houses and villas at the edge
  const DENSE_HOMES = ['flats', 'flats', 'flats', 'apartments', 'quadrangle'];
  const homeFor = (d) => dense ? rng.pick(DENSE_HOMES) : (d < 10 ? rng.pick(['flats', 'shophouse', 'terrace', 'terrace']) : d < 15 ? rng.pick(['terrace', 'terrace', 'house', 'mansion', 'shophouse']) : d < 19 ? rng.pick(['terrace', 'house', 'house', 'house', 'villa']) : rng.pick(['house', 'house', 'house', 'villa', 'villa', 'manor']));
  // grown-ups looking for work for each place in a home (homes are left a
  // little short of full): a few more of them than there are jobs, so that
  // every workplace is staffed
  const WORKFORCE = def.workforce ?? 0.55;
  // What reaches a home, worked out from where things stand (nobody works
  // anywhere yet, so the Sim would say nothing does): a service's own reach,
  // a shop within 7, a stop within 4.
  // (the Metropolis leaves out a stop by every door: its stops are for the coach lines)
  const NEEDS = [['health', 'clinic'], ['safety', 'firestation'], ['culture', 'chapel'], ['education', 'school'], ['shops', null], ['transit', 'coachstop'], ['play', 'playground']].filter(([k]) => !(dense && k === 'transit'));
  const reachOf = (b, key) => {
    const d = BUILDINGS[b.type], L = d.levels[b.level];
    if (key === 'shops') return d.shop || d.leisure ? 7 : 0;
    if (key === 'transit') return d.stop ? 4 : 0;
    if (key === 'play') return d.play ? (L.radius || 0) + 0.5 : 0;
    return servicesOf(d).includes(key) ? (L.radius || 0) + 0.5 : 0;
  };
  const mid = (b) => [b.x + fw(b) / 2, b.z + fd(b) / 2];
  // what reaches each tile (from its centre), for each need, kept up to date
  // as buildings go up (and worked out afresh after one is taken down)
  const cov = new Map(NEEDS.map(([k]) => [k, new Uint8Array(N * N)]));
  let covDirty = false;
  const stamp = (o) => {
    for (const [key, grid] of cov) {
      const r = reachOf(o, key);
      if (!r) continue;
      const [ox, oz] = mid(o);
      for (let z = Math.max(0, Math.floor(oz - r - 1)); z <= Math.min(N - 1, Math.ceil(oz + r)); z++) {
        for (let x = Math.max(0, Math.floor(ox - r - 1)); x <= Math.min(N - 1, Math.ceil(ox + r)); x++) if (Math.hypot(ox - x - 0.5, oz - z - 0.5) <= r) grid[z * N + x] = 1;
      }
    }
  };
  // where the works' smoke reaches (a polluter's reach plus a tile and a
  // half, from its middle), and the town's power and water, likewise
  const smoke = new Uint8Array(N * N);
  const tot = { p: 0, k: 0, s: 0, h: 0 };
  const tally = (o) => {
    const d = BUILDINGS[o.type], L = d.levels[o.level];
    if (L.kw) tot.k += L.kw; else if (!d.park) tot.p += 0.5 + 0.2 * capOf(o, 'housing') + 0.25 * capOf(o, 'jobs');
    tot.s += L.supply || 0;
    tot.h += capOf(o, 'housing');
    if (L.pollution) {
      const [ox, oz] = mid(o), r = L.pollution + 1.5;
      for (let z = Math.max(0, Math.floor(oz - r - 1)); z <= Math.min(N - 1, Math.ceil(oz + r)); z++) {
        for (let x = Math.max(0, Math.floor(ox - r - 1)); x <= Math.min(N - 1, Math.ceil(ox + r)); x++) if (Math.hypot(ox - x - 0.5, oz - z - 0.5) <= r) smoke[z * N + x] = 1;
      }
    }
  };
  for (const o of w.buildings.values()) { stamp(o); tally(o); }
  onPlaced = (b) => { stamp(b); tally(b); };
  const retally = () => { smoke.fill(0); tot.p = tot.k = tot.s = tot.h = 0; for (const o of w.buildings.values()) tally(o); };
  const reaches = (b, key) => {
    if (covDirty) { covDirty = false; for (const g of cov.values()) g.fill(0); for (const o of w.buildings.values()) stamp(o); }
    return !!cov.get(key)[b.z * N + b.x];
  };
  const fillServices = () => {
    for (let round = 0; round < 200; round++) {
      const homes = [...w.buildings.values()].filter(b => capOf(b, 'housing'));
      let placed = false;
      for (const [key, type] of NEEDS) {
        const lack = homes.filter(b => !reaches(b, key));
        if (!lack.length) continue;
        // by the home that goes without nearest the middle of the rest
        const ax = lack.reduce((a, b) => a + b.x, 0) / lack.length, az = lack.reduce((a, b) => a + b.z, 0) / lack.length;
        const one = lack.reduce((m, b) => (!m || Math.hypot(b.x - ax, b.z - az) < Math.hypot(m.x - ax, m.z - az) ? b : m), null);
        const t = type || rng.pick(trades);
        if (putBest(t, near(one.x, one.z, (x, z) => !works(x, z) && dist(x, z) < R + 2 && Math.hypot(x - one.x, z - one.z) < reachOf({ type: t, level: TOP(t) }, key) - 1))) placed = true;
      }
      if (!placed) return;
    }
  };
  // Every lot is built on, nearest the middle first: a home while there are
  // more jobs than grown-ups to take them, else a place of work (offices and
  // shops in town, the works on their side of it). Homes keep clear of the
  // works' smoke; the services follow wherever homes would go without.
  const smoky = (x, z) => {
    if (dense ? works(x, z) : dist(x, z) >= R * 0.4 && away(x, z) < 1.05) return true;
    return !!smoke[z * N + x];
  };
  const skill = (t) => BUILDINGS[t].levels[TOP(t)].edu || 0;
  let S = 0;
  for (const b of w.buildings.values()) if ((BUILDINGS[b.type].levels[b.level].edu || 0) >= 2) S += capOf(b, 'jobs');
  const plain = (list) => (S > H * (def.skilled ?? 0.15) ? list.filter(t => skill(t) < 2) : list);
  const workFor = (x, z) => {
    if (dense && works(x, z)) return edgeD(x, z) < BAND / 2 ? rng.pick(plain(['workshop', 'workshop', 'foundry', 'joinery'])) : rng.pick(plain(['market', 'deptstore', 'papermill', 'offices']));
    if (dense && !works(x, z)) return rng.pick(plain(['offices', 'offices', 'offices', 'bank', 'exchange', 'market', 'market', 'deptstore', 'draper', 'grocer', 'butcher', 'ironmonger']));
    if (works(x, z)) return rng.pick(plain(['workshop', 'workshop', 'workshop', 'papermill', 'joinery', 'timberworks', 'builder', 'brewhouse']));
    const d = dist(x, z);
    if (d < 9) return rng.pick(plain(['offices', 'coffeehouse', 'draper', 'chemist', 'stationer', 'bank']));
    if (d < 15) return rng.pick(plain([...trades, 'offices', 'inn', 'arcade']));
    return rng.pick(plain([...trades, 'coffeehouse', 'tavern', 'grocer', 'bakery']));
  };
  putBest('college', near(cx, cz, (x, z) => !works(x, z) && dist(x, z) > 7 && dist(x, z) < R - 3));
  putBest('university', near(cx, cz, (x, z) => !works(x, z) && dist(x, z) > 9 && dist(x, z) < R - 2));
  // a coach stop within a few steps of every street corner, laid out first
  const [SX, SZ] = def.stopGap || [6, 5];
  for (let i = -12; i <= 12; i++) for (let j = -12; j <= 12; j++) {
    if (!dense && (Math.abs(i) > 6 || Math.abs(j) > 6)) continue;
    const px = cx + i * SX + (j % 2) * Math.round(SX / 2), pz = cz + j * SZ;
    if (inside(px, pz) && dist(px, pz) > 4) putBest('coachstop', near(px, pz, (x, z) => Math.hypot(x - px, z - pz) < 2.6));
  }
  // power and water to keep up as the town fills
  const kwNeed = () => tot.p * 1.25 - tot.k;
  const waterNeed = () => tot.h * FILL * 1.1 - tot.s;
  const utilities = () => {
    // (the Metropolis burns coal: a power station gives the most to a plot)
    for (let i = 0; i < 40 && kwNeed() > 0; i++) if (dense ? !putBest('powerplant', worksAt) && !putBest('windgen', worksAt) : !putBest('windgen', windAt) && !putBest('windgen', worksAt)) break;
    for (let i = 0; i < 12 && waterNeed() > 0; i++) if (!putBest('pump', (x, z) => (dist(x, z) < R + 6 ? dist(x, z) : null)) && !putBest('well', (x, z) => (inside(x, z) && smoky(x, z) ? dist(x, z) : null)) && !(dense && putBest('well', (x, z) => (inside(x, z) ? -dist(x, z) : null)))) break;
  };
  const FILL = def.fill ?? 0.94;
  // names already taken, kept as families move in (rather than gathered from
  // the whole town for every family)
  const used = sim.namesInUse();
  sim.namesInUse = () => used;
  const moveIn = (b) => {
    for (let tries = 0; tries < 80; tries++) {
      const room = Math.floor(capOf(b, 'housing') * FILL) - b.residents.length;
      if (room <= 0 || householdsIn(w, b) >= householdCap(b)) break;
      for (const r of sim.makeFamily(b, room)) used.last.add(r.last);
    }
  };
  onPlaced = (b) => { stamp(b); tally(b); if (dense && capOf(b, 'housing')) moveIn(b); };
  // school places for the children as they come, near the newest homes
  const kidsAt = [0, 0, 0, 0, 0, 0], seats = [0, 0, 0, 0, 0, 0];
  const schoolStep = (x, z) => {
    kidsAt.fill(0); seats.fill(0);
    for (const r of w.residents.values()) if (r.age === 'child') kidsAt[stageForAge(r.years)]++;
    for (const b of w.buildings.values()) { const L = BUILDINGS[b.type].levels[b.level]; if (L.seats) seats[L.teaches || 1] += capOf(b, 'seats'); }
    for (const [stage, type] of [[1, 'boardschool'], [2, 'middleschool'], [3, 'highschool']]) {
      for (let k = 0; k < 6 && seats[stage] < kidsAt[stage] * 1.15; k++) {
        const b = putBest(type, near(x, z, (px, pz) => !works(px, pz) && inside(px, pz)));
        if (!b) break;
        seats[stage] += capOf(b, 'seats');
      }
    }
  };
  const lots = [];
  for (const [x, z] of spots) if (inside(x, z) || (works(x, z) && dist(x, z) <= R + OUT)) lots.push([dist(x, z) + hash2(x, z, seed + 1) * 2, x, z]);
  lots.sort((a, b) => a[0] - b[0]);
  let J = jobs(), H = housing(), since = 0;
  for (const [, x, z] of lots) {
    if (w.buildingOn(x, z) || w.roadAt(x, z)) continue;
    let b = null;
    // about one lot in nine is a garden, a court, a play area or a statue
    if (!works(x, z) && hash2(x, z, seed + 7) < (def.parks ?? 0.08)) b = place(rng.pick(['garden', 'garden', 'flowers', 'courts', 'playground', 'statue']), x, z);
    const wantHome = H * WORKFORCE < J;
    if (dense && works(x, z)) {
      b = kwNeed() > 0 ? place('powerplant', x, z) : waterNeed() > 0 ? place('well', x, z) : null;
      if (!b) b = place(workFor(x, z), x, z, { look: rng.pick(LOOKS) });
      if (b) { J += capOf(b, 'jobs'); if ((BUILDINGS[b.type].levels[b.level].edu || 0) >= 2) S += capOf(b, 'jobs'); }
      continue;
    }
    // near the works, where nobody would live, it's a green or a turbine instead
    if (!b && wantHome && smoky(x, z)) b = place(works(x, z) && kwNeed() > 0 ? 'windgen' : rng.pick(['garden', 'courts', 'garden', 'flowers']), x, z);
    if (!b && wantHome && !smoky(x, z)) {
      const t = homeFor(dist(x, z));
      b = place(t, x, z, { look: rng.pick(LOOKS), flavor: t === 'shophouse' ? rng.pick(trades.slice(0, 8)) : null });
    }
    if (!b && !wantHome) b = place(workFor(x, z), x, z, { look: rng.pick(LOOKS) });
    if (!b) continue;
    J += capOf(b, 'jobs'); H += capOf(b, 'housing');
    if ((BUILDINGS[b.type].levels[b.level].edu || 0) >= 2) S += capOf(b, 'jobs');
    if (++since >= 10) { since = 0; fillServices(); utilities(); if (dense) schoolStep(x, z); J = jobs(); H = housing(); }
  }
  fillServices();
  if (housing() * WORKFORCE < jobs()) notes.push(`homes for ${housing()} against ${jobs()} jobs: out of room`);
  // parks round the town, between the homes
  for (let a = 0; a < 6; a++) {
    const ang = out + Math.PI / 3 + (a * Math.PI * 2) / 6, px = cx + Math.cos(ang) * R * 0.6, pz = cz + Math.sin(ang) * R * 0.6;
    putBest(a % 2 ? 'park' : 'landscapepark', near(px, pz, (x, z) => !works(x, z) && inside(x, z)));
  }

  // ---- families move in (in the Metropolis, the last few homes' families)
  for (const b of w.buildings.values()) {
    if (!capOf(b, 'housing')) continue;
    if (dense) { moveIn(b); continue; }
    for (let tries = 0; tries < 60; tries++) {
      const room = Math.floor(capOf(b, 'housing') * FILL) - b.residents.length;
      if (room <= 0 || householdsIn(w, b) >= householdCap(b)) break;
      for (const r of sim.makeFamily(b, room)) used.last.add(r.last);
    }
  }
  // school places for every child, by stage
  schools(w, sim, putBest, near, works, dist, R, cx, cz, dense ? 300 : 30);
  delete sim.namesInUse;

  // ---- power and water for all of it, with a little to spare
  const demand = () => { let p = 0; for (const b of w.buildings.values()) { const d = BUILDINGS[b.type]; if (!d.levels[b.level].kw && !d.park) p += 0.5 + 0.2 * capOf(b, 'housing') + 0.25 * capOf(b, 'jobs'); } return p; };
  const supply = (key) => { let s = 0; for (const b of w.buildings.values()) s += (BUILDINGS[b.type].levels[b.level][key] || 0) * (capOf(b, 'housing') || 1) ** 0; return s; };
  utilities();
  for (let i = 0; i < 40 && supply('kw') < demand() * 1.25; i++) if (!putBest('windgen', windAt) && !putBest('windgen', worksAt)) break;
  for (let i = 0; i < 60 && supply('supply') < w.residents.size * 1.12; i++) if (!putBest('pump', (x, z) => (dist(x, z) < R + 6 ? dist(x, z) : null)) && !putBest('well', (x, z) => (inside(x, z) ? (works(x, z) ? 0 : 10) + dist(x, z) * -0.1 : null))) break;

  // the coach lines: the stops round the town in a few lines
  coachLines(w, game, cx, cz, log);

  // ---- a few days of ordinary life
  w.day = def.day || 1;
  for (let d = 0; d < (def.settle || 4); d++) {
    w.hours = 8;
    sim.recompute();
    if (onDay) onDay(w, sim);
    w.day++;
    sim.daily();
  }
  w.sandbox.unlockAll = false;
  sim.recompute();
  w.hours = 8.5;
  w.money = def.money || 60000;
  return { world: w, sim, log, notes };
}

function householdsIn(w, b) {
  const fams = new Set();
  for (const id of b.residents) { const r = w.residents.get(id); if (r) fams.add(r.fam); }
  return fams.size;
}

function treesAround(w, x, z, r) {
  let n = 0;
  for (let tz = z - r; tz <= z + r; tz++) for (let tx = x - r; tx <= x + r; tx++) if (w.inBounds(tx, tz)) n += w.treeCount[w.idx(tx, tz)];
  return n;
}

// Enough school places for the children of every stage (elementary,
// middle, high school), by the homes they live in. Places are counted from
// what each school holds (nobody teaches anywhere yet, so the Sim would say
// none do), with a tenth to spare.
function schools(w, sim, putBest, near, works, dist, R, cx, cz, most = 30) {
  for (const [stage, type] of [[1, 'boardschool'], [2, 'middleschool'], [3, 'highschool']]) {
    const kids = [...w.residents.values()].filter(r => r.age === 'child' && stageForAge(r.years) === stage);
    const places = () => { let n = 0; for (const b of w.buildings.values()) { const L = BUILDINGS[b.type].levels[b.level]; if ((L.teaches || 0) === stage || (!L.teaches && L.seats && stage === 1)) n += capOf(b, 'seats'); } return n; };
    for (let k = 0; k < most && places() < kids.length * 1.2; k++) {
      // by the children furthest from a school of their stage
      const homes = kids.map(r => w.buildings.get(r.home)).filter(Boolean);
      const ax = homes.reduce((a, b) => a + b.x, 0) / homes.length, az = homes.reduce((a, b) => a + b.z, 0) / homes.length;
      const off = (k * 2.4) % (Math.PI * 2), px = ax + Math.cos(off) * R * 0.45, pz = az + Math.sin(off) * R * 0.45;
      if (!putBest(type, near(px, pz, (x, z) => !works(x, z) && dist(x, z) < R + 1))) break;   // (no room left: noted by putBest)
    }
  }
}

function coachLines(w, game, cx, cz, log) {
  const stops = [...w.buildings.values()].filter(b => BUILDINGS[b.type].stop && b.type === 'coachstop' && isOpen(b))
    .sort((p, q) => Math.atan2(p.z - cz, p.x - cx) - Math.atan2(q.z - cz, q.x - cx));
  const n = Math.max(1, Math.min(6, Math.round(stops.length / 7)));
  for (let k = 0; k < n; k++) {
    const part = stops.filter((_, i) => i % n === k);
    if (part.length < 2) continue;
    const r = game.transit.createLine('coach', part.map(b => b.id));
    if (!r.ok) { log.push(`coach line ${k + 1}: ${r.reason}`); continue; }
    game.transit.setVehicles(r.line.id, 3);
  }
}
