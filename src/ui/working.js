// What a building needs to work and what it is missing (Sim._working):
// warning badges over blocked buildings, and the building panel's
// "Working" section with what to do about each problem.

import { BUILDINGS, needsOf, servicesOf } from '../defs.js';
import { isOpen, capOf } from '../world/world.js';
import { streetOf } from '../world/streets.js';
import { EDU } from '../sim/people.js';

export const BLOCKER_ICON = { road: 'link_off', workers: 'person_off', power: 'power_off', water: 'format_color_reset', priority: 'flag' };

// The main thing holding a building back: no road, nobody at all, then no
// power or water, and only then being short of staff.
export function mainBlocker(b) {
  const bl = b.blockers || [];
  if (bl.includes('road')) return 'road';
  if (bl.includes('workers') && !b.workers.length) return 'workers';
  return ['power', 'water', 'workers'].find(k => bl.includes(k)) || null;
}
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// What each blocker does to a building on its own: 'stop' if that alone
// stops it, 'part' if it only holds it back (or, for a home, stops it
// growing).
export function blockerEffect(b, k) {
  const need = needsOf(b.type, b.level);
  if (k === 'road') return 'stop';
  if (k === 'workers') return b.workers.length ? 'part' : 'stop';
  if (k === 'power') return need.power && !need.power.without ? 'stop' : 'part';
  if (k === 'water') return need.water && !need.water.without ? 'stop' : 'part';
  return 'part';
}
const ORDER = ['road', 'workers', 'power', 'water'];

// Badges over buildings that can't do their job properly, one for each
// thing missing, side by side: red for what stops it, amber for what holds
// it back. One of the pop-ups, so it can be switched off.
export class BlockedIcons {
  constructor(game, layer) {
    this.game = game;
    this.layer = layer;
    this.els = new Map();
    this.v = new game.THREE.Vector3();
  }

  update() {
    const g = this.game, w = g.world;
    const show = w && !g.demo && g.view && g.settings.popBlocked !== false && g.renderer.rig.zoom >= 0.8;
    const seen = new Set();
    if (show) {
      for (const b of w.buildings.values()) {
        const it = g.view.items.get(b.id);
        if (!it) continue;
        // a building site gets a flag when the player has put it first
        const site = it.site || !!b.con;
        if (site ? !(b.con && b.con.priority) : !(b.blockers && b.blockers.length)) continue;
        const bb = it.mesh && it.mesh.geometry && it.mesh.geometry.boundingBox;
        const p = g.renderer.worldToScreen(this.v.set(b.x, b.baseY + (bb ? bb.max.y : 0.7) + 0.12, b.z));
        if (p.behind || p.x < -20 || p.y < -20 || p.x > innerWidth + 20 || p.y > innerHeight + 20) continue;
        const all = site ? [['priority', 'prio']] : ORDER.filter(k => b.blockers.includes(k)).map(k => [k, blockerEffect(b, k)]);
        const key = all.map(a => a.join(':')).join(' ');
        let el = this.els.get(b.id);
        if (!el) { el = document.createElement('div'); el.className = 'blocked'; this.layer.appendChild(el); this.els.set(b.id, el); }
        if (el.dataset.key !== key) { el.dataset.key = key; el.innerHTML = all.map(([k, e]) => `<span class="bi ${e}"><span class="ms">${BLOCKER_ICON[k]}</span></span>`).join(''); }
        el.style.left = `${p.x}px`; el.style.top = `${p.y}px`;
        seen.add(b.id);
      }
    }
    for (const [id, el] of this.els) if (!seen.has(id)) { el.remove(); this.els.delete(id); }
  }
}

// What to do about missing power or water, given the state of the town.
export function powerAdvice(game) {
  const w = game.world, U = game.sim.utility;
  if (!w.hasTech('electricity')) return 'Research Electricity, then build a generator';
  const gens = [...w.buildings.values()].filter(b => BUILDINGS[b.type].generator && isOpen(b));
  if (!U.power.gen) return gens.length ? 'The generators have nobody to run them' : 'Build a generator (Utilities): a Water Wheel or a Wind Generator';
  if (U.power.demand > U.power.gen) return `The grid is short by ${U.power.demand - U.power.gen} kW: build more generators`;
  return 'Connect it to the grid along the roads';
}
export function waterAdvice(game, b) {
  const U = game.sim.utility;
  return b.wet === 1 ? `The town's water runs short (${U.water.supply} for ${U.water.demand} people): build more wells, a pump or a water tower`
    : !b.connected ? "Not on the water mains: connect it to the town's roads"
      : 'The town has no well or pump drawing water: build one anywhere on the roads (Utilities)';
}
function workerAdvice(game, b) {
  const w = game.world, L = BUILDINGS[b.type].levels[b.level];
  const free = [...w.residents.values()].filter(r => r.age === 'adult' && r.job == null && r.school == null);
  if (L.edu && free.length) return `It needs workers with ${EDU[L.edu].toLowerCase()} education, and none of the ${free.length} looking for work have it: build schools`;
  return 'Nobody is free to work here: build homes to bring in more villagers';
}

