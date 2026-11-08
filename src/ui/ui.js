// HUD, toolbar, inspector, notifications and dialogs.

import { CONFIG, DRESSINGS, ROAD_LEVELS, SEASONS, titleFor, seasonOf, TITLES, TREE_COST, TERRAFORM_COST, streetPart, lookPart } from '../config.js';
import { BUILDINGS, CATEGORIES, SERVICES, TRANSIT, RAIL_COST, unlockOf, TECHS, STYLE_TECH, servicesOf, BRANCHES, MERGES, techForLevel, CAPABILITIES, growsInto, plotName, parkOrigin, visitOf, KINDS, kindOf, ESTATE_TYPES, PRODUCE, produceOf, FARM_JOIN, sellsText, choosesProduce, CIVIC_QUARTER, CIVIC_TYPES } from '../defs.js';
import { isOpen, capOf, isExpanded, sizeK, sizeKFor, scaledLevel, householdCap, civicQuarter, buildingCenter } from '../world/world.js';
import { thumb } from './thumbs.js';
import { computeIssues } from './issues.js';
import { BlockedIcons, workingHTML, needsNoteHTML, buryHTML, townRoadTiles } from './working.js';
import { STYLES } from '../render/buildings.js';
import { TRAITS, traitsOf, salaryOf, livingCostOf, pensionOf, wealthOf, relativesOf, friendsOf, yearsOf, eduOf, EDU, schoolingOf, familyOf, householdsIn } from '../sim/people.js';
// What keeps gondola lines locked: too few villagers, or Cable Cars not researched.
const gondolaLock = (w) => w.unlockPop < TRANSIT.gondola.unlock ? TRANSIT.gondola.unlock : !w.hasTech('cablecars') ? `🔬 ${TECHS.cablecars.name}` : 0;
// What feeds a home's happiness, and what to do about each.
const HAPPY = {
  base: { label: 'Everyday life', icon: 'cottage', tip: '' },
  water: { want: 'water', label: 'Water', icon: 'water_drop', tip: (f) => (f.dry ? 'Water runs short — build more wells, a pump or a water tower' : 'Connect it by road to the water mains (any well, pump or water tower in town)'), act: { label: 'Utilities', cat: 'utilities' } },
  health: { want: 'a clinic nearby', label: 'Health care', icon: 'medical_services', tip: 'Build a clinic within reach', act: { label: 'Services', cat: 'services' } },
  education: { want: 'a school nearby', label: 'Schooling', icon: 'school', tip: 'Build a school within reach', act: { label: 'Services', cat: 'services' } },
  safety: { want: 'a watch post nearby', label: 'Safety', icon: 'shield', tip: 'Build a watch post or fire station within reach', act: { label: 'Services', cat: 'services' } },
  culture: { want: 'a chapel or hall nearby', label: 'Culture', icon: 'church', tip: 'Build a chapel or music hall within reach', act: { label: 'Services', cat: 'services' } },
  power: { want: 'electricity', label: 'Electricity', icon: 'bolt', tip: (f, g) => (g.sim.utility && g.sim.utility.power.gen ? 'Not enough power — build more generators' : 'Build a generator (Utilities)'), act: { label: 'Utilities', cat: 'utilities' } },
  appeal: { want: 'nicer scenery', label: 'Scenery', icon: 'park', tip: 'Plant trees, or build gardens and parks nearby', act: { label: 'Parks', cat: 'parks' } },
  play: { want: 'somewhere to play', label: 'Play', icon: 'toys', tip: 'Build a play area or playing field within reach of homes with children', act: { label: 'Parks', cat: 'parks' } },
  potter: { want: 'an allotment to dig', label: 'Allotment', icon: 'agriculture', tip: 'Build allotments within reach of homes with elders', act: { label: 'Parks', cat: 'parks' } },
  shops: { want: 'shops nearby', label: 'Shops nearby', icon: 'storefront', tip: 'Build a shop, café or tavern within 7 tiles', act: { label: 'Commerce', cat: 'commercial' } },
  transit: { want: 'a coach stop nearby', label: 'Transport', icon: 'directions_bus', tip: 'Put a coach stop within 4 tiles', act: { label: 'Transit', cat: 'transit' } },
  pollution: { want: 'less smoke', label: 'Smoke', icon: 'factory', tip: 'Industry is too close — move it, or plant trees between', act: { label: 'Show homes' } },
  land: { label: 'Garden deal', icon: 'yard', tip: '' },
  tax: { want: 'lower taxes', label: 'Taxes', icon: 'payments', tip: 'Lower the tax rate in the budget', act: { label: 'Budget', budget: true } },
  crowded: { want: 'more room', label: 'Crowding', icon: 'groups', tip: 'More people than rooms — upgrade or expand the home', act: { label: 'Show homes' } },
  jobs: { want: 'work for the household', label: 'Work', icon: 'work', tip: 'Some grown-ups here are looking for work — build workplaces', act: { label: 'Industry', cat: 'industry' } },
  road: { want: 'a road', label: 'Road', icon: 'add_road', tip: "Not connected to the town's roads — lay a road to it", act: { label: 'Show homes' } },
};

import { LocalSaves, serialize, downloadJSON, readJSONFile, saveFileName, saveFileNameFor } from '../save/saves.js';
import { MergeDialog } from './mergeUI.js';
import { showMultiplayer, renderNetBox } from './multiplayer.js';
import { buildingSummary, showBuildingGuide } from './guide.js';
import { showPathMap } from './pathMap.js';
import { RNG, randomSeed } from '../util/rng.js';
import { townName as genTownName } from '../util/names.js';
import { starterPickerHTML, mountStarterPicker, EMPTY } from './starterPicker.js';
import { roadSelTool, roadSelHTML, roadSelAct, bindRoadSel, dressAct, boulevardHTML } from './roadSelect.js';
import { streetOf } from '../world/streets.js';
import { perfHTML, bindPerf, readPerf, group, check, seg, segValue, bindSegs } from './perfSettings.js';
import { minionIcon, MINION, MINIONS } from './minion.js';

const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = (n) => Math.round(n).toLocaleString('en-US');
const signed = (n) => (n >= 0 ? '+' : '−') + fmt(Math.abs(n));
const pad = (n) => String(n).padStart(2, '0');

// Emoji used around the codebase are rendered as calm monochrome icons.
const ICONS = {
  '🖐': 'pan_tool', '🛤': 'add_road', '🏡': 'cottage', '🛍': 'storefront', '⚒': 'handyman', '⛲': 'account_balance',
  '🌳': 'park', '🚂': 'train', '🚡': 'gondola_lift', '⛰': 'landscape', '🚜': 'delete', '🙂': 'sentiment_satisfied', '😄': 'sentiment_very_satisfied',
  '😐': 'sentiment_neutral', '😟': 'sentiment_dissatisfied', '💧': 'water_drop', '🩺': 'medical_services', '📚': 'school',
  '🛡': 'shield', '🔔': 'church', '🏭': 'factory', '🚏': 'directions_bus', '🟫': 'route', '🪨': 'grid_on', '⬛': 'road',
  '🕳': 'vertical_align_bottom', '📐': 'straighten', '🌲': 'forest', '🐴': 'directions_bus', '📋': 'list_alt', '🔒': 'lock',
  '🔓': 'lock_open', '⬆': 'arrow_upward', '⬇': 'download', '🧰': 'work', '💸': 'money_off', '🎥': 'videocam', '💻': 'computer',
  '☁': 'cloud', '📁': 'folder', '🧳': 'luggage', '🎉': 'celebration', '💡': 'lightbulb', '💾': 'save', '📊': 'bar_chart',
  '⚙': 'settings', '❓': 'help', '👁': 'layers', '🌅': 'wb_twilight', '☀': 'light_mode', '🌙': 'dark_mode', '🌸': 'local_florist',
  '🍂': 'eco', '❄': 'ac_unit', '🎲': 'casino',
  '🐟': 'set_meal', '🌾': 'grass', '🪓': 'carpenter', '🔨': 'hardware', '🥖': 'bakery_dining', '🍺': 'sports_bar',
  '🧺': 'shopping_basket', '🏛': 'account_balance', '🌷': 'local_florist', '🌼': 'filter_vintage', '🚉': 'train', '🏠': 'home',
  '😢': 'sentiment_dissatisfied', '🗽': 'person_pin', '🧱': 'construction', '🏗': 'construction', '🏘': 'holiday_village',
  '🏪': 'store', '⚡': 'bolt', '🔬': 'science', '🎓': 'school', '🔗': 'link', '↔': 'open_with', '🌿': 'yard', '🪚': 'carpenter',
  '🥕': 'nutrition', '🥩': 'kebab_dining', '👞': 'steps', '🧵': 'checkroom', '🔧': 'build', '💊': 'medication', '📖': 'menu_book',
  '☕': 'local_cafe', '🏦': 'savings', '✉': 'mail', '🏢': 'business_center', '🏬': 'local_mall', '🛝': 'toys', '🎾': 'sports_tennis', '⚽': 'sports_soccer',
};
// ...and people as little minions, like the villagers themselves (ui/minion.js).
const SVG_ICONS = { '🧑': MINION, '🧒': MINION, '🧓': MINION, '👪': MINIONS };
const EMOJI_RE = new RegExp([...Object.keys(ICONS), ...Object.keys(SVG_ICONS)].join('|'), 'g');
export function ico(html) {
  return String(html).replace(/️/g, '').replace(/🪙 ?/gu, '$$').replace(EMOJI_RE, (m) => `<span class="ms">${SVG_ICONS[m] || ICONS[m]}</span>`);
}

const TOOLS = [
  { id: 'select', icon: '🖐️', label: 'Select', key: '1' },
  { id: 'roads', icon: '🛤️', label: 'Roads', key: 'R' },
  ...CATEGORIES.map(c => ({ id: c.id, icon: c.icon, label: c.name.split(' ')[0], key: c.key })),
  { id: 'terrain', icon: '⛰️', label: 'Terrain', key: '8' },
  { id: 'bulldoze', icon: '🚜', label: 'Demolish', key: 'X' },
];

const OVERLAYS = [
  { id: null, name: 'No overlay' },
  { id: 'happiness', name: '🙂 Happiness' },
  { id: 'water', name: '💧 Water' },
  { id: 'health', name: '🩺 Health' },
  { id: 'education', name: '📚 Education' },
  { id: 'safety', name: '🛡️ Safety' },
  { id: 'culture', name: '🔔 Culture' },
  { id: 'power', name: '⚡ Power' },
  { id: 'appeal', name: '🌳 Scenery' },
  { id: 'pollution', name: '🏭 Pollution' },
  { id: 'transit', name: '🚏 Transit routes' },
];

export class UI {
  constructor(game) {
    this.game = game;
    this.category = null;
    this.selection = null;
    this._t = 0;
    this.labels = new Map();
    this.follow = null;
    this.lookChoice = new Map();   // building id → style picked for its next upgrade
    this.buildToolbar();
    this.bindStatic();
  }

  get world() { return this.game.world; }

  // --------------------------------------------------------------- setup
  bindStatic() {
    const g = this.game;
    for (const b of $('speed').querySelectorAll('button')) b.onclick = () => g.setSpeed(Number(b.dataset.speed));
    $('zoomIn').onclick = () => g.renderer.zoomBy(1.35);
    $('zoomOut').onclick = () => g.renderer.zoomBy(1 / 1.35);
    $('btnView').onclick = () => g.toggleTopDown();
    $('btnRotL').onclick = () => g.rotateView(-1);
    $('btnRotR').onclick = () => g.rotateView(1);
    $('btnClassic').onclick = () => g.classicView();
    $('btnOverlay').onclick = () => this.toggleOverlayMenu();
    $('btnLines').onclick = () => this.showLines();
    $('btnHideUI').onclick = () => this.setUIHidden(true);
    $('showUI').onclick = () => this.setUIHidden(false);
    $('btnBudget').onclick = () => this.showBudget();
    $('btnPeople').onclick = () => this.showPeople();
    // the townsfolk, as a pair of minions
    for (const el of [$('pop').previousElementSibling, $('btnPeople').firstElementChild]) el.innerHTML = MINIONS;
    const insp = $('inspector');
    // where it was dragged to (on a smaller screen it is brought back on when it opens)
    try { const p = JSON.parse(localStorage.getItem('hearthvale.win.inspector') || 'null'); if (p) { insp.style.left = `${p.x}px`; insp.style.top = `${p.y}px`; insp.style.right = 'auto'; } } catch {}
    insp.addEventListener('pointerdown', (e) => {
      const r = insp.getBoundingClientRect();
      if (e.button === 0 && e.clientY - r.top < 24 && !e.target.closest('button') && !this._docked()) this._drag(insp, e, 'hearthvale.win.inspector');
    });
    this._watchFit(insp);
    // a smaller browser window or a turned phone brings every window back on screen
    addEventListener('resize', () => requestAnimationFrame(() => { for (const w of [insp, ...(this.windows || new Map()).values()]) this._fitWin(w); }));
    $('happy').parentElement.style.cursor = 'pointer';
    $('happy').parentElement.title = 'Happiness: what helps and what hurts (click)';
    $('happy').parentElement.onclick = () => this.showHappiness();
    $('btnResearch').onclick = () => this.showResearch();
    $('resStat').onclick = () => this.showResearch();
    $('btnPops').onclick = () => this.togglePopups();
    $('btnMusic').onclick = () => this.toggleMusic();
    $('issuesHead').onclick = () => this.toggleIssues();
    this._issueCycle = {};
    this.syncPopButton();
    this.syncMusicButton();
    $('btnSave').onclick = () => this.showSaves();
    $('btnMergeIn').onclick = () => this.showMerge({ intoTown: true });
    $('btnNet').onclick = () => this.showMultiplayer();
    $('netBox').onclick = () => this.showMultiplayer();
    $('btnSettings').onclick = () => this.showSettings();
    $('btnHelp').onclick = () => this.showHelp();
    $('townBox').onclick = () => this.showRename();
    const om = $('overlayMenu');
    om.innerHTML = ico(OVERLAYS.map(o => `<button data-o="${o.id ?? ''}">${o.name}</button>`).join(''));
    for (const b of om.querySelectorAll('button')) b.onclick = () => { g.setOverlay(b.dataset.o || null); this.toggleOverlayMenu(false); };
  }

  buildToolbar() {
    const tb = $('toolbar');
    tb.innerHTML = '';
    TOOLS.forEach((t, i) => {
      if (i === 1 || i === TOOLS.length - 2) { const s = document.createElement('div'); s.className = 'sep'; tb.appendChild(s); }
      const b = document.createElement('button');
      b.className = 'tool';
      b.dataset.tool = t.id;
      b.title = `${t.label} (${t.key})`;
      b.innerHTML = `<span class="e">${ico(t.icon)}</span><span class="l">${t.label}</span><span class="k">${t.key}</span>`;
      b.onclick = () => this.pressTool(t.id);
      tb.appendChild(b);
    });
  }

  pressTool(id) {
    const g = this.game;
    if (id === 'select') { this.closeFlyout(); g.input.setTool({ kind: 'select' }); return; }
    if (id === 'bulldoze') { this.closeFlyout(); g.input.setTool({ kind: 'bulldoze' }); return; }
    if (this.category === id) { this.closeFlyout(); g.input.setTool({ kind: 'select' }); return; }
    this.openFlyout(id);
  }

  syncToolbar() {
    const t = this.game.input.tool;
    let active = 'select';
    if (t.kind === 'bulldoze') active = 'bulldoze';
    else if (this.category) active = this.category;
    for (const b of $('toolbar').querySelectorAll('.tool')) b.classList.toggle('on', b.dataset.tool === active);
    for (const c of $('flyout').querySelectorAll('.card')) c.classList.toggle('on', c.dataset.key === toolKey(t));
    this.renderKindBar();
    $('btnView').textContent = this.game.renderer.rig.topDown ? 'ISO' : '2D';
    $('btnView').classList.toggle('on', this.game.renderer.rig.topDown);
    this.updateHint();
  }

  // While building a planting or a monument, a bar above the build menu
  // picks its kind ("By its seed": one of those that need no research,
  // different from one to the next). The choice is kept for the next one.
  renderKindBar() {
    const bar = $('kindBar'), t = this.game.input.tool, K = t.kind === 'build' && KINDS[t.type];
    if (!bar) return;
    const hint = $('toolHint');
    if (!K || this.uiHidden) { bar.classList.add('hidden'); bar.dataset.key = ''; if (hint) hint.style.bottom = ''; return; }
    const cur = t.flavor || '';
    const key = `${t.type}|${cur}|${Object.keys(K).map(k => +this.world.hasTech(K[k].tech)).join('')}`;
    bar.classList.remove('hidden');
    if (bar.dataset.key !== key) this._fillKindBar(bar, t, K, cur, key);
    // just above the build menu (as tall as the screen makes it), the hint above that
    const box = bar.offsetParent ? bar.offsetParent.getBoundingClientRect().bottom : innerHeight, fly = $('flyout');
    if (fly && !fly.classList.contains('hidden')) bar.style.bottom = `${Math.round(box - fly.getBoundingClientRect().top + 4)}px`;
    if (hint) hint.style.bottom = `${Math.round(box - bar.getBoundingClientRect().top + 4)}px`;
  }
  _fillKindBar(bar, t, K, cur, key) {
    bar.dataset.key = key;
    const btn = (k, icon, name, title, ok) => `<button class="btn small ${cur === k ? 'on' : ''}" data-kind="${k}" ${ok ? '' : 'disabled'} title="${esc(title)}">${ok ? '' : '🔒'}<span class="ms">${icon}</span> ${esc(name)}</button>`;
    bar.innerHTML = `<span class="kb-label">${esc(BUILDINGS[t.type].name)}:</span>${btn('', 'casino', 'By its seed', 'A different one each time, from the kinds that need no research', true)}${Object.entries(K).map(([k, x]) => btn(k, x.icon, x.name, this.world.hasTech(x.tech) ? x.desc : `Research ${TECHS[x.tech].name}`, this.world.hasTech(x.tech))).join('')}`;
    for (const el of bar.querySelectorAll('button[data-kind]')) el.onclick = () => {
      const k = el.dataset.kind || null;
      (this.kindChoice ||= {})[t.type] = k;
      this.game.input.setTool({ kind: 'build', type: t.type, flavor: k });
    };
  }

