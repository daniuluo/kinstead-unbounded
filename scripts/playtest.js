// Headless playtest: a simple bot plays a fresh town for many in-game days
// with the normal economy, using most features (building, roads, research,
// utilities, upgrades with styles, joins, expansions, moves, demolition), and
// checks the town for broken invariants every day. Prints a daily log, a
// summary, and any problems found.
// Usage: node scripts/playtest.js [days=60] [mapSize=48] [seed=2024] [mode]
//   mode: economy (default, real money) · stress (sandbox money, everything
//   unlocked, lots of building / joining / moving every day) · scale (a big
//   ready-grown town, to measure how the simulation copes) · chaos (like
//   stress, with instant construction, so far more upgrades / joins / moves)

import { World, isOpen, capOf, seatOf, civicQuarter, findPlot, ownPlot } from '../src/world/world.js';
import { pointAt, toWorld } from '../src/world/geom.js';
import { PathFinder } from '../src/sim/path.js';
import { Sim } from '../src/sim/sim.js';
import { Agents, visitorCap } from '../src/sim/agents.js';
import { Transit } from '../src/sim/transit.js';
import { Animals } from '../src/sim/animals.js';
import { Construction } from '../src/sim/construction.js';
import { BUILDINGS, TECHS, PRODUCE, KINDS, kindOf } from '../src/defs.js';
import { STYLES } from '../src/render/buildings.js';
import { serialize, deserialize } from '../src/save/saves.js';
import { computeIssues } from '../src/ui/issues.js';
import { RNG } from '../src/util/rng.js';
import { growDemoTown } from '../src/world/demo.js';
import { applyRoadEdit, applyDress, streetOf } from '../src/world/streets.js';
import { DRESSINGS } from '../src/config.js';
import { makeAudit } from './audit.js';

const DAYS = Number(process.argv[2] || 60), N = Number(process.argv[3] || 48), SEED = Number(process.argv[4] || 2024);
const MODE = process.argv[5] || 'economy';
const busy = MODE !== 'economy' ? 3 : 1;
const rng = new RNG(SEED);
const problems = [];
const problem = (day, msg) => { if (problems.length < 60) problems.push(`day ${day}: ${msg}`); };

const scene = { add() {}, remove() {} };
const game = {
  speed: 8, env: { night: 0 }, renderer: { scene, worldToScreen: () => ({ x: 0, y: 0 }) }, view: { smoke: { emit() {} } },
  _ev: {}, on(e, f) { (this._ev[e] ||= []).push(f); }, emit(e, d) { for (const f of this._ev[e] || []) f(d); },
};
const w = World.createNew({ N, seed: SEED, name: 'Botton' });
if (MODE === 'scale') growDemoTown(w, SEED, 2);
if (MODE !== 'economy') w.setSandbox({ infiniteMoney: true, unlockAll: true, instantBuild: MODE === 'chaos' });
game.world = w;
game.paths = new PathFinder(w);
game.sim = new Sim(game);
game.transit = new Transit(game);
game.sim.seedFounders();
game.agents = new Agents(game);
game.animals = new Animals(game);
game.construction = new Construction(game);
game.on('day', () => game.transit.planCarts());
w.on('roads', () => game.paths.invalidate?.());
const counts = { placed: 0, upgrades: 0, merges: 0, expands: 0, estates: 0, estateBuilt: 0, grounds: 0, groundsBuilt: 0, moves: 0, demolish: 0, roads: 0, research: 0, rekinds: 0, born: 0, died: 0, grads: 0 };
game.on('born', (b) => { counts.born += b.length; });
game.on('died', (d) => { counts.died += d.length; });
game.on('graduated', () => { counts.grads++; });
w.on('research:done', () => { counts.research++; });