// The building panel's "Working" section: how well it works, and for each
// thing it lacks, what that does and what to do about it.
export function workingHTML(game, b) {
  const def = BUILDINGS[b.type], L = def.levels[b.level], sim = game.sim;
  if (!isOpen(b) || b.working == null) return '';
  const need = needsOf(b.type, b.level);
  const bl = b.blockers || [];
  const home = !!L.housing && !L.jobs;
  if (home && !bl.length) return '';
  const lines = [];
  const k = Math.min(1, b.working);
  const pct = (v) => `${Math.round(v * 100)}%`;
  if (bl.includes('road')) lines.push(['no', "Not connected to the town's roads: lay a road to it"]);
  if (capOf(b, 'jobs') && need.staff && !bl.includes('road')) {
    const jobs = capOf(b, 'jobs');
    if (!b.workers.length) lines.push(['no', `No workers, so nothing gets done. ${workerAdvice(game, b)}`]);
    else if (b.workers.length < jobs) lines.push([bl.includes('workers') ? 'no' : 'warn', `${b.workers.length} of ${jobs} jobs filled. ${workerAdvice(game, b)}`]);
  }
  if (need.power) {
    const n = need.power;
    const effect = n.use === 'lights' ? `it does little trade after dark (${pct(n.without)} of its takings)`
      : n.without ? `it works at ${pct(n.without)}` : 'it stops';
    if (bl.includes('power')) lines.push(['no', `No power for ${n.what}: ${effect}. ${powerAdvice(game)}`]);
    else if (!bl.includes('road')) lines.push(['ok', `Power for ${n.what}`]);
  }
  if (need.water || L.housing) {
    const what = need.water ? `No water for ${need.water.what}: ${need.water.without ? `it works at ${pct(need.water.without)}` : 'it stops'}`
      : "No running water: the home can't upgrade, expand or grow its family";
    if (bl.includes('water')) lines.push([need.water ? 'no' : 'warn', `${what}. ${waterAdvice(game, b)}`]);
    else if (need.water && !bl.includes('road')) lines.push(['ok', `Running water for ${need.water.what}`]);
  }
  if (!lines.length) return '';
  // what that means for its work
  const rows = [];
  if (!home) rows.push(['Working', k >= 1 ? 'Fully' : k > 0 ? `At ${pct(k)}` : 'Stopped']);
  if (L.radius && servicesOf(def).length && !def.park) rows.push(['Reach now', `${sim.reachOf(b).toFixed(1).replace(/\.0$/, '')} of ${L.radius} units`]);
  if (L.seats) rows.push(['Places now', `${sim.seatsOf(b)} of ${capOf(b, 'seats')}`]);
  if (L.kw) rows.push(['Making', `${Math.round(L.kw * k)} of ${L.kw} kW`]);
  if (L.supply) rows.push(['Drawing water for', `${Math.round(sim.supplyOf(b))} of ${L.supply} people`]);
  if (def.park && L.appeal) rows.push(['Scenery now', `+${Math.round(L.appeal * k)} of +${L.appeal}`]);
  const head = home ? 'Running water' : k >= 1 && !bl.length ? 'Working' : k > 0 ? 'Working in part' : 'Stopped';
  const icon = bl.length ? BLOCKER_ICON[mainBlocker(b)] : 'check_circle';
  let h = `<div class="sec working ${k > 0 ? (bl.length ? 'part' : 'ok') : 'stop'}"><h5><span class="ms">${icon}</span> ${head}</h5>`;
  h += rows.map(([a, v]) => `<div class="row"><span>${a}</span><b>${v}</b></div>`).join('');
  h += `<div class="req">${lines.map(([c, t]) => `<div class="${c === 'warn' ? 'no warn' : c}">${esc(t)}</div>`).join('')}</div></div>`;
  return h;
}

// Every road tile in town (to bury all the power lines at once).
// every road edge in town (ids)
export function townRoadTiles(w) { return [...w.roads.edges.keys()]; }

// The power lines along the streets: how much is on poles, and buttons to
// bury this street's (e given: a road panel) or every one in town.
export function buryHTML(game, e = null) {
  const w = game.world;
  if (![...w.buildings.values()].some(b => BUILDINGS[b.type].generator && isOpen(b))) return '';
  const all = townRoadTiles(w);
  const len = (list) => list.reduce((s, id) => s + w.roads.edges.get(id).len, 0);
  const under = len(all.filter(id => w.roads.edges.get(id).buried));
  let h = '<div class="sec"><h5><span class="ms">bolt</span> Power lines</h5>';
  if (e != null) h += `<div class="row"><span>Along this stretch</span><b>${w.roads.edges.get(e).buried ? 'Underground' : 'On poles and wires'}</b></div>`;
  h += `<div class="row"><span>In town</span><b>${under.toFixed(0)} of ${len(all).toFixed(0)} units of road underground</b></div>`;
  if (!w.hasTech('cables')) return h + '<div class="note">Research Underground Cables (Power) to bury the lines: no more poles and wires, and prettier streets.</div></div>';
  const street = e != null ? w.buryCost(streetOf(w, e)) : 0, town = w.buryCost(all);
  const btn = (scope, label, cost) => `<button class="btn" data-act="bury" data-scope="${scope}" ${w.money >= cost ? '' : 'disabled'}>${label} · $${Math.round(cost).toLocaleString('en-US')}</button>`;
  if (street || town) h += `<div class="actions col">${street ? btn('street', 'Bury the lines along this street', street) : ''}${town ? btn('town', 'Bury every line in town', town) : ''}</div>`;
  else h += '<div class="note">Every line in town is underground.</div>';
  return h + '</div>';
}

// For an upgrade card: what the next level will need that this one doesn't.
export function needsNoteHTML(b, type, level) {
  const now = needsOf(b.type, b.level), next = needsOf(type, level);
  const out = [];
  for (const k of ['power', 'water']) {
    const n = next[k];
    if (!n || (now[k] && now[k].what === n.what && now[k].without === n.without)) continue;
    const effect = k === 'power' && n.use === 'lights' ? 'trades less after dark without it' : n.without ? `works at ${Math.round(n.without * 100)}% without it` : 'stops without it';
    out.push(`<div class="needs-note"><span class="ms">${k === 'power' ? 'bolt' : 'water_drop'}</span> Needs ${k === 'power' ? 'electricity' : 'running water'} for ${esc(n.what)}: ${effect}</div>`);
  }
  return out.join('');
}

