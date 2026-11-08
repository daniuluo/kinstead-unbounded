// What a building does, for the build menu: a short summary when hovering a
// card, and the full picture (every level, its needs and where it can lead)
// in the Building guide window when one is picked.

import { BUILDINGS, SERVICES, TECHS, MERGES, LARGE, ESTATE, GRAND, RESEARCH_SOURCES, KINDS, servicesOf, unlockOf, techForLevel, workNeeded, sellsText } from '../defs.js';
import { EDU } from '../sim/people.js';
import { visitorCap, visitKind } from '../sim/agents.js';
import { thumb } from './thumbs.js';
import { showPathMap } from './pathMap.js';

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const GUIDE = 'Building guide';

const plot = (def) => (def.merged ? { w: 2, d: 1 } : { w: def.size, d: def.size });
const visitors = (type, level) => { const p = plot(BUILDINGS[type]); return visitorCap({ type, level, size: Math.max(p.w, p.d), ...p }); };
const WHO = { park: 'people out for a stroll', shop: 'shoppers', tavern: 'guests', chapel: 'worshippers', clinic: 'patients' };

// What one level offers, as [label, value] pairs (the wiki shows these too).
export function stats(type, level) {
  const def = BUILDINGS[type], L = def.levels[level], out = [];
  if (L.housing) out.push(['Homes for', `${L.housing} villagers`]);
  if (L.households) out.push(['Households', L.households === 1 ? 'one family' : `up to ${L.households} families`]);
  if (L.jobs) out.push(['Jobs', `${L.jobs}${L.edu ? ` (${EDU[L.edu].toLowerCase()} schooling)` : ''}`]);
  if (L.seats) out.push(['Pupils', `${L.seats}`]);
  const cap = visitors(type, level);
  if (Number.isFinite(cap)) out.push(['Visitors at once', `${cap} ${WHO[visitKind(def)]}`]);
  if (def.shop) out.push(['Sells', sellsText({ type })]);
  for (const s of servicesOf(def)) out.push([`${SERVICES[s].name} reach`, `${L.radius} units`]);
  if (def.park && L.appeal) out.push(['Scenery', `+${L.appeal} within ${L.radius} units`]);
  else if (L.appeal) out.push(['Scenery', `+${L.appeal}`]);
  if (L.visit) out.push(['Per visit', `$${L.visit}`]);
  if (def.play) out.push(['Play', 'homes with children nearby are happier']);
  if (def.potter) out.push(['Digging', 'homes with elders nearby are happier']);
  if (L.culture) out.push(['Culture reach', `${L.culture} units`]);
  const res = RESEARCH_SOURCES[type];
  if (res) out.push(['Research', `${res[Math.min(level, res.length - 1)]} a day`]);
  if (L.income) out.push(['Earnings', `$${L.income} a worker a day`]);
  if (L.supply) out.push(['Water for', `${L.supply} villagers`]);
  if (L.kw) out.push(['Power', `${L.kw} kW`]);
  if (L.rate) out.push(['Builder speed', `${L.rate}×`]);
  if (L.taxBonus) out.push(['Town tax', `+${Math.round(L.taxBonus * 100)}%`]);
  if (L.pollution) out.push(['Smoke', `${L.pollution} units around`]);
  if (L.upkeep) out.push(['Upkeep', `$${L.upkeep} a day`]);
  return out;
}

// What a level needs before it can be built or upgraded to.
function needs(world, type, level) {
  const L = BUILDINGS[type].levels[level], out = [];
  const pop = unlockOf(type, level), tech = techForLevel(type, level);
  if (pop) out.push({ text: `${pop} villagers`, met: world.unlockPop >= pop });
  if (tech) out.push({ text: `Research: ${TECHS[tech].name}`, met: world.hasTech(tech) });
  const r = L.req || {};
  if (r.happiness) out.push({ text: `Happiness ${r.happiness}%` });
  for (const s of ['water', 'health', 'education', 'safety', 'culture']) if (r[s]) out.push({ text: `${SERVICES[s].name} nearby` });
  if (r.power) out.push({ text: 'Electricity' });
  return out;
}