// ------------------------------------------------------------ bot helpers
const center = (() => { const th = seatOf(w); return { x: th.x, z: th.z }; })();
// the ground just beyond the end of a street: kept free so the street can grow
const blocksEnd = (x, z) => {
  for (const n of w.roads.nodes.values()) {
    if (n.edges.length !== 1 || Math.abs(n.x - x) > 3 || Math.abs(n.z - z) > 3) continue;
    const e = w.roads.edges.get(n.edges[0]), a = w.roads.dirAt(e, n.id) + Math.PI, ux = Math.sin(a), uz = Math.cos(a);
    for (const t of [0.6, 1.2, 1.8, 2.4]) if (Math.hypot(n.x + ux * t - x, n.z + uz * t - z) < 0.95) return true;
  }
  return false;
};
// somewhere for a building along the town's streets near a point, on the
// roads to the way out: { x, z, a }, or null
const spot = (type, near = center, r = 14) => findPlot(w, type, near, { r, test: (x, z, a, chk) => !blocksEnd(x, z) && (!chk || !!(chk.access && chk.access.conn)) });
function place(type, near) {
  if (MODE === 'economy' && [...w.buildings.values()].some(b => b.type === type && b.con && b.con.kind === 'build') && type !== 'house') return null;
  // near the middle if there's room, else further out
  const s = spot(type, near) || spot(type, near, 22);
  if (!s) return null;
  // a planting or monument is half the time built as a kind of the bot's choosing
  const kinds = KINDS[type] && Object.keys(KINDS[type]).filter(k => w.hasTech(KINDS[type][k].tech));
  const flavor = kinds && kinds.length && rng.chance(0.5) ? rng.pick(kinds) : undefined;
  const r = w.placeBuilding(type, s.x, s.z, { a: s.a, variant: (rng.next() * 1e9) | 0, flavor });
  if (r.ok) counts.placed++;
  return r.ok ? r.building : null;
}
// A street out from one of the town's (from a dead end on, or off the side
// of a stretch), len long, bending by bend: the points to lay, or null.
function streetOut(len, bend) {
  const es = [...w.roads.edges.values()].filter(e => w.connected.has(e.a));
  for (let t = 0; t < 40 && es.length; t++) {
    const e = rng.pick(es);
    let x, z, ux, uz;
    const end = [e.a, e.b].find(n => w.roads.nodes.get(n).edges.length === 1 && n !== w.entry.node);
    if (end != null && rng.chance(0.5)) {
      const n = w.roads.nodes.get(end), a = w.roads.dirAt(e, end) + Math.PI;
      x = n.x; z = n.z; ux = Math.sin(a); uz = Math.cos(a);
    } else {
      if (e.len < 2.2) continue;
      const p = pointAt(e.pts, e.cum, rng.float(1, e.len - 1)), sd = rng.chance(0.5) ? 1 : -1;
      x = p[0]; z = p[1]; ux = -p[4] * sd; uz = p[3] * sd;
    }
    // (the bend: the far end swung round, the middle half as much)
    const c = Math.cos(bend), si = Math.sin(bend), vx = ux * c + uz * si, vz = -ux * si + uz * c;
    const pts = [[x, z], [x + (ux + vx) * len / 4, z + (uz + vz) * len / 4], [x + vx * len, z + vz * len]];
    if (w.checkRoad(pts, 1).ok) return pts;
  }
  return null;
}
// lay a new street off an existing one, heading out of town
function growRoads() {
  // a proper street if there's room for one, else a short spur
  for (const len of [6, 4.5, 3, 2]) {
    const pts = streetOut(len, rng.float(-0.4, 0.4));
    if (pts) { const r = w.placeRoad(pts, 1); if (r.placed) { counts.roads += r.placed; return true; } }
  }
  return false;
}

// ------------------------------------------------------------ the bot's day
// a workplace type that already has a building standing idle for want of
// workers, or one still going up, isn't worth building more of yet (build
// homes for more villagers instead)
// any high-street trade the town can build yet (market, baker, butcher, draper...)
const anyShop = () => rng.pick(Object.keys(BUILDINGS).filter(t => BUILDINGS[t].cat === 'commercial' && !BUILDINGS[t].hidden && w.hasTech(BUILDINGS[t].tech) && w.unlockPop >= (BUILDINGS[t].unlock || 0)));
const idleType = (type) => !!BUILDINGS[type].levels[0].jobs && [...w.buildings.values()].some(b => b.type === type && (b.con ? b.con.kind === 'build' : (b.blockers || []).includes('workers')));
const placeUseful = (type, near) => place(idleType(type) ? 'house' : type, near);

