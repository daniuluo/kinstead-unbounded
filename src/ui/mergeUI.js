// "Merge villages" windows: pick two saved towns (a browser save slot, the
// town being played, or an uploaded .json), arrange them on a 2D map of both
// valleys — beside, apart or overlapping, turned in quarter turns — see what
// will be settled, merge, and read a report of what was moved or refunded.

import { deserialize, serialize, LocalSaves, readJSONFile, downloadJSON, saveFileNameFor } from '../save/saves.js';
import { mergeWorlds, layoutMerge, besideOffset, reportLines, newVillage } from '../save/merge.js';
import { BUILDINGS } from '../defs.js';
import { drawNets, fillPlot } from './mapDraw.js';
import { STARTERS } from '../world/starters.js';
import { townName as genTownName } from '../util/names.js';
import { RNG, randomSeed } from '../util/rng.js';
import { MergePlacement } from './mergePlace.js';

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '∞');
const ms = (name) => `<span class="ms">${name}</span>`;
const GAP = 8;   // how far apart (in tiles) town B may be set from town A

const CAT_COLOR = {
  residential: [196, 96, 72], commercial: [226, 178, 64], industry: [150, 108, 66], services: [124, 104, 196],
  utilities: [84, 150, 176], parks: [64, 140, 58], transit: [58, 88, 168],
};

