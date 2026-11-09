// Game orchestrator: owns the renderer, the current world and every system.

import * as THREE from 'three';
import { CONFIG, SEASONS, TITLES, SHADOW_SIZE, PERF_DEFAULTS } from './config.js';
import { BUILDINGS, SERVICES, unlockOf, TECHS } from './defs.js';
import { Renderer } from './render/renderer.js';
import { Sky, daylightHour } from './render/sky.js';
import { WorldView } from './render/worldView.js';
import { Particles } from './render/particles.js';
import { World, plotOf } from './world/world.js';
import { growDemoTown } from './world/demo.js';
import { loadStarter } from './world/starters.js';
import { PathFinder } from './sim/path.js';
import { Sim } from './sim/sim.js';
import { Agents } from './sim/agents.js';
import { Transit } from './sim/transit.js';
import { Animals } from './sim/animals.js';
import { Construction } from './sim/construction.js';
import { UI } from './ui/ui.js';
import { Input } from './ui/input.js';
import { Sfx } from './ui/sfx.js';
import { Music } from './ui/music.js';
import { newTownId } from './util/text.js';
import { serialize, deserialize, LocalSaves, downloadJSON, readJSONFile, saveFileName } from './save/saves.js';
import { randomSeed, RNG } from './util/rng.js';
import { townName } from './util/names.js';
import { runCommand } from './commands.js';
import { ReplicaSim, ReplicaConstruction } from './net/replica.js';
import { worldFromSnapshot } from './net/sync.js';
import { RemoteCursors } from './net/cursors.js';
import { STORE } from './store.js';

const SETTINGS_KEY = `${STORE}settings`;   // under this copy's own name (src/store.js)