function botDay() {
  const sim = game.sim;
  if (w.money < 150) return;
  // (the busy modes try every kind of little park too)
  const parks = MODE !== 'economy' ? ['pond', 'rosegarden', 'bandstand', 'allotment', 'physic', 'flowers', 'statue'] : [];
  // (and the civic buildings, near the town hall)
  const civic = MODE !== 'economy' ? ['lawcourts', 'museum', 'operahouse'] : [];
  for (let k = 1; k < busy; k++) { const t = rng.pick(['house', 'house', 'shop', 'bakery', 'tavern', 'workshop', 'chapel', 'school', 'clinic', 'garden', 'playground', 'well', ...parks, ...civic]); if (!placeUseful(t === 'shop' ? anyShop() : t)) growRoads(); }
  // and now and then has a planting or a monument reworked as another kind
  if (MODE !== 'economy' && rng.chance(0.3)) {
    const cands = [...w.buildings.values()].filter(b => KINDS[b.type] && !b.con);
    const b = cands.length ? rng.pick(cands) : null, keys = b ? Object.keys(KINDS[b.type]).filter(k => w.kindCheck(b, k).ok) : [];
    if (keys.length && w.setKind(b.id, rng.pick(keys)).ok) counts.rekinds++;
  }
  const issues = computeIssues(game);
  const has = (t) => issues.some(i => i.text.includes(t));
  // research: cheapest available project, but water and power once the
  // town is big enough to need them
  if (!w.research.current) {
    const can = Object.keys(TECHS).filter(id => w.canResearch(id)).sort((a, b) => TECHS[a].cost - TECHS[b].cost);
    const want = w.population >= 40 && ['hydraulics', 'electricity'].find(id => can.includes(id)) || w.population >= 140 && can.includes('steam') && 'steam';
    if (want || can.length) w.startResearch(want || can[0]);
  }
  // power before anything else: generators while it is short, a power
  // station once steam allows (saving up for one rather than upgrading)
  let saving = false;
  const genSite = [...w.buildings.values()].some(b => BUILDINGS[b.type].generator && b.con && b.con.kind === 'build');
  if ((has('No electricity') || has('Power short') || has('no power')) && w.hasTech('electricity') && !genSite) {
    const U = sim.utility, short = U.power.demand - U.power.gen;
    const big = w.hasTech('steam') && w.population >= 60 && short > 50 && (MODE !== 'economy' || w.money > 2400);
    const gen = () => (big && place('powerplant')) || (rng.chance(0.6) && place('watermill')) || place('windgen');
    const built = gen() || (w.money > 400 && growRoads() && gen());
    saving = !built && w.money < 400;
  }
  // keep the builders ahead of the work
  if (has('waiting for builders')) {
    const yard = [...w.buildings.values()].find(b => b.type === 'builder' && !b.con && w.upgradeCheck(b).ok);
    if (yard) { if (w.upgradeBuilding(yard.id).ok) counts.upgrades++; } else place('builder');
  }
  // homes
  // room a new household can move into (a single-family home with a family in has none)
  const free = sim.housing.open ?? sim.housing.cap - sim.housing.used;
  if (free < 4) { for (let i = 0; i < 2; i++) if (!place('house')) { growRoads(); break; } }
  // jobs
  const jobless = [...w.residents.values()].filter(r => r.age === 'adult' && r.job == null && r.school == null).length;
  if (jobless > 3) place(rng.pick([anyShop(), 'farm', 'workshop', 'lumber', 'bakery', 'tavern'].filter(t => w.checkBuild(t, center.x, center.z).reason !== `Research ${w.techName(BUILDINGS[t].tech)} first`)));
  // services that homes lack
  for (const [s, type] of [['water', 'well'], ['health', 'clinic'], ['safety', 'watch'], ['education', 'school']]) {
    const miss = [...w.buildings.values()].filter(b => b.factors && !b.factors[s] && BUILDINGS[b.type].levels[b.level].housing);
    if (miss.length >= 3) placeUseful(type, rng.pick(miss));
  }
  if (has('need a middle school') || has('need a high school') || has('need an elementary')) {
    const sch = [...w.buildings.values()].filter(b => BUILDINGS[b.type].levels[b.level].seats && !b.con);
    const opt = sch.flatMap(b => w.upgradeOptions(b).map(o => ({ b, o }))).find(({ b, o }) => w.upgradeCheck(b, o.type).ok);
    if (opt) { const r = w.upgradeBuilding(opt.b.id, opt.o.type); if (r.ok) counts.upgrades++; } else place('school');
  }
  if (has('Water for')) place(w.hasTech('hydraulics') && rng.chance(0.5) ? 'pump' : 'well');
  // water for the trades and services that need it
  const dry = [...w.buildings.values()].filter(b => (b.blockers || []).includes('water') && !BUILDINGS[b.type].levels[b.level].housing);
  if (dry.length) place('well', rng.pick(dry));
  if (has('builders can\'t reach') || has('not connected')) growRoads();
  // upgrades, with a random style now and then
  const ups = [...w.buildings.values()].filter(b => !b.con).sort(() => rng.next() - 0.5);
  let n = 0;
  for (const b of ups) {
    if (n >= 3 * busy || saving) break;
    const key = (o) => (o.extend ? 'extend' : o.type);
    const opts = w.upgradeOptions(b).filter(o => w.upgradeCheck(b, key(o)).ok);
    if (!opts.length) continue;
    const o = rng.pick(opts);
    const look = rng.chance(0.3) ? rng.pick(STYLES).id : undefined;
    if (w.upgradeBuilding(b.id, key(o), look).ok) { n++; counts.upgrades++; if (o.estate) counts.estateBuilt++; if (o.grand) counts.groundsBuilt++; if (o.extend) counts.extended = (counts.extended || 0) + 1; }
  }
  // farms plough more fields, and now and then change what they grow or raise
  // (the busy modes keep a farm going to try it on)
  if (MODE !== 'economy' && ![...w.buildings.values()].some(b => BUILDINGS[b.type].fields) && rng.chance(0.4)) place('farm');
  if (rng.chance(MODE !== 'economy' ? 0.5 : 0.12)) {
    const farms = [...w.buildings.values()].filter(b => BUILDINGS[b.type].fields && !b.con && (b.fields || 0) < w.fieldMax(b));
    const b = farms.length && rng.pick(farms);
    if (b && (MODE !== 'economy' || w.money > 200)) {
      // (squares of land beside it and behind it, lined up with it)
      const R = ownPlot(b), tiles = [];
      for (let j = -4; j <= 2; j++) for (let i = -4; i <= 4; i++) tiles.push([...toWorld(R, i + 0.5 * ((b.w + 1) % 2), j - 0.5 + 0.5 * (b.d % 2)), b.a]);
      const r = w.setFields(b.id, tiles, true);
      if (r.ok) counts.fields = (counts.fields || 0) + r.n;
    }
  }
  if (rng.chance(MODE !== 'economy' ? 0.15 : 0.03)) {
    const farms = [...w.buildings.values()].filter(b => BUILDINGS[b.type].fields && !b.con);
    const b = farms.length && rng.pick(farms);
    if (b && w.setProduce(b.id, rng.pick(Object.keys(PRODUCE))).ok) counts.produce = (counts.produce || 0) + 1;
  }
  // joins, expansions, moves, demolition
  for (let k = 0; k < busy; k++) if (rng.chance(MODE !== 'economy' ? 0.8 : 0.25)) {
    const cands = [...w.buildings.values()].filter(b => w.mergeOptions(b).some(m => m.ok));
    const b = cands.length && rng.pick(cands);
    const m = b && rng.pick(w.mergeOptions(b).filter(m => m.ok));
    if (m && w.mergeBuildings(b.id, m.other.id).ok) counts.merges++;
  }
  for (let k = 0; k < busy; k++) if (rng.chance(MODE !== 'economy' ? 0.6 : 0.12)) {
    const cands = [...w.buildings.values()].filter(b => !b.con && w.expandOptions(b).length);
    // the busy modes grow a double plot into a 2×2 estate (and a 2×2 park
    // into bigger grounds) whenever one can
    const grand = MODE !== 'economy' ? cands.filter(b => w.expandOptions(b).some(o => o.kind === 'estate' || o.kind === 'grand')) : [];
    const b = grand.length && rng.chance(0.5) ? rng.pick(grand) : cands.length && rng.pick(cands);
    const opts = b ? w.expandOptions(b).filter(o => MODE !== 'economy' || o.kind !== 'takeover') : [];
    const o = opts.length && rng.pick(opts);
    if (o && w.expandBuilding(b.id, o.dir, o.kind).ok) { counts.expands++; if (o.kind === 'estate') counts.estates++; if (o.kind === 'grand') counts.grounds++; }
  }
  if (rng.chance(MODE !== 'economy' ? 0.5 : 0.06)) {
    const cands = [...w.buildings.values()].filter(b => !b.con && BUILDINGS[b.type].size === 1 && !BUILDINGS[b.type].seat);
    const b = cands.length && rng.pick(cands);
    const s = b && spot(b.type, { x: b.x, z: b.z }, 8);
    if (s && w.moveBuilding(b.id, s.x, s.z, { a: s.a }).ok) counts.moves++;
  }
  if (rng.chance(MODE !== 'economy' ? 0.3 : 0.04)) {
    const cands = [...w.buildings.values()].filter(b => !b.con && !BUILDINGS[b.type].seat && b.type !== 'builder');
    const b = cands.length && rng.pick(cands);
    if (b && w.demolishBuilding(b.id).ok) counts.demolish++;
  }
  // the busy modes lay curving streets out of town with homes facing them
  // (and take a stretch up now and then), dress streets, and turn buildings
  // on their plots
  if (MODE !== 'economy' && rng.chance(0.4)) curve();
  if (MODE !== 'economy' && rng.chance(0.3)) dress();
  if (MODE !== 'economy' && rng.chance(0.4)) turn();
}