// A small map of a town, a few pixels to a unit: water, ground by height,
// woods, roads and track as they run, and buildings coloured by kind.
const PX = 4;
export function townPicture(w) {
  const N = w.N, t = w.terrain, c = document.createElement('canvas');
  c.width = c.height = N * PX;
  const g0 = document.createElement('canvas');
  g0.width = g0.height = N;
  const g = g0.getContext('2d'), img = g.createImageData(N, N), px = img.data;
  const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    const i = z * N + x, h = t.tileAvg(x, z);
    let col;
    if (t.isWater(x, z)) col = mix([104, 172, 222], [44, 102, 168], Math.min(1, Math.max(0, -h / 0.8)));
    else {
      col = h < 1.2 ? mix([140, 182, 92], [112, 152, 72], h / 1.2) : h < 2.4 ? mix([112, 152, 72], [150, 140, 104], (h - 1.2) / 1.2) : mix([150, 140, 104], [176, 172, 166], Math.min(1, (h - 2.4) / 1.2));
    }
    px[i * 4] = col[0]; px[i * 4 + 1] = col[1]; px[i * 4 + 2] = col[2]; px[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const G = c.getContext('2d');
  G.imageSmoothingEnabled = false;
  G.drawImage(g0, 0, 0, N * PX, N * PX);
  G.setTransform(PX, 0, 0, PX, 0, 0);
  G.fillStyle = 'rgba(52,96,44,0.75)';
  for (const tr of w.trees) G.fillRect(tr.x - 0.2, tr.z - 0.2, 0.4, 0.4);
  drawNets(G, w, [null, 'rgb(182,146,100)', 'rgb(188,180,166)', 'rgb(188,180,166)'], 'rgb(72,64,60)');
  for (const b of w.buildings.values()) {
    const col = BUILDINGS[b.type].seat ? [250, 244, 228] : CAT_COLOR[BUILDINGS[b.type].cat] || [200, 200, 200], k = b.con ? 0.6 : 1;
    fillPlot(G, b, `rgb(${col.map(v => Math.round(v * k + 255 * (1 - k) * 0.5)).join(',')})`, 0.05);
  }
  G.setTransform(1, 0, 0, 1, 0, 0);
  return c;
}

export class MergeDialog {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this.pick = { A: null, B: null };
    this.arr = null;
    this.seam = 0;
    this.name = '';
    this.step = 'pick';
    this.result = null;
    this.fresh = { A: false, B: false };   // the brand-new village form is open
  }

  get inGame() { return !!this.game.world && !this.game.demo; }

  // intoTown: merging a village into the town being played (it is town A)
  open({ intoTown = false } = {}) {
    if (this.placer && this.placer.active) return;
    this.step = 'pick';
    // the town being played has moved on since it was last picked
    for (const s of ['A', 'B']) if (this.pick[s] && this.pick[s].kind === 'current') { this.pick[s] = this.inGame ? this._current() : null; this.result = null; }
    if (this.inGame && (intoTown || !this.pick.A) && (!this.pick.A || this.pick.A.kind !== 'current')) {
      if (this.pick.B && this.pick.B.kind === 'current') this.pick.B = null;
      this.pick.A = this._current();
      this.arr = null;
      this.result = null;
    }
    this.render();
  }

  get canPlace() { return this.inGame && !!this.pick.A && this.pick.A.kind === 'current' && !!this.pick.B; }

  _ensureArr() {
    if (this.arr) return;
    const NA = this.pick.A.world.N, NB = this.pick.B.world.N;
    this.arr = { ...besideOffset(NA, NB, 'right'), rot: 0 };
    this.name = this.pick.A.world.townName;
  }

  // arrange it in the game view itself, over the town being played
  placeInTown() {
    if (!this.canPlace) return;
    this._ensureArr();
    (this.placer ||= new MergePlacement(this, GAP)).start();
  }

  render() { if (this.step === 'arrange') this._arrange(); else this._pickStep(); }

  _entry(kind, key, label, data) {
    const world = deserialize(data);
    return { kind, key, label, data, world, pic: townPicture(world) };
  }

  _current() {
    const data = serialize(this.game.world);
    return this._entry('current', 'current', `${data.name} (playing now)`, data);
  }

  _choose(side, entry) {
    this.pick[side] = entry;
    this.arr = null;
    this.result = null;
    this._pickStep();
  }

  // ------------------------------------------------------------ step 1
  _pickStep() {
    const slots = LocalSaves.list();
    const col = (side) => {
      const p = this.pick[side];
      const role = side === 'A' ? 'keeps its name and stays put' : 'joins town A';
      const chosen = p
        ? `<div class="merge-chosen"><span class="merge-pic" data-pic="${side}"></span><div><div class="t">${esc(p.world.townName)}</div>
            <div class="m">${p.world.N}×${p.world.N} · day ${p.world.day} · ${fmt(p.world.population)} villagers · ${p.world.buildings.size} buildings</div>
            <div class="m">${esc(p.label)}</div></div></div>`
        : `<div class="merge-chosen"><span class="merge-pic ph">${ms('add_location_alt')}</span><div class="m">Pick a town below.</div></div>`;
      const rows = [];
      if (this.inGame) rows.push(`<button class="${p && p.key === 'current' ? 'on' : ''}" data-cur="${side}">${ms('play_circle')} The town you are playing</button>`);
      rows.push(`<button class="${p && p.kind === 'new' ? 'on' : ''}" data-fresh="${side}">${ms('add_home')} A brand-new village…</button>`);
      for (const e of slots) {
        rows.push(`<button class="${p && p.key === 'slot:' + e.id ? 'on' : ''}" data-slot="${esc(e.id)}" data-side="${side}">${ms(e.id === 'autosave' ? 'history' : 'save')} ${esc(e.name)} <small>day ${e.day} · ${fmt(e.pop)} villagers</small></button>`);
      }
      return `<div class="merge-side" data-drop="${side}">
        <h3>Town ${side} <small>— ${role}</small></h3>
        ${chosen}
        ${this.fresh[side] ? freshForm(side) : `<div class="merge-list">${rows.join('')}</div>`}
        <label class="btn small" title="A Kinstead .json save file">${ms('upload_file')} Upload a .json save…<input type="file" accept=".json,application/json" hidden data-file="${side}"></label>
        <div class="merge-drop">…or drop a .json save here</div>
      </div>`;
    };
    const freshForm = (side) => `<div class="merge-new" data-nv="${side}">
        <div class="field"><label>Start from</label><select data-nv-start><option value="">An empty valley: a town hall, a well and a few cottages</option>${STARTERS.map(st => `<option value="${st.id}">${esc(st.name)} (${st.N}×${st.N})</option>`).join('')}</select></div>
        <div class="field"><label>Village name</label><input data-nv-name maxlength="40" value="${esc(genTownName(new RNG(randomSeed())))}"></div>
        <div class="grid2"><div class="field"><label>Map seed</label><div class="inline"><input data-nv-seed style="flex:1;min-width:0" value="${randomSeed() % 1000000}"><button class="btn small" data-nv-dice title="Random seed">${ms('casino')}</button></div></div>
          <div class="field"><label>Valley size</label><select data-nv-size><option value="32">32×32</option><option value="48" selected>48×48</option><option value="64">64×64</option><option value="80">80×80</option></select></div></div>
        <div class="inline"><button class="btn small" data-nv-back>${ms('arrow_back')} Back</button><span style="flex:1"></span><button class="btn small primary" data-nv-go>${ms('add_home')} Found it</button></div>
      </div>`;
    const both = this.pick.A && this.pick.B;
    this.ui.openModal(`<h2>Merge villages</h2>
      <p class="lead">Join two saved towns into one. Town B is set beside, apart from or over town A; the ground is blended where the valleys meet, the roads are joined up, and every clash is settled for you. Neither save is changed — the merged town is a new one.${this.game.net ? ' <b>Merging ends your multiplayer session.</b>' : ''}</p>
      <div class="merge-pick">${col('A')}${col('B')}</div>
      <div class="actions"><button class="btn" id="mgSwap" ${this.pick.A || this.pick.B ? '' : 'disabled'}>${ms('swap_horiz')} Swap A and B</button>
      <span style="flex:1"></span><button class="btn${this.canPlace ? '' : ' primary'}" id="mgNext" ${both ? '' : 'disabled'}>${ms('map')} Arrange on a map</button>
      ${this.canPlace ? `<button class="btn primary" id="mgPlace" title="Drag the village into place in the town view">${ms('add_location_alt')} Place it in the town</button>` : ''}</div>`, (c) => {
      c.classList.add('merge-win');
      for (const el of c.querySelectorAll('[data-pic]')) {
        const p = this.pick[el.dataset.pic];
        p.pic.className = 'merge-canvas';
        el.replaceWith(p.pic);
      }
      for (const b of c.querySelectorAll('[data-cur]')) b.onclick = () => this._choose(b.dataset.cur, this._current());
      for (const b of c.querySelectorAll('[data-slot]')) b.onclick = () => {
        const e = slots.find(s => s.id === b.dataset.slot);
        try { this._choose(b.dataset.side, this._entry('slot', 'slot:' + e.id, `Browser save “${e.name}”`, LocalSaves.load(e.id))); } catch (err) { this.ui.toast(err.message, 'bad'); }
      };
      const load = async (side, f) => {
        if (!f) return;
        try { this._choose(side, this._entry('file', 'file:' + f.name + ':' + f.size, `Uploaded file ${f.name}`, await readJSONFile(f))); } catch (err) { this.ui.toast(err.message, 'bad'); }
      };
      for (const inp of c.querySelectorAll('[data-file]')) inp.onchange = (e) => load(inp.dataset.file, e.target.files[0]);
      // dropping a save here picks it (and must not load it as the game, which a drop elsewhere does)
      for (const zone of c.querySelectorAll('[data-drop]')) {
        zone.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.add('over'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('over'));
        zone.addEventListener('drop', (e) => {
          e.preventDefault(); e.stopPropagation(); zone.classList.remove('over');
          load(zone.dataset.drop, e.dataTransfer?.files?.[0]);
        });
      }
      c.querySelector('#mgSwap').onclick = () => { [this.pick.A, this.pick.B] = [this.pick.B, this.pick.A]; this.arr = null; this.result = null; this._pickStep(); };
      c.querySelector('#mgNext').onclick = () => {
        this._ensureArr();
        this.step = 'arrange';
        this._arrange();
      };
      const place = c.querySelector('#mgPlace');
      if (place) place.onclick = () => this.placeInTown();
      for (const b of c.querySelectorAll('[data-fresh]')) b.onclick = () => { this.fresh[b.dataset.fresh] = true; this._pickStep(); };
      for (const form of c.querySelectorAll('[data-nv]')) {
        const side = form.dataset.nv, q = (sel) => form.querySelector(sel);
        // a starter town comes with its own valley: the seed and size are its own
        q('[data-nv-start]').onchange = () => {
          const st = STARTERS.find(x => x.id === q('[data-nv-start]').value);
          for (const el of [q('[data-nv-seed]'), q('[data-nv-size]'), q('[data-nv-dice]')]) el.disabled = !!st;
          if (st) { q('[data-nv-seed]').value = st.seed; q('[data-nv-size]').value = st.N; }
        };
        q('[data-nv-dice]').onclick = () => { q('[data-nv-seed]').value = randomSeed() % 1000000; };
        q('[data-nv-back]').onclick = () => { this.fresh[side] = false; this._pickStep(); };
        q('[data-nv-go]').onclick = () => {
          const starter = q('[data-nv-start]').value || null, N = Number(q('[data-nv-size]').value);
          const seedStr = q('[data-nv-seed]').value.trim(), name = q('[data-nv-name]').value.trim() || 'Newbury';
          const seed = /^\d+$/.test(seedStr) ? Number(seedStr) : [...seedStr].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
          const go = q('[data-nv-go]');
          go.disabled = true; go.textContent = 'Founding…';
          // let the button repaint first: a starter town takes a moment to grow
          setTimeout(() => {
            try {
              const data = newVillage({ starter, seed, N, name });
              const what = starter ? STARTERS.find(x => x.id === starter).name.toLowerCase() : `an empty valley, seed ${seed}`;
              this.fresh[side] = false;
              this._choose(side, this._entry('new', `new:${starter || ''}:${seed}:${N}:${name}`, `A brand-new village (${what})`, data));
            } catch (err) { this.ui.toast(err.message, 'bad'); go.disabled = false; go.textContent = 'Found it'; }
          }, 30);
        };
      }
    });
  }

  // ------------------------------------------------------------ step 2
  _arrange() {
    const A = this.pick.A, B = this.pick.B;
    if (!A || !B) { this.step = 'pick'; this._pickStep(); return; }
    const sides = [['left', 'west', 'Left'], ['right', 'east', 'Right'], ['above', 'north', 'Above'], ['below', 'south', 'Below']];
    this.ui.openModal(`<h2>Merge villages</h2>
      <p class="lead">Drag <b class="merge-b">${esc(B.world.townName)}</b> (B) around <b class="merge-a">${esc(A.world.townName)}</b> (A): beside it, apart from it, or overlapping it. The picture shows the merged valley as it will be.</p>
      <div class="merge-arrange">
        <canvas id="mgCanvas" width="560" height="560" title="Drag to move town B"></canvas>
        <div class="merge-tools">
          <div class="field"><label>Put town B beside town A</label>
            <div class="inline">${sides.map(([s, ic, t]) => `<button class="btn small" data-side="${s}">${ms(ic)} ${t}</button>`).join('')}</div></div>
          <div class="field"><label>Turn or overlap</label>
            <div class="inline"><button class="btn small" id="mgTurn">${ms('rotate_right')} Turn B 90°</button><button class="btn small" id="mgOver">${ms('join_inner')} Centre B on A</button></div></div>
          <div class="grid2">
            <div class="field"><label>Blend width</label><select id="mgSeam">${[[0, 'Auto'], [3, '3 units'], [5, '5 units'], [8, '8 units'], [12, '12 units']].map(([v, t]) => `<option value="${v}" ${v === this.seam ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
            <div class="field"><label>Merged town's name</label><input id="mgName" maxlength="40" value="${esc(this.name)}"></div>
          </div>
          <div class="merge-info" id="mgInfo"></div>
          <ul class="merge-sum" id="mgSum"></ul>
        </div>
      </div>
      <div class="actions"><button class="btn" id="mgBack">${ms('arrow_back')} Pick other towns</button><span style="flex:1"></span>
        ${this.canPlace ? `<button class="btn" id="mgPlace" title="Drag the village into place in the town view">${ms('add_location_alt')} Place it in the town</button>` : ''}
        <button class="btn primary" id="mgGo">${ms('merge')} Merge villages</button></div>`, (c) => {
      c.classList.add('merge-win');
      this.cv = c.querySelector('#mgCanvas');
      this.win = c;
      for (const b of c.querySelectorAll('[data-side]')) b.onclick = () => { Object.assign(this.arr, besideOffset(A.world.N, B.world.N, b.dataset.side)); this._changed(); };
      c.querySelector('#mgTurn').onclick = () => { this.arr.rot = (this.arr.rot + 1) % 4; this._changed(); };
      c.querySelector('#mgOver').onclick = () => {
        const d = Math.round((A.world.N - B.world.N) / 2);
        Object.assign(this.arr, { x: d, z: d });
        this._changed();
      };
      c.querySelector('#mgSeam').onchange = (e) => { this.seam = Number(e.target.value); this._changed(); };
      c.querySelector('#mgName').oninput = (e) => { this.name = e.target.value; };
      c.querySelector('#mgBack').onclick = () => { this.step = 'pick'; this._pickStep(); };
      c.querySelector('#mgGo').onclick = () => this._merge();
      const place = c.querySelector('#mgPlace');
      if (place) place.onclick = () => this.placeInTown();
      this._bindDrag();
      this._changed(true);
    });
  }

  _key() { return JSON.stringify([this.arr.x, this.arr.z, this.arr.rot, this.seam, this.pick.A.key, this.pick.B.key]); }

  // the arrangement changed: redraw now, work out the merge a moment later
  _changed(now = false) {
    this._draw();
    this._info();
    clearTimeout(this._t);
    this._t = setTimeout(() => this._preview(), now ? 0 : 140);
  }

  _preview() {
    const key = this._key();
    if (this.result && this.result.key === key) return;
    let out = null, error = null;
    try { out = mergeWorlds(this.pick.A.world, this.pick.B.world, { ...this.arr, seam: this.seam || undefined, name: this.name }, { preview: true }); } catch (e) { error = e.message; }
    this.result = { key, out, error, pic: out ? townPicture(out.world) : null };
    if (this.win && this.win.isConnected) { this._draw(); this._info(); }
  }

  _layout() { return layoutMerge(this.pick.A.world, this.pick.B.world, this.arr); }

  // a fixed frame around town A, with room for B on every side
  _frame() {
    const NA = this.pick.A.world.N, NB = this.pick.B.world.N;
    const x0 = -NB - GAP - 2, size = NA + 2 * (NB + GAP + 2);
    const s = this.cv.width / size;
    return { x0, z0: x0, s, NA, NB };
  }

  _draw() {
    const cv = this.cv;
    if (!cv || !cv.isConnected) return;
    const g = cv.getContext('2d'), F = this._frame(), L = this._layout();
    const X = (x) => (x - F.x0) * F.s, Z = (z) => (z - F.z0) * F.s;
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#56644a';
    g.fillRect(0, 0, cv.width, cv.height);
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let k = 0; k < cv.width; k += F.s * 8) { g.beginPath(); g.moveTo(k, 0); g.lineTo(k, cv.height); g.moveTo(0, k); g.lineTo(cv.width, k); g.stroke(); }
    const fresh = this.result && this.result.key === this._key() && this.result.pic;
    if (fresh) {
      g.drawImage(this.result.pic, X(L.wx), Z(L.wz), L.N * F.s, L.N * F.s);
    } else {
      g.globalAlpha = 0.95;
      g.drawImage(this.pick.A.pic, X(0), Z(0), F.NA * F.s, F.NA * F.s);
      g.save();
      g.translate(X(L.ox + F.NB / 2), Z(L.oz + F.NB / 2));
      g.rotate(L.k * Math.PI / 2);
      g.globalAlpha = L.overlap ? 0.75 : 0.95;
      g.drawImage(this.pick.B.pic, -F.NB * F.s / 2, -F.NB * F.s / 2, F.NB * F.s, F.NB * F.s);
      g.restore();
      g.globalAlpha = 1;
    }
    // the merged map's edge, then each town's outline
    g.setLineDash([5, 4]);
    g.lineWidth = 1.5;
    g.strokeStyle = L.ok ? '#fffbe8' : '#ff5a4a';
    g.strokeRect(X(L.wx) + 0.5, Z(L.wz) + 0.5, L.N * F.s - 1, L.N * F.s - 1);
    g.setLineDash([]);
    g.lineWidth = 2;
    g.strokeStyle = '#2d6cdf';
    g.strokeRect(X(0) + 1, Z(0) + 1, F.NA * F.s - 2, F.NA * F.s - 2);
    g.strokeStyle = '#ef8a1d';
    g.strokeRect(X(L.ox) + 1, Z(L.oz) + 1, F.NB * F.s - 2, F.NB * F.s - 2);
    const tag = (t, x, z, col) => {
      g.font = 'bold 13px Tahoma, sans-serif';
      const w = g.measureText(t).width + 8;
      g.fillStyle = col; g.fillRect(x, z, w, 18);
      g.fillStyle = '#fff'; g.fillText(t, x + 4, z + 13);
    };
    tag('A', X(0) + 4, Z(0) + 4, '#2d6cdf');
    // B's tag marks its turned top-left corner, so the turn is easy to follow
    tag(`B ${['', '↻90°', '↻180°', '↻270°'][L.k]}`.trim(), X(L.ox) + 4, Z(L.oz) + 4, '#ef8a1d');
  }

  _info() {
    const el = this.win && this.win.querySelector('#mgInfo'), sum = this.win && this.win.querySelector('#mgSum'), go = this.win && this.win.querySelector('#mgGo');
    if (!el) return;
    const L = this._layout();
    const how = L.mode === 'overlap' ? `B overlaps A by ${fmt(L.overlap)} units` : L.mode === 'beside' ? 'B sits right beside A' : 'B is apart from A, with new countryside between';
    el.className = 'merge-info' + (L.ok ? '' : ' bad');
    el.innerHTML = L.ok
      ? `${ms('crop_free')} Merged map <b>${L.N}×${L.N}</b>${L.cropped ? ' (empty countryside trimmed)' : ''} · ${how}`
      : `${ms('error')} ${esc(L.reason)}`;
    go.disabled = !L.ok;
    const r = this.result && this.result.key === this._key() ? this.result : null;
    if (!L.ok) sum.innerHTML = '';
    else if (!r) sum.innerHTML = `<li>${ms('hourglass_top')}<span>Working out the merge…</span></li>`;
    else if (r.error) sum.innerHTML = `<li>${ms('error')}<span>${esc(r.error)}</span></li>`;
    else sum.innerHTML = '<li class="h">What will be settled</li>' + reportLines(r.out.report).map(([ic, t]) => `<li>${ms(ic)}<span>${esc(t)}</span></li>`).join('');
  }

  _bindDrag() {
    const cv = this.cv;
    cv.onpointerdown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      cv.setPointerCapture(e.pointerId);
      const F = this._frame(), r = cv.getBoundingClientRect(), k = cv.width / r.width;
      const sx = e.clientX, sz = e.clientY, start = { x: this.arr.x, z: this.arr.z };
      const NA = F.NA, NB = F.NB;
      // edges and centres B snaps to when it comes close
      const snaps = [-NB, 0, NA - NB, NA, Math.round((NA - NB) / 2)];
      const snap = (v) => { for (const s of snaps) if (Math.abs(v - s) <= 1) return s; return v; };
      cv.classList.add('dragging');
      const move = (ev) => {
        const dx = Math.round((ev.clientX - sx) * k / F.s), dz = Math.round((ev.clientY - sz) * k / F.s);
        const x = snap(Math.max(-NB - GAP, Math.min(NA + GAP, start.x + dx)));
        const z = snap(Math.max(-NB - GAP, Math.min(NA + GAP, start.z + dz)));
        if (x === this.arr.x && z === this.arr.z) return;
        this.arr.x = x; this.arr.z = z;
        this._draw(); this._info();
      };
      const up = () => {
        cv.removeEventListener('pointermove', move);
        cv.classList.remove('dragging');
        this._changed();
      };
      cv.addEventListener('pointermove', move);
      cv.addEventListener('pointerup', up, { once: true });
      cv.addEventListener('pointercancel', up, { once: true });
    };
  }

  // ------------------------------------------------------------ merging
  _merge() {
    const g = this.game, ui = this.ui;
    // the town being played may have moved on since it was picked
    for (const side of ['A', 'B']) if (this.pick[side].kind === 'current' && this.inGame) this.pick[side] = this._current();
    const A = this.pick.A, B = this.pick.B;
    let out;
    try { out = mergeWorlds(A.world, B.world, { ...this.arr, seam: this.seam || undefined, name: this.name }); } catch (e) { ui.toast(e.message, 'bad'); return; }
    // (a guest's copy of a friend's town is not theirs to keep)
    const before = this.inGame && !g.replica ? g.world.townName : null;
    if (before) g.saveLocal('premerge', true);
    g.loadData(out.data);
    ui.closeAllWindows();
    g.saveLocal('autosave', true);
    this.pick = { A: null, B: null };
    this.arr = null;
    this.result = null;
    ui.toast(`${A.world.townName} and ${B.world.townName} are now one town: ${g.world.townName}`, 'big', '🏘️');
    this.showReport(out.report, out.data, before);
  }

  showReport(rep, data, before) {
    const list = (title, icon, rows) => (rows.length ? `<h4>${ms(icon)} ${title}</h4><ul class="merge-detail">${rows.map(r => `<li>${r}</li>`).join('')}</ul>` : '');
    const money = (v) => `$${fmt(v)}`;
    const [na, nb] = rep.names.map(esc);
    this.ui.openModal(`<h2>Merge report</h2>
      <p class="lead"><b>${na}</b> and <b>${nb}</b> are now <b>${esc(data.name)}</b>, a ${rep.N}×${rep.N} valley.${before ? ` The town you were playing, ${esc(before)}, was saved in this browser first.` : ''}</p>
      <ul class="merge-sum">${reportLines(rep).map(([ic, t]) => `<li>${ms(ic)}<span>${esc(t)}</span></li>`).join('')}</ul>
      ${list('Moved', 'local_shipping', rep.moved.map(m => `<b>${esc(m.name)}</b> from ${esc(m.from)} — ${esc(m.why)}; moved ${m.dist} tile${m.dist === 1 ? '' : 's'}`))}
      ${list('Refunded', 'payments', rep.refunded.map(m => `<b>${esc(m.name)}</b> from ${esc(m.from)} — ${esc(m.why)} · ${money(m.refund)}`))}
      ${list('Changed', 'swap_horiz', rep.converted.map(m => `<b>${esc(m.name)}</b> from ${esc(m.from)} became a ${esc(m.to)} — ${esc(m.why)}${m.refund ? ` · ${money(m.refund)} back` : ''}`))}
      ${list('Dropped', 'cleaning_services', rep.removed.map(m => `<b>${esc(m.name)}</b> from ${esc(m.from)} — ${esc(m.why)}${m.refund ? ` · ${money(m.refund)} back` : ''}`))}
      ${list('Transit', 'directions_bus', [...rep.linesTrimmed.map(l => `<b>${esc(l.name)}</b> (${esc(l.from)}) lost ${l.stops} stop${l.stops === 1 ? '' : 's'}`), ...rep.linesRemoved.map(l => `<b>${esc(l.name)}</b> (${esc(l.from)}) closed: too few stops left · ${money(l.refund)} for its vehicles`)])}
      <div class="actions"><button class="btn" id="mrDl">${ms('download')} Download the merged save (.json)</button><span style="flex:1"></span><button class="btn primary" id="mrOk">Start playing</button></div>`, (c) => {
      c.classList.add('merge-win');
      c.querySelector('#mrDl').onclick = () => downloadJSON(serialize(this.game.world), saveFileNameFor(data));
      c.querySelector('#mrOk').onclick = () => this.ui.closeWindow(c);
    });
  }
}