  // ------------------------------------------------------------- flyouts
  openFlyout(cat) {
    this.category = cat;
    const fl = $('flyout');
    const pop = this.world.unlockPop;
    const cards = [];
    const card = (key, img, name, cost, locked, onclick, title = '') => ({ key, img, name, cost, locked, onclick, title });
    if (cat === 'roads') {
      for (const L of [1, 2, 3]) {
        const d = ROAD_LEVELS[L];
        cards.push(card(`road:${L}`, ['🟫', '🪨', '⬛'][L - 1], d.name, `${d.cost} a unit`, pop < d.unlock ? d.unlock : 0, () => this.game.input.setTool({ kind: 'road', level: L }), 'Drag to draw it any way you like: it is laid as a smooth curve, joining the roads it meets (Shift: straight). Click a lesser road to upgrade it.'));
      }
      cards.push(card('roadsel', '<span class="ms">highlight_alt</span>', 'Select roads', '', 0, () => this.game.input.setTool(roadSelTool()), 'Pick whole stretches of road, then upgrade, downgrade or take them all up at once.'));
    } else if (cat === 'terrain') {
      cards.push(card('terrain:raise', '⛰️', 'Raise land', `${TERRAFORM_COST}`, 0, () => this.game.input.setTool({ kind: 'terrain', mode: 'raise' })));
      cards.push(card('terrain:lower', '🕳️', 'Lower land', `${TERRAFORM_COST}`, 0, () => this.game.input.setTool({ kind: 'terrain', mode: 'lower' })));
      cards.push(card('terrain:flatten', '📐', 'Level land', `${TERRAFORM_COST}`, 0, () => this.game.input.setTool({ kind: 'terrain', mode: 'flatten' })));
      cards.push(card('trees', '🌲', 'Plant trees', `${TREE_COST}`, 0, () => this.game.input.setTool({ kind: 'trees' })));
    } else {
      for (const [type, def] of Object.entries(BUILDINGS)) {
        if (def.cat !== cat || def.hidden) continue;
        const u = unlockOf(type, 0);
        const lock = pop < u ? u : !this.world.hasTech(def.tech) ? `🔬 ${TECHS[def.tech].name}` : 0;
        cards.push({ ...card(`build:${type}`, thumb(type, 0), def.name, `${def.levels[0].cost}`, lock, () => this.game.input.setTool({ kind: 'build', type, flavor: (this.kindChoice || {})[type] || null }), def.desc), type });
      }
      if (cat === 'parks') cards.push(card('trees', '🌲', 'Plant trees', `${TREE_COST}`, 0, () => this.game.input.setTool({ kind: 'trees' })));
      if (cat === 'transit') {
        cards.push(card('rail', '🛤️', 'Lay track', `${RAIL_COST} / tile`, pop < 25 ? 25 : 0, () => this.game.input.setTool({ kind: 'rail' }), 'Drag to lay railway track. Trains never reverse, so lines need a loop of track. Track can cross roads.'));
        cards.push(card('line:coach', '🐴', 'New coach line', `${TRANSIT.coach.vehicleCost}`, 0, () => this.game.input.setTool({ kind: 'line', mode: 'coach', stops: [] }), 'Click coach stops in order, then press Enter.'));
        cards.push(card('line:rail', '🚂', 'New rail line', `${TRANSIT.rail.vehicleCost}`, pop < 25 ? 25 : 0, () => this.game.input.setTool({ kind: 'line', mode: 'rail', stops: [] }), 'Stations must sit on a loop of track (trains never reverse). Click them in order, then press Enter.'));
        cards.push(card('line:gondola', '🚡', 'New gondola line', `${TRANSIT.gondola.vehicleCost}`, gondolaLock(this.world), () => this.game.input.setTool({ kind: 'line', mode: 'gondola', stops: [] }), 'Click gondola stations in order, then press Enter. The cable runs straight from station to station, over roofs, streets and the river.'));
        cards.push(card('lines', '📋', 'Manage lines', '', 0, () => this.showLines()));
      }
    }
    fl.innerHTML = '';
    for (const c of cards) {
      const el = document.createElement('div');
      el.className = 'card' + (c.locked ? ' locked' : '');
      el.dataset.key = c.key;
      const img = c.img.startsWith('data:') ? `<img src="${c.img}" alt="">` : `<div class="ph">${ico(c.img)}</div>`;
      const research = typeof c.locked === 'string';
      el.innerHTML = ico(`${img}<div class="n">${esc(c.name)}</div>` + (c.locked ? `<div class="lock">${research ? esc(c.locked) : `🔒 ${c.locked} villagers`}</div>` : (c.cost ? `<div class="c">$${c.cost}</div>` : '')));
      // hovering shows what it does; picking a building opens its guide
      let tip = null;
      el.onmouseenter = el.onmousemove = () => {
        tip ||= ico(c.type ? buildingSummary(this.world, c.type) : `<b>${esc(c.name)}</b>${c.title ? `<br>${esc(c.title)}` : ''}`);
        this._cardTip(el, tip);
      };
      el.onmouseleave = () => this.tooltip(null);
      el.onclick = () => {
        if (c.type) showBuildingGuide(this, c.type);
        if (research) { this.toast(`${c.name} needs research: ${c.locked.replace('🔬 ', '')}. Press K to open Research.`, 'bad', '🔬'); return; }
        if (c.locked) { this.toast(`${c.name} unlocks when your town reaches ${c.locked} villagers.`, 'bad', '🔒'); return; }
        c.onclick();
      };
      fl.appendChild(el);
    }
    fl.classList.remove('hidden');
    // a row of cards wider than the window scrolls sideways with the wheel
    fl.onwheel = (e) => { if (fl.scrollWidth > fl.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { fl.scrollLeft += e.deltaY; e.preventDefault(); } };
    // auto-select the first available tool for quick building
    this.syncToolbar();
  }

  // A build card's tip sits just above the card.
  _cardTip(el, html) {
    this.tooltip(html, 0, 0);
    const t = $('tooltip');
    if (t.classList.contains('hidden')) return;
    const r = el.getBoundingClientRect(), tr = t.getBoundingClientRect();
    t.style.left = `${Math.max(8, Math.min(innerWidth - tr.width - 8, r.left + r.width / 2 - tr.width / 2))}px`;
    t.style.top = `${Math.max(8, r.top - tr.height - 8)}px`;
  }

  closeFlyout() {
    this.tooltip(null);
    this.category = null;
    $('flyout').classList.add('hidden');
    this.syncToolbar();
  }

  updateHint() {
    const t = this.game.input.tool;
    const h = $('toolHint');
    let msg = '';
    switch (t.kind) {
      case 'road': msg = `Drag to lay ${ROAD_LEVELS[t.level].name.toLowerCase()} · ${t.grid ? 'along the grid only (Tab: diagonals too)' : 'drag at 45° for a diagonal street (Tab: grid only)'} · drawing over roads upgrades them · right-click to stop`; break;
      case 'rail': msg = 'Drag to lay track · trains need a loop · track can cross roads · right-click to stop'; break;
      case 'roadsel': msg = `Click a road to pick its stretch · Shift-click adds · drag to pick a ${t.box ? 'box' : 'line'} (Tab: ${t.box ? 'line' : 'box'}) · Backspace undoes · right-click clears`; break;
      case 'build': msg = `Click to place a ${BUILDINGS[t.type].levels[0].name}${KINDS[t.type] ? ` (${t.flavor ? KINDS[t.type][t.flavor].name.toLowerCase() : 'its kind by its seed'}: choose above)` : ''} · builders will put it up · Tab flips the entrance · Z / C turn it · right-click to stop`; break;
      case 'move': {
        const b = this.world.buildings.get(t.id);
        msg = b ? `Click a new plot for the ${BUILDINGS[b.type].levels[b.level].name} · it is taken down, carted over and rebuilt · Tab flips the entrance · right-click to cancel` : '';
        break;
      }
      case 'bulldoze': msg = 'Click or drag to demolish · right-click to stop'; break;
      case 'fields': msg = t.add ? `Drag a box over open land to plough it as fields · behind or beside the farm, touching it or its fields · $${CONFIG.FIELD_COST} each · right-click to stop` : 'Drag over the farm\'s fields to take them out (a quarter back) · right-click to stop'; break;
      case 'terrain': msg = `Click or drag to ${t.mode === 'flatten' ? 'level' : t.mode} the land · $${TERRAFORM_COST} each`; break;
      case 'trees': msg = `Click or drag to plant trees · $${TREE_COST} each`; break;
      case 'line': msg = `Click ${t.mode === 'rail' ? 'stations on a loop of track' : t.mode === 'gondola' ? 'gondola stations (the cable runs straight between them)' : 'coach stops'} in order (${t.stops.length} chosen) · Enter to create · Backspace to undo · Esc to cancel`; break;
      default: msg = '';
    }
    h.textContent = msg;
    h.classList.toggle('hidden', !msg);
  }

  // ----------------------------------------------------------------- HUD
  update(dt) {
    const w = this.world;
    if (!w) return;
    const sim = this.game.sim;
    const h = Math.floor(w.hours), m = Math.floor((w.hours - h) * 60 / 10) * 10;
    $('clockTime').textContent = `${pad(h)}:${pad(m)}`;
    const night = this.game.env.night;
    const env = this.game.env;
    const ci = env.snowing ? 'weather_snowy' : env.rain > 0.3 ? 'rainy' : env.cloud > 0.5 ? 'cloud'
      : night > 0.6 ? 'dark_mode' : (w.hours < 8 || w.hours > 18 ? 'wb_twilight' : 'light_mode');
    if (this._ci !== ci) { this._ci = ci; $('clockIcon').innerHTML = `<span class="ms">${ci}</span>`; }
    // the classic-view button is a compass: it turns with the view, and
    // stands out while the view is not the classic one
    const R = this.game.renderer, deg = Math.round(((R.rig.angle - Math.PI / 4) * 180) / Math.PI), classic = R.classic;
    if (this._compass !== deg || this._classic !== classic) {
      this._compass = deg; this._classic = classic;
      $('btnClassic').firstChild.style.transform = `rotate(${-deg}deg)`;
      $('btnClassic').classList.toggle('off', classic);
    }
    this._t += dt;
    if (this._t > 0.25) {
      this._t = 0;
      const s = seasonOf(w.day);
      const dayOfYear = ((w.day - 1) % (CONFIG.DAYS_PER_SEASON * 4)) + 1;
      const year = Math.floor((w.day - 1) / (CONFIG.DAYS_PER_SEASON * 4)) + 1;
      $('clockDate').innerHTML = ico(`${SEASONS[s].icon} ${SEASONS[s].name} · Day ${w.day}` + (year > 1 ? ` · Year ${year}` : ''));
      void dayOfYear;
      $('money').textContent = Number.isFinite(w.money) ? `${w.money < 0 ? '−' : ''}$${fmt(Math.abs(w.money))}` : '∞';
      $('money').style.color = w.money < 0 ? 'var(--brick)' : '';
      const net = sim.budget.net;
      $('net').textContent = Number.isFinite(w.money) ? `${net >= 0 ? '+' : '−'}$${fmt(Math.abs(net))} / day` : 'sandbox';
      $('net').className = !Number.isFinite(w.money) ? '' : net >= 0 ? 'pos' : 'neg';
      $('pop').textContent = fmt(w.population);
      const free = sim.housing.open ?? sim.housing.cap - sim.housing.used;
      $('housing').textContent = `${free} free home${free === 1 ? '' : 's'}`;
      const hp = Math.round(sim.happiness);
      $('happy').textContent = `${hp}%`;
      $('happyIco').textContent = hp >= 75 ? 'sentiment_very_satisfied' : hp >= 55 ? 'sentiment_satisfied' : hp >= 40 ? 'sentiment_neutral' : 'sentiment_dissatisfied';
      $('jobs').textContent = `${sim.jobs.filled}/${sim.jobs.total}`;
      this._researchHUD();
      const U = sim.utility;
      if (U) {
        $('power').textContent = U.power.gen ? `${U.power.demand}/${U.power.gen} kW` : 'no power';
        $('power').style.color = U.power.gen && U.power.demand > U.power.gen ? 'var(--bad)' : '';
        $('water').textContent = `water ${U.water.demand}/${U.water.supply}`;
        $('water').className = U.water.demand > U.water.supply ? 'neg' : '';
      }
      $('demR').style.height = `${sim.demand.r * 100}%`;
      $('demC').style.height = `${sim.demand.c * 100}%`;
      $('demI').style.height = `${sim.demand.i * 100}%`;
      $('townName').textContent = w.townName;
      $('townTitle').textContent = titleFor(w.population).name;
      for (const b of $('speed').querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.speed) === this.game.speed);
      $('speed').title = `Speed ${this.game.speed}× · [ and ] change speed`;
      if (this.selection) this.renderInspector();
    }
    this._issuesT = (this._issuesT || 0) + dt;
    if (this._issuesT > 1) { this._issuesT = 0; this.renderIssues(); }
    this.updateLabels();
    (this.blockedIcons ||= new BlockedIcons(this.game, $('popups'))).update();
  }

  // ------------------------------------------------------------ inspector
  inspect(sel) {
    this.confirmExpand = null;
    if (this.game.input) this.game.input.previewTiles = null;
    if (this.preview && (!sel || sel.kind !== 'building' || sel.id !== this.preview.id)) { this.preview = null; this.game.view?.setPreview(null, null); }
    this.selection = sel;
    this.game.agents.select(sel && sel.kind === 'resident' ? this.world.residents.get(sel.id) : null);
    if (!sel) { $('inspector').classList.add('hidden'); this.game.setFollow(null); this.game.refreshCursor(); return; }
    if (sel.kind !== 'resident') this.game.setFollow(null);
    this.renderInspector(true);
    this.game.refreshCursor();
  }

  renderInspector(force = false) {
    const el = $('inspector');
    const sel = this.selection;
    const w = this.world;
    if (!sel) return;
    // don't rebuild while the pointer is over a button (keeps clicks reliable)
    if (!force && el.matches(':hover') && el.querySelector('button:hover')) return;
    let html = '';
    if (sel.kind === 'building') {
      const b = w.buildings.get(sel.id);
      if (!b) { this.inspect(null); return; }
      html = this._buildingHTML(b);
    } else if (sel.kind === 'resident') {
      const r = w.residents.get(sel.id);
      if (!r) { this.inspect(null); return; }
      html = this._residentHTML(r);
    } else if (sel.kind === 'road') {
      const e = (sel.rail ? w.rails : w.roads).edges.get(sel.e);
      if (!e) { this.inspect(null); return; }
      html = this._roadHTML(e, !!sel.rail);
    } else if (sel.kind === 'roadsel') {
      html = roadSelHTML(this.game);
      if (html == null) { this.inspect(null); return; }
    }
    const full = `<button class="close" data-act="close">✕</button>` + ico(html);
    // the regular refresh with nothing new to show leaves the panel be
    // (rebuilding it costs far more than working it out)
    const same = !force && full === this._inspHTML && !el.classList.contains('hidden');
    this._inspHTML = full;
    if (!same) el.innerHTML = full;
    if (sel.kind === 'building') this._syncPreview(w.buildings.get(sel.id));
    if (same) return;
    el.classList.remove('hidden');
    for (const a of el.querySelectorAll('[data-act]')) a.onclick = (e) => this._act(a.dataset.act, a.dataset, e);
    if (sel.kind === 'roadsel') bindRoadSel(this, el);
    // hovering an expansion option shows the plot it would take
    for (const a of el.querySelectorAll('[data-act="expand"]')) {
      a.onmouseenter = () => { this.game.input.previewTiles = JSON.parse(a.dataset.rects || '[]').map(pts => ({ pts, color: a.dataset.kind === 'takeover' ? '#ff6b5a' : a.dataset.kind === 'strip' ? '#ffd84a' : '#7fdc6a', alpha: 0.45 })); this.game.input.refresh(); };
      a.onmouseleave = () => { this.game.input.previewTiles = null; this.game.input.refresh(); };
    }
  }

