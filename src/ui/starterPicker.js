// The "Start from" choice in the new-village window: an empty valley (a
// town hall, a well and two cottages, as always), or one of the starter
// towns from src/world/starters.js. Every card has a little map of the
// actual town, and picking one shows that town behind the window.

import { STARTERS, loadStarter, starterSummary, starterGrown } from '../world/starters.js';
import { World, plotOf } from '../world/world.js';
import { aabbOf } from '../world/geom.js';
import { drawNets, fillPlot } from './mapDraw.js';
import { BUILDINGS } from '../defs.js';
import { CONFIG } from '../config.js';

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Math.round(n).toLocaleString('en-US');

export const EMPTY = 'empty';

export function starterPickerHTML() {
  const card = (id, name, desc) => `<button type="button" class="starter${id === EMPTY ? ' on' : ''}" data-start="${id}">
    <canvas width="150" height="100"></canvas><b>${esc(name)}</b><span class="d">${esc(desc)}</span><span class="m">…</span></button>`;
  return `<div class="starters">${card(EMPTY, 'Empty valley', 'Found a village from scratch: a town hall, a well, a market stall and two cottages.')}${STARTERS.map(s => card(s.id, s.name, s.desc)).join('')}</div>`;
}

// Wires up the cards. getMap() gives the seed, size and relief chosen for
// an empty valley. Returns { pick } (the chosen id, or EMPTY).
export function mountStarterPicker(root, game, { getMap, onPick }) {
  const state = { pick: EMPTY };
  const cards = [...root.querySelectorAll('.starter')];
  const cardOf = (id) => cards.find(c => c.dataset.start === id);
  const show = (id, w) => {
    const c = cardOf(id);
    if (!c || !c.isConnected) return;
    drawTownMap(c.querySelector('canvas'), w);
  };
  // the starter towns take a moment each to grow: one at a time, after the
  // window is up (a heavy one, like the Metropolis, only when it's picked)
  const grow = (def) => {
    try {
      const s = starterSummary(def.id);
      cardOf(def.id).querySelector('.m').textContent = `${s.N}×${s.N} · ${fmt(s.pop)} villagers · $${fmt(s.money)} · day ${s.day}`;
      show(def.id, loadStarter(def.id));
      return true;
    } catch (e) {
      console.error(e);
      cardOf(def.id).querySelector('.m').textContent = 'Could not grow this town';
      cardOf(def.id).disabled = true;
      return false;
    }
  };
  let k = 0;
  for (const def of STARTERS) {
    if (def.heavy && !starterGrown(def.id)) { cardOf(def.id).querySelector('.m').textContent = `${def.N}×${def.N} · built when you pick it (a few seconds)`; continue; }
    setTimeout(() => { if (root.isConnected) grow(def); }, 60 + 40 * k++);
  }
  // the empty valley follows the seed and size fields
  let emptyKey = null, timer = 0;
  const emptyValley = () => {
    const { seed, N, relief } = getMap();
    const key = `${seed}:${N}:${relief}`;
    if (key === emptyKey) return null;
    emptyKey = key;
    const w = World.createNew({ N, seed, relief, name: 'Preview' });
    cardOf(EMPTY).querySelector('.m').textContent = `${N}×${N} · a few settlers · $${fmt(CONFIG.START_MONEY)} · day 1`;
    show(EMPTY, w);
    return w;
  };
  emptyValley();
  const refresh = () => { clearTimeout(timer); timer = setTimeout(() => { const w = emptyValley(); if (w && state.pick === EMPTY && state.shown) preview(w); }, 250); };
  for (const sel of ['#ngSeed', '#ngSize', '#ngRelief']) root.querySelector(sel)?.addEventListener('input', refresh);
  root.querySelector('#ngDice')?.addEventListener('click', refresh);

  // the town behind the title screen becomes the one picked
  const preview = (w) => {
    if (!game.demo && game.world) return;
    try { game.load(w, { demo: true }); } catch (e) { console.error(e); }
  };
  for (const c of cards) c.onclick = () => {
    const id = c.dataset.start;
    for (const o of cards) o.classList.toggle('on', o === c);
    state.pick = id;
    state.shown = true;
    const def = STARTERS.find(s => s.id === id);
    if (onPick) onPick(id, id === EMPTY ? null : def);
    const { seed, N, relief } = getMap();
    if (def && def.heavy && !starterGrown(id)) {
      // a heavy town: say so and let the window draw before it's built
      c.querySelector('.m').textContent = `Building the ${def.name.toLowerCase()}…`;
      setTimeout(() => setTimeout(() => { if (root.isConnected && grow(def) && state.pick === id) preview(loadStarter(id)); }, 30), 0);
      return;
    }
    preview(id === EMPTY ? World.createNew({ N, seed, relief, name: 'Preview' }) : loadStarter(id));
  };
  return state;
}