export function placement(def) {
  const out = [];
  out.push(def.grand ? `Takes ${def.size}×${def.size} grounds, grown from ${def.seat ? `the ${def.size - 1}×${def.size - 1} seat of government` : `a ${def.size - 1}×${def.size - 1} park`}` : def.estate ? 'Takes a 2×2 estate, grown from a double plot' : def.merged ? 'Takes a double plot' : def.size > 1 ? `Takes a ${def.size}×${def.size} plot` : 'Takes one plot');
  if (!def.park) out.push('needs a road alongside');
  if (def.needsWater) out.push('must be beside water');
  if (def.needsRail) out.push('needs railway track alongside');
  if (def.unique) out.push(def.seat ? 'one seat of government per town' : 'only one per town');
  return out.join(', ');
}

function lockText(world, type) {
  const def = BUILDINGS[type], pop = unlockOf(type, 0);
  if (world.unlockPop < pop) return `Unlocks at ${pop} villagers`;
  if (!world.hasTech(def.tech)) return `Research ${TECHS[def.tech].name} first`;
  return null;
}

// The 2×2 estates a building can lead to: every double-plot building it can
// become (grown, joined, branched or moved on a stage), and what each of
// those can be rebuilt as on a 2×2 estate. [{ from, to }]
export function estatesFrom(type) {
  const seen = new Set([type]), queue = [type], out = [];
  while (queue.length) {
    const t = queue.shift(), def = BUILDINGS[t];
    for (const e of ESTATE[t] || []) if (!out.some(o => o.to === e)) out.push({ from: t, to: e });
    const next = [...(LARGE[t] || []), ...(def.branches || []), ...Object.values(def.paths || {}).flat(), ...(def.stageNext || []),
      ...MERGES.filter(m => m.a.includes(t) || m.b.includes(t)).map(m => m.to)];
    for (const n of next) if (!seen.has(n) && !BUILDINGS[n].estate) { seen.add(n); queue.push(n); }
  }
  return out;
}

// The hover summary for a build menu card.
export function buildingSummary(world, type) {
  const def = BUILDINGS[type], L = def.levels[0];
  const chain = def.levels.map(l => esc(l.name)).join(' › ');
  const lock = lockText(world, type);
  let h = `<div class="bsum"><b>${esc(def.name)}</b>`;
  h += `<div class="bsum-chain">${chain}</div><div class="bsum-desc">${esc(def.desc || '')}</div><div class="bsum-stats">`;
  h += [['Cost', `$${L.cost}`], ...stats(type, 0)].map(([k, v]) => `<span>${esc(k)}</span><b>${esc(v)}</b>`).join('');
  h += `</div><div class="bsum-foot">${esc(placement(def))}</div>`;
  if (lock) h += `<div class="bad">🔒 ${esc(lock)}</div>`;
  return h + '<div class="bsum-hint">Click for the full guide</div></div>';
}