  // Upgrade choices as separate path cards: each has its own colour and
  // icon, shows where the path leads, what changes, its requirements and
  // its own button. Several paths are split by an "or".
  _upgradeHTML(b) {
    const w = this.world;
    const options = w.upgradeOptions(b);
    if (!options.length) return '';
    const branching = options.length > 1 || options[0].type !== b.type;
    const cur = scaledLevel(BUILDINGS[b.type].levels[b.level], sizeK(b));
    const cards = options.map((o, i) => {
      const td = BUILDINGS[o.type];
      const restylable = td.cat === 'residential' || td.cat === 'commercial';
      const up = w.upgradeCheck(b, o.extend ? 'extend' : o.type, restylable && this.lookChoice.has(b.id) ? this.lookChoice.get(b.id) : undefined);
      const n = up.next;
      const accent = branching ? (td.accent || '#4f6a3a') : '#3c6e3c';
      const icon = branching ? (td.pathIcon || 'alt_route') : 'upgrade';
      const bigger = o.type === b.type && (n.seats || 0) > (cur.seats || 0) && n.teaches === cur.teaches;
      const tabName = o.extend ? 'Extend across the plot' : branching ? `Path ${'ABCDEFGH'[i]} · ${bigger ? 'Larger' : o.type === b.type ? 'Next level' : esc(td.branch || td.name)}` : 'Next level';
      const unmet = up.reqs.filter(r => !r.met);
      const status = up.ok ? '✓ Ready' : unmet.some(r => r.tech) ? '🔒 Research' : `${unmet.length} to go`;
      // where this path leads
      const later = td.levels.slice(o.level + 1);
      const chain = o.extend ? `<span class="now">${esc(cur.name)}</span><i>▸</i><span class="next">${esc(n.name)}, built out across its plot</span>`
        : [`<span class="now">${esc(cur.name)}</span>`, `<span class="next">${esc(n.name)}</span>`, ...later.map(L => `<span>${esc(L.name)}</span>`)].join('<i>▸</i>');
      const styled = td.cat === 'residential' || td.cat === 'commercial';
      const look = styled ? (this.lookChoice.has(b.id) ? this.lookChoice.get(b.id) : b.look || null) : null;
      let c = `<div class="path" style="--accent:${accent}">`;
      c += `<div class="path-tab"><span class="ms">${icon}</span><span>${tabName}</span><span class="tag ${up.ok ? 'ok' : ''}">${status}</span></div><div class="path-body">`;
      c += '<div class="path-top">';
      if (styled) c += `<img class="preview" src="${thumb(o.type, o.level, b.variant, b.flavor, look)}" alt="">`;
      const who = cur.housing ? 'households' : cur.seats ? 'pupils' : td.park ? 'visitors' : 'workers';
      c += `<div><div class="path-name">${o.extend ? `Extend the ${esc(cur.name.toLowerCase())}` : esc(n.name)}</div><div class="path-desc">${esc(o.extend ? `Build the ${cur.name.toLowerCase()} out across the land it took: room for ${Math.round((sizeKFor(b.type, b.w ?? b.size, b.d ?? b.size) / sizeK(b) - 1) * 100)}% more ${who}.` : o.type !== b.type ? td.desc : branching ? td.desc : `The next level of the ${cur.name.toLowerCase()}.`)}</div></div></div>`;
      c += `<div class="chain">${chain}</div>`;
      c += this._tilesHTML(cur, n);
      c += needsNoteHTML(b, o.type, o.level);
      if (styled) {
        const on = this.preview && this.preview.id === b.id && this.preview.type === o.type;
        c += `<div class="styles"><span>Style</span>${[{ id: '', name: 'As now' }, ...STYLES].map(s => { const t = STYLE_TECH[s.id], ok = !t || w.hasTech(t); return `<button class="style ${(look || '') === s.id ? 'on' : ''}" data-act="look" data-type="${o.type}" data-look="${s.id}" ${ok ? '' : `disabled title="Research ${esc(TECHS[t].name)}"`}>${ok ? '' : '🔒'}${s.name}</button>`; }).join('')}</div>`;
        c += `<label class="chk"><input type="checkbox" data-act="preview" data-type="${o.type}" ${on ? 'checked' : ''}> Preview in town</label>`;
      }
      c += `<div class="req">${[...unmet, ...up.reqs.filter(r => r.met)].map(r => `<div class="${r.met ? 'ok' : 'no'}">${esc(r.label)}</div>`).join('')}</div>`;
      if (up.moveOut) c += `<div class="warnline">⚠ Room for fewer people: ${up.moveOut} resident${up.moveOut > 1 ? 's' : ''} will move out</div>`;
      c += `<button class="btn primary path-go" data-act="upgrade" data-type="${o.extend ? 'extend' : o.type}" ${up.ok ? '' : 'disabled'}>⬆ ${o.extend ? 'Extend it' : branching ? `Build ${esc(n.name)}` : `Upgrade to ${esc(n.name)}`} · $${fmt(up.cost ?? n.cost)}</button>`;
      if (up.restyle) c += `<div class="note">Includes $${fmt(up.restyle)} for the new style. Keeping the current style costs $${fmt(n.cost)}.</div>`;
      return c + '</div></div>';
    });
    return `<div class="upgrades"><div class="up-head"><span class="ms">upgrade</span>Upgrade${branching ? '<span class="up-hint">choose one path</span>' : ''}</div>${cards.join('<div class="path-or"><span>or</span></div>')}</div>`;
  }

  // Before → after tiles for everything the upgrade changes.
  _tilesHTML(cur, n) {
    const F = [
      ['housing', 'Homes for', (v) => v], ['jobs', 'Jobs', (v) => v], ['seats', 'Student places', (v) => v], ['teaches', 'Teaches', (v) => EDU[v]], ['income', 'Earnings / worker', (v) => `$${v}`],
      ['tax', 'Tax / worker', (v) => `${v}×`], ['visit', 'Per visit', (v) => `$${v}`], ['radius', 'Reach', (v) => `${v} tiles`],
      ['appeal', 'Scenery', (v) => `+${v}`], ['supply', 'Water for', (v) => `${v}`], ['kw', 'Power', (v) => `${v} kW`],
      ['rate', 'Builder speed', (v) => `${v}×`], ['taxBonus', 'Town tax', (v) => `+${Math.round(v * 100)}%`], ['culture', 'Culture reach', (v) => `${v} tiles`],
      ['pollution', 'Smoke', (v) => `${v} tiles`, true], ['upkeep', 'Upkeep / day', (v) => `$${v}`, true],
    ];
    const tiles = [];
    for (const [k, label, f, worse] of F) {
      const a = cur[k] || 0, z = n[k] || 0;
      if (a === z) continue;
      const better = worse ? z < a : z > a;
      tiles.push(`<div class="tile ${better ? 'up' : 'down'}"><small>${label}</small><b>${a ? f(a) : '—'} <i>→</i> <span class="to">${z ? f(z) : '—'}</span></b></div>`);
    }
    return tiles.length ? `<div class="tiles">${tiles.join('')}</div>` : '';
  }

  // Keep the in-town preview in step with the style picker.
  _syncPreview(b) {
    const p = this.preview;
    if (!b || !p || p.id !== b.id || b.con) { if (p && (!b || p.id !== b.id || b.con)) this.preview = null; this.game.view.setPreview(null, null); return; }
    const opt = this.world.upgradeOptions(b).find(o => o.type === p.type);
    if (!opt) { this.preview = null; this.game.view.setPreview(null, null); return; }
    const look = this.lookChoice.has(b.id) ? this.lookChoice.get(b.id) : b.look || null;
    this.game.view.setPreview(b, { type: opt.type, level: opt.level, look });
  }

  _siteHTML(b) {
    const st = this.game.construction.status(b);
    const con = b.con;
    const tdef = BUILDINGS[con.toType || b.type];
    const target = con.kind === 'upgrade' ? tdef.levels[con.to].name : BUILDINGS[b.type].levels[b.level].name;
    const title = con.kind === 'demolish' ? 'Being demolished' : con.kind === 'dismantle' ? 'Being taken down for a move'
      : con.wait === 'dismantle' ? 'Waiting for the old building to come down'
        : con.wait === 'haul' ? 'Materials on their way by cart'
          : con.kind === 'upgrade' && KINDS[b.type] && typeof con.flavor === 'string' && Object.hasOwn(KINDS[b.type], con.flavor) ? `Being ${BUILDINGS[b.type].seat ? 'restyled' : 'reworked'} · ${KINDS[b.type][con.flavor].name}`
          : con.kind === 'upgrade' ? `Upgrading to ${target}`
            : con.kind === 'merge' ? `Joining into ${target}`
              : con.moved ? 'Going back up on its new plot' : 'Under construction';
    const pct = Math.round(st.progress * 100);
    let h = `<div class="sec"><h5>🏗️ ${esc(title)}</h5><div class="meter build"><i style="width:${pct}%"></i></div>`;
    const rows = [['Progress', `${pct}%`]];
    if (!con.wait) {
      rows.push(['Builders on site', `${st.onSite} / ${st.cap}` + (st.hired ? ` + ${st.hired} hired` : '')]);
      if (st.eta != null) rows.push(['Work left', `about ${Math.max(1, Math.ceil(st.eta))} h at this pace`]);
    }
    h += rows.map(([a, v]) => `<div class="row"><span>${a}</span><b>${v}</b></div>`).join('');
    let note = null, cls = 'ok';
    const hrs = this.world.hours;
    if (con.wait) note = null;
    else if (!b.access) note = 'Volunteers from the village are doing this one.';
    else if (!st.hasBuilders) { note = "No builders in town: hired hands from the next village are doing it, slowly. Build a 🧱 Builder's Yard."; cls = 'no'; }
    else if (!b.connected) { note = "Builders can't reach it: connect it to the town's roads."; cls = 'no'; }
    else if (hrs < 6.5 || hrs >= 18) note = 'The builders start again at dawn.';
    else if (!st.assigned) note = 'Waiting for a free builder.';
    if (note) h += `<div class="req"><div class="${cls}">${note}</div></div>`;
    if (con.kind !== 'dismantle') h += `<label class="chk" title="Builders come to this site before any other"><input type="checkbox" data-act="priority" ${con.priority ? 'checked' : ''}> Priority: builders come here first</label>`;
    return h + '</div>';
  }

  _buildingHTML(b) {
    const w = this.world, sim = this.game.sim;
    const def = BUILDINGS[b.type], L = def.levels[b.level], S = scaledLevel(L, sizeK(b));
    const open = isOpen(b);
    const stars = def.levels.length > 1 ? `<span class="stars">${'★'.repeat(b.level + 1)}${'☆'.repeat(def.levels.length - b.level - 1)}</span>` : '';
    const kind = KINDS[b.type] ? KINDS[b.type][kindOf(b)] : null;
    let h = `<div class="head"><img src="${thumb(b.type, b.level, b.variant, b.flavor)}" alt=""><div><h3>${esc(L.name)}</h3><div class="sub">${esc(kind ? `${def.name} · ${kind.name}` : def.name)} ${stars}<button class="btn small pm-open" data-act="paths" title="Every upgrade, rebuild and join it can lead to"><span class="ms">account_tree</span> Paths</button></div></div></div>`;
    if (b.con) h += this._siteHTML(b);
    const chips = [];
    if (!def.park || b.access) chips.push(b.connected ? '<span class="chip ok">Road connected</span>' : '<span class="chip no">Not connected to the town entrance</span>');
    if (def.needsRail) chips.push(b.rail ? '<span class="chip ok">On the railway</span>' : '<span class="chip no">No track alongside</span>');
    h += `<div class="chips">${chips.join('')}</div>`;
    h += workingHTML(this.game, b);
    if (def.generator && isOpen(b)) h += buryHTML(this.game);
    const rows = [];
    if (L.housing) {
      rows.push(['Residents', `${b.residents.length} / ${capOf(b, 'housing')}`]);
      const hh = householdsIn(w, b);
      const hc = householdCap(b), takes = Number.isFinite(hc) ? ` (${hc === 1 ? 'a home for one family' : `room for ${hc}`})` : '';
      rows.push(['Households', hh ? `${hh} ${hh === 1 ? 'family' : 'families'} · ${(b.residents.length / hh).toFixed(1)} people each${takes}` : `Empty${takes}`]);
    }
    if (L.jobs) rows.push(['Workers', `${b.workers.length} / ${capOf(b, 'jobs')}`]);
    if (L.edu) rows.push(['Workers need', `${EDU[L.edu]} education`]);
    if (L.seats) rows.push([L.teaches >= 4 ? 'Students' : 'Pupils', `${(b.pupils || []).length} / ${capOf(b, 'seats')}`], ['Teaches', `${EDU[L.teaches || 1]}${L.teaches === 1 ? ' (ages 6–10)' : L.teaches === 2 ? ' (ages 11–13)' : L.teaches === 3 ? ' (ages 14–17)' : ' (young adults)'}`]);
    if (isExpanded(b)) {
      const plot = plotName((b.w ?? b.size) * (b.d ?? b.size)), Plot = plot[0].toUpperCase() + plot.slice(1);
      rows.push(['Plot', b.spare ? `${Plot} · not built on yet (see Upgrade)` : `${Plot} · room for ${Math.round((sizeK(b) - 1) * 100)}% more`]);
    }
    else if (def.estate) rows.push(['Plot', '2×2 estate']);
    else if (def.grand) rows.push(['Plot', `${def.size}×${def.size} grounds`]);
    if (L.income) {
      let v = sim.incomeOf(b);
      rows.push([def.cat === 'industry' ? 'Production' : 'Sales', `$${fmt(v)} / day`]);
    }
    if (visitOf(b)) rows.push(['Per visit', `$${visitOf(b)}`]);
    if (L.upkeep) rows.push(['Upkeep', `$${S.upkeep} / day`]);
    for (const s of servicesOf(def)) rows.push(s === 'water' ? [`${SERVICES[s].icon} Water`, 'Into the mains along the roads'] : [`${SERVICES[s].icon} ${SERVICES[s].name} reach`, `${L.radius} tiles`]);
    if (L.culture) rows.push([`${SERVICES.culture.icon} Culture reach`, `${L.culture} tiles`]);
    if (def.park) rows.push(['Scenery', `+${L.appeal} within ${L.radius} tiles`]);
    if (L.pollution) rows.push(['Pollution', `${L.pollution} tile radius`]);
    if (L.taxBonus) rows.push(['Tax bonus', `+${Math.round(L.taxBonus * 100)}%`]);
    if (def.stop) {
      const lines = w.lines.filter(l => l.stops.includes(b.id));
      const waiting = (this.game.transit.waiting.get(b.id) || []).length;
      rows.push(['Lines', lines.length ? lines.map(l => `<span style="color:${l.color}">●</span> ${esc(l.name)}`).join('<br>') : 'None yet']);
      rows.push(['Waiting', `${waiting}`]);
    }
    const U = sim.utility;
    if (L.kw) rows.push(['Power output', `${S.kw} kW`], ['Town grid', `${U.power.demand} of ${U.power.gen} kW in use`]);
    if (open && this.game.agents) { const v = this.game.agents.visitorsAt(b); if (Number.isFinite(v.cap)) rows.push(['Visitors', `${v.now} of ${v.cap} at once`]); }
    if (L.supply) rows.push(['Water supply', `${S.supply} people`], ['Town water', `${U.water.demand} of ${U.water.supply} people`]);
    if (open && !def.park && !L.kw) rows.push(['Electricity', b.powered ? 'Connected' : U.power.gen ? (b.connected ? 'Cut off — not enough power' : 'Not on the grid') : 'No generator in town']);
    if (def.builders) rows.push(['Builders', `${b.workers.length} · work rate ${L.rate}×`]);
    if (L.tax && L.housing) rows.push(['Tax per worker', `${L.tax}×`]);
    if (def.fields && (b.flavor || def.fruit)) rows.push(['Produce', produceOf(b).name]);
    else if (b.flavor && def.park) {
      const o = parkOrigin(b.flavor);
      if (o) rows.push(['Laid out round', `the ${BUILDINGS[o.type].levels[Math.min(o.level ?? 0, BUILDINGS[o.type].levels.length - 1)].name.toLowerCase()}`]);
    }
    else if (b.flavor && !KINDS[b.type]) rows.push(['Shop', BUILDINGS[b.flavor] ? BUILDINGS[b.flavor].levels[0].name : b.flavor]);
      if (def.shop) rows.push(['Sells', esc(sellsText(b))]);
    for (const l of b.leases || []) {
      const o = w.buildings.get(l.with);
      if (!o) continue;
      const on = BUILDINGS[o.type].levels[o.level].name;
      rows.push(l.buyer ? ['Extra land', `bought from the ${esc(on)} next door for $${l.price}`] : ['Garden', `a strip sold to the ${esc(on)} next door for $${l.price}`]);
    }
    rows.push(['Built', `Day ${b.built}`]);
    if (open) h += `<div class="sec">${rows.map(([a, v]) => `<div class="row"><span>${a}</span><b>${v}</b></div>`).join('')}</div>`;
    if (L.housing && open) {
      const f = b.factors || {};
      h += `<div class="sec"><h5>Happiness ${b.happiness}%</h5><div class="meter"><i style="width:${b.happiness}%;background-position:${-300 + b.happiness * 3}px 0"></i></div>`;
      h += this._happyTable(f);
      h += '</div>';
      // residents, grouped by household
      if (b.residents.length) {
        const fams = new Map();
        for (const id of b.residents) { const r = w.residents.get(id); if (!r) continue; const k = familyOf(r); if (!fams.has(k)) fams.set(k, []); fams.get(k).push(r); }
        const many = fams.size > 1;
        h += `<div class="sec"><h5>${many ? `${fams.size} households` : 'Household'}</h5>`;
        for (const members of fams.values()) {
          if (many) h += `<div class="hh">The ${esc(members[0].last)} ${members.length > 1 ? 'family' : 'household'} <span class="muted">· ${members.length}</span></div>`;
          h += `<div class="chips">${members.map(r => `<span class="chip link" data-act="resident" data-id="${r.id}">${minionIcon(r)} ${esc(r.first)} <i>${Math.floor(yearsOf(r))}</i></span>`).join('')}</div>`;
        }
        h += '</div>';
      }
    }
    if (L.jobs && b.workers.length) {
      h += `<div class="sec"><h5>Workers</h5><div class="chips">${b.workers.slice(0, 16).map(id => {
        const r = w.residents.get(id);
        return r ? `<span class="chip link" data-act="resident" data-id="${id}">${esc(r.first)} ${esc(r.last[0])}.</span>` : '';
      }).join('')}${b.workers.length > 16 ? `<span class="chip">+${b.workers.length - 16}</span>` : ''}</div></div>`;
    }
    // a planting or monument: another of its kinds, reworked by the builders
    // (the seat of government: rebuilt in another style)
    if (!b.con && KINDS[b.type]) {
      const K = KINDS[b.type], cur = kindOf(b), cost = w.kindCheck(b, '__probe__').cost || 0;
      const head = def.seat ? 'Its style' : b.type === 'statue' ? 'What it is' : 'What is planted';
      const how = def.seat ? `Builders can rebuild it in another style, keeping its level, for $${fmt(cost)}.` : `Builders can rework it as another kind, keeping its level, for $${fmt(cost)}.`;
      h += `<div class="sec kinds"><h5>${def.icon} ${head}</h5><div class="note">${esc(K[cur].desc)}</div><div class="note">${how}</div><div class="produce">${Object.entries(K).map(([k, x]) => {
        const unlocked = w.hasTech(x.tech), on = k === cur;
        return `<button class="btn small ${on ? 'on' : ''}" data-act="kind" data-kind="${k}" ${!on && unlocked && w.money >= cost ? '' : 'disabled'} title="${esc(unlocked ? x.desc : `Research ${TECHS[x.tech].name}`)}">${unlocked ? '' : '🔒'}<span class="ms">${x.icon}</span> ${esc(x.name)}</button>`;
      }).join('')}</div></div>`;
    }
    // the seat and the civic buildings round it
    if (open && (def.seat || def.civic)) h += this._quarterHTML(b);
    // a farm: what it grows or raises, and its fields beyond the plot
    if (!b.con && def.fields) {
      const P = produceOf(b), cur = b.flavor || 'mixed', max = w.fieldMax(b), n = b.fields || 0;
      h += `<div class="sec farm"><h5>🌾 Produce</h5>`;
      if (choosesProduce(b.type)) h += `<div class="produce">${Object.entries(PRODUCE).map(([k, p]) => `<button class="btn small ${k === cur ? 'on' : ''}" data-act="produce" data-produce="${k}" title="${esc(p.desc)}">${p.icon} ${esc(p.name)}</button>`).join('')}</div>`;
      h += `<div class="note">${def.fruit ? `${P.icon} ` : ''}${esc(P.desc)} ${P.jobs !== 1 || P.income !== 1 ? `Needs ${P.jobs > 1 ? 'more' : 'fewer'} hands (×${P.jobs}); each earns ×${P.income}.` : ''}</div>`;
      h += `<h5>Fields · ${n} of ${max}</h5><div class="note">${def.fruit ? 'Orchard' : 'Farmland'} beyond the plot: $${fmt(CONFIG.FIELD_COST)} a field, behind or beside it and touching it or its other fields. Each gives work to about ${+(CONFIG.FIELD_JOBS * P.jobs).toFixed(2)} more farmhands${n ? ` (${Math.round(n * CONFIG.FIELD_JOBS * P.jobs)} now)` : ''}.${max < CONFIG.FIELD_MAX[CONFIG.FIELD_MAX.length - 1] && b.level < def.levels.length - 1 ? ` Upgrading lets it work more.` : ''}</div>`;
      h += `<div class="actions"><button class="btn" data-act="fields" data-mode="add" ${n < max ? '' : 'disabled'}><span class="ms">add_box</span> Add fields</button><button class="btn" data-act="fields" data-mode="remove" ${n ? '' : 'disabled'}><span class="ms">disabled_by_default</span> Take fields out</button></div>`;
      if (FARM_JOIN.from.includes(b.type)) h += `<div class="note">No farmhouse yet: join a ${esc(BUILDINGS.house.levels[0].name.toLowerCase())} beside it (below, when there is one) and its family moves into a farmhouse in the yard.</div>`;
      h += '</div>';
    }
    // upgrades: one path, or a choice of branches at the top level
    if (!b.con) {
      h += this._upgradeHTML(b);
      // a new style on its own, without an upgrade
      if (def.cat === 'residential' || def.cat === 'commercial') {
        const cost = w.restyleCheck(b, '__probe__').cost || 0;
        h += `<div class="sec"><h5>🎨 Restyle</h5><div class="note">Builders rebuild its fronts and roof in another style, without upgrading it, for $${fmt(cost)}.</div><div class="styles">${[{ id: '', name: 'Its own' }, ...STYLES].map(s => {
          const look = s.id || null, t = STYLE_TECH[s.id], unlocked = !t || w.hasTech(t), cur = (b.look || null) === look;
          return `<button class="style ${cur ? 'on' : ''}" data-act="restyle" data-look="${s.id}" ${!cur && unlocked && w.money >= cost ? '' : 'disabled'} title="${cur ? 'Its style now' : unlocked ? `Restyle · $${fmt(cost)}` : `Research ${esc(TECHS[t].name)}`}">${unlocked ? '' : '🔒'}${s.name}</button>`;
        }).join('')}</div></div>`;
      }
      const grow = w.expandOptions(b);
      if (grow.length) {
        const kind = grow[0].kind, estate = kind === 'estate' || kind === 'grand';
        const area = kind === 'grand' ? ((b.w ?? b.size) + 1) ** 2 : (b.w ?? b.size) * (b.d ?? b.size) * 2, plot = plotName(area);
        const into = growsInto(b.type, area).map(t => BUILDINGS[t].levels[estate && !def.seat ? Math.min(b.level, BUILDINGS[t].levels.length - 1) : 0].name);
        const who = L.housing ? 'households' : L.seats ? 'students' : def.park ? 'visitors' : 'workers';
        // (a park isn't offered extended as it is: more lawn holds no more scenery)
        const asIs = def.park || def.seat ? '' : `${into.length ? ', or ' : ''}the ${esc(L.name.toLowerCase())} extended to hold 50% more ${who}`;
        const absorbs = (def.park || def.seat) && kind !== 'land' ? ' Little parks in the way become part of it.' : '';
        h += `<div class="sec"><h5>⇲ ${kind === 'grand' ? `Take land for ${plot}` : estate ? 'Take land for a 2×2 estate' : 'Take a neighbouring plot'}</h5><div class="note">Buy the land first: the ${esc(L.name.toLowerCase())} stays as it is and the new land becomes its ${def.park ? 'lawn' : 'garden'}. Then choose what to build across the ${plot} under Upgrade: ${into.length ? `the ${esc(into.join(' or the '))}` : ''}${asIs}.${absorbs}</div><div class="actions col">`;
        for (const o of grow) {
          const key = `${b.id}:${o.dir}:${o.kind}`, confirm = this.confirmExpand === key;
          const label = confirm ? `⚠ Click again: ${o.kind === 'takeover' ? 'demolish' : 'shrink'} the neighbour` : `${esc(o.label)} · $${fmt(o.cost)}`;
          h += `<button class="btn ${o.warn ? 'warn' : ''} ${confirm ? 'gold' : ''}" data-act="expand" data-dir="${o.dir}" data-kind="${o.kind}" data-rects="${esc(JSON.stringify(o.rects || []))}" ${w.money >= o.cost ? '' : 'disabled'}>${label}</button>`;
          if (o.warn) h += `<div class="warnline">⚠ ${esc(o.warn)}</div>`;
        }
        h += '</div></div>';
      }
      const merges = w.mergeOptions(b);
      if (merges.length) {
        h += `<div class="sec"><h5>🔗 Join with a neighbour</h5><div class="note">${merges.every(m => m.farmJoin) ? 'The house becomes the farm\'s farmhouse, in its yard: its family moves in and its own plot is freed.' : 'Builders knock the two together into one new building on a double plot. Different pairs make different buildings.'}</div><div class="actions col">`;
        for (const m of merges) {
          const on = BUILDINGS[m.other.type].levels[m.other.level].name;
          h += `<button class="btn" data-act="merge" data-id="${m.other.id}" ${m.ok ? '' : 'disabled'} title="${esc(BUILDINGS[m.type].desc)}">+ ${esc(on)} → ${esc(m.name)} · $${fmt(m.cost)}</button>`;
          h += `<div class="mergedesc">${esc(BUILDINGS[m.type].desc)}</div>`;
          if (m.moveOut) h += `<div class="warnline">⚠ Room for fewer people: about ${m.moveOut} resident${m.moveOut > 1 ? 's' : ''} will move out</div>`;
        }
        h += '</div></div>';
      }
    }
    // which way it faces: any angle (turned about its middle)
    if (!b.con && !b.spare && !(b.leases && b.leases.length)) {
      const deg = Math.round((b.a * 180) / Math.PI);
      const btn = (op, icon, title) => `<button class="btn" data-act="turn" data-op="${op}" title="${title}"><span class="ms">${icon}</span></button>`;
      const face = w.faceRoad(b.x, b.z);
      h += `<div class="sec"><h5>Which way it faces</h5><div class="note">Facing ${((deg % 360) + 360) % 360}° · turned about its middle; it must still fit and face a street.</div><div class="actions">`
        + btn('ccw15', 'rotate_left', 'Turn it 15° anticlockwise') + btn('ccw1', 'chevron_left', 'Turn it 1° anticlockwise') + btn('cw1', 'chevron_right', 'Turn it 1° clockwise') + btn('cw15', 'rotate_right', 'Turn it 15° clockwise')
        + `<button class="btn" data-act="turn" data-op="face" ${face == null ? 'disabled' : ''} title="Turn it square to the street it faces">Face the street</button></div></div>`;
    }
    h += `<div class="actions">`;
    if (!b.con) h += w.hasTech('relocation')
      ? `<button class="btn" data-act="move" title="Builders take it down, cart the materials over and rebuild it">↔ Move · ${fmt(w.moveCost(b))}</button>`
      : '<button class="btn" disabled title="Research House Moving to move buildings">↔ Move 🔒</button>';
    if ((!def.seat || b.con) && !(b.con && b.con.kind === 'demolish')) h += `<button class="btn danger" data-act="demolish">${b.con && b.con.kind === 'build' && !b.con.moved ? 'Cancel' : 'Demolish'}</button>`;
    h += `</div>`;
    return h;
  }