export class Game {
  constructor() {
    this.THREE = THREE;
    this.renderer = new Renderer(document.getElementById('app'));
    this.sky = new Sky(this.renderer);
    this.settings = { shadows: true, ao: true, pixelArt: true, pixelSize: 2, autosave: true, sound: true, popCoins: true, popToasts: true, popTips: true, popLabels: true, issuesOpen: true, music: true, musicVol: 0.5, tiltShift: 'off', tiltBand: 'normal', alwaysDay: false, camera: 'iso', fov: 45, v: 4, ...PERF_DEFAULTS };
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch {}
    Object.assign(this.settings, saved);
    // The pixel-art look at 2× is the game's look: settings saved before
    // version 3 start from it once (a later choice of the smooth look or
    // another pixel size is kept)
    if ((saved.v || 0) < 3) Object.assign(this.settings, { pixelArt: true, pixelSize: 2, v: 3 });
    // and busy streets thinned out, as from version 4, unless only some or
    // only the nearest villagers were already being drawn
    if ((saved.v || 0) < 4) Object.assign(this.settings, { villagers: this.settings.villagers === 'some' || this.settings.villagers === 'near' ? this.settings.villagers : 'crowds', v: 4 });
    this.speed = 1;
    this.prevSpeed = 1;
    this.env = { hours: 7, night: 0, season: 0, snowing: false };
    this._ev = {};
    this.world = null;
    this.demo = false;
    this.follow = null;
    this.overlayMode = null;
    this._overlayT = 0;
    this._toastT = { arrived: -99, departed: -99 };
    this.time = 0;
    this.net = null;         // a multiplayer session (src/net/session.js), when hosting or joined
    this.replica = false;    // true while this town is a guest's copy of the host's
    this.audio = new Sfx();
    this.music = new Music(this);
    // browsers only allow sound after the player has clicked or pressed a key
    const wake = () => { this.music.apply(); window.removeEventListener('pointerdown', wake); window.removeEventListener('keydown', wake); };
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    this.lantern = new Particles(this.renderer.scene, 400, { additive: true });
    this.ui = new UI(this);
    this.input = new Input(this);
    this.cursors = new RemoteCursors(this);

    this.on('coins', (c) => this.ui.coin(c.x, c.y, c.z, c.v));
    this.on('day', () => this._onDay());
    this.on('born', (babies) => {
      if (this.demo || this.time - (this._toastT.born || -99) < 20) return;
      this._toastT.born = this.time;
      this.ui.toast(babies.length > 1 ? `${babies.length} babies were born today` : `A baby, ${babies[0].first}, was born to the ${babies[0].last} family`, 'good', '👪');
    });
    this.on('died', (gone) => {
      if (this.demo || this.time - (this._toastT.died || -99) < 20) return;
      this._toastT.died = this.time;
      this.ui.toast(gone.length > 1 ? `${gone.length} old villagers passed away` : `${gone[0].first} ${gone[0].last} passed away at ${Math.floor(gone[0].years)}`, 'info', '🔔');
    });
    this.on('graduated', ({ r, st }) => {
      if (this.demo || this.time - (this._toastT.grad || -99) < 20) return;
      this._toastT.grad = this.time;
      this.ui.toast(`${r.first} ${r.last} graduated from ${st === 5 ? 'university' : 'college'}`, 'good', '🎓');
    });
    this.on('season', (s) => { if (!this.demo) this.ui.toast(`${SEASONS[s].name} has arrived`, 'info', SEASONS[s].icon); });
    this.on('milestone', (t) => this._onMilestone(t));
    this.on('arrived', ({ building, family }) => {
      if (this.demo || this.time - this._toastT.arrived < 25) return;
      this._toastT.arrived = this.time;
      this.ui.toast(`The ${family[0].last} family moved into a ${BUILDINGS[building.type].levels[building.level].name}`, 'good', '🧳');
    });
    this.on('departed', ({ count }) => {
      if (this.demo || this.time - this._toastT.departed < 30) return;
      this._toastT.departed = this.time;
      this.ui.toast(`${count} unhappy villager${count > 1 ? 's' : ''} packed up and left`, 'bad', '😟');
    });
    this.on('transit:routes', () => this.updateRouteOverlay());

    this._bindFileDrop();
    // closing or reloading the tab: say goodbye rather than leave the others waiting
    window.addEventListener('pagehide', () => { if (this.net) this.net.close(); this.autosave(); });
    // switching away (or a phone locking) may be the last chance to save
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.autosave(); });
    this.clock = performance.now();
    // the last time the player moved the mouse or pressed a key (see _due)
    this._inputAt = 0;
    for (const e of ['pointermove', 'pointerdown', 'wheel', 'keydown']) window.addEventListener(e, () => { this._inputAt = performance.now(); }, { passive: true });
    // one bad frame must never stop the game: log it and carry on
    const loop = (ts) => {
      this._raf = performance.now();
      if (this._due(ts)) {
        try { this.frame(); } catch (e) { if (!this._frameErr) { this._frameErr = true; console.error('Frame error (the game keeps running):', e); } }
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    // a tab in the background gets no animation frames: a host keeps its town
    // running for its guests in steps of at most a tenth of a second, without drawing
    setInterval(() => {
      if (!this.net || !this.net.isHost || performance.now() - (this._raf || 0) < 500) return;
      try {
        for (let behind = Math.min(3000, performance.now() - this.clock); behind > 1; behind -= 100) {
          this.clock = performance.now() - Math.min(100, behind);
          this.frame(false);
        }
      } catch (e) { console.error('Background frame error:', e); }
    }, 250);
  }

  // Whether to draw this animation frame: every one the screen shows,
  // unless the Performance settings cap the frame rate, or (pausedSlow) ask
  // for only a few a second while the game is paused and nothing moves
  // (not in a multiplayer town: the others' cursors and changes keep coming).
  _due(ts) {
    const s = this.settings;
    let fps = s.fps || 0;
    if (s.pausedSlow && this.speed === 0 && this.world && !this.demo && !this.net && !this.renderer.moving && ts - this._inputAt > 1000) fps = Math.min(fps || 10, 10);
    if (!fps) { this._frameAt = ts; return true; }
    const step = 1000 / fps, since = ts - (this._frameAt ?? -1e9);
    // (a couple of milliseconds early still counts: animation frames come a little unevenly)
    if (since < step - 2) return false;
    this._frameAt = since > step * 2 ? ts : this._frameAt + step;
    return true;
  }

  on(e, fn) { (this._ev[e] ||= []).push(fn); }
  off(e, fn) { const l = this._ev[e]; if (l) this._ev[e] = l.filter(f => f !== fn); }
  emit(e, d) { for (const fn of this._ev[e] || []) fn(d); }

  get isGuest() { return !!(this.net && this.net.isGuest); }

  // Every change a player makes goes through here (see commands.js): applied
  // at once in single-player and by a host, or sent to the host by a guest.
  // done(result) runs when it has been applied (for a guest, when the host answers).
  cmd(c, done = null) {
    if (this.isGuest) { this.net.request(c, done); return null; }
    const r = runCommand(this, c);
    if (done) done(r);
    return r;
  }

  // ------------------------------------------------------------ lifecycle
  load(world, { fresh = false, demo = false, replica = false } = {}) {
    this.ui?.setUIHidden(false);
    this._teardown();
    this.world = world;
    this.demo = demo;
    this.replica = replica;
    this.paths = new PathFinder(world);
    this.view = new WorldView(world, this.renderer);
    this.sim = replica ? new ReplicaSim(this) : new Sim(this);
    this.transit = new Transit(this);
    if (fresh) this.sim.seedFounders(); else this.sim.recompute();
    this.agents = new Agents(this);
    this.animals = new Animals(this);
    this.construction = replica ? new ReplicaConstruction(this) : new Construction(this);
    world.on('building:done', (e) => this._onBuilt(e));
    world.on('land:sold', (e) => this._onLand(e));
    world.on('research:done', (id) => this._onResearch(id));
    this.transit.rebuild();
    this.transit.planCarts();
    this.renderer.setBounds(world.N);
    this.renderer.groundAt = (x, z) => world.terrain.heightAt(x, z);
    let focus = { x: world.N / 2, z: world.N / 2 };
    for (const b of world.buildings.values()) if (BUILDINGS[b.type].seat) focus = { x: b.x, z: b.z };
    this.renderer.lookAt(focus.x, focus.z, true);
    this._demoFocus = focus;
    this.renderer.rig.zoom = this.renderer.rig.zoomT = demo ? 1.25 : 1.7;
    this.overlayMode = null;
    this.follow = null;
    this.speed = 1;
    this.view.setSeason(this.sky.season, this.sky.seasonW);
    document.getElementById('hud').classList.toggle('hidden', demo);
    this.ui.inspect(null);
    this.ui.closeFlyout();
    this.ui.setLegend(null);
    this.input.setTool({ kind: 'select' });
    this.applySettings();
  }

  _teardown() {
    if (!this.world) return;
    this.input._setGhost(null);
    this.agents?.dispose();
    this.animals?.dispose();
    this.transit?.dispose();
    this.view?.dispose();
    this.lantern.clear();
    this.world = null;
  }

  startDemo() {
    const seed = randomSeed();
    const w = World.createNew({ N: 44, seed, name: townName(new RNG(seed)) });
    growDemoTown(w, seed, 1);
    w.hours = 17.2;
    w.day = 1 + CONFIG.DAYS_PER_SEASON * (seed % 3);
    this.load(w, { fresh: true, demo: true });
    this.speed = 1;
  }

  newGame({ name, seed, N, sandbox, starter = null, relief = 'hilly' }) {
    this.endNet();
    const w = starter ? loadStarter(starter, { name, sandbox }) : World.createNew({ N, seed, name, sandbox, relief });
    w.townId = newTownId();   // every game from the same starter is a town of its own
    this.ui.closeAllWindows();   // none of them is about this town
    this.load(w, { fresh: !starter });
    document.getElementById('title').classList.add('hidden');
    if (starter) this.ui.toast(`Welcome to ${name}! ${w.population} villagers are counting on you.`, 'big', '🏡');
    else this.ui.toast(`Welcome to ${name}! Build cottages along the road to attract settlers.`, 'big', '🏡');
    setTimeout(() => this.ui.toast('Press ❓ any time for a quick guide.', 'info', '💡'), 2500);
  }

  loadData(data) {
    const w = deserialize(data);
    this.endNet();
    this.ui.closeAllWindows();
    this.load(w, { fresh: false });
    document.getElementById('title').classList.add('hidden');
  }

  toTitle() {
    this.autosave();
    this.endNet();
    this.startDemo();
    this.showTitle();
  }

  // ---------------------------------------------------------- multiplayer
  // A guest's copy of the host's town has arrived (see net/session.js).
  joinTown(snap, session) {
    this.autosave();
    const w = worldFromSnapshot(snap);
    if (this.net && this.net !== session) this.endNet();
    this.net = session;
    this.load(w, { replica: true });
    this.applySpeed(snap.clock ? snap.clock[2] : 1);
    this.sim.syncClock(w.day, w.hours);
    document.getElementById('title').classList.add('hidden');
  }

  // Stop hosting (guests are told the town has closed), or leave the host's town.
  endNet() {
    const n = this.net;
    if (!n) return;
    this.net = null;
    n.close();
    this.cursors.clear();
    this.ui.renderNetBox?.();
  }

  showTitle() {
    const t = document.getElementById('title');
    t.classList.remove('hidden');
    const saves = LocalSaves.list();
    const cont = document.getElementById('btnContinue');
    cont.classList.toggle('hidden', !saves.length);
    cont.onclick = () => {
      const latest = [...LocalSaves.list()].sort((a, b) => (b.savedAt > a.savedAt ? 1 : -1))[0];
      if (!latest) return;
      try { this.loadData(LocalSaves.load(latest.id)); this.ui.toast(`Welcome back to ${this.world.townName}`, 'good', '🏡'); } catch (e) { this.ui.toast(e.message, 'bad'); }
    };
    document.getElementById('btnNew').onclick = () => this.ui.showNewGame((o) => this.newGame(o));
    document.getElementById('btnLoad').onclick = () => this.ui.showSaves('local');
    document.getElementById('btnMerge').onclick = () => this.ui.showMerge();
    document.getElementById('btnMulti').onclick = () => this.ui.showMultiplayer();
    // first visit: straight to choosing how to start (unless an invite link brought them here)
    const invited = new URLSearchParams(location.search).has('join');
    if (!saves.length && !this._offeredStart && !invited) { this._offeredStart = true; this.ui.showNewGame((o) => this.newGame(o)); }
  }

  // --------------------------------------------------------------- saving
  saveLocal(id, quiet = false) {
    if (!this.world || this.demo) return false;
    try {
      const data = serialize(this.world);
      if (id === 'autosave') data.name = this.world.townName;
      LocalSaves.save(id, data, this.captureThumb());
      this._savedAt = performance.now();
      if (!quiet) this.ui.toast('Saved', 'good', '💾');
      return true;
    } catch (e) {
      this.ui.toast(e.message, 'bad');
      return false;
    }
  }

  quickSave() { this.saveLocal('quick'); }

  // The town as it stands, to the autosave slot: at the turn of every day,
  // every AUTOSAVE_SECONDS of real time (a day is long, and never ends while
  // paused), when the tab is hidden or closed, and before leaving the town.
  // Never a guest's copy of someone else's town.
  autosave() {
    if (!this.world || this.demo || this.replica || !this.settings.autosave) return;
    // a different town is about to take the autosave slot: the one there
    // moves to the "previous town" slot, so starting a new village or loading
    // another never loses the last one (older saves go by name)
    const cur = LocalSaves.list().find(e => e.id === 'autosave');
    if (cur && (cur.town ? cur.town !== this.world.townId : cur.name !== this.world.townName)) LocalSaves.copy('autosave', 'previous');
    this.saveLocal('autosave', true);
  }

  // Plain .json download of the current town.
  downloadSave() {
    if (!this.world || this.demo) return;
    downloadJSON(serialize(this.world), saveFileName(this.world));
    this.ui.toast('Save file downloaded', 'good', '⬇');
  }

  // Drop a .json save anywhere on the page to load it.
  _bindFileDrop() {
    window.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
    window.addEventListener('drop', async (e) => {
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      e.preventDefault();
      if (!/\.json$/i.test(f.name) && f.type !== 'application/json') { this.ui.toast('Drop a Kinstead .json save to load it', 'bad'); return; }
      try {
        this.loadData(await readJSONFile(f));
        this.ui.closeAllWindows();
        this.ui.toast(`Loaded ${f.name}`, 'good', '📁');
      } catch (err) { this.ui.toast(err.message, 'bad'); }
    });
  }

  captureThumb() {
    try {
      this.renderer.render();
      const src = this.renderer.canvas;
      const c = document.createElement('canvas');
      c.width = 320; c.height = 180;
      const g = c.getContext('2d');
      const sky = this.sky.cur;
      const grd = g.createLinearGradient(0, 0, 0, 180);
      grd.addColorStop(0, '#' + sky.top.getHexString()); grd.addColorStop(1, '#' + sky.bot.getHexString());
      g.fillStyle = grd; g.fillRect(0, 0, 320, 180);
      const ar = src.width / src.height, tw = 320, th = 180;
      let sw = src.width, sh = src.height, sx = 0, sy = 0;
      if (ar > tw / th) { sw = src.height * (tw / th); sx = (src.width - sw) / 2; } else { sh = src.width / (tw / th); sy = (src.height - sh) / 2; }
      g.drawImage(src, sx, sy, sw, sh, 0, 0, tw, th);
      return c.toDataURL('image/jpeg', 0.72);
    } catch { return null; }
  }

  _onDay() {
    if (this.demo) return;
    const U = this.sim.utility;
    if (U && this.world.day % 2 === 0) {
      if (U.power.gen && U.power.demand > U.power.gen) this.ui.toast(`Power is short by ${U.power.demand - U.power.gen} kW — some buildings are in the dark. Build more generators.`, 'bad', '⚡');
      if (U.water.demand > U.water.supply) this.ui.toast(`Water runs short: ${U.water.demand} villagers, enough for ${U.water.supply}. Build wells, a pump or a water tower.`, 'bad', '💧');
    }
    this.transit.planCarts();
    // a guest's copy of someone else's town is not their autosave
    if (this.world.day % CONFIG.AUTOSAVE_DAYS === 0) this.autosave();
  }

  _onMilestone(t) {
    if (this.demo) return;
    const unlocked = [];
    for (const [type, def] of Object.entries(BUILDINGS)) {
      if (unlockOf(type, 0) === t.pop) unlocked.push(def.levels[0].name);
      def.levels.forEach((L, i) => { if (i > 0 && L.unlock === t.pop) unlocked.push(L.name); });
    }
    this.ui.toast(`${this.world.townName} is now a ${t.name}!`, 'big', '🎉');
    if (unlocked.length) setTimeout(() => this.ui.toast(`Unlocked: ${unlocked.slice(0, 6).join(', ')}${unlocked.length > 6 ? '…' : ''}`, 'good', '🔓'), 900);
    this.sfx('fanfare');
    let at = null;
    for (const b of this.world.buildings.values()) if (BUILDINGS[b.type].seat) at = b;
    const x = at ? at.x : this.renderer.rig.target.x, z = at ? at.z : this.renderer.rig.target.z;
    this.view.fireworks(x, at ? at.baseY : 1, z);
  }

  // ------------------------------------------------------------- controls
  // The clock belongs to the town (in multiplayer the host's), so speed is a command too.
  setSpeed(s) { this.cmd({ t: 'speed', s }); }

  applySpeed(s) {
    if (s === 0 && this.speed) this.prevSpeed = this.speed;
    this.speed = s;
  }

  stepSpeed(dir) {
    const S = [0, 1, 2, 4, 8, 16, 32];
    const i = Math.max(0, S.indexOf(this.speed));
    this.setSpeed(S[Math.max(0, Math.min(S.length - 1, i + dir))]);
  }

  rotateView(dir) {
    if (!this.world || this.demo) return;
    this.renderer.rotate(dir, this._centerGround());
  }

  // Turning and tilting by hand (a drag, a twist or a held key): orbitStart()
  // when it begins, so the view turns around the ground at the middle of the
  // screen, then orbit() as it goes (see Renderer.orbit).
  orbitStart() {
    if (!this.world || this.demo) return;
    this.renderer._pivotOn(this._centerGround());
  }
  orbit(dTurn, dElev, at = null) {
    if (!this.world || this.demo) return;
    const was = this.renderer.rig.topDown;
    this.renderer.orbit(dTurn, dElev, at);
    if (this.renderer.rig.topDown !== was) this.ui.syncToolbar();
  }

  // Home: back to the classic isometric view, from any angle or tilt, the
  // 2D map or the perspective camera.
  classicView() {
    if (!this.world || this.demo) return;
    if (this.settings.camera === 'perspective') { this.settings.camera = 'iso'; this.applySettings(); }
    this.renderer.classicView(this._centerGround());
    this.ui.syncToolbar();
  }

  // The ground (or water) under the middle of the screen: the point the view
  // turns and tilts around.
  _centerGround() {
    const tv = this.view && this.view.terrain;
    if (!tv) return null;
    // cast along the line of sight through the camera's target (not from the
    // pixel-snapped camera), so repeated turns don't creep
    // (a perspective camera's from where it stands: the line behind it may
    // run into a hill)
    const R = this.renderer, rc = this._centerRay || (this._centerRay = new THREE.Raycaster());
    if (R.camera.isPerspectiveCamera) rc.set(R.eye, R.rig.target.clone().sub(R.eye).normalize());
    else {
      const dir = R.camera.getWorldDirection(new THREE.Vector3());
      rc.set(R.rig.target.clone().addScaledVector(dir, -200), dir);
    }
    const hit = rc.intersectObjects([tv.surface, tv.water].filter(Boolean), true)[0];
    return hit ? hit.point : null;
  }

  toggleTopDown() {
    this.renderer.setTopDown(!this.renderer.rig.topDown, this.world && !this.demo ? this._centerGround() : null);
    this.ui.syncToolbar();
  }

  setFollow(id) {
    if (this.follow === id) return;
    this.follow = id;
    if (this.ui.selection && this.ui.selection.kind === 'resident') this.ui.renderInspector(true);
  }

  refreshCursor() { this.input.refresh(); }

  sfx(name) { if (this.settings.sound) this.audio.play(name); }

  _onBuilt({ building: b, kind, moved }) {
    if (this.demo || this.time - (this._toastT.built || -99) < 4) return;
    this._toastT.built = this.time;
    const name = BUILDINGS[b.type].levels[b.level].name;
    const msg = kind === 'upgrade' ? `Upgrade finished: ${name}` : kind === 'merge' ? `The builders finished the ${name}`
      : moved ? `The ${name} is back up on its new plot` : `The builders finished a new ${name}`;
    this.ui.toast(msg, 'good', '🏗️');
    this.sfx('upgrade');
  }

  _onResearch(id) {
    if (this.demo) return;
    this.ui.toast(`Research complete: ${TECHS[id].name}! Press K to choose the next project.`, 'big', '🔬');
    this.sfx('upgrade');
    if (this.ui.category) this.ui.openFlyout(this.ui.category);
    if (this.ui.selection) this.ui.renderInspector(true);
  }

  _onLand({ buyer, seller, price }) {
    if (this.demo) return;
    const n = (b) => BUILDINGS[b.type].levels[b.level].name;
    this.ui.toast(`The ${n(buyer)} household bought part of the next-door ${n(seller)}'s garden for $${price}`, 'info', '🌿');
  }

  applySettings() {
    const s = this.settings;
    this.renderer.setShadows(s.shadows, SHADOW_SIZE[s.shadowQuality] || SHADOW_SIZE.high);
    const gf = this.renderer.gfx, scale = s.resScale || 1, tilt = s.tiltShift === 'off' ? null : s.tiltShift;
    const persp = s.camera === 'perspective', fov = s.fov || 45;
    if (!this.renderer.post && (s.pixelArt || s.ao || tilt) || gf.pixelArt !== s.pixelArt || gf.pixelSize !== s.pixelSize || gf.ao !== s.ao || gf.scale !== scale
      || gf.tilt !== tilt || gf.tiltBand !== s.tiltBand || gf.persp !== persp || gf.fov !== fov || !this._gfxInit) {
      this._gfxInit = true;
      this.renderer.setGraphics({ pixelArt: s.pixelArt, pixelSize: s.pixelSize, ao: s.ao, scale, tilt, tiltBand: s.tiltBand, persp, fov });
    }
    this.view?.setEffects(s.effects);
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch {}
  }

  // ------------------------------------------------------------- overlays
  setOverlay(mode) {
    this.overlayMode = mode;
    this.refreshOverlay();
    this.updateRouteOverlay();
    const legends = {
      happiness: '🙂 Happiness <span class="grad" style="background:linear-gradient(90deg,#e0533d,#e8c84a,#5fbf4e)"></span>',
      appeal: '🌳 Scenery <span class="grad" style="background:linear-gradient(90deg,transparent,#3fae4e)"></span>',
      pollution: '🏭 Pollution <span class="grad" style="background:linear-gradient(90deg,transparent,#7a4aa0)"></span>',
      transit: '🚏 Transit routes',
    };
    let html = legends[mode] || (SERVICES[mode] ? `${SERVICES[mode].icon} ${SERVICES[mode].name} coverage <span class="grad" style="background:${SERVICES[mode].color}"></span>` : null);
    if (html) html += ' <button class="btn small" id="legendX">✕</button>';
    this.ui.setLegend(html);
    const x = document.getElementById('legendX');
    if (x) x.onclick = () => this.setOverlay(null);
  }

  refreshOverlay() {
    if (!this.view) return;
    const ov = this.view.overlay, mode = this.overlayMode, sim = this.sim, w = this.world;
    if (!mode || mode === 'transit') { ov.setMap(null); return; }
    const N = w.N;
    if (SERVICES[mode]) {
      const col = SERVICES[mode].color;
      ov.setMap(sim.coverage[mode], (v, x, z) => (v ? [col, w.terrain.isWater(x, z) ? 0.12 : 0.34] : null));
    } else if (mode === 'happiness') {
      // each home's own plot, in its colour
      const c = new THREE.Color(), a = new THREE.Color('#e0533d'), m = new THREE.Color('#e8c84a'), g = new THREE.Color('#5fbf4e');
      const shapes = [];
      for (const b of w.buildings.values()) {
        if (!BUILDINGS[b.type].levels[b.level].housing) continue;
        const v = b.happiness / 100;
        if (v < 0.5) c.copy(a).lerp(m, v * 2); else c.copy(m).lerp(g, (v - 0.5) * 2);
        shapes.push({ pts: plotOf(b).pts, color: '#' + c.getHexString(), alpha: 0.6, border: false, y: b.baseY + 0.04 });
      }
      ov.setMapShapes(shapes);
      void N;
    } else if (mode === 'appeal') {
      ov.setMap(sim.appeal, (v) => (v > 0.5 ? ['#3fae4e', Math.min(0.6, v / 25)] : null));
    } else if (mode === 'pollution') {
      ov.setMap(sim.pollution, (v) => (v > 0.5 ? ['#7a4aa0', Math.min(0.6, v / 25)] : null));
    }
  }

  updateRouteOverlay() {
    if (!this.view || !this.transit) return;
    const t = this.input.tool;
    const show = this.overlayMode === 'transit' || t.kind === 'line' || t.kind === 'rail' || this.ui.category === 'transit';
    const ribbons = show ? this.transit.routeRibbons() : [];
    if (t.kind === 'line' && t.stops.length >= 2) {
      const tmp = { mode: t.mode, stops: t.stops };
      const r = this.transit._route(tmp);
      if (r) ribbons.push({ points: this.transit.routePoints(r).map(([x, y, z]) => [x, y + 0.02, z]), color: '#ffffff', opacity: 0.7, width: 0.05 });
    }
    this.view.overlay.setRoutes(ribbons);
  }

  // ---------------------------------------------------------------- frame
  frame(render = true) {
    const now = performance.now();
    let dt = (now - this.clock) / 1000;
    this.clock = now;
    dt = Math.min(dt, 0.1);
    this.time += dt;
    const w = this.world;
    if (w) {
      if (!this._savedAt) this._savedAt = now;
      else if (now - this._savedAt > CONFIG.AUTOSAVE_SECONDS * 1000) { this._savedAt = now; this.autosave(); }
      const gameDt = this.sim.update(dt);
      // (always daytime: the light stays in the day while the clock runs on)
      this.sky.update(w.day, this.settings.alwaysDay ? daylightHour(w.hours) : w.hours, w.seed);
      const env = this.env;
      env.hours = w.hours; env.night = this.sky.night; env.season = this.sky.season;
      // the weather brings snow in winter and rain the rest of the year
      env.snowing = env.season === 3 && this.sky.snow > 0.15 && this.sky.wet > 0.45;
      env.rain = this.sky.rain;
      env.cloud = this.sky.cloud;
      this.audio.setRain(this.settings.sound ? env.rain : 0);
      env.seasonW = this.sky.seasonW;
      this.view.setSeason(env.season, env.seasonW);
      this.agents.update(dt, gameDt);
      this.construction.update(dt, gameDt);
      this.transit.update(dt);
      this.animals.update(dt, this.speed);
      this.view.update(dt, gameDt, env);
      // villagers carry little lanterns at night, lit where the hand holds it
      // (only those carried by villagers being drawn: see Agents._drawList)
      const l = [];
      for (const wk of this.agents.lanterns) if (wk.shown !== false) l.push({ x: wk.lx ?? wk.x, y: wk.ly ?? wk.y + 0.05, z: wk.lz ?? wk.z, size: 0.12, r: 1, g: 0.75, b: 0.4, a: 0.8 });
      this.lantern.setStatics(l);
      this.lantern.update(dt, this.renderer.pixelsPerUnit(), env.night);
      if (this.follow != null) {
        const r = w.residents.get(this.follow);
        const p = r && this.agents.positionOf(r);
        if (p) this.renderer.lookAt(p.x, p.z); else this.follow = null;
      }
      if (this.demo) {
        const rig = this.renderer.rig;
        const cx = this._demoFocus.x, cz = this._demoFocus.z;
        rig.goal.x = cx + Math.sin(this.time * 0.05) * 3;
        rig.goal.z = cz + Math.cos(this.time * 0.04) * 2.5;
      }
      this._overlayT += dt;
      if (this.overlayMode && this._overlayT > 1) { this._overlayT = 0; this.refreshOverlay(); }
      if (this.net) this.net.update(dt);
      if (render) this.cursors.update();
      this.input.update(dt);
      if (!this.demo) this.ui.update(dt);
    }
    if (!render) return;
    this.renderer.updateCamera(dt);
    this.renderer.render();
  }
}
