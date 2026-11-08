// Headless test of the starter towns: each one must grow the same every time,
// carry out its whole build script, be consistent (research for everything
// built, homes within capacity, everything on the road network), then play
// on for a few days with the full simulation without breaking any of the
// playtest invariants, and save and load back the same.
// Usage: node scripts/starters.js [days=6] [id,id…] [--map]
//   --map also prints each town day by day as it grows, and a map of it
//   (handy when changing a build script in src/world/starters.js)

import { STARTERS, growStarter, loadStarter, starterSummary } from '../src/world/starters.js';
import { PathFinder } from '../src/sim/path.js';
import { Sim } from '../src/sim/sim.js';
import { Agents } from '../src/sim/agents.js';
import { Transit } from '../src/sim/transit.js';
import { Animals } from '../src/sim/animals.js';
import { Construction } from '../src/sim/construction.js';
import { capOf, isOpen } from '../src/world/world.js';
import { BUILDINGS, techForLevel, unlockOf, STYLE_TECH } from '../src/defs.js';
import { ROAD_LEVELS } from '../src/config.js';
import { serialize, deserialize } from '../src/save/saves.js';
import { makeAudit } from './audit.js';
import { computeIssues } from '../src/ui/issues.js';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const MAP = process.argv.includes('--map');
const DAYS = Number(args[0] || 6);
const only = args[1] ? args[1].split(',') : null;
let failures = 0;

// The town as text, a character for each unit square (what stands at its
// middle): buildings by letter (capital once upgraded), : dirt, = cobbles,
// | bridge, ~ water, T trees, ^ steep.
const LETTER = { townhall: 'H', capitol: 'H', parliament: 'H', house: 'h', market: 'm', bakery: 'b', tavern: 'p', well: 'w', builder: 'B', farm: 'F', lumber: 'L', fishery: 'f', workshop: 'W',
  school: 'S', chapel: 'C', clinic: '+', watch: 'G', garden: 'g', flowers: '*', coachstop: 'c', watermill: 'M', windgen: 'X', pump: 'u' };
function asciiMap(w, R = 14) {
  const th = [...w.buildings.values()].find(b => BUILDINGS[b.type].seat), cx = Math.floor(th.x), cz = Math.floor(th.z), rows = [];
  for (let z = Math.max(0, cz - R); z <= Math.min(w.N - 1, cz + R); z++) {
    let row = '';
    for (let x = Math.max(0, cx - R); x <= Math.min(w.N - 1, cx + R); x++) {
      const px = x + 0.5, pz = z + 0.5, b = w.buildingAt(px, pz), r = w.roadAt(px, pz, 0.1);
      if (b) { const c = LETTER[b.type] || '?'; row += b.level ? c.toUpperCase() : c; }
      else if (r) row += w.waterAt(px, pz) ? '|' : r.e.level === 1 ? ':' : '=';
      else if (w.waterAt(px, pz)) row += '~';
      else if (w.treesNear(px, pz, 0.5).length) row += 'T';
      else row += w.terrain.slope(x, z) > 0.85 ? '^' : '.';
      row += ' ';
    }
    rows.push('     ' + row);
  }
  return rows.join('\n');
}