  // The civic quarter: on the seat, each kind of civic building and the one
  // that counts for it; on a civic building, whether it is part of it.
  _quarterHTML(b) {
    const w = this.world, def = BUILDINGS[b.type], q = civicQuarter(w), R = CIVIC_QUARTER.reach, pc = Math.round(CIVIC_QUARTER.tax * 100);
    let h = '<div class="sec quarter"><h5>🏛️ Civic quarter</h5>';
    if (def.seat) {
      h += `<div class="note">Each of these with its middle within ${R} tiles of this one's makes part of a civic quarter, and each kind there adds ${pc}% to the town's taxes.</div>`;
      for (const t of CIVIC_TYPES) {
        const m = q.members.find(e => e.b.type === t);
        h += `<div class="row"><span>${BUILDINGS[t].icon} ${esc(BUILDINGS[t].name)}</span><b>${m ? `<span class="chip link ok" data-act="building" data-id="${m.b.id}">${esc(BUILDINGS[t].levels[m.b.level].name)} · ${Math.round(m.d)} tiles</span>` : '<span class="muted">none near</span>'}</b></div>`;
      }
      h += `<div class="row"><span>Town tax from the quarter</span><b>${q.tax ? `+${Math.round(q.tax * 100)}%` : '—'}</b></div>`;
      return h + '</div>';
    }
    const seat = q.seat;
    if (!seat) return h + '<div class="note">There is no town hall for it to stand by.</div></div>';
    const sn = BUILDINGS[seat.type].levels[seat.level].name, s = buildingCenter(seat), c = buildingCenter(b), d = Math.round(Math.hypot(c.x - s.x, c.z - s.z));
    const me = q.members.find(e => e.b === b), first = q.members.find(e => e.b.type === b.type);
    if (me && first === me) h += `<div class="note ok">Part of the civic quarter, ${d} tiles from the ${esc(sn)}: +${pc}% to the town's taxes.</div>`;
    else if (me) h += `<div class="note">In the civic quarter, ${d} tiles from the ${esc(sn)}, but the ${esc(BUILDINGS[first.b.type].levels[first.b.level].name)} there already counts for its kind.</div>`;
    else if (!b.connected) h += `<div class="note no">Not on the roads, so not part of the civic quarter round the ${esc(sn)}.</div>`;
    else h += `<div class="note">${d} tiles from the ${esc(sn)}: built within ${R} tiles of it, it would make part of a civic quarter, +${pc}% to the town's taxes.</div>`;
    return h + '</div>';
  }

  _residentHTML(r) {
    const w = this.world, ag = this.game.agents;
    const home = w.buildings.get(r.home), job = r.job != null ? w.buildings.get(r.job) : null;
    const age = r.age === 'child' ? 'Child' : r.age === 'elder' ? 'Elder' : 'Adult';
    const mood = Math.max(0, Math.min(100, Math.round(r.mood ?? 60)));
    const moodE = mood >= 75 ? '😄' : mood >= 55 ? '🙂' : mood >= 40 ? '😐' : '😟';
    let work = job ? `<span class="chip link" data-act="building" data-id="${job.id}">${esc(BUILDINGS[job.type].levels[job.level].name)}</span>` :
      (r.age === 'adult' ? 'Looking for work' : r.age === 'child' ? 'Student' : 'Retired');
    let h = `<div class="head"><div class="big">${minionIcon(r)}</div><div><h3>${esc(r.first)} ${esc(r.last)}</h3><div class="sub">${age}, ${Math.floor(yearsOf(r))} · ${moodE} ${mood}%</div></div></div>`;
    h += `<div class="sec"><div class="row"><span>Now</span><b>${esc(ag.activity(r))}</b></div>`;
    h += `<div class="row"><span>Home</span><b>${home ? `<span class="chip link" data-act="building" data-id="${home.id}">${esc(BUILDINGS[home.type].levels[home.level].name)}</span>` : 'Homeless'}</b></div>`;
    h += `<div class="row"><span>Work</span><b>${work}</b></div>`;
    h += `<div class="row"><span>Education</span><b>${EDU[eduOf(r)]}</b></div>`;
    const sc = schoolingOf(w, r);
    if (sc) h += `<div class="row"><span>School</span><b class="${sc.ok ? '' : 'neg'}">${sc.building ? `<span class="chip link" data-act="building" data-id="${sc.building.id}">${esc(sc.text)}</span>` : esc(sc.text)}</b></div>`;
    const pay = salaryOf(w, r), cost = livingCostOf(w, r), pension = pensionOf(r);
    if (r.age !== 'child') {
      if (pay) h += `<div class="row"><span>Wage</span><b>$${pay} / day</b></div>`;
      if (pension) h += `<div class="row"><span>Pension</span><b>$${pension} / day</b></div>`;
      h += `<div class="row"><span>Living costs</span><b>$${cost} / day</b></div>`;
      const wl = wealthOf(r);
      h += `<div class="row"><span>Savings</span><b class="${wl < 0 ? 'neg' : ''}">${wl < 0 ? '−' : ''}$${fmt(Math.abs(wl))}</b></div>`;
    }
    h += '</div>';
    if (home && home.factors) {
      const job = r.age === 'adult' ? (r.job ? 4 : r.school != null ? 0 : -8) : 0;
      const jobless = r.age === 'adult' && !r.job && r.school == null;
      const lacks = (home.factors.parts || []).map(([k, v, max]) => ({ k, gap: Math.max(0, max - v) })).filter(x => x.gap > 0.4 && HAPPY[x.k] && !(jobless && x.k === 'jobs')).sort((a, b) => b.gap - a.gap).slice(0, 3);
      h += `<div class="sec"><h5>Mood ${mood}%</h5><div class="row"><span>Home happiness</span><b>${home.happiness}%</b></div>`;
      if (r.age === 'adult') h += `<div class="row"><span>${r.job ? 'Has a job' : r.school != null ? 'Studying' : 'Looking for work'}</span><b class="${job < 0 ? 'neg' : ''}">${job > 0 ? '+' : job < 0 ? '−' : ''}${Math.abs(job)}</b></div>`;
      const wants = lacks.map(x => `${esc(HAPPY[x.k].want || HAPPY[x.k].label.toLowerCase())} (+${Math.round(x.gap)})`);
      if (jobless) wants.unshift('a job (+12)');
      if (wants.length) h += `<div class="note">Would be happier with: ${wants.join(', ')}.</div>`;
      h += '</div>';
    }
    const traits = traitsOf(r);
    h += `<div class="sec"><h5>Personality</h5><div class="chips">${traits.map(t => `<span class="chip" title="${esc(TRAITS[t].desc)}">${esc(TRAITS[t].name)}</span>`).join('')}</div>`;
    h += `<div class="note">${traits.map(t => esc(TRAITS[t].desc)).join('. ')}.</div></div>`;
    const rel = relativesOf(w, r), friends = friendsOf(w, r);
    const link = (o, label) => `<span class="chip link" data-act="resident" data-id="${o.id}">${minionIcon(o)} ${esc(o.first)}${o.last !== r.last ? ' ' + esc(o.last[0]) + '.' : ''} <i>${label}</i></span>`;
    if (rel.length) h += `<div class="sec"><h5>Family</h5><div class="chips">${rel.map(x => link(x.r, x.role)).join('')}</div></div>`;
    h += `<div class="sec"><h5>Friends</h5><div class="chips">${friends.length ? friends.map(x => link(x.r, x.ctx)).join('') : '<span class="muted">Keeps to themselves</span>'}</div></div>`;
    h += `<div class="actions"><button class="btn ${this.game.follow === r.id ? 'gold' : 'primary'}" data-act="follow">${this.game.follow === r.id ? '◉ Following' : '🎥 Follow'}</button><button class="btn" data-act="people">👪 All villagers</button></div>`;
    return h;
  }

  _roadHTML(e, rail) {
    const w = this.world;
    let h = '';
    if (!rail) {
      const L = e.level, d = ROAD_LEVELS[L], wet = w._heights(e).wet.some(Boolean);
      h += `<div class="head"><div class="big">${['', '🟫', '🪨', '⬛'][L]}</div><div><h3>${d.name}</h3><div class="sub">${wet ? 'Road with a bridge' : 'Road'} · ${e.len.toFixed(1)} long · upkeep ${(d.upkeep * e.len).toFixed(2)}/day</div></div></div>`;
      const dv = e.dress;
      const chip = (D) => (D ? `<span class="chip"><span class="ms">${D.icon}</span> ${D.name}</span>` : '');
      h += `<div class="chips">${w.edgeConnected(e.id) ? '<span class="chip ok">Connected</span>' : '<span class="chip no">Not connected to the entrance</span>'}${chip(DRESSINGS[lookPart(dv)])}${chip(DRESSINGS[streetPart(dv)])}</div>`;
      h += buryHTML(this.game, e.id);
      const del = w.removeCheck(e.id);
      if (L < 3) {
        const c = w.levelCheck([e.id], L + 1);
        h += `<div class="actions"><button class="btn primary" data-act="roadup" ${c.ok ? '' : 'disabled'} title="${esc(c.reason || '')}">⬆ ${ROAD_LEVELS[L + 1].name} · $${c.cost ?? '—'}</button><button class="btn danger" data-act="roaddel" ${del.ok ? '' : 'disabled'} title="${esc(del.reason || '')}">Remove${del.ok ? ` · +$${del.refund}` : ''}</button></div>`;
        if (!c.ok) h += `<div class="req"><div class="no">${esc(c.reason)}</div></div>`;
      } else h += `<div class="actions"><button class="btn danger" data-act="roaddel" ${del.ok ? '' : 'disabled'} title="${esc(del.reason || '')}">Remove${del.ok ? ` · +$${del.refund}` : ''}</button></div>`;
      const run = streetOf(w, e.id);
      h += `<div class="actions"><button class="btn" data-act="roadrun" title="Pick the whole street (on through each junction the way it runs straightest) to change it all at once"><span class="ms">highlight_alt</span> Select the street${run.length > 1 ? ` · ${run.length} stretches` : ''}</button></div>`;
    } else {
      h += `<div class="head"><div class="big">🛤️</div><div><h3>Railway track</h3><div class="sub">upkeep 0.25/day</div></div></div>`;
      h += `<div class="actions"><button class="btn danger" data-act="raildel">Remove</button></div>`;
    }
    return h;
  }