// a curving street out of town off one of its streets, homes along it
function curve() {
  // a stretch taken up now and then (its homes left to find another street)
  if (rng.chance(0.15)) {
    const ends = [...w.roads.edges.values()].filter(e => [e.a, e.b].some(n => w.roads.nodes.get(n).edges.length === 1) && e.a !== w.entry.node && e.b !== w.entry.node);
    if (ends.length && applyRoadEdit(w, [rng.pick(ends).id], 'remove').ok) counts.curveGone = (counts.curveGone || 0) + 1;
    return;
  }
  const pts = streetOut(rng.float(4, 8), rng.float(-0.6, 0.6));
  if (!pts || !w.placeRoad(pts, rng.pick([1, 2, 3])).placed) return;
  counts.curves = (counts.curves || 0) + 1;
  for (let i = 1; i < pts.length; i++) {
    const s2 = findPlot(w, rng.pick(['house', 'house', 'bakery', 'grocer']), { x: pts[i][0], z: pts[i][1] }, { r: 1.5, opts: { ignoreUnlock: true } });
    if (s2 && rng.chance(0.6) && w.placeBuilding(s2.chk ? rng.pick(['house', 'house']) : 'house', s2.x, s2.z, { a: s2.a, ignoreUnlock: true }).ok) counts.facing = (counts.facing || 0) + 1;
  }
}