for (const def of STARTERS) {
  if (only && !only.includes(def.id)) continue;
  const problems = [];
  const problem = (day, msg) => { if (problems.length < 40) problems.push(`day ${day}: ${msg}`); };
  const t0 = performance.now();

  // 1. the same town every time, with the whole script carried out
  const onDay = MAP ? (w, sim) => console.log(`     day ${w.day}: ${w.population} villagers · $${Math.round(w.money)} (${Math.round(sim.budget.net)}/day) · happiness ${Math.round(sim.happiness)}% · homes ${sim.housing.used}/${sim.housing.cap} · jobs ${sim.jobs.filled}/${sim.jobs.total} · research ${w.research.current || '-'} ${w.research.progress}`) : undefined;
  const a = growStarter(def, { onDay }), ms = performance.now() - t0;
  const b = growStarter(def);
  const strip = (d) => JSON.stringify({ ...d, savedAt: null });
  if (strip(serialize(a.world)) !== strip(serialize(b.world))) problem(0, 'grows differently from one run to the next');
  for (const l of a.log) problem(0, `build script step not done: ${l}`);

  // 2. a new game from it, set up the way Game.load does
  const w = loadStarter(def.id, { name: 'Testham' });
  const scene = { add() {}, remove() {} };
  const game = {
    speed: 8, env: { night: 0 }, renderer: { scene, worldToScreen: () => ({ x: 0, y: 0 }) }, view: { smoke: { emit() {} } },
    _ev: {}, on(e, f) { (this._ev[e] ||= []).push(f); }, emit(e, d) { for (const f of this._ev[e] || []) f(d); },
  };
  game.world = w;
  game.paths = new PathFinder(w);
  game.sim = new Sim(game);
  game.transit = new Transit(game);
  game.sim.recompute();
  game.agents = new Agents(game);
  game.animals = new Animals(game);
  game.construction = new Construction(game);
  game.transit.rebuild();
  game.transit.planCarts();
  game.on('day', () => game.transit.planCarts());
  w.on('roads', () => game.paths.invalidate?.());
  const audit = makeAudit(game, problem);
  const sim = game.sim;

  // 3. consistent from the start
  if (w.townName !== 'Testham') problem(0, 'the chosen name was not used');
  for (const bd of w.buildings.values()) {
    const L = BUILDINGS[bd.type].levels[bd.level];
    if (bd.con) problem(0, `${L.name} #${bd.id} is still a building site`);
    if (!bd.connected) problem(0, `${L.name} #${bd.id} is not on the road network`);
    for (let l = 0; l <= bd.level; l++) {
      const tech = techForLevel(bd.type, l);
      if (tech && !w.hasTech(tech)) problem(0, `${BUILDINGS[bd.type].levels[l].name} built without researching ${tech}`);
    }
    if (bd.look && STYLE_TECH[bd.look] && !w.hasTech(STYLE_TECH[bd.look])) problem(0, `${L.name} #${bd.id} has the ${bd.look} style without its research`);
    if (unlockOf(bd.type, bd.level) > w.population + 10) problem(0, `${L.name} needs ${unlockOf(bd.type, bd.level)} villagers but the town has ${w.population}`);
    if (L.housing && bd.residents.length > capOf(bd, 'housing') + 1) problem(0, `${L.name} #${bd.id} starts overcrowded: ${bd.residents.length}/${capOf(bd, 'housing')}`);
  }
  let road2 = 0;
  for (const e of w.roads.edges.values()) if (e.level >= 2) road2 = Math.max(road2, e.level);
  if (road2 && ROAD_LEVELS[road2].unlock > w.population) problem(0, `${ROAD_LEVELS[road2].name} laid with only ${w.population} villagers`);
  const R = w.research, researched = R.done.join(', ') || 'none', researching = R.current;
  if (R.current && !w.canResearch(R.current)) problem(0, `researching ${R.current} without what it needs`);
  for (const id of R.done) if (!R.done.includes(id)) problem(0, 'research list broken');
  if (!(w.money > 0 && Number.isFinite(w.money))) problem(0, `starts with $${w.money}`);
  const kids = [...w.residents.values()].filter(r => r.age === 'child');
  const adults = [...w.residents.values()].filter(r => r.age === 'adult');
  if (!w.population) problem(0, 'nobody lives here');
  if (adults.some(r => r.home == null)) problem(0, 'homeless villagers');
  const jobless = adults.filter(r => r.job == null && r.school == null).length;
  if (jobless > Math.max(3, adults.length * 0.25)) problem(0, `${jobless} of ${adults.length} grown-ups have no work`);
  audit(w.day);
  const issues = computeIssues(game).map(i => i.text);
  if (issues.some(t => /debt|Losing|not connected|short/.test(t))) problem(w.day, `starts with trouble: ${issues.join(' | ')}`);

  // 4. plays on without trouble (a heavy town, like the Metropolis, one day
  // unless it is named: its tens of thousands of villagers take a while)
  const days = def.heavy && !only ? 1 : DAYS;
  const start = { day: w.day, money: w.money, pop: w.population, visits: w.stats.visitIncome };
  let day = w.day, steps = 0;
  while (w.day < start.day + days && steps < 200000) {
    const g = sim.update(0.1);
    game.agents.update(0.1, g);
    game.construction.update(0.1, g);
    game.transit.update(0.1);
    game.animals.update(0.1, game.speed);
    steps++;
    if (w.day !== day) { day = w.day; audit(day); }
  }
  if (w.population < start.pop * 0.7) problem(w.day, `population fell from ${start.pop} to ${w.population}`);

  // 5. saves and loads back the same
  const json = JSON.stringify(serialize(w));
  const w2 = deserialize(JSON.parse(json));
  if (w2.buildings.size !== w.buildings.size || w2.residents.size !== w.residents.size || w2.research.done.length !== w.research.done.length) problem(w.day, 'save round-trip lost something');

  const s = starterSummary(def.id);
  const perDay = (w.stats.visitIncome - start.visits) / days;
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${def.name}: grown in ${ms.toFixed(0)} ms · day ${s.day} · ${s.N}×${s.N} · ${s.pop} villagers (${kids.length} children, ${jobless} looking for work) · $${s.money} · ${s.buildings} buildings · research ${researched}${researching ? ` (now ${researching})` : ''}`);
  console.log(`     issues at the start: ${issues.join(' | ') || 'none'}`);
  console.log(`     after ${days} more day${days === 1 ? '' : 's'}: ${w.population} villagers · $${Math.round(w.money)} · happiness ${Math.round(sim.happiness)}% · shop visits $${perDay.toFixed(0)}/day`);
  if (MAP) {
    const miss = {};
    for (const bd of a.world.buildings.values()) if (bd.factors && BUILDINGS[bd.type].levels[bd.level].housing) for (const k of ['water', 'health', 'education', 'safety', 'culture']) if (!bd.factors[k]) miss[k] = (miss[k] || 0) + 1;
    console.log(`     homes out of reach: ${JSON.stringify(miss)}\n${asciiMap(a.world)}`);
  }
  if (problems.length) { failures++; console.log('     ' + problems.join('\n     ')); }
}
console.log(failures ? `\n${failures} starter town(s) with problems` : '\nall starter towns ok');
process.exit(failures ? 1 : 0);