  _act(act, data) {
    const g = this.game, w = this.world, sel = this.selection;
    switch (act) {
      case 'close': this.inspect(null); break;
      case 'resident': this.inspect({ kind: 'resident', id: Number(data.id) }); break;
      case 'building': {
        const b = w.buildings.get(Number(data.id));
        if (b) { this.inspect({ kind: 'building', id: b.id }); g.renderer.lookAt(b.x, b.z); }
        break;
      }
      case 'priority': {
        const b = sel && w.buildings.get(sel.id);
        if (b) g.cmd({ t: 'priority', id: b.id, on: !(b.con && b.con.priority) }, () => this.renderInspector(true));
        break;
      }
      case 'upgrade': {
        const id = sel.id;
        const look = this.lookChoice.has(id) ? this.lookChoice.get(id) : undefined;
        this.preview = null;
        g.view.setPreview(null, null);
        g.cmd({ t: 'upgrade', id, to: data.type || null, look }, (r) => {
          const b = r.building;
          if (r.ok && b) {
            this.lookChoice.delete(id);
            g.sfx('upgrade');
            if (r.instant || !b.con) this.toast(`Upgraded to ${BUILDINGS[b.type].levels[b.level].name}!`, 'good', '⬆️');
            else this.toast(b.con.extend ? 'Builders will extend it across its plot' : `Builders will rebuild it as a ${BUILDINGS[b.con.toType || b.type].levels[b.con.to].name}`, 'good', '🏗️');
          } else if (!r.ok) this.toast(r.reason || 'Cannot upgrade yet', 'bad');
          if (this.selection) this.renderInspector(true);
        });
        break;
      }
      case 'merge': {
        g.cmd({ t: 'merge', a: sel.id, b: Number(data.id) }, (r) => {
          if (r.ok && r.building) {
            g.sfx('build');
            this.toast(`Joining them into a ${BUILDINGS[r.building.type].levels[r.building.level].name}`, 'good', '🏗️');
            this.inspect({ kind: 'building', id: r.building.id });
          } else if (!r.ok) this.toast(r.reason || "Can't join these", 'bad');
        });
        break;
      }
      case 'move': g.input.setTool({ kind: 'move', id: sel.id }); break;
      case 'turn': {
        const pb = w.buildings.get(sel.id);
        if (!pb) break;
        const D = Math.PI / 180, by = { ccw15: 15 * D, ccw1: D, cw1: -D, cw15: -15 * D }[data.op];
        const a = data.op === 'face' ? w.faceRoad(pb.x, pb.z) : pb.a + (by || 0);
        if (a == null) break;
        g.cmd({ t: 'turn', id: pb.id, a: Math.round(a * 1000) / 1000 }, (r) => {
          if (!r.ok && r.reason) this.toast(r.reason, 'bad');
          this.renderInspector(true);
        });
        break;
      }
      case 'paths': { const pb = w.buildings.get(sel.id); if (pb) showPathMap(this, pb); break; }
      case 'kind': {
        const kb = w.buildings.get(sel.id), K = kb && KINDS[kb.type];
        g.cmd({ t: 'kind', id: sel.id, kind: data.kind }, (r) => {
          const verb = kb && BUILDINGS[kb.type].seat ? ['Restyled', 'rebuild it'] : ['Reworked', 'rework it'];
          if (r.ok) { g.sfx('build'); this.toast(r.instant ? `${verb[0]} · ${K[data.kind].name}` : `Builders will ${verb[1]} · ${K[data.kind].name}`, 'good', '🏗️'); } else if (r.reason) this.toast(r.reason, 'bad');
          if (this.selection) this.renderInspector(true);
        });
        break;
      }
      case 'produce':
        g.cmd({ t: 'produce', id: sel.id, produce: data.produce }, (r) => {
          if (r.ok) { g.sfx('click'); this.toast(`Now ${PRODUCE[data.produce].name.toLowerCase()}`, 'good', PRODUCE[data.produce].icon); } else if (r.reason) this.toast(r.reason, 'bad');
          if (this.selection) this.renderInspector(true);
        });
        break;
      case 'fields': g.input.setTool({ kind: 'fields', id: sel.id, add: data.mode === 'add' }); break;
      case 'expand': {
        const key = `${sel.id}:${data.dir}:${data.kind}`;
        // anything that shrinks or demolishes a neighbour needs a second click
        if ((data.kind === 'takeover' || data.kind === 'strip') && this.confirmExpand !== key) { this.confirmExpand = key; this.renderInspector(true); break; }
        this.confirmExpand = null;
        g.input.previewTiles = null;
        g.cmd({ t: 'expand', id: sel.id, dir: Number(data.dir), kind: data.kind }, (r) => {
          if (!r.ok) { this.toast(r.reason || "Can't expand that way", 'bad'); return; }
          g.sfx('build');
          this.toast(r.kind === 'strip' ? 'Bought a strip of the neighbouring garden' : 'The plot is yours: choose what to build on it under Upgrade', 'good', '🏡');
          if (this.selection) this.renderInspector(true);
        });
        break;
      }
      case 'restyle': {
        g.cmd({ t: 'restyle', id: sel.id, look: data.look || null }, (r) => {
          if (!r.ok) { this.toast(r.reason || "Can't restyle it", 'bad'); return; }
          g.sfx('upgrade');
          this.toast(r.instant ? 'Restyled' : 'Builders will restyle it', 'good', '🎨');
          if (this.selection) this.renderInspector(true);
        });
        break;
      }
      case 'look':
        this.lookChoice.set(sel.id, data.look || null);
        // the in-town preview only follows the style if it is switched on
        if (this.preview && this.preview.id === sel.id) this.preview = { id: sel.id, type: data.type };
        this.renderInspector(true);
        break;
      case 'preview': {
        const on = this.preview && this.preview.id === sel.id && this.preview.type === data.type;
        this.preview = on ? null : { id: sel.id, type: data.type };
        this.renderInspector(true);
        break;
      }
      case 'demolish': {
        const b = w.buildings.get(sel.id);
        if (!b) break;
        g.cmd({ t: 'demolish', id: b.id }, (r) => {
          if (!r.ok) { this.toast(r.reason || "Can't demolish that", 'bad'); return; }
          g.sfx('demolish');
          if (r.instant) { if (this.selection === sel) this.inspect(null); }
          else { this.toast('A demolition crew is on its way; the people inside have moved out', 'info', '🏗️'); if (this.selection) this.renderInspector(true); }
        });
        break;
      }
      case 'follow': g.setFollow(g.follow === sel.id ? null : sel.id); this.renderInspector(true); break;
      case 'people': this.showPeople(); break;
      case 'roadup': {
        const e = w.roads.edges.get(sel.e);
        if (!e) break;
        g.cmd({ t: 'roadlevel', ids: [e.id], level: e.level + 1 }, (r) => {
          if (!r.ok) this.toast(r.reason || 'Cannot upgrade', 'bad');
          if (this.selection) this.renderInspector(true);
        });
        break;
      }
      case 'roaddel':
        g.cmd({ t: 'unroad', e: sel.e }, (r) => {
          if (!r.ok) this.toast(r.reason || 'Cannot remove', 'bad');
          else if (this.selection === sel) this.inspect(null);
        });
        break;
      case 'raildel': g.cmd({ t: 'unrail', e: sel.e }); this.inspect(null); break;
      case 'roadrun': g.input.setTool(roadSelTool(streetOf(w, sel.e))); break;
      case 'rsel': roadSelAct(this, data); break;
      case 'bury': {
        const ids = data.scope === 'town' ? townRoadTiles(w) : streetOf(w, sel.e);
        g.cmd({ t: 'bury', ids }, (r) => {
          if (!r.ok) this.toast(r.reason || "Those lines can't be buried", 'bad');
          else { this.toast(`Power lines laid underground along ${r.n} stretch${r.n === 1 ? '' : 'es'} of road`, 'good', '⚡'); this.renderInspector(true); }
        });
        break;
      }
    }
  }

  // --------------------------------------------------------- floating UI
  coin(x, y, z, v) {
    const g = this.game;
    if (!g.settings.popCoins || g.renderer.rig.zoom < 1.1) return;
    const layer = $('popups');
    if (layer.childElementCount > 30) return;
    const p = g.renderer.worldToScreen(new g.THREE.Vector3(x, y, z));
    if (p.behind || p.x < 0 || p.y < 0 || p.x > innerWidth || p.y > innerHeight) return;
    const el = document.createElement('div');
    el.className = 'coin';
    el.textContent = `+$${v}`;
    el.style.left = `${p.x}px`; el.style.top = `${p.y}px`;
    layer.appendChild(el);
    setTimeout(() => el.remove(), 1300);
  }

  updateLabels() {
    const g = this.game;
    const r = g.agents.selected;
    let el = this.labels.get('sel');
    if (!r || !this.world.residents.has(r.id) || !g.settings.popLabels) { if (el) { el.remove(); this.labels.delete('sel'); } return; }
    const pos = g.agents.positionOf(r);
    if (!pos) return;
    if (!el) { el = document.createElement('div'); el.className = 'label3d'; $('popups').appendChild(el); this.labels.set('sel', el); }
    const p = g.renderer.worldToScreen(new g.THREE.Vector3(pos.x, pos.y + 0.24, pos.z));
    el.style.display = p.behind ? 'none' : '';
    el.style.left = `${p.x}px`; el.style.top = `${p.y}px`;
    el.textContent = `${r.first} · ${g.agents.activity(r)}`;
  }