// The Building guide window: every level and path, kept to one window that
// follows whichever building was picked last.
export function showBuildingGuide(ui, type) {
  const world = ui.world, def = BUILDINGS[type];
  const lock = lockText(world, type);
  let h = `<h2>${GUIDE}</h2><div class="guide-head"><img src="${thumb(type, 0)}" alt=""><div><h3>${esc(def.name)}</h3><div class="guide-desc">${esc(def.desc || '')}</div>`;
  h += `<div class="guide-place">${esc(placement(def))} · builders take about ${Math.max(1, Math.round(workNeeded(def.levels[0].cost)))} builder-hours to put it up</div>`;
  if (lock) h += `<div class="guide-lock">🔒 ${esc(lock)}</div>`;
  h += '</div></div>';
  def.levels.forEach((L, i) => {
    const nd = needs(world, type, i);
    h += `<div class="guide-level"><img src="${thumb(type, i)}" alt=""><div><div class="guide-lname"><b>${i ? '⬆ ' : ''}${esc(L.name)}</b><span>$${L.cost}</span></div>`;
    h += `<div class="guide-stats">${stats(type, i).map(([k, v]) => `<span>${esc(k)}</span><b>${esc(v)}</b>`).join('')}</div>`;
    if (nd.length) h += `<div class="guide-needs">${nd.map(n => `<span class="${n.met === false ? 'no' : n.met ? 'ok' : ''}">${esc(n.text)}</span>`).join('')}</div>`;
    h += '</div></div>';
  });
  // the kinds it comes in
  if (KINDS[type]) {
    h += def.seat
      ? `<div class="guide-more"><h5>${Object.keys(KINDS[type]).length} styles</h5><div class="note">Builders can rebuild it in another style at any level, from its panel. Until one is chosen it has a clock tower, and a dome from the Civic Palace up.</div>`
      : `<div class="guide-more"><h5>${Object.keys(KINDS[type]).length} kinds</h5><div class="note">Choose one in the bar above the build menu, or let its seed choose; builders can rework it as another later, from its panel.</div>`;
    for (const x of Object.values(KINDS[type])) h += `<div><span class="ms">${x.icon}</span> <b>${esc(x.name)}</b>${x.tech ? ` <span class="${world.hasTech(x.tech) ? 'ok' : 'no'}">(${esc(TECHS[x.tech].name)})</span>` : ''}: ${esc(x.desc)}</div>`;
    h += '</div>';
  }
  // where it can lead beyond its own levels
  const more = [];
  for (const b of def.branches || []) more.push(`At the top level it can become: <b>${esc(BUILDINGS[b].levels[0].name)}</b> (${esc(BUILDINGS[b].name)})`);
  for (const [lv, list] of Object.entries(def.paths || {})) for (const b of list) more.push(`From the ${esc(def.levels[lv].name)} it can turn into a <b>${esc(BUILDINGS[b].levels[0].name)}</b>`);
  for (const b of def.stageNext || []) more.push(`It can move on to the next stage: <b>${esc(BUILDINGS[b].levels[0].name)}</b>`);
  for (const b of LARGE[type] || []) more.push(`On a double plot it can be rebuilt as <b>${esc(BUILDINGS[b].levels[0].name)}</b>`);
  for (const b of GRAND[type] || []) more.push(def.seat
    ? `At the top level, grown onto the land round it (${BUILDINGS[b].size}×${BUILDINGS[b].size} grounds, Capital City), it can be rebuilt as the <b>${esc(BUILDINGS[b].levels[0].name)}</b>`
    : `Grown onto the land round it (${BUILDINGS[b].size}×${BUILDINGS[b].size} grounds, Public Parks) it can be laid out as <b>${esc(BUILDINGS[b].levels[0].name)}</b>`);
  for (const m of MERGES) {
    const other = m.a.includes(type) ? m.b : m.b.includes(type) ? m.a : null;
    if (other) more.push(`Joined with a neighbouring ${other.map(o => esc(BUILDINGS[o].levels[0].name.toLowerCase())).join(' or ')}: <b>${esc(BUILDINGS[m.to].levels[0].name)}</b>`);
  }
  if (more.length) h += `<div class="guide-more"><h5>Other paths</h5>${more.map(t => `<div>${t}</div>`).join('')}<button class="btn small" data-paths="${type}">All paths</button></div>`;
  // and the 2×2 estates further along (Great Plots)
  const estates = estatesFrom(type);
  if (estates.length) {
    h += `<div class="guide-estates"><h5>On a 2×2 estate</h5>`;
    for (const { from, to } of estates) {
      const E = BUILDINGS[to], src = BUILDINGS[from].levels[0].name;
      // growing the plot takes Great Plots, whatever the building itself needs
      const nd = [...(techForLevel(to, 0) === 'bigplots' ? [] : [{ text: `Research: ${TECHS.bigplots.name}`, met: world.hasTech('bigplots') }]), ...needs(world, to, 0)];
      h += `<div class="guide-level"><img src="${thumb(to, 0)}" alt=""><div><div class="guide-lname"><b>${esc(E.levels[0].name)}</b><span>$${E.levels[0].cost}</span></div>`;
      h += `<div class="guide-from">${/^[AEIOU]/.test(src) ? 'An' : 'A'} ${esc(src)} grown onto the two plots beside it can be rebuilt as this · ${E.levels.map(l => esc(l.name)).join(' › ')}</div>`;
      h += `<div class="guide-stats">${stats(to, 0).map(([k, v]) => `<span>${esc(k)}</span><b>${esc(v)}</b>`).join('')}</div>`;
      h += `<div class="guide-needs">${nd.map(n => `<span class="${n.met === false ? 'no' : n.met ? 'ok' : ''}">${esc(n.text)}</span>`).join('')}</div>`;
      h += '</div></div>';
    }
    h += '</div>';
  }
  const known = ui.windows && ui.windows.has(GUIDE);
  let saved = null;
  try { saved = localStorage.getItem(`hearthvale.win.${GUIDE}`); } catch {}
  ui.openModal(h, (c) => { c.classList.add('guide'); for (const p of c.querySelectorAll('[data-paths]')) p.onclick = () => showPathMap(ui, null, p.dataset.paths); });
  // the first time, keep it to the left so the map stays clear for building
  const win = ui.windows.get(GUIDE);
  if (win && !known && !saved) { win.style.left = '8px'; win.style.top = '132px'; ui._fitWin(win); }
}