// a street dressed (trees, hedges, lamps, a median), or a dressing taken off
function dress() {
  const es = [...w.roads.edges.values()];
  if (!es.length) return;
  const e = rng.pick(es), kinds = DRESSINGS.map((D, k) => (D && !D.blvd ? k : -1)).filter(k => k >= 0);
  if (applyDress(w, streetOf(w, e.id), rng.pick(kinds)).ok) counts.dressed = (counts.dressed || 0) + 1;
}

// a building turned a little on its plot (a park any way at all)
function turn() {
  const cands = [...w.buildings.values()].filter(b => !b.con && !b.spare && !(b.leases && b.leases.length));
  const b = cands.length && rng.pick(cands);
  if (!b) return;
  const a = BUILDINGS[b.type].park ? rng.float(-Math.PI, Math.PI) : b.a + rng.float(-0.35, 0.35);
  if (w.turnBuilding(b.id, a).ok) counts.turned = (counts.turned || 0) + 1;
}

// ------------------------------------------------------------ invariants
const audit = makeAudit(game, problem);

// ------------------------------------------------------------ run
const t0 = Date.now();
let day = w.day, botDone = -1, worstDayMs = 0;
console.log('day  pop  homes  jobs     money   happy  sites  issues  walkers  ms/day');
let dayStart = Date.now();
const startDay = w.day;
let steps = 0, idleCheck = -1, idleDays = 0, crowdCheck = -1, peakVisit = 0;
while (w.day < startDay + DAYS && steps < 400000) {
  const g = game.sim.update(0.1);
  game.agents.update(0.1, g);
  game.construction.update(0.1, g);
  game.transit.update(0.1);
  game.animals.update(0.1, game.speed);
  steps++;
  if (w.hours >= 9 && botDone !== w.day) { botDone = w.day; botDay(); }
  // parks and squares never hold more villagers than they have room for
  if (w.hours >= 15 && crowdCheck !== w.day) {
    crowdCheck = w.day;
    const at = new Map();
    for (const wk of game.agents.walkers) if (wk.r && wk.mode === 'wander' && !wk.working) at.set(wk.r.at, (at.get(wk.r.at) || 0) + 1);
    for (const [id, n] of at) {
      const b = w.buildings.get(id);
      if (!b || visitorCap(b) === Infinity) continue;
      peakVisit = Math.max(peakVisit, n / visitorCap(b));
      if (n > visitorCap(b)) problem(w.day, `${n} villagers crowd ${b.type} #${b.id} (room for ${visitorCap(b)})`);
    }
  }
  if (w.hours >= 12.5 && idleCheck !== w.day) {
    idleCheck = w.day;
    const C = game.construction;
    const idle = [...w.residents.values()].filter(r => r.site == null && r.loc === 'in' && r.at === r.job && BUILDINGS[w.buildings.get(r.job)?.type]?.builders && r.age === 'adult');
    const waiting = [...w.buildings.values()].filter(b => b.con && !b.con.wait && b.access && b.connected && !(b._unreach > w.day * 24 + w.hours) && ((C.crew.get(b.id) || {}).assigned || 0) < 2);
    idleDays = idle.length && waiting.length ? idleDays + 1 : 0;
    if (idleDays >= 3) problem(w.day, `${idle.length} builders idle at the yard while ${waiting.length} sites wait`);
  }
  if (w.day !== day) {
    const ms = Date.now() - dayStart; dayStart = Date.now();
    worstDayMs = Math.max(worstDayMs, ms);
    day = w.day;
    audit(day);
    if (process.env.DEBUG_SITES) {
      const C = game.construction;
      const sites = [...w.buildings.values()].filter(b => b.con).sort((a, b) => a.id - b.id).slice(0, 4);
      const builders = [...w.residents.values()].filter(r => r.job != null && BUILDINGS[w.buildings.get(r.job)?.type]?.builders);
      console.log('  sites', sites.map(s => `${s.type}#${s.id}:${s.con.kind}${s.con.wait ? '/' + s.con.wait : ''} ${(s.con.done / s.con.work * 100).toFixed(0)}% acc=${!!s.access} conn=${s.connected} unreach=${s._unreach ? (s._unreach - (w.day * 24 + w.hours)).toFixed(1) : '-'}`).join(' | '));
      console.log('  builders', builders.length, builders.map(r => r.loc + (r.site != null ? '@' + r.site : '')).join(' '), 'yards', [...w.buildings.values()].filter(b => b.type === 'builder').map(b => b.workers.length + '/' + capOf(b, 'jobs')).join(','));
    }
    const s = game.sim;
    const sites = [...w.buildings.values()].filter(b => b.con).length;
    if ((day - startDay) % 5 === 0 || day - startDay <= 2) {
      console.log(`${String(day).padStart(3)}  ${String(w.population).padStart(4)}  ${String(s.housing.cap).padStart(5)}  ${(s.jobs.filled + '/' + s.jobs.total).padStart(7)}  ${String(Math.round(w.money)).padStart(7)}   ${String(Math.round(s.happiness)).padStart(4)}%  ${String(sites).padStart(5)}  ${String(computeIssues(game).length).padStart(6)}  ${String(game.agents.walkers.size).padStart(7)}  ${String(ms).padStart(6)}`);
    }
  }
}
// a save from the middle of all this must load back the same
const json = JSON.stringify(serialize(w));
// PLAYTEST_SAVE=<file>: keep the town as a save, e.g. to load into the game for profiling
if (process.env.PLAYTEST_SAVE) (await import('node:fs')).writeFileSync(process.env.PLAYTEST_SAVE, json);
const w2 = deserialize(JSON.parse(json));
if (w2.buildings.size !== w.buildings.size || w2.residents.size !== w.residents.size) problems.push('save round-trip lost buildings or people');