  // Notices can be switched off; warnings about something the player just
  // tried ('bad') always show, since they explain why it didn't work.
  toast(msg, kind = 'info', icon = null) {
    if (!this.game.settings.popToasts && kind !== 'bad') return;
    const box = $('toasts');
    // the same notice twice in a row just stays up a little longer
    const top = box.firstElementChild;
    if (top && top.msg === msg && !top.classList.contains('out')) { top.hold(); return; }
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = (icon ? `<span>${ico(icon)}</span>` : '') + `<span>${ico(esc(msg))}</span>`;
    el.msg = msg;
    let t = 0;
    el.hold = () => { clearTimeout(t); t = setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, kind === 'big' ? 6500 : 4000); };
    el.hold();
    box.prepend(el);
    while (box.childElementCount > 5) box.lastElementChild.remove();
  }

  tooltip(html, x, y) {
    const t = $('tooltip');
    if (!this.game.settings.popTips) html = null;
    if (!html) { t.classList.add('hidden'); return; }
    t.innerHTML = html;
    t.classList.remove('hidden');
    const r = t.getBoundingClientRect();
    t.style.left = `${Math.min(innerWidth - r.width - 8, x + 16)}px`;
    t.style.top = `${Math.min(innerHeight - r.height - 8, y + 18)}px`;
  }

  toggleOverlayMenu(force) {
    const m = $('overlayMenu');
    const show = force ?? m.classList.contains('hidden');
    m.classList.toggle('hidden', !show);
    for (const b of m.querySelectorAll('button')) b.classList.toggle('on', (b.dataset.o || null) === this.game.overlayMode);
  }

  setLegend(html) {
    const l = $('legend');
    if (!html) { l.classList.add('hidden'); return; }
    l.innerHTML = ico(html);
    l.classList.remove('hidden');
    $('btnOverlay').classList.toggle('on', !!this.game.overlayMode);
  }

  // ------------------------------------------------------------- windows
  // Every dialog is a window: drag it by its title bar, keep several open,
  // click one to bring it to the front. A window is identified by its title,
  // so opening the same one again refreshes it in place.
  openModal(html, mount, locked = false) {
    this.windows ||= new Map();
    const key = ((html.match(/<h2>([\s\S]*?)<\/h2>/) || [])[1] || 'Window').replace(/<[^>]+>/g, '').trim();
    let win = this.windows.get(key);
    const fresh = !win;
    if (fresh) {
      win = document.createElement('div');
      win.className = 'modal-card panel win';
      win.dataset.key = key;
      $('windows').appendChild(win);
      this.windows.set(key, win);
      win.addEventListener('pointerdown', () => this._focusWin(win), true);
      this._watchFit(win);
    }
    win.classList.toggle('locked', locked);
    win.innerHTML = (locked ? '' : '<button class="x" data-close>✕</button>') + ico(html);
    const x = win.querySelector('[data-close]');
    if (x) x.onclick = () => this.closeWindow(win);
    const bar = win.querySelector('h2');
    if (bar) bar.onpointerdown = (e) => { if (e.button === 0) this._drag(win, e, `hearthvale.win.${key}`); };
    this._focusWin(win);
    if (mount) mount(win);
    if (fresh) this._placeWin(win, key);
    else this._fitWin(win);
  }

  _placeWin(win, key) {
    let pos = null;
    try { pos = JSON.parse(localStorage.getItem(`hearthvale.win.${key}`) || 'null'); } catch {}
    const r = win.getBoundingClientRect();
    // a window as wide as the screen (a phone) opens in the middle, wherever it was left on a bigger one
    if (r.width > innerWidth - 48) pos = null;
    const n = this.windows.size - 1;
    win.style.left = `${pos ? pos.x : Math.max(8, (innerWidth - r.width) / 2 + n * 26)}px`;
    win.style.top = `${pos ? pos.y : Math.max(8, Math.min(90, (innerHeight - r.height) / 2) + n * 26)}px`;
    this._fitWin(win);
  }

  // Keep a window (or the properties panel) on screen: all of it when there is
  // room, and its title bar always. One nearly as wide as the screen sits in the
  // middle, and one too tall for the room below it moves up. The properties
  // panel, a new size with every building clicked, stays put and scrolls inside
  // while at least half the screen is left below it.
  _fitWin(el) {
    if (!el || !el.isConnected || el.classList.contains('hidden') || (el.id === 'inspector' && this._docked())) return;
    const W = innerWidth, H = innerHeight, scroll = el.scrollTop;
    el.style.maxHeight = '';
    const r = el.getBoundingClientRect();
    if (!r.width) return;
    const left = r.width > W - 48 ? (W - r.width) / 2 : Math.min(Math.max(0, r.left), Math.max(0, W - r.width));
    let top = Math.min(Math.max(0, r.top), H - 30);
    if (top + r.height > H) {
      if (el.id !== 'inspector' || H - top < Math.min(r.height, H / 2)) top = Math.max(0, H - r.height);
      if (top + r.height > H) el.style.maxHeight = `${H - 8 - top}px`;
    }
    // only move what has to move, so the properties panel keeps to its corner
    if (Math.abs(left - r.left) > 0.5) { el.style.left = `${left}px`; el.style.right = 'auto'; }
    if (Math.abs(top - r.top) > 0.5) el.style.top = `${top}px`;
    el.scrollTop = scroll;
  }

  // fit it again whenever it changes size (new content, pictures loading in)
  _watchFit(el) {
    this._fitRO ||= new ResizeObserver((es) => requestAnimationFrame(() => { for (const e of es) this._fitWin(e.target); }));
    this._fitRO.observe(el);
  }

  // on a narrow screen the properties panel sits along the bottom (see style.css)
  _docked() { return matchMedia('(max-width: 900px)').matches; }

  _focusWin(win) {
    this._z = (this._z || 60) + 1;
    win.style.zIndex = this._z;
    this._top = win;
    for (const w of this.windows.values()) w.classList.toggle('inactive', w !== win);
  }

  // Drag a window (or the properties panel) by its title bar.
  _drag(el, e, storeKey) {
    e.preventDefault();
    const r = el.getBoundingClientRect(), sx = e.clientX, sy = e.clientY;
    el.style.right = 'auto';
    const move = (ev) => {
      el.style.left = `${Math.min(Math.max(0, r.left + ev.clientX - sx), innerWidth - 60)}px`;
      el.style.top = `${Math.min(Math.max(0, r.top + ev.clientY - sy), innerHeight - 30)}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      this._fitWin(el);
      try { localStorage.setItem(storeKey, JSON.stringify({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) })); } catch {}
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  }

  closeWindow(win) {
    if (!win) return false;
    win.remove();
    this.windows.delete(win.dataset.key);
    if (this._top === win) {
      this._top = [...this.windows.values()].sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex))[0] || null;
      if (this._top) this._focusWin(this._top);
    }
    return true;
  }

  // Closes the front window (the one the player last clicked in).
  closeModal() { return this.closeWindow(this._top && this._top.isConnected ? this._top : null); }
  closeAllWindows() { for (const w of [...(this.windows || new Map()).values()]) this.closeWindow(w); }
  // only a window that must be answered (no close button) blocks the game
  get modalOpen() { return [...(this.windows || new Map()).values()].some(w => w.classList.contains('locked')); }
  get anyWindow() { return !!(this.windows && this.windows.size); }

  showRename() {
    this.openModal(`<h2>Rename your town</h2><div class="field"><label>Town name</label><input id="renameIn" maxlength="40" value="${esc(this.world.townName)}"></div>
      <div class="actions"><button class="btn primary" id="renameOk">Save name</button></div>`, (c) => {
      const inp = c.querySelector('#renameIn');
      inp.focus(); inp.select();
      const ok = () => { const v = inp.value.trim(); if (v) this.game.cmd({ t: 'rename', name: v }); this.closeModal(); };
      c.querySelector('#renameOk').onclick = ok;
      inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
    });
  }

  showNewGame(onCreate) {
    const rng = new RNG(randomSeed());
    const name = genTownName(rng);
    this.openModal(`<h2>Found a new village</h2><p class="lead">Start in an empty valley, or take over a village a few weeks along. Every seed grows a different valley — rivers, lakes, hills and forests, and highland round it to climb (or a gondola to take).</p>
      <div class="field"><label>Start from</label>${starterPickerHTML()}</div>
      <div class="field"><label>Village name</label><input id="ngName" maxlength="40" value="${esc(name)}"></div>
      <div class="grid2">
        <div class="field"><label>Map seed</label><div class="inline"><input id="ngSeed" style="flex:1" value="${randomSeed() % 1000000}"><button class="btn small" id="ngDice" title="Random seed">🎲</button></div></div>
        <div class="field"><label>Valley size</label><select id="ngSize"><option value="32">Small · 32×32 (hamlet)</option><option value="48" selected>Medium · 48×48 (village)</option><option value="64">Large · 64×64 (town)</option><option value="80">Huge · 80×80 (valley)</option></select></div>
      </div>
      <div class="field"><label>The land round it</label><select id="ngRelief"><option value="gentle">Gentle · a valley with a hill or two</option><option value="hilly" selected>Hilly · highland round the valley, steep slopes to climb</option><option value="mountains">Mountains · higher still, a second tier and peaks</option></select></div>
      <div class="field"><label class="inline"><input type="checkbox" id="ngInf"> Sandbox: unlimited money</label></div>
      <div class="field"><label class="inline"><input type="checkbox" id="ngAll"> Sandbox: unlock every building from the start</label></div>
      <div class="field"><label class="inline"><input type="checkbox" id="ngFree"> Sandbox: upgrade buildings without meeting their needs</label></div>
      <div class="field"><label class="inline"><input type="checkbox" id="ngInst"> Sandbox: buildings go up instantly (no builders needed)</label></div>
      <div class="actions"><button class="btn primary" id="ngGo">🏡 Found the village</button></div>`, (c) => {
      c.querySelector('#ngDice').onclick = () => { c.querySelector('#ngSeed').value = randomSeed() % 1000000; };
      const seedOf = () => {
        const seedStr = c.querySelector('#ngSeed').value.trim();
        return /^\d+$/.test(seedStr) ? Number(seedStr) : [...seedStr].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
      };
      // a starter town comes with its own valley: the seed and size are its own
      const typed = {};
      const picker = mountStarterPicker(c, this.game, {
        getMap: () => ({ seed: seedOf(), N: Number(c.querySelector('#ngSize').value), relief: c.querySelector('#ngRelief').value }),
        onPick: (id, def) => {
          const seedIn = c.querySelector('#ngSeed'), sizeIn = c.querySelector('#ngSize');
          if (def && !seedIn.disabled) Object.assign(typed, { seed: seedIn.value, N: sizeIn.value });
          if (def) { seedIn.value = def.seed; sizeIn.value = def.N; } else if (seedIn.disabled) { seedIn.value = typed.seed; sizeIn.value = typed.N; }
          for (const el of [seedIn, sizeIn, c.querySelector('#ngDice'), c.querySelector('#ngRelief')]) el.disabled = !!def;
        },
      });
      c.classList.add('wide');
      c.querySelector('#ngGo').onclick = () => {
        const seed = seedOf();
        const opts = { name: c.querySelector('#ngName').value.trim() || name, seed, N: Number(c.querySelector('#ngSize').value), relief: c.querySelector('#ngRelief').value, starter: picker.pick === EMPTY ? null : picker.pick, sandbox: { infiniteMoney: c.querySelector('#ngInf').checked, unlockAll: c.querySelector('#ngAll').checked, freeUpgrades: c.querySelector('#ngFree').checked, instantBuild: c.querySelector('#ngInst').checked } };
        this.closeModal();
        onCreate(opts);
      };
    });
  }

  // ---------------------------------------------------------- save/load
  showMerge(opts) { (this._merge ||= new MergeDialog(this)).open(opts); }

  showSaves(tab = 'local') {
    const g = this.game;
    const inGame = !!g.world && !g.demo;
    const tabs = [['local', '💻 This browser'], ['file', '📁 File']];
    this.openModal(`<h2>Save & load</h2><p class="lead">${inGame ? `Saving <b>${esc(this.world.townName)}</b> — day ${this.world.day}, ${fmt(this.world.population)} villagers.` : 'Pick a saved village to continue.'}</p>
      <div class="actions" style="margin:0 0 10px">
        ${inGame ? '<button class="btn primary" id="svDownload" title="Ctrl+Shift+S">⬇ Download save (.json)</button>' : ''}
        <label class="btn" title="You can also drop a .json save onto the game"><input type="file" id="svUpload" accept=".json,application/json" hidden>⬆ Open a .json save…</label>
        <button class="btn" id="svMerge" title="Join two saved towns into one">🔗 Merge villages…</button>
      </div>
      <div class="tabs">${tabs.map(([k, n]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${n}</button>`).join('')}</div><div id="saveBody"></div>`, (c) => {
      for (const b of c.querySelectorAll('[data-tab]')) b.onclick = () => this.showSaves(b.dataset.tab);
      const dl = c.querySelector('#svDownload');
      if (dl) dl.onclick = () => g.downloadSave();
      c.querySelector('#svMerge').onclick = () => this.showMerge();
      c.querySelector('#svUpload').onchange = async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        try { g.loadData(await readJSONFile(f)); this.closeModal(); this.toast(`Loaded ${f.name}`, 'good', '📁'); } catch (err) { this.toast(err.message, 'bad'); }
      };
      const body = c.querySelector('#saveBody');
      if (tab === 'local') this._localTab(body, inGame);
      else this._fileTab(body, inGame);
    });
  }

  _localTab(body, inGame) {
    const g = this.game;
    const list = LocalSaves.list();
    let h = '';
    if (inGame) h += `<div class="actions" style="margin:0 0 12px"><button class="btn primary" id="lsNew">💾 Save as new slot</button></div>`;
    if (!list.length) h += `<div class="empty">No saves in this browser yet.</div>`;
    h += `<div class="saves">${list.map(e => `<div class="save">
      ${e.thumb ? `<img src="${e.thumb}" alt="">` : '<div class="ph">🏡</div>'}
      <div><div class="t">${esc(e.name)} ${e.id === 'autosave' ? '<span class="chip">Autosave</span>' : e.id === 'previous' ? '<span class="chip">Previous town</span>' : ''}</div>
      <div class="m">Day ${e.day} · ${fmt(e.pop)} villagers · $${typeof e.money === "number" ? fmt(e.money) : e.money}</div><div class="m">${new Date(e.savedAt).toLocaleString()}</div></div>
      <div class="acts"><button class="btn small primary" data-load="${e.id}">Load</button>
      ${inGame && e.id !== 'autosave' && e.id !== 'previous' ? `<button class="btn small" data-over="${e.id}">Overwrite</button>` : ''}
      <button class="btn small" data-dl="${e.id}" title="Download as .json">⬇</button>
      <button class="btn small danger" data-del="${e.id}">✕</button></div></div>`).join('')}</div>`;
    body.innerHTML = h;
    const nb = body.querySelector('#lsNew');
    if (nb) nb.onclick = () => { if (g.saveLocal('s' + Date.now().toString(36))) this.showSaves('local'); };
    for (const b of body.querySelectorAll('[data-load]')) b.onclick = () => { try { g.loadData(LocalSaves.load(b.dataset.load)); this.closeModal(); } catch (e) { this.toast(e.message, 'bad'); } };
    for (const b of body.querySelectorAll('[data-over]')) b.onclick = () => { if (g.saveLocal(b.dataset.over)) this.showSaves('local'); };
    for (const b of body.querySelectorAll('[data-dl]')) b.onclick = () => {
      try { const data = LocalSaves.load(b.dataset.dl); downloadJSON(data, saveFileNameFor(data)); } catch (e) { this.toast(e.message, 'bad'); }
    };
    for (const b of body.querySelectorAll('[data-del]')) b.onclick = () => {
      if (b.dataset.confirm) { LocalSaves.remove(b.dataset.del); this.showSaves('local'); }
      else { b.dataset.confirm = '1'; b.textContent = 'Delete?'; }
    };
  }

  _fileTab(body, inGame) {
    const g = this.game;
    body.innerHTML = `<div class="note">Export your village as a <code>.json</code> file to back it up or move it to another computer.</div>
      <div class="actions">${inGame ? '<button class="btn primary" id="fExport">⬇ Export save file</button>' : ''}
      <label class="btn"><input type="file" id="fImport" accept=".json,application/json" hidden>⬆ Import save file</label></div>`;
    const ex = body.querySelector('#fExport');
    if (ex) ex.onclick = () => downloadJSON(serialize(g.world), saveFileName(g.world));
    body.querySelector('#fImport').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try { g.loadData(await readJSONFile(f)); this.closeModal(); this.toast('Save imported', 'good', '📁'); } catch (err) { this.toast(err.message, 'bad'); }
    };
  }

  // -------------------------------------------------------------- budget
  showBudget() {
    const g = this.game, w = this.world, sim = g.sim;
    const b = sim.budget;
    const row = (k, v) => `<tr><td>${k}</td><td>${signed(v)}</td></tr>`;
    this.openModal(`<h2>Budget & statistics</h2><p class="lead">${esc(w.townName)} · ${titleFor(w.population).name} · day ${w.day}</p>
      <div class="field"><label>Tax rate: <b id="taxV">${w.taxRate}%</b> — higher taxes earn more but make villagers grumpy</label>
      <input type="range" id="tax" min="0" max="20" step="1" value="${w.taxRate}"></div>
      <div class="grid2">
        <div><h5 style="margin:6px 0">Income / day</h5><table class="budget" id="bIn"></table></div>
        <div><h5 style="margin:6px 0">Expenses / day</h5><table class="budget" id="bOut"></table></div>
      </div>
      <div class="note" style="margin-top:12px">Shop visits, fares and deliveries pay out live as villagers go about their day:
        <b>$${fmt(w.stats.todayVisitIncome)}</b> so far today, ${fmt(w.stats.visitIncome)} all time.</div>
      <div class="grid2" style="margin-top:12px">
        <div><h5 style="margin:6px 0">Population</h5><canvas class="chart" id="chPop" width="600" height="220"></canvas></div>
        <div><h5 style="margin:6px 0">Treasury</h5><canvas class="chart" id="chMoney" width="600" height="220"></canvas></div>
      </div>
      <div class="grid2" style="margin-top:8px;font-size:13px">
        <div class="row"><span>Arrived / left</span><b>${fmt(w.stats.arrivals)} / ${fmt(w.stats.departures)}</b></div>
        <div class="row"><span>Next title</span><b>${nextTitle(w.population)}</b></div>
      </div>`, (c) => {
      const fill = () => {
        const bb = sim.budget;
        c.querySelector('#bIn').innerHTML = row('🏠 Taxes', bb.income.taxes) + row('🛍️ Commerce', bb.income.commerce) + row('⚒️ Industry', bb.income.industry) + `<tr class="tot"><td>Total</td><td>${signed(bb.totalIn)}</td></tr>`;
        c.querySelector('#bOut').innerHTML = row('⛲ Services & transit stops', -bb.expense.services) + row('🏗️ Building upkeep', -bb.expense.buildings) + row('🛤️ Roads & track', -bb.expense.roads) + row('🚂 Transit vehicles', -bb.expense.transit) + `<tr class="tot"><td>Net</td><td style="color:${bb.net >= 0 ? 'var(--moss-d)' : 'var(--brick)'}">${signed(bb.net)}</td></tr>`;
      };
      fill();
      const tax = c.querySelector('#tax');
      tax.oninput = () => {
        const rate = Number(tax.value);
        c.querySelector('#taxV').textContent = `${rate}%`;
        g.cmd({ t: 'tax', rate }, () => { if (g.sim.dirty) g.sim.recompute(); if (c.isConnected) fill(); });
      };
      const hist = w.history.concat([{ day: w.day, pop: w.population, money: Math.round(w.money) }]);
      drawChart(c.querySelector('#chPop'), hist.map(h => h.pop), '#5f8f4e');
      drawChart(c.querySelector("#chMoney"), hist.map(h => (Number.isFinite(h.money) ? h.money : 0)), "#d9a23b");
    });
    void b;
  }

  // --------------------------------------------------------------- lines
  showLines() {
    const g = this.game, w = this.world;
    const lines = w.lines;
    const gLock = gondolaLock(w);
    let h = `<h2>Transit lines</h2><p class="lead">Coaches loop between coach stops on the roads. Trains never reverse, so a rail line needs a loop of track passing every station; a loop can run up to three trains. Gondola cabins run on a cable straight from station to station and back, over roofs, streets and the river; a line takes up to ${TRANSIT.gondola.maxVehicles} cabins, and lines meet at an interchange. Villagers take whatever gets them there soonest, walking or riding, a hill to climb counted, changing lines if that's quicker, and pay a fare for each ride.</p>`;
    h += `<div class="actions" style="margin:0 0 12px"><button class="btn primary" id="nlCoach">🐴 New coach line</button><button class="btn primary" id="nlRail" ${w.unlockPop < 25 ? 'disabled title="Unlocks at 25 villagers"' : ''}>🚂 New rail line</button><button class="btn primary" id="nlGondola" ${gLock ? `disabled title="${typeof gLock === 'number' ? `Unlocks at ${gLock} villagers` : `Research ${TECHS.cablecars.name} first`}"` : ''}>🚡 New gondola line</button></div>`;
    if (!lines.length) h += `<div class="empty">No lines yet. Build at least two coach stops (Transit menu), then create a line.</div>`;
    h += `<div class="lines-list">${lines.map(l => {
      const st = g.transit.stats[l.id] || { riders: 0, fares: 0 };
      const cfg = TRANSIT[l.mode];
      // (a gondola's climb, in storeys; the time a trip on it saves, in game
      // minutes: a tile of walking takes about CONFIG.DAY_SECONDS / 24 / 60
      // of a game minute's real seconds)
      const climb = l.mode === 'gondola' ? g.transit.climbOf(l) : 0;
      const mins = st.trips ? (st.saved / st.trips / CONFIG.WALK_SPEED) * (24 * 60 / CONFIG.DAY_SECONDS) : 0;
      const more = [climb >= 0.3 ? `climbs about ${Math.round(climb / 0.3)} storeys` : '', st.trips ? `${fmt(st.trips)} trips, each about ${Math.round(mins)} min quicker than walking` : '', st.changes ? `${fmt(st.changes)} changing lines` : ''].filter(Boolean).join(' · ');
      return `<div class="line-item"><span class="dot" style="background:${l.color}"></span>
        <div><b>${esc(l.name)}</b> ${l.broken ? `<span class="chip no"${l.blocked ? ` title="${esc(l.blocked)}"` : ''}>${l.blocked ? 'Cable blocked' : 'Route broken'}</span>` : ''}${l.blocked ? `<div class="m" style="font-size:12px;color:var(--brick)">${esc(l.blocked)}</div>` : ''}<div class="m" style="font-size:12px;color:var(--ink-2);font-weight:700">${l.stops.length} stops · ${l.vehicles} ${l.vehicles > 1 ? cfg.vehicles : cfg.vehicle} ·${fmt(st.riders)} riders · $${fmt(st.fares)} fares · upkeep ${cfg.upkeep * l.vehicles}/day</div>${more ? `<div class="m" style="font-size:12px;color:var(--ink-2)">${more}</div>` : ''}</div>
        <div class="inline"><button class="btn small" data-veh="${l.id}" data-d="-1">−</button><button class="btn small" data-veh="${l.id}" data-d="1" title="Add a vehicle ($${cfg.vehicleCost})">+</button><button class="btn small danger" data-ldel="${l.id}">✕</button></div></div>`;
    }).join('')}</div>`;
    this.openModal(h, (c) => {
      c.querySelector('#nlCoach').onclick = () => { this.closeModal(); this.openFlyout('transit'); g.input.setTool({ kind: 'line', mode: 'coach', stops: [] }); };
      c.querySelector('#nlRail').onclick = () => { this.closeModal(); this.openFlyout('transit'); g.input.setTool({ kind: 'line', mode: 'rail', stops: [] }); };
      c.querySelector('#nlGondola').onclick = () => { this.closeModal(); this.openFlyout('transit'); g.input.setTool({ kind: 'line', mode: 'gondola', stops: [] }); };
      for (const b of c.querySelectorAll('[data-veh]')) b.onclick = () => {
        const l = w.lines.find(x => x.id === Number(b.dataset.veh));
        if (!l) return;
        g.cmd({ t: 'vehicles', id: l.id, n: Math.max(0, l.vehicles + Number(b.dataset.d)) }, (r) => {
          if (r.reason) this.toast(r.reason, 'bad');
          this.showLines();
        });
      };
      for (const b of c.querySelectorAll('[data-ldel]')) b.onclick = () => {
        if (!b.dataset.confirm) { b.dataset.confirm = '1'; b.textContent = 'Delete?'; return; }
        g.cmd({ t: 'unline', id: Number(b.dataset.ldel) }, () => this.showLines());
      };
    });
  }

  // ------------------------------------------------------- settings/help
  // Settings, in group boxes: how the town looks, how hard the computer
  // works, sound, pop-ups, the game, and this town's sandbox switches . Every change applies as it's made.
  showSettings() {
    const g = this.game;
    const s = g.settings;
    const town = g.world && !g.demo, guest = !!g.isGuest, sb = town ? g.world.sandbox : {};
    const display = group('Display', `
      ${check('stPix', s.pixelArt, 'Pixel-art look', 'Drawn small with outlines, then scaled up crisply')}
      ${seg('stPixSize', 'Pixel size', [[1, '1×', 'Finest'], [2, '2×', 'Classic'], [3, '3×', 'Chunky'], [4, '4×', 'Retro']], s.pixelSize || 2)}
      ${check('stAO', s.ao, 'Soft contact shadows', 'Ambient occlusion: shade where walls meet the ground')}
      ${seg('stTilt', 'Tilt-shift', [['off', 'Off'], ['subtle', 'Subtle'], ['strong', 'Strong']], s.tiltShift || 'off')}
      ${seg('stTiltBand', 'Sharp band', [['narrow', 'Narrow'], ['normal', 'Normal'], ['wide', 'Wide']], s.tiltBand || 'normal')}
      <p class="set-hint">Tilt-shift makes the town look like a tabletop model: the middle of the screen stays sharp and the view softens toward every edge.</p>
      ${check('stDay', s.alwaysDay, 'Always daytime', "The clock and the villagers' days run on, but the light never goes down")}`);
    const camera = group('Camera', `
      ${seg('stCam', 'Projection', [['iso', 'Isometric', 'Flat, the classic look: far things as big as near ones'], ['perspective', 'Perspective', 'Like a real camera: far things smaller']], s.camera || 'iso')}
      ${seg('stFov', 'Field of view', [[30, '30°', 'Narrow, nearly flat'], [45, '45°', 'Normal'], [60, '60°', 'Wide, more depth']], s.fov || 45)}
      <p class="set-hint">Turn and tilt the view freely with a middle-drag, Shift + right-drag, Shift + W A S D, or two fingers (twist to turn, drag up or down together to tilt). Home or the compass button goes back to the classic isometric view.</p>`);
    const sound = group('Sound', `
      ${check('stSound', s.sound, 'Sound effects')}
      ${check('stMusic', s.music !== false, 'Music')}
      <div class="set-row"><span class="set-label">Music volume</span><input type="range" id="stMusicVol" min="0" max="1" step="0.05" value="${s.musicVol ?? 0.5}"></div>`);
    const pops = group('Pop-ups', `
      ${check('stCoins', s.popCoins, 'Coins over buildings as they earn')}
      ${check('stToasts', s.popToasts, 'Notices')}
      ${check('stTips', s.popTips, 'Tips when hovering')}
      ${check('stLabels', s.popLabels, 'Name tag over the selected villager')}
      ${check('stBlocked', s.popBlocked !== false, 'Warnings over buildings', 'With no power, water or workers')}`);
    const game = group('Game', check('stAuto', s.autosave, 'Autosave every in-game day'));
    const sandbox = town ? group('Sandbox · this town only', `
      ${guest ? '<p class="set-hint">Only the host can change these.</p>' : ''}
      ${check('stInf', sb.infiniteMoney, 'Unlimited money', '', guest)}
      ${check('stAll', sb.unlockAll, 'Every building unlocked', '', guest)}
      ${check('stFree', sb.freeUpgrades, 'Upgrades without their needs', '', guest)}
      ${check('stInst', sb.instantBuild, 'Instant building', 'No builders needed', guest)}`) : '';
    this.openModal(`<h2>Settings</h2>
      <p class="lead">Changes apply as you make them.</p>
      <div class="set-cols"><div>${display}${perfHTML(s)}</div><div>${camera}${sound}${pops}${game}${sandbox}</div></div>
      <div class="actions set-actions"><button class="btn" id="stMenu">Quit to title</button><span style="flex:1"></span><button class="btn primary" id="stOk">Close</button></div>`, (c) => {
      c.classList.add('settings-win');
      bindSegs(c);
      bindPerf(c);
      const val = (id) => c.querySelector(`#${id}`);
      const syncDisplay = () => {
        for (const b of val('stPixSize').querySelectorAll('button')) b.disabled = !val('stPix').checked;
        for (const b of val('stTiltBand').querySelectorAll('button')) b.disabled = segValue(c, 'stTilt') === 'off';
        for (const b of val('stFov').querySelectorAll('button')) b.disabled = segValue(c, 'stCam') !== 'perspective';
      };
      syncDisplay();
      const apply = (e) => {
        readPerf(c, s);
        s.pixelArt = val('stPix').checked;
        s.pixelSize = Number(segValue(c, 'stPixSize'));
        s.ao = val('stAO').checked;
        s.alwaysDay = val('stDay').checked;
        s.tiltShift = segValue(c, 'stTilt');
        s.tiltBand = segValue(c, 'stTiltBand');
        s.camera = segValue(c, 'stCam');
        s.fov = Number(segValue(c, 'stFov'));
        s.sound = val('stSound').checked;
        s.music = val('stMusic').checked;
        s.musicVol = Number(val('stMusicVol').value);
        s.popCoins = val('stCoins').checked;
        s.popToasts = val('stToasts').checked;
        s.popTips = val('stTips').checked;
        s.popLabels = val('stLabels').checked;
        s.popBlocked = val('stBlocked').checked;
        s.autosave = val('stAuto').checked;
        syncDisplay();
        g.music.apply();
        this.syncMusicButton();
        this.syncPopButton();
        g.applySettings();
        // this town's sandbox switches go through the host
        if (town && !guest && e && /^st(Inf|All|Free|Inst)$/.test(e.target.id)) {
          const opts = { infiniteMoney: val('stInf').checked, unlockAll: val('stAll').checked, freeUpgrades: val('stFree').checked, instantBuild: val('stInst').checked };
          if (Object.entries(opts).some(([k, v]) => !!g.world.sandbox[k] !== v)) g.cmd({ t: 'sandbox', opts }, (r) => { if (r.ok) this.refreshAfterSandbox(); });
        }
      };
      c.addEventListener('change', apply);
      val('stMusicVol').addEventListener('input', apply);
      val('stOk').onclick = () => this.closeModal();
      val('stMenu').onclick = () => { this.closeModal(); g.toTitle(); };
    });
  }

  // Unlocks and limits may have changed: redraw what shows them.
  refreshAfterSandbox() {
    if (this.category) this.openFlyout(this.category);
    if (this.selection) this.renderInspector(true);
  }

  // ---------------------------------------------------------- multiplayer
  showMultiplayer(opts) { showMultiplayer(this.game, opts); }
  renderNetBox() { renderNetBox(this.game); }

  // What each research project unlocks, worked out from the definitions.
  // What a project unlocks: [{ text, img }] (img is a thumbnail, if any).
  _techUnlocks(id) {
    const out = [], seen = new Set();
    const add = (text, img = null) => { if (!seen.has(text)) { seen.add(text); out.push({ text, img }); } };
    if (CAPABILITIES[id]) add(CAPABILITIES[id]);
    for (const [type, def] of Object.entries(BUILDINGS)) {
      def.levels.forEach((L, i) => {
        if (techForLevel(type, i) !== id) return;
        if (i === 0) {
          const m = MERGES.find(m => m.to === type);
          add(m ? `${L.name} — join ${BUILDINGS[m.a[0]].levels[0].name.toLowerCase()} + ${BUILDINGS[m.b[0]].levels[0].name.toLowerCase()}` : def.hidden && def.branch ? `${L.name} (new path)` : `${L.name} (${def.name})`, thumb(type, 0));
        } else add(`${L.name} (upgrade)`, thumb(type, i));
      });
    }
    for (const [style, t] of Object.entries(STYLE_TECH)) if (t === id) add(`${STYLES.find(s => s.id === style).name} style`, thumb('house', 1, 4242, null, style));
    if (id === 'railways') add('Railway track and lines');
    if (id === 'cablecars') add('Gondola lines');
    // Great Plots opens every 2×2 estate building, whatever else it needs
    if (id === 'bigplots') for (const type of ESTATE_TYPES) add(`${BUILDINGS[type].levels[0].name} (new path)`, thumb(type, 0));
    return out;
  }

  showResearch() {
    const g = this.game, w = this.world;
    if (!w || g.demo) return;
    const R = w.research, rate = g.sim.researchRate();
    const all = w.sandbox.unlockAll;
    const state = (id) => (all || R.done.includes(id) ? 'done' : R.current === id ? 'cur' : w.canResearch(id) ? 'can' : 'locked');
    const tiers = Math.max(...Object.values(TECHS).map(t => t.tier)) + 1;
    const rows = BRANCHES.filter(([b]) => Object.values(TECHS).some(t => t.branch === b));
    if (!this._techSel || !TECHS[this._techSel]) this._techSel = R.current || Object.keys(TECHS).find(id => state(id) === 'can') || 'carpentry';
    const HUES = ['#8a6a3a', '#6a3f8a', '#7a7468', '#9a4a32', '#b0708a', '#a0522d', '#7a2a5a', '#5a4a3a', '#5a7a2a', '#2f6a8a', '#b08a1a', '#8a2f2f', '#2f5a8a', '#3a3a3a'];
    const hue = (b) => HUES[rows.findIndex(r => r[0] === b) % HUES.length];
    // only same-branch links are drawn; anything else a project needs shows as a tag
    const node = (id) => {
      const t = TECHS[id], s = state(id);
      const tail = s === 'done' ? '✓ done' : s === 'cur' ? `${Math.floor(R.progress)}/${t.cost}` : s === 'can' ? (R.bank >= t.cost ? `🔬 ${t.cost} · now` : `🔬 ${t.cost}`) : `🔒 ${t.cost}`;
      const cross = t.needs.filter(n => TECHS[n].branch !== t.branch).map(n => `<em class="${R.done.includes(n) || all ? 'ok' : ''}">+ ${esc(TECHS[n].name)}</em>`).join('');
      return `<div class="tnode ${s} ${this._techSel === id ? 'sel' : ''}" data-node="${id}" style="--hue:${hue(t.branch)};grid-row:${rows.findIndex(r => r[0] === t.branch) + 1};grid-column:${t.tier + 2}"><b>${esc(t.name)}</b><span>${tail}</span>${cross ? `<div class="tx">${cross}</div>` : ''}${s === 'cur' ? `<i style="width:${Math.round((R.progress / t.cost) * 100)}%"></i>` : ''}</div>`;
    };
    const sel = TECHS[this._techSel], ss = state(this._techSel);
    const days = rate > 0 ? Math.max(1, Math.ceil((sel.cost - (ss === 'cur' ? R.progress : 0) - (ss === 'cur' ? 0 : R.bank)) / rate)) : null;
    let detail = `<div class="tdetail"><div><b>${esc(sel.name)}</b> <span class="tcost">${sel.cost} points</span><div class="tdesc">${esc(sel.desc)}</div>`;
    if (sel.needs.length) detail += `<div class="tneeds">Needs: ${sel.needs.map(n => `<span class="${R.done.includes(n) || all ? 'ok' : 'no'}">${esc(TECHS[n].name)}</span>`).join(' + ')}</div>`;
    const un = this._techUnlocks(this._techSel);
    detail += `</div><div class="tunlocks">${un.map(u => `<div class="tu">${u.img ? `<img src="${u.img}" alt="">` : '<div class="tu-ph"><span class="ms">auto_awesome</span></div>'}<span>${esc(u.text)}</span></div>`).join('') || '<div class="tsub">—</div>'}</div><div class="tact">`;
    if (ss === 'done') detail += '<div class="tdone">✓ Researched</div>';
    else if (ss === 'cur') detail += `<div class="meter build"><i style="width:${Math.round((R.progress / sel.cost) * 100)}%"></i></div><div class="tsub">${R.progress}/${sel.cost} · ${days ? `about ${days} day${days === 1 ? '' : 's'}` : 'no research yet'}</div>`;
    else if (ss === 'can') detail += `<button class="btn primary" data-tech="${this._techSel}">🔬 Research · ${sel.cost} points${R.bank >= sel.cost ? ' · done now with banked points' : days ? ` · ~${days} day${days === 1 ? '' : 's'}${R.bank ? ` (${Math.floor(R.bank)} banked go in first)` : ''}` : ''}</button>`;
    else detail += '<div class="tsub">Research the projects it needs first.</div>';
    detail += '</div></div>';
    this.openModal(`<h2>Research</h2><div id="resHead">${this._researchHead()}</div>
      <div class="ttree-wrap"><div class="ttree" style="grid-template-columns: 104px repeat(${tiers}, 136px); grid-template-rows: repeat(${rows.length}, minmax(44px, auto))">
        <svg class="tlinks"></svg>
        ${rows.map(([b, name], i) => `<div class="tbranch" style="--hue:${hue(b)};grid-row:${i + 1};grid-column:1">${esc(name)}</div>`).join('')}
        ${Object.keys(TECHS).map(node).join('')}
      </div></div>${detail}`, (c) => {
      c.classList.add('wide');
      const tree = c.querySelector('.ttree'), svg = c.querySelector('.tlinks');
      const draw = () => {
        const box = tree.getBoundingClientRect();
        svg.setAttribute('width', tree.scrollWidth); svg.setAttribute('height', tree.scrollHeight);
        const at = (id) => { const r = tree.querySelector(`[data-node="${id}"]`).getBoundingClientRect(); return { l: r.left - box.left, r: r.right - box.left, y: r.top - box.top + r.height / 2 }; };
        let p = '';
        for (const [id, t] of Object.entries(TECHS)) for (const n of t.needs) {
          if (TECHS[n].branch !== t.branch) continue;
          const a = at(n), b = at(id), s = state(id);
          const col = s === 'done' ? '#2c7a2c' : s === 'can' || s === 'cur' ? '#000080' : '#9a9a9a';
          const mx = (a.r + b.l) / 2;
          p += `<path d="M${a.r} ${a.y} C${mx} ${a.y} ${mx} ${b.y} ${b.l} ${b.y}" stroke="${col}" stroke-width="2" fill="none" ${s === 'locked' ? 'stroke-dasharray="4 3"' : ''}/>`;
        }
        svg.innerHTML = p;
      };
      requestAnimationFrame(draw);
      for (const el of c.querySelectorAll('[data-node]')) el.onclick = () => { this._techSel = el.dataset.node; this.showResearch(); };
      for (const btn of c.querySelectorAll('[data-tech]')) btn.onclick = () => g.cmd({ t: 'research', id: btn.dataset.tech }, (r) => {
        if (r.ok) { g.sfx('click'); if (c.isConnected) this.showResearch(); } else if (r.reason) this.toast(r.reason, 'bad');
      });
    });
  }

  // ------------------------------------------------------------ research
  // Research points at a glance: what's banked, what comes in each day and
  // from where, and how the current project is going.
  _researchHead() {
    const w = this.world, R = w.research, sim = this.game.sim;
    if (w.sandbox.unlockAll) return '<div class="rhead"><div class="rcell wide"><span class="ms">lock_open</span><div><b>Sandbox: everything is unlocked</b></div></div></div>';
    const src = sim.researchSources(), rate = src.reduce((n, s) => n + s.points, 0);
    const cur = R.current && TECHS[R.current];
    let h = '<div class="rhead">';
    h += `<div class="rcell"><span class="ms">savings</span><div><b>${fmt(Math.floor(R.bank))}</b><small>points banked</small></div></div>`;
    h += `<div class="rcell"><span class="ms">trending_up</span><div><b>+${rate}</b><small>points a day</small></div></div>`;
    if (cur) {
      const pct = Math.min(100, Math.round((R.progress / cur.cost) * 100)), left = cur.cost - Math.floor(R.progress);
      const days = rate > 0 ? Math.max(1, Math.ceil(left / rate)) : null;
      h += `<div class="rcell wide"><span class="ms">science</span><div><b>${esc(cur.name)} · ${Math.floor(R.progress)} / ${cur.cost}</b><div class="meter build"><i style="width:${pct}%"></i></div><small>${days ? `${left} to go · about ${days} day${days === 1 ? '' : 's'}` : 'no points coming in: build a town hall or a school'}</small></div></div>`;
    } else {
      h += `<div class="rcell wide warn"><span class="ms">pending</span><div><b>Nothing being researched</b><small>${R.bank ? 'points are banking up: pick a project and they go straight in' : 'pick a project below'}</small></div></div>`;
    }
    h += '</div>';
    h += `<div class="rsrc">Each day: ${src.length ? src.map(s => `${esc(s.name)}${s.n > 1 ? ` ×${s.n}` : ''} <b>+${s.points}</b>`).join(' · ') : 'nothing yet'}. Town halls, schools, colleges and chapels add more as they're upgraded; villagers add 1 for every 60.</div>`;
    return h;
  }

  // The research readout in the top bar, and the open research window's header.
  _researchHUD() {
    const w = this.world, R = w.research, sim = this.game.sim;
    const rate = sim.researchRate(), cur = R.current && TECHS[R.current];
    const pts = $('resPts'), sub = $('resRate'), box = $('resStat');
    if (w.sandbox.unlockAll) {
      pts.textContent = 'all'; sub.textContent = 'unlocked'; sub.className = '';
      box.title = 'Sandbox: everything is unlocked';
    } else if (cur) {
      pts.textContent = `${Math.floor(R.progress)}/${cur.cost}`;
      sub.textContent = `+${rate}/day · ${cur.name}`;
      sub.className = '';
      box.title = `Researching ${cur.name}: ${Math.floor(R.progress)} of ${cur.cost} points, +${rate} a day${R.bank ? `, ${Math.floor(R.bank)} banked` : ''}. Click for the research tree.`;
    } else {
      pts.textContent = `${fmt(Math.floor(R.bank))} pts`;
      sub.textContent = `+${rate}/day · ${R.bank ? 'pick a project' : 'nothing chosen'}`;
      sub.className = R.bank ? 'neg' : '';
      box.title = `${Math.floor(R.bank)} research points banked, +${rate} a day. Nothing is being researched: click to pick a project.`;
    }
    const head = document.getElementById('resHead');
    if (head) {
      const key = `${Math.floor(R.bank)}|${Math.floor(R.progress)}|${R.current}|${rate}`;
      if (head.dataset.k !== key) {
        head.dataset.k = key;
        head.innerHTML = this._researchHead();
        const node = cur && head.closest('.win')?.querySelector(`.tnode[data-node="${R.current}"]`);
        if (node) {
          node.querySelector('span').textContent = `${Math.floor(R.progress)}/${cur.cost}`;
          const bar = node.querySelector('i');
          if (bar) bar.style.width = `${Math.round((R.progress / cur.cost) * 100)}%`;
        }
      }
    }
  }

  // ----------------------------------------------------------- happiness
  // What a home's happiness is made of: the gaps first, each with what to do.
  _happyTable(f) {
    const parts = (f && f.parts) || [];
    const rows = parts.map(([k, v, max]) => ({ k, v, gap: Math.max(0, max - v), info: HAPPY[k] })).filter(r => r.info);
    rows.sort((a, b) => b.gap - a.gap || b.v - a.v);
    const tip = (r) => (typeof r.info.tip === 'function' ? r.info.tip(f, this.game) : r.info.tip);
    let html = '<table class="hap">';
    for (const r of rows) {
      const missing = r.gap > 0.4;
      if (!missing && r.v === 0 && r.k !== 'base') continue;
      const val = r.v > 0 ? `+${Math.round(r.v)}` : r.v < 0 ? `−${Math.round(-r.v)}` : '0';
      const of = missing && r.v >= 0 && r.k !== 'tax' ? ` <em>of ${Math.round(r.v + r.gap)}</em>` : '';
      html += `<tr class="${missing ? (r.v < 0 ? 'bad' : 'miss') : 'ok'}"><td><span class="ms">${r.info.icon}</span>${esc(r.info.label)}</td><td class="pts">${val}${of}</td></tr>`;
      if (missing && tip(r)) html += `<tr class="tip"><td colspan="2">${esc(tip(r))}</td></tr>`;
    }
    return html + '</table>';
  }

  // The whole town's happiness: what pulls it down most, and where.
  showHappiness() {
    const g = this.game, w = this.world, sim = g.sim;
    if (!w || g.demo) return;
    const homes = [...w.buildings.values()].filter(b => b.factors && b.residents.length);
    const people = homes.reduce((n, b) => n + b.residents.length, 0) || 1;
    const agg = {};
    for (const b of homes) for (const [k, v, max] of b.factors.parts || []) {
      const a = agg[k] || (agg[k] = { v: 0, lost: 0, homes: [] });
      const lost = Math.max(0, max - v);
      a.v += v * b.residents.length;
      a.lost += lost * b.residents.length;
      if (lost > 0.4) a.homes.push(b.id);
    }
    const rows = Object.entries(agg).filter(([k]) => HAPPY[k]).map(([k, a]) => ({ k, avg: a.v / people, lost: a.lost / people, homes: a.homes, info: HAPPY[k] })).sort((a, b) => b.lost - a.lost);
    const bands = [[75, 101, 'Very happy'], [55, 75, 'Content'], [40, 55, 'Unsettled'], [0, 40, 'Unhappy — may leave']];
    const dist = bands.map(([lo, hi, name]) => `<span class="chip ${lo >= 55 ? 'ok' : lo >= 40 ? '' : 'no'}">${name}: ${homes.filter(b => b.happiness >= lo && b.happiness < hi).length} homes</span>`).join('');
    const avg = Math.round(sim.happiness);
    let table = '<table class="hap big"><tr><th>What matters</th><th>Average now</th><th>Could gain</th><th>Homes missing out</th><th></th></tr>';
    rows.forEach((r, i) => {
      const val = Math.abs(r.avg) < 0.05 ? '0' : r.avg > 0 ? `+${r.avg.toFixed(1)}` : `−${(-r.avg).toFixed(1)}`;
      const tip = r.lost > 0.2 ? (typeof r.info.tip === 'function' ? r.info.tip({}, g) : r.info.tip) : '';
      const act = r.lost > 0.2 && r.info.act ? `<button class="btn small" data-hap="${i}">${esc(r.info.act.label)}</button>` : '';
      table += `<tr class="${r.lost > 2 ? 'miss' : 'ok'}"><td><span class="ms">${r.info.icon}</span>${esc(r.info.label)}<div class="sub">${esc(tip)}</div></td><td class="pts">${val}</td><td class="pts">${r.lost > 0.05 ? '+' + r.lost.toFixed(1) : '—'}</td><td class="pts">${r.homes.length || '—'}</td><td>${act}</td></tr>`;
    });
    table += '</table>';
    this.openModal(`<h2>Happiness</h2><p class="lead">The town is <b>${avg}%</b> happy on average (each home counts by how many live there). <i>Could gain</i> is how many points the average villager would add if that need were fully met. A villager's mood is their home's happiness, plus 4 with a job or minus 8 while looking for work.</p><div class="chips" style="margin-bottom:8px">${dist}</div>${table}`, (c) => {
      c.classList.add('wide');
      for (const btn of c.querySelectorAll('[data-hap]')) btn.onclick = () => {
        const r = rows[Number(btn.dataset.hap)], a = r.info.act;
        if (a.cat) this.openFlyout(a.cat);
        else if (a.budget) this.showBudget();
        else if (r.homes.length) {
          this._hapCycle = ((this._hapCycle ?? -1) + 1) % r.homes.length;
          const b = w.buildings.get(r.homes[this._hapCycle]);
          if (b) { this.inspect({ kind: 'building', id: b.id }); g.renderer.lookAt(b.x, b.z); }
        }
      };
    });
  }

  // ------------------------------------------------------------- issues
  toggleIssues() {
    const s = this.game.settings;
    s.issuesOpen = !(s.issuesOpen ?? true);
    this.game.applySettings();
    this.renderIssues();
  }

  renderIssues() {
    const g = this.game, el = $('issues');
    if (!el) return;
    if (!g.world || g.demo) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const list = computeIssues(g);
    const open = g.settings.issuesOpen ?? true;
    el.classList.toggle('collapsed', !open);
    $('issueCount').textContent = list.length;
    $('issueCount').className = list.some(i => i.sev === 'bad') ? 'bad' : list.length ? 'warn' : 'ok';
    $('issueCaret').textContent = open ? 'expand_more' : 'expand_less';
    const key = JSON.stringify(list.map(i => i.text)) + open;
    if (key === this._issuesKey) return;
    this._issuesKey = key;
    this._issues = list;
    $('issueList').innerHTML = !open ? '' : list.length
      ? list.map((i, k) => `<div class="issue ${i.sev}" data-k="${k}" title="${i.act ? 'Click to show' : ''}"><span class="ms">${i.icon}</span><span>${esc(i.text)}</span>${i.act ? '<span class="ms go">chevron_right</span>' : ''}</div>`).join('')
      : '<div class="issue ok"><span class="ms">check_circle</span><span>No problems right now</span></div>';
    for (const row of $('issueList').querySelectorAll('[data-k]')) row.onclick = () => this._issueAct(this._issues[Number(row.dataset.k)]);
  }

  _issueAct(i) {
    const g = this.game, a = i && i.act;
    if (!a) return;
    if (a.kind === 'focus' && a.ids.length) {
      // each click moves on to the next building involved
      const n = this._issueCycle[i.text] = ((this._issueCycle[i.text] ?? -1) + 1) % a.ids.length;
      const b = this.world.buildings.get(a.ids[n]);
      if (b) { this.inspect({ kind: 'building', id: b.id }); g.renderer.lookAt(b.x, b.z); }
    } else if (a.kind === 'tool') this.openFlyout(a.cat);
    else if (a.kind === 'people') { this._ppl = { q: '', f: a.filter, k: 'name', dir: 1 }; this.showPeople(); }
    else if (a.kind === 'research') this.showResearch();
    else if (a.kind === 'budget') this.showBudget();
  }

  // One switch for every pop-up (coins, notices, hover tips, name tags,
  // warnings over blocked buildings).
  // Hide every panel, button and pop-up to see just the town (for a
  // picture, or to take it in). The camera and the game speed still answer
  // to the keys; clicks on the town do nothing until it comes back (V, Esc
  // or the button in the corner).
  setUIHidden(on) {
    const g = this.game;
    on = !!on && !!g.world && !g.demo;
    if (on === !!this.uiHidden) return;
    this.uiHidden = on;
    document.body.classList.toggle('ui-hidden', on);
    if (on) {
      this.closeFlyout();
      g.input?.setTool({ kind: 'select' });
      this.inspect(null);
      this.tooltip(null);
    }
    g.input?.refresh();
  }

  togglePopups() {
    const s = this.game.settings;
    const any = s.popCoins || s.popToasts || s.popTips || s.popLabels || s.popBlocked !== false;
    s.popCoins = s.popToasts = s.popTips = s.popLabels = s.popBlocked = !any;
    this.game.applySettings();
    this.syncPopButton();
    if (!any) this.toast('Pop-ups on', 'info', '💡');
  }

  toggleMusic() {
    const g = this.game;
    g.settings.music = g.settings.music === false;
    g.applySettings();
    g.music.apply();
    this.syncMusicButton();
  }

  syncMusicButton() {
    const b = $('btnMusic');
    if (!b) return;
    const on = this.game.settings.music !== false;
    b.innerHTML = `<span class="ms">${on ? 'music_note' : 'music_off'}</span>`;
    b.classList.toggle('on', !on);
    b.title = `${on ? 'Turn off' : 'Turn on'} the music`;
  }

  syncPopButton() {
    const s = this.game.settings, b = $('btnPops');
    if (!b) return;
    const any = s.popCoins || s.popToasts || s.popTips || s.popLabels || s.popBlocked !== false;
    b.innerHTML = `<span class="ms">${any ? 'notifications' : 'notifications_off'}</span>`;
    b.classList.toggle('on', !any);
    b.title = `${any ? 'Hide' : 'Show'} pop-ups: coins, notices, tips (N)`;
  }

  // Everyone in town: who they are, where they live and work, pay and savings.
  showPeople() {
    const g = this.game, w = this.world;
    if (!w || g.demo) return;
    const st = this._ppl ||= { q: '', f: '', k: 'name', dir: 1 };
    const name = (id) => { const b = id != null ? w.buildings.get(id) : null; return b ? BUILDINGS[b.type].levels[b.level].name : ''; };
    const AGE = { child: 0, adult: 1, elder: 2 };
    const rows = [...w.residents.values()].map(r => ({
      r, name: `${r.first} ${r.last}`, age: r.age, years: yearsOf(r), edu: eduOf(r), school: r.age === 'child' ? schoolingOf(w, r) : null, home: name(r.home), job: r.job != null ? name(r.job) : (r.age === 'adult' ? '' : r.age === 'child' ? 'Child' : 'Retired'),
      pay: salaryOf(w, r) + pensionOf(r), wealth: r.age === 'child' ? null : wealthOf(r), mood: Math.round(r.mood ?? 60), traits: traitsOf(r),
      builder: r.job != null && BUILDINGS[w.buildings.get(r.job)?.type]?.builders,
    }));
    const adults = rows.filter(x => x.age !== 'child');
    const sk = this.game.sim.schooling || { kids: 0, placed: 0 };
    const eduShare = adults.length ? Math.round(100 * adults.filter(x => x.edu >= 2).length / adults.length) : 0;
    const avgPay = adults.filter(x => x.pay > 0);
    const homes = [...w.buildings.values()].filter(b => b.residents && b.residents.length);
    const households = homes.reduce((n, b) => n + householdsIn(w, b), 0);
    const summary = `${fmt(rows.length)} villagers in ${fmt(households)} households · ${eduShare}% of grown-ups with secondary schooling · ${sk.placed}/${sk.kids} school-age children in school · ${rows.filter(x => x.r.age === 'adult' && x.r.job != null).length} employed · ${rows.filter(x => x.r.age === 'adult' && x.r.job == null).length} looking for work · average wage $${avgPay.length ? (avgPay.reduce((s, x) => s + x.pay, 0) / avgPay.length).toFixed(1) : 0} · savings $${fmt(adults.reduce((s, x) => s + (x.wealth || 0), 0))}`;
    const cols = [['name', 'Name'], ['years', 'Age'], ['edu', 'Education'], ['home', 'Home'], ['job', 'Job / school'], ['pay', 'Income'], ['wealth', 'Savings'], ['mood', 'Mood'], ['traits', 'Personality']];
    this.openModal(`<h2>Villagers</h2><p class="lead">${summary}</p>
      <div class="pplbar"><input id="pplQ" placeholder="Search names, homes, jobs or traits…" value="${esc(st.q)}">
        <select id="pplF">${[['', 'Everyone'], ['adult', 'Adults'], ['child', 'Children'], ['elder', 'Elders'], ['jobless', 'Looking for work'], ['noschool', 'No school place'], ['builders', 'Builders'], ['poor', 'In debt']].map(([v, l]) => `<option value="${v}" ${st.f === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <span id="pplN"></span></div>
      <div class="pplwrap"><table class="people"><thead><tr>${cols.map(([k, l]) => `<th data-k="${k}">${l}<span class="sort"></span></th>`).join('')}</tr></thead><tbody id="pplBody"></tbody></table></div>`, (c) => {
      c.classList.add('wide');
      const body = c.querySelector('#pplBody');
      const render = () => {
        const q = st.q.trim().toLowerCase();
        let list = rows.filter(x => {
          if (st.f === 'adult' || st.f === 'child' || st.f === 'elder') { if (x.age !== st.f) return false; }
          else if (st.f === 'jobless') { if (!(x.age === 'adult' && x.r.job == null)) return false; }
          else if (st.f === 'builders') { if (!x.builder) return false; }
          else if (st.f === 'noschool') { if (!(x.school && !x.school.ok)) return false; }
          else if (st.f === 'poor') { if (!(x.wealth != null && x.wealth < 0)) return false; }
          if (!q) return true;
          return [x.name, x.home, x.job, ...x.traits.map(t => TRAITS[t].name)].some(s => s.toLowerCase().includes(q));
        });
        const k = st.k;
        list.sort((a, b) => {
          const va = k === 'age' ? AGE[a.age] : k === 'job' && a.school ? a.school.text : k === 'traits' ? a.traits.map(t => TRAITS[t].name).join() : a[k] ?? -1e9;
          const vb = k === 'age' ? AGE[b.age] : k === 'job' && b.school ? b.school.text : k === 'traits' ? b.traits.map(t => TRAITS[t].name).join() : b[k] ?? -1e9;
          return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * st.dir || a.r.id - b.r.id;
        });
        const total = list.length;
        list = list.slice(0, 400);
        c.querySelector('#pplN').textContent = total > 400 ? `showing 400 of ${fmt(total)}` : `${fmt(total)} shown`;
        body.innerHTML = ico(list.map(x => `<tr data-id="${x.r.id}"><td>${minionIcon(x.r)} ${esc(x.name)}</td><td class="num">${Math.floor(x.years)}</td><td>${EDU[x.edu]}</td><td>${esc(x.home) || '—'}</td><td>${x.school ? (x.school.ok ? esc(x.school.text) : '<span class="bad">No school place</span>') : x.job ? esc(x.job) : '<span class="bad">Looking for work</span>'}</td>` +
          `<td class="num">${x.pay ? '$' + x.pay.toFixed(1) : '—'}</td><td class="num ${x.wealth != null && x.wealth < 0 ? 'bad' : ''}">${x.wealth == null ? '—' : (x.wealth < 0 ? '−$' : '$') + fmt(Math.abs(x.wealth))}</td><td class="num">${x.mood}%</td><td class="traits">${x.traits.map(t => TRAITS[t].name).join(', ')}</td></tr>`).join(''));
        for (const th of c.querySelectorAll('th')) th.querySelector('.sort').textContent = th.dataset.k === st.k ? (st.dir > 0 ? ' ▲' : ' ▼') : '';
      };
      c.querySelector('#pplQ').oninput = (e) => { st.q = e.target.value; render(); };
      c.querySelector('#pplF').onchange = (e) => { st.f = e.target.value; render(); };
      for (const th of c.querySelectorAll('th')) th.onclick = () => { if (st.k === th.dataset.k) st.dir = -st.dir; else { st.k = th.dataset.k; st.dir = ['pay', 'wealth', 'mood'].includes(st.k) ? -1 : 1; } render(); };
      body.onclick = (e) => {
        const tr = e.target.closest('tr[data-id]');
        if (!tr) return;
        const r = w.residents.get(Number(tr.dataset.id));
        if (!r) return;
        this.closeModal();
        this.inspect({ kind: 'resident', id: r.id });
        g.setFollow(r.id);
      };
      render();
      c.querySelector('#pplQ').focus();
    });
  }

  showHelp() {
    const k = (s) => `<span class="kbd">${s}</span>`;
    this.openModal(`<h2>How to play</h2><p class="lead">Grow a cozy village: lay roads, build homes, give villagers work, services and pretty places — and watch them go about their day.</p>
      <div class="grid2"><div class="help-grid">
        ${k('Drag')}<span>Pan (right mouse, or left-drag with Select)</span>
        ${k('Middle-drag')}<span>Turn and tilt the view (or ${k('Shift')} + right-drag; on a touch screen, twist two fingers, or drag them up or down together)</span>
        ${k('Wheel')}<span>Zoom in & out</span>
        ${k('W A S D')}<span>Pan the camera · with ${k('Shift')}, turn (A D) and tilt (W S) it</span>
        ${k('T')}<span>Toggle 2D top-down / isometric</span>
        ${k('V')}<span>Hide the interface to see just the town (V or Esc brings it back)</span>
        <span>${k('Q')} ${k('E')}</span><span>Rotate the view a quarter turn</span>
        ${k('Home')}<span>Back to the classic isometric view (the compass button too)</span>
        <span>${k('1')}–${k('8')}</span><span>Tool menus · ${k('R')} roads · ${k('X')} demolish</span>
        ${k('Tab')}<span>Flip a building's entrance</span>
        ${k('Space')}<span>Pause · ${k('[')} ${k(']')} slower / faster (up to 32×)</span>
        ${k('O')}<span>Overlays · ${k('B')} budget · ${k('L')} lines · ${k('P')} villagers</span>
        ${k('N')}<span>Hide / show pop-ups (coins, notices, tips)</span>
        ${k('I')}<span>Show / hide the town issues list (lower left)</span>
        ${k('K')}<span>Research: unlock buildings, upgrade paths and styles</span>
        ${k('M')}<span>Multiplayer: host this town, or join a friend's with their code</span>
        ${k('Esc')}<span>Cancel / close</span>
      </div><div style="font-size:13px;line-height:1.5">
        <b>Getting started</b><br>
        1. Build 🏡 cottages along the road — builders from the 🧱 Builder's Yard put them up, then families move in from the edge of the map.<br>
        2. Give them work: 🧺 markets, 🌾 farms, 🪓 woodcutters, 🐟 fisheries.<br>
        3. Build 💧 wells (water reaches every home on the roads through the mains), cover homes with 🩺 health, 📚 schools and 🛡️ safety, and add 🌷 gardens. Happy homes can be upgraded: a Family House becomes a grand Villa or a block of Flats.<br>
        Select a building next to another to 🔗 join them into one on a double plot (two homes make a terrace, a home and a shop a shophouse, a tavern and a workshop a brewhouse, two watch posts a watch house: the building guide lists every pair), or ↔ move any building (it is taken down and rebuilt).<br>
        4. Watch the RCI bars to see what's in demand, and pick 🔬 research projects (K) to unlock new buildings, upgrade paths and styles.<br>
        Bigger works need ⚡ power and 💧 water, and every workplace its workers: a badge over a building shows what it lacks, and its panel says what to do.<br>
        5. When the town grows, link 🚏 coach stops into lines, or lay 🛤️ track between 🚉 stations.<br>
        6. Save to this browser or to a file from 💾.
      </div></div>`);
  }
}

function toolKey(t) {
  switch (t.kind) {
    case 'road': return `road:${t.level}`;
    case 'build': return `build:${t.type}`;
    case 'terrain': return `terrain:${t.mode}`;
    case 'trees': return 'trees';
    case 'rail': return 'rail';
    case 'line': return `line:${t.mode}`;
    case 'roadsel': return 'roadsel';
    default: return '';
  }
}


function nextTitle(pop) {
  for (const t of TITLES) if (t.pop > pop) return `${t.name} at ${t.pop}`;
  return 'Top title reached';
}

function drawChart(cv, values, color) {
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  if (values.length < 2) { g.fillStyle = '#9a8a76'; g.font = 'bold 22px Nunito'; g.fillText('Not enough history yet', 24, H / 2); return; }
  const min = Math.min(0, ...values), max = Math.max(1, ...values);
  const x = (i) => 16 + (i / (values.length - 1)) * (W - 32);
  const y = (v) => H - 18 - ((v - min) / (max - min || 1)) * (H - 40);
  g.strokeStyle = '#e2d4b6'; g.lineWidth = 1;
  for (let k = 0; k <= 3; k++) { const yy = 18 + (k * (H - 36)) / 3; g.beginPath(); g.moveTo(10, yy); g.lineTo(W - 10, yy); g.stroke(); }
  g.beginPath();
  values.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v))));
  g.lineTo(x(values.length - 1), H - 18); g.lineTo(x(0), H - 18); g.closePath();
  g.fillStyle = color + '33'; g.fill();
  g.beginPath();
  values.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v))));
  g.strokeStyle = color; g.lineWidth = 4; g.lineJoin = 'round'; g.stroke();
  g.fillStyle = '#6e5b4a'; g.font = 'bold 20px Nunito';
  g.fillText(fmt(values[values.length - 1]), W - 16 - g.measureText(fmt(values[values.length - 1])).width, 26);
}