// ------------------------------------------------------------ the map
const CAT = {
  residential: '#c4563c', commercial: '#e3a52f', industry: '#8c5a36', services: '#4f62c8',
  utilities: '#2f9a9a', parks: '#79c25a', transit: '#f2f2f2',
};
const ROAD = [null, '#c9a46a', '#9b958c', '#6e6e6e'];

// A small top-down map of the town (the built-up part of the valley).
export function drawTownMap(canvas, w) {
  const g = canvas.getContext('2d');
  const N = w.N, t = w.terrain;
  // frame the buildings, with a margin, at the canvas's shape
  let x0 = N, z0 = N, x1 = 0, z1 = 0;
  for (const b of w.buildings.values()) {
    const [ax, az, bx, bz] = aabbOf(plotOf(b));
    x0 = Math.min(x0, ax); z0 = Math.min(z0, az);
    x1 = Math.max(x1, bx); z1 = Math.max(z1, bz);
  }
  if (x0 > x1) { x0 = z0 = 0; x1 = z1 = N; }
  const ar = canvas.width / canvas.height;
  let cw = Math.max(x1 - x0 + 6, (z1 - z0 + 6) * ar, 27), ch = cw / ar;
  cw = Math.min(cw, N); ch = Math.min(ch, N);
  const cx = Math.max(0, Math.min(N - cw, (x0 + x1) / 2 - cw / 2)), cz = Math.max(0, Math.min(N - ch, (z0 + z1) / 2 - ch / 2));
  const s = canvas.width / cw;
  g.setTransform(s, 0, 0, s, -cx * s, -cz * s);
  g.imageSmoothingEnabled = false;
  for (let z = Math.floor(cz); z < Math.min(N, cz + ch + 1); z++) {
    for (let x = Math.floor(cx); x < Math.min(N, cx + cw + 1); x++) {
      const h = t.tileAvg(x, z);
      let col;
      if (t.isWater(x, z)) {
        const d = Math.max(0, Math.min(1, -h / 0.8));
        col = `rgb(${Math.round(84 - 30 * d)},${Math.round(150 - 35 * d)},${Math.round(210 - 25 * d)})`;
      } else {
        // grass, lit from the top left
        const shade = (t.ch(x, z) - t.ch(x + 1, z + 1)) * 60;
        const hk = Math.min(1, Math.max(0, (h - 0.4) / 2.6));
        const r = 118 + hk * 30 + shade, gg = 166 - hk * 18 + shade, bb = 84 + hk * 10 + shade * 0.6;
        col = `rgb(${Math.round(r)},${Math.round(gg)},${Math.round(bb)})`;
      }
      g.fillStyle = col;
      g.fillRect(x, z, 1.02, 1.02);
    }
  }
  // the woods: a dark dot for each tree
  g.fillStyle = 'rgba(38,82,40,0.9)';
  for (const tr of w.trees) if (tr.x >= cx - 1 && tr.x <= cx + cw + 1 && tr.z >= cz - 1 && tr.z <= cz + ch + 1) g.fillRect(tr.x - 0.17, tr.z - 0.17, 0.34, 0.34);
  // the roads as they run, and the buildings: a coloured roof with a darker rim
  drawNets(g, w, ROAD);
  for (const b of w.buildings.values()) {
    const def = BUILDINGS[b.type];
    const col = def.seat ? '#7d4cb0' : def.outdoorWork ? '#d9c467' : CAT[def.cat] || '#999';
    fillPlot(g, b, 'rgba(40,30,20,0.55)', 0.08);
    fillPlot(g, b, col, 0.18);
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
}