const types = {};
for (const b of w.buildings.values()) types[b.type] = (types[b.type] || 0) + 1;
console.log(`\n${DAYS} days in ${((Date.now() - t0) / 1000).toFixed(1)} s (worst day ${worstDayMs} ms) · map ${N}×${N} · ${w.buildings.size} buildings · save ${(json.length / 1024).toFixed(0)} KB`);
console.log('activity:', JSON.stringify(counts));
console.log(`busiest park at 3pm: ${Math.round(peakVisit * 100)}% full`);
console.log('research done:', w.research.done.length, '/', Object.keys(TECHS).length, '· education:', [0, 1, 2, 3, 4, 5].map(e => [...w.residents.values()].filter(r => r.age !== 'child' && r.edu === e).length).join('/'));
console.log('buildings:', Object.entries(types).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
{
  // double plots grown into 2×2 estates, and the estate buildings standing on them
  const est = [...w.buildings.values()].filter(b => BUILDINGS[b.type].estate);
  const on = [...w.buildings.values()].filter(b => b.w * b.d === 4 && BUILDINGS[b.type].merged).length;
  console.log(`2×2 estates: ${counts.estates} grown, ${counts.estateBuilt} rebuilt as estate buildings · standing: ${est.map(b => `${BUILDINGS[b.type].levels[b.level].name}${b.con ? ' (building)' : ''}`).join(', ') || 'none'} · ${on} double-plot buildings on grown estates`);
  // 2×2 parks grown into bigger grounds, and the grand parks standing on them
  const big = [...w.buildings.values()].filter(b => BUILDINGS[b.type].grand && BUILDINGS[b.type].park);
  const parkTypes = new Set([...w.buildings.values()].filter(b => BUILDINGS[b.type].park).map(b => b.type));
  console.log(`park grounds: ${counts.grounds} grown, ${counts.groundsBuilt} laid out · standing: ${big.map(b => `${BUILDINGS[b.type].levels[b.level].name} ${b.w}×${b.d}`).join(', ') || 'none'} · ${parkTypes.size} kinds of park in town`);
  // plantings and monuments by kind and level, and how many were reworked
  const kinds = {};
  for (const b of w.buildings.values()) if (KINDS[b.type] && !BUILDINGS[b.type].seat) { const k = `${KINDS[b.type][kindOf(b)].name} L${b.level}`; kinds[k] = (kinds[k] || 0) + 1; }
  console.log(`plantings and monuments: ${Object.entries(kinds).sort().map(([k, v]) => `${k} ×${v}`).join(', ') || 'none'} · ${counts.rekinds} reworked`);
  // the seat of government, and the civic quarter round it
  const seat = seatOf(w), q = civicQuarter(w), civic = [...w.buildings.values()].filter(b => BUILDINGS[b.type].civic);
  console.log(`seat: ${seat ? `${BUILDINGS[seat.type].levels[seat.level].name} on ${seat.w}×${seat.d} (${KINDS[seat.type][kindOf(seat)].name.toLowerCase()})` : 'none'} · civic buildings: ${civic.map(b => BUILDINGS[b.type].levels[b.level].name).join(', ') || 'none'} · quarter: ${q.kinds.length} kinds, +${Math.round(q.tax * 100)}% tax`);
}
console.log('issues now:', computeIssues(game).map(i => i.text).join(' | ') || 'none');
{
  // where the money comes from, and how many buildings can't fully work (Sim._working)
  const B = game.sim.budget, r = (o) => Object.entries(o).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ');
  const why = {};
  let stopped = 0, part = 0;
  for (const b of w.buildings.values()) {
    if (!b.blockers || !b.blockers.length || (BUILDINGS[b.type].levels[b.level].housing && !BUILDINGS[b.type].levels[b.level].jobs)) continue;
    if (b.working === 0) stopped++; else if (b.working < 1) part++;
    for (const k of b.blockers) why[k] = (why[k] || 0) + 1;
  }
  const U = game.sim.utility;
  console.log(`budget/day: in ${r(B.income)} · out ${r(B.expense)} · visits so far $${Math.round(w.stats.visitIncome)} · power ${U.power.demand}/${U.power.gen} kW · water ${U.water.demand}/${U.water.supply}`);
  console.log(`working: ${stopped} stopped, ${part} in part · lacking ${r(why) || 'nothing'}`);
}
console.log(problems.length ? `\n${problems.length} problem(s):\n  ` + problems.join('\n  ') : '\nno problems found');
process.exit(problems.length ? 1 : 0);
