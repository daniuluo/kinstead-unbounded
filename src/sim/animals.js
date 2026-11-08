// Wildlife and livestock: deer, foxes and rabbits roam the forests and
// meadows, ducks paddle on the water, and sheep, cows and chickens keep to
// the farm fields. Every step is checked against a walkability map so animals
// steer around buildings (with a little clearance), mostly avoid roads and
// track, never wander into water (or, for ducks, out of it), and wild animals
// bolt away from villagers who come too close.

import * as THREE from 'three';
import { BUILDINGS, produceOf } from '../defs.js';
import { GeoBuilder } from '../render/geo.js';
import { RNG } from '../util/rng.js';
import { workArea } from '../render/buildings.js';
import { homeField, plotOf } from '../world/world.js';
import { inRect, toLocal, toWorld, grow } from '../world/geom.js';
import { inArea } from './agents.js';

// speed / run: tiles per second at 1x · walk / idle: seconds · turn: how much
// the heading wanders (radians per second) · per: habitat tiles per animal
const SPECIES = {
  deer: { name: 'Red deer', habitat: 'forest', speed: 0.12, run: 0.8, range: 5, walk: [2, 6], idle: [3, 9], turn: 2.2, flee: 1.3, group: [1, 2], per: 75, max: 6, graze: true },
  fox: { name: 'Fox', habitat: 'forest', speed: 0.15, run: 0.8, range: 8, walk: [2, 5], idle: [2, 6], turn: 2.6, flee: 1.1, group: [1, 1], per: 220, max: 2 },
  rabbit: { name: 'Rabbit', habitat: 'meadow', speed: 0.15, run: 0.8, range: 2.5, walk: [0.6, 2], idle: [2, 7], turn: 3.4, flee: 0.8, group: [1, 2], per: 100, max: 8, hop: true },
  duck: { name: 'Mallard', habitat: 'water', speed: 0.06, run: 0.25, range: 3.5, walk: [2, 6], idle: [3, 8], turn: 1.6, flee: 0.7, group: [2, 3], per: 45, max: 7, swim: true },
  sheep: { name: 'Sheep', habitat: 'farm', speed: 0.05, walk: [1.5, 4], idle: [4, 12], turn: 1.5, graze: true },
  cow: { name: 'Cow', habitat: 'farm', speed: 0.035, walk: [1.5, 4], idle: [6, 16], turn: 1.2, graze: true },
  chicken: { name: 'Chicken', habitat: 'farm', speed: 0.08, walk: [0.5, 1.5], idle: [1, 4], turn: 4, peck: true },
};
// Drawn life-size against the villagers and buildings (a storey is about
// 0.28 units, ~3 m, so 1 m is about 0.093): a cow stands about 1.4 m and is
// 2 m long, a sheep about 1 m, a deer 1.2 m at the shoulder, a fox 0.4 m,
// a chicken or a duck about 0.35 m, a rabbit about 0.25 m.
const SIZE = { deer: 0.95, fox: 0.62, rabbit: 0.48, duck: 0.62, sheep: 0.9, cow: 1.05, chicken: 0.52 };

function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
const KEYS = Object.keys(SPECIES);
const CAP = 160;

function legs(g, w, l, h, color, t = 0.014) {
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.box(sx * w, 0, sz * l, t, h, t, color);
}

const MODELS = {
  deer() {
    const g = new GeoBuilder(), c = '#8a5a36', d = '#4e3322';
    legs(g, 0.022, 0.055, 0.095, d);
    g.cbox(0, 0.085, 0, 0.062, 0.062, 0.165, c, 0, 0.012);
    g.box(0, 0.082, 0, 0.05, 0.012, 0.12, '#c8a27a');
    g.boxC(0, 0.165, 0.072, 0.03, 0.085, 0.032, c, -0.45);
    g.box(0, 0.185, 0.1, 0.036, 0.036, 0.062, c);
    g.box(0, 0.19, 0.135, 0.022, 0.02, 0.012, '#2a1e16');
    for (const s of [-1, 1]) {
      g.box(s * 0.024, 0.215, 0.085, 0.012, 0.02, 0.006, c, 0, 0, s * 0.5);
      g.box(s * 0.012, 0.22, 0.092, 0.006, 0.055, 0.006, '#d8c8a8', 0, 0, s * 0.25);
      g.box(s * 0.022, 0.25, 0.098, 0.005, 0.025, 0.005, '#d8c8a8', 0, -0.5, s * 0.6);
    }
    g.box(0, 0.11, -0.088, 0.016, 0.022, 0.012, '#efe6d6');
    return g.build();
  },
  fox() {
    const g = new GeoBuilder(), c = '#c8642a', d = '#2e241e';
    legs(g, 0.014, 0.035, 0.045, d, 0.011);
    g.cbox(0, 0.042, 0, 0.038, 0.036, 0.1, c, 0, 0.008);
    g.box(0, 0.04, 0.01, 0.03, 0.012, 0.06, '#f0e8dc');
    g.box(0, 0.06, 0.055, 0.034, 0.032, 0.036, c);
    g.box(0, 0.062, 0.08, 0.016, 0.016, 0.024, '#f0e8dc');
    g.box(0, 0.066, 0.092, 0.008, 0.008, 0.006, d);
    for (const s of [-1, 1]) g.box(s * 0.011, 0.092, 0.055, 0.01, 0.02, 0.006, c);
    g.boxC(0, 0.06, -0.075, 0.024, 0.024, 0.07, c, 0.5);
    g.boxC(0, 0.077, -0.104, 0.02, 0.02, 0.022, '#f0e8dc', 0.5);
    return g.build();
  },
  rabbit() {
    const g = new GeoBuilder(), c = '#9a8670';
    g.sphere(0, 0.026, 0, 0.026, c, 1, 0.85);
    g.sphere(0, 0.046, 0.024, 0.016, c, 1);
    for (const s of [-1, 1]) g.box(s * 0.006, 0.055, 0.018, 0.006, 0.03, 0.004, c, 0, -0.3, s * 0.12);
    g.sphere(0, 0.03, -0.026, 0.008, '#f2ede4', 0);
    return g.build();
  },
  duck() {
    const g = new GeoBuilder();
    g.add(new THREE.IcosahedronGeometry(1, 1).deleteAttribute('uv').deleteAttribute('normal'), '#8a7a62',
      new THREE.Matrix4().compose(new THREE.Vector3(0, 0.014, 0), new THREE.Quaternion(), new THREE.Vector3(0.026, 0.018, 0.04)));
    g.box(0, 0.016, -0.03, 0.03, 0.012, 0.02, '#e8e2d6');
    g.box(0, 0.03, 0.026, 0.014, 0.006, 0.008, '#f2ede4');
    g.sphere(0, 0.044, 0.03, 0.014, '#2e6b3a', 1);
    g.box(0, 0.04, 0.046, 0.01, 0.006, 0.014, '#e09a2a');
    return g.build();
  },
  sheep() {
    const g = new GeoBuilder();
    legs(g, 0.018, 0.035, 0.048, '#3a3430', 0.012);
    g.add(new THREE.IcosahedronGeometry(1, 1).deleteAttribute('uv').deleteAttribute('normal'), '#efeae0',
      new THREE.Matrix4().compose(new THREE.Vector3(0, 0.072, 0), new THREE.Quaternion(), new THREE.Vector3(0.042, 0.036, 0.055)));
    g.box(0, 0.068, 0.058, 0.026, 0.03, 0.032, '#3a3430');
    for (const s of [-1, 1]) g.box(s * 0.017, 0.085, 0.058, 0.012, 0.006, 0.01, '#3a3430');
    return g.build();
  },
  cow() {
    const g = new GeoBuilder(), w = '#f0ece4', b = '#2a2624';
    legs(g, 0.026, 0.06, 0.07, '#e8e2d8', 0.016);
    g.cbox(0, 0.068, 0, 0.074, 0.07, 0.16, w, 0, 0.012);
    g.box(0.038, 0.09, 0.02, 0.002, 0.03, 0.05, b);
    g.box(-0.038, 0.08, -0.03, 0.002, 0.035, 0.045, b);
    g.box(0.01, 0.138, -0.04, 0.04, 0.002, 0.05, b);
    g.box(0, 0.09, 0.09, 0.04, 0.042, 0.045, w);
    g.box(0, 0.09, 0.114, 0.034, 0.022, 0.012, '#d8a0a0');
    for (const s of [-1, 1]) { g.box(s * 0.026, 0.128, 0.09, 0.016, 0.006, 0.006, '#e8dcc0'); g.box(s * 0.026, 0.11, 0.084, 0.014, 0.012, 0.006, b); }
    g.box(0, 0.11, -0.082, 0.008, 0.03, 0.006, b, 0, 0.3);
    return g.build();
  },
  chicken() {
    const g = new GeoBuilder();
    for (const s of [-1, 1]) g.box(s * 0.006, 0, 0, 0.004, 0.018, 0.004, '#d8a030');
    g.sphere(0, 0.03, 0, 0.018, '#f2ede0', 1, 0.95);
    g.sphere(0, 0.05, 0.012, 0.011, '#f2ede0', 1);
    g.box(0, 0.06, 0.012, 0.004, 0.01, 0.012, '#c8302a');
    g.box(0, 0.05, 0.024, 0.006, 0.004, 0.008, '#e0a030');
    g.box(0, 0.036, -0.018, 0.012, 0.016, 0.008, '#f2ede0', 0, -0.4);
    return g.build();
  },
};

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color(), _v = new THREE.Vector3();

export class Animals {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    this.list = [];
    this.rng = new RNG((this.world.seed ^ 0xA11) >>> 0);
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 });
    this.meshes = {};
    const scene = game.renderer.scene;
    for (const k of KEYS) {
      const m = new THREE.InstancedMesh(MODELS[k](), this.mat, CAP);
      m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; m.count = 0;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, _c.set('#ffffff'));
      scene.add(m);
      this.meshes[k] = m;
    }
    this.census = 0;
    this.fleeT = 0;
    this.dirty = true;
    const mark = () => { this.dirty = true; };
    for (const e of ['building:add', 'building:remove', 'building:change', 'roads', 'rails', 'trees', 'terrain', 'fields']) this.world.on(e, mark);
    this._reconcile(true);
  }

  dispose() {
    for (const m of Object.values(this.meshes)) { this.game.renderer.scene.remove(m); m.geometry.dispose(); m.dispose(); }
    this.mat.dispose();
  }

  // ------------------------------------------------------------ terrain sense
  // Can animal a stand at (x, z)?
  _tileOk(a, x, z) {
    const w = this.world, t = w.terrain;
    if (!w.inBounds(x, z) || x < 0.05 || z < 0.05 || x > w.N - 0.05 || z > w.N - 0.05) return false;
    const sp = SPECIES[a.sp];
    if (sp.swim) return t.heightAt(x, z) < -0.12 && t.heightAt(x + 0.3, z) < -0.05 && t.heightAt(x - 0.3, z) < -0.05 && t.heightAt(x, z + 0.3) < -0.05 && t.heightAt(x, z - 0.3) < -0.05;
    if (sp.habitat === 'farm') {
      const f = w.buildings.get(a.farm);
      if (!f) return false;
      // its farmland (its own field behind the yard, and its fields), clear
      // of the fence round it; an orchard's hens keep to the orchard
      const land = [homeField(f), ...w.fieldsOf(f.id).map(q => q.rect)].filter(Boolean);
      if (!land.some(R => inRect(R, x, z))) {
        const r = f.work || (f.work = workArea(f));
        if (!r) return false;
        const [lx, lz] = r[4] ? toLocal(r[4], x, z) : [x, z];
        return lx > r[0] + 0.03 && lx < r[2] - 0.03 && lz > r[1] + 0.03 && lz < r[3] - 0.03;
      }
      // (inside the fence: within its field, or across into the next)
      return land.some(R => inRect(R, x, z, -0.08)) || land.filter(R => inRect(R, x, z, 0.02)).length > 1;
    }
    if (w.waterAt(x, z) || t.heightAt(x, z) < 0.05) return false;
    if (w.railAt(x, z, 0.08) || w.fieldAt(x, z)) return false;
    if (w.roadAt(x, z, 0.05) && !a.crossing) return false;
    // keep clear of plots, their walls and fences
    for (const b of w.plots.near(x, z, 0.2)) if (inRect(plotOf(b), x, z, 0.16)) return false;
    // not on a cliff
    const s = Math.abs(t.heightAt(x + 0.25, z) - t.heightAt(x - 0.25, z)) + Math.abs(t.heightAt(x, z + 0.25) - t.heightAt(x, z - 0.25));
    return s < 0.95;
  }

  // Is the straight walk from a to (x, z) clear? Returns 'road' if it crosses one.
  _lineOk(a, x, z) {
    const dx = x - a.x, dz = z - a.z, L = Math.hypot(dx, dz);
    const n = Math.max(1, Math.ceil(L / 0.12));
    let road = false;
    const w = this.world;
    for (let k = 1; k <= n; k++) {
      const px = a.x + (dx * k) / n, pz = a.z + (dz * k) / n;
      if (w.roadAt(px, pz, 0.05) && SPECIES[a.sp].habitat !== 'farm' && !SPECIES[a.sp].swim) {
        road = true;
        const saved = a.crossing; a.crossing = true;
        const ok = this._tileOk(a, px, pz);
        a.crossing = saved;
        if (!ok) return false;
        continue;
      }
      if (!this._tileOk(a, px, pz)) return false;
    }
    return road ? 'road' : true;
  }

  _pickTarget(a, awayFrom = null) {
    const sp = SPECIES[a.sp], r = this.rng, w = this.world;
    for (let tries = 0; tries < 12; tries++) {
      let x, z;
      if (awayFrom) {
        const base = Math.atan2(a.x - awayFrom.x, a.z - awayFrom.z) + (tries ? (tries % 2 ? 1 : -1) * Math.ceil(tries / 2) * 0.45 : 0);
        const d = 1.4 + r.next() * 1.4;
        x = a.x + Math.sin(base) * d; z = a.z + Math.cos(base) * d;
      } else if (sp.habitat === 'farm') {
        const f = w.buildings.get(a.farm);
        if (!f || !f.work) return false;
        const q = f.work, fields = w.fieldsOf(f.id);
        if (fields.length && r.next() < 0.6) {
          // wander out into the fields
          const F = fields[(r.next() * fields.length) | 0];
          [x, z] = toWorld(F.rect, (r.next() - 0.5) * 0.76, (r.next() - 0.5) * 0.76);
        } else [x, z] = inArea(q, q[0] + 0.05 + r.next() * (q[2] - q[0] - 0.1), q[1] + 0.05 + r.next() * (q[3] - q[1] - 0.1));
        if (Math.hypot(x - a.x, z - a.z) > 0.9) { const k = 0.9 / Math.hypot(x - a.x, z - a.z); x = a.x + (x - a.x) * k; z = a.z + (z - a.z) * k; }
      } else {
        const ang = r.next() * Math.PI * 2, d = 0.4 + r.next() * sp.range;
        x = a.hx + Math.sin(ang) * d; z = a.hz + Math.cos(ang) * d;
        if (Math.hypot(x - a.x, z - a.z) > 2.5) { const k = 2.5 / Math.hypot(x - a.x, z - a.z); x = a.x + (x - a.x) * k; z = a.z + (z - a.z) * k; }
        // forest animals prefer to stay near trees
        if (sp.habitat === 'forest' && tries < 8 && !this._nearTrees(x, z)) continue;
      }
      if (!this._tileOk(a, x, z)) continue;
      const line = this._lineOk(a, x, z);
      if (!line) continue;
      if (line === 'road' && !awayFrom && r.next() > 0.12) continue; // roads are crossed only now and then
      a.crossing = line === 'road';
      a.tx = x; a.tz = z;
      return true;
    }
    return false;
  }

  _nearTrees(x, z) { return this.world.treeIx.near(x, z, 1.2).length > 0; }

  // ------------------------------------------------------------ population
  _habitats() {
    const w = this.world, t = w.terrain, N = w.N;
    const forest = [], meadow = [], water = [];
    // (a unit square of ground at a time: wild land well away from the town)
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
      if (t.isWater(x, z)) { if (t.tileAvg(x, z) < -0.15) water.push([x, z]); continue; }
      const cx = x + 0.5, cz = z + 0.5;
      if (t.slope(x, z) > 0.7 || w.roadAt(cx, cz, 0.4) || w.railAt(cx, cz, 0.4) || w.plots.near(cx, cz, 2).length) continue;
      if (w.treeIx.near(cx, cz, 0.5).length) forest.push([x, z]);
      else if (t.tileAvg(x, z) > 0.2 && t.tileAvg(x, z) < 2) meadow.push([x, z]);
    }
    return { forest, meadow, water };
  }

  _spawn(sp, x, z, extra = {}) {
    const r = this.rng;
    const a = {
      sp, x, z, hx: x, hz: z, tx: x, tz: z, h: r.next() * Math.PI * 2, state: 'idle', t: r.next() * 3,
      phase: r.next() * 6, crossing: false, graze: 0,
      s: 0.9 + r.next() * 0.2,
      tint: sp === 'chicken' && r.next() < 0.45 ? [0.72, 0.48, 0.3] : sp === 'sheep' && r.next() < 0.08 ? [0.3, 0.28, 0.27] : [0.92 + r.next() * 0.16, 0.92 + r.next() * 0.16, 0.92 + r.next() * 0.16],
      ...extra,
    };
    if (!this._tileOk(a, x, z)) return null;
    this.list.push(a);
    return a;
  }

  _reconcile(initial = false) {
    const w = this.world, r = this.rng;
    this.dirty = false;
    // drop or rescue animals whose spot became unusable (a building went up, a farm was removed...)
    this.list = this.list.filter((a) => {
      if (this._tileOk(a, a.x, a.z) || (a.crossing && this._lineOk(a, a.tx, a.tz))) return true;
      for (let k = 0; k < 16; k++) {
        const ang = k * 0.8, d = 0.3 + k * 0.12;
        const x = a.x + Math.sin(ang) * d, z = a.z + Math.cos(ang) * d;
        if (this._tileOk(a, x, z)) { a.x = x; a.z = z; a.state = 'idle'; a.t = 0.5; return true; }
      }
      return false;
    });
    // livestock per farm
    const want = new Map();
    for (const b of w.buildings.values()) {
      if (!BUILDINGS[b.type].fields || (b.con && b.con.kind !== 'upgrade')) continue;
      b.work = workArea(b);
      // a few of each on mixed farms, herds on livestock farms (more with more fields)
      const P = produceOf(b), n = b.fields || 0;
      want.set(b.id, P.animal === 'sheep' ? { chicken: 1, sheep: Math.min(14, 3 + b.level + (n >> 1)), cow: 0 }
        : P.animal === 'cow' ? { chicken: 1, sheep: 0, cow: Math.min(10, 2 + b.level + Math.floor(n / 3)) }
          : P.animal === 'chicken' ? { chicken: Math.min(18, 5 + b.level * 2 + n), sheep: 0, cow: 0 }
            : P.name === 'Mixed farming' ? { chicken: 2, sheep: b.level >= 1 ? 2 + (n >> 3) : 0, cow: b.level >= 2 ? 1 : 0 } : { chicken: 2, sheep: 0, cow: 0 });
    }
    const have = new Map();
    for (const a of this.list) if (a.farm != null) {
      const h = have.get(a.farm) || { chicken: 0, sheep: 0, cow: 0 };
      h[a.sp]++; have.set(a.farm, h);
    }
    this.list = this.list.filter(a => a.farm == null || want.has(a.farm));
    // a farm that has changed what it keeps sends the extra animals away
    for (const [id, h] of have) {
      const wn = want.get(id);
      if (!wn) continue;
      for (const sp of ['chicken', 'sheep', 'cow']) {
        let extra = h[sp] - wn[sp];
        if (extra > 0) this.list = this.list.filter(a => !(a.farm === id && a.sp === sp && extra-- > 0));
        h[sp] = Math.min(h[sp], wn[sp]);
      }
    }
    for (const [id, wn] of want) {
      const f = w.buildings.get(id), q = f.work;
      const h = have.get(id) || { chicken: 0, sheep: 0, cow: 0 };
      for (const sp of ['chicken', 'sheep', 'cow']) {
        for (let k = h[sp]; k < wn[sp]; k++) {
          for (let t = 0; t < 6; t++) {
            // in the farm's own field, or out in one of the others
            const fields = w.fieldsOf(id);
            if (fields.length && r.next() < 0.6) {
              const F = fields[(r.next() * fields.length) | 0];
              if (this._spawn(sp, ...toWorld(F.rect, (r.next() - 0.5) * 0.7, (r.next() - 0.5) * 0.7), { farm: id })) break;
            } else if (this._spawn(sp, ...inArea(q, q[0] + 0.1 + r.next() * (q[2] - q[0] - 0.2), q[1] + 0.1 + r.next() * (q[3] - q[1] - 0.2)), { farm: id })) break;
          }
        }
      }
    }
    // wildlife in proportion to the forest, meadows and water left untouched
    const hab = this._habitats();
    const count = {};
    for (const a of this.list) count[a.sp] = (count[a.sp] || 0) + 1;
    for (const sp of ['deer', 'fox', 'rabbit', 'duck']) {
      const S = SPECIES[sp];
      const tiles = hab[S.habitat];
      const target = Math.min(S.max, Math.floor(tiles.length / S.per));
      let n = count[sp] || 0;
      let budget = initial ? 99 : 3;
      while (n < target && budget-- > 0 && tiles.length) {
        const [x, z] = tiles[(r.next() * tiles.length) | 0];
        const g = S.group[0] + ((r.next() * (S.group[1] - S.group[0] + 1)) | 0);
        for (let k = 0; k < g && n < target; k++) {
          if (this._spawn(sp, x + 0.25 + r.next() * 0.5, z + 0.25 + r.next() * 0.5)) n++;
        }
      }
      // too many for what's left of their habitat: some wander off
      if (n > target + 2) {
        let extra = n - target;
        this.list = this.list.filter(a => !(a.sp === sp && extra-- > 0));
      }
    }
  }

  // -------------------------------------------------------------- update
  update(dt, gameSpeed) {
    const speed = Math.min(gameSpeed, 6);
    this.census += dt;
    if (this.census > 4 || (this.dirty && this.census > 0.5)) { this.census = 0; this._reconcile(); }
    if (speed > 0) {
      // wild animals keep an eye out for villagers
      this.fleeT += dt;
      if (this.fleeT > 0.25) {
        this.fleeT = 0;
        const walkers = [...this.game.agents.walkers].filter(wk => wk.delay === undefined || wk.delay <= 0);
        for (const a of this.list) {
          const sp = SPECIES[a.sp];
          if (!sp.flee || a.state === 'flee') continue;
          for (const wk of walkers) {
            if (Math.abs(wk.x - a.x) < sp.flee && Math.abs(wk.z - a.z) < sp.flee && Math.hypot(wk.x - a.x, wk.z - a.z) < sp.flee) {
              if (this._pickTarget(a, wk)) { a.state = 'flee'; a.hx = a.tx; a.hz = a.tz; }
              break;
            }
          }
        }
      }
      for (const a of this.list) {
        const sp = SPECIES[a.sp];
        const r = this.rng;
        if (a.state === 'idle') {
          a.t -= dt * speed;
          a.graze = (sp.graze || sp.peck) ? Math.min(1, a.graze + dt * 2) : 0;
          if (a.t <= 0) {
            a.state = 'walk';
            a.graze = 0;
            a.t = sp.walk[0] + r.next() * (sp.walk[1] - sp.walk[0]);
            a.wh = a.h + (r.next() - 0.5) * 2.4;
            // wild animals only rarely wander across a road
            a.crossing = !sp.swim && sp.habitat !== 'farm' && r.next() < 0.08;
          }
          continue;
        }
        if (a.state === 'flee') {
          const v = sp.run * dt * speed;
          const dx = a.tx - a.x, dz = a.tz - a.z, d = Math.hypot(dx, dz);
          if (d <= v) { a.x = a.tx; a.z = a.tz; this._rest(a); continue; }
          const nx = a.x + (dx / d) * v, nz = a.z + (dz / d) * v;
          if (!this._tileOk(a, nx, nz)) { this._rest(a, 0.4); continue; }
          a.x = nx; a.z = nz;
          a.h += angDiff(Math.atan2(dx, dz), a.h) * Math.min(1, dt * 8);
          a.phase += dt * speed * 18 * (sp.hop ? 0.6 : 1);
          continue;
        }
        // walking: the heading drifts at random, with a gentle pull back home
        a.t -= dt * speed;
        if (a.t <= 0) { this._rest(a); continue; }
        a.wh += (r.next() - 0.5) * sp.turn * 2 * Math.sqrt(dt * speed);
        if (sp.range) {
          const hx = a.hx - a.x, hz = a.hz - a.z;
          if (Math.hypot(hx, hz) > sp.range) a.wh += angDiff(Math.atan2(hx, hz), a.wh) * Math.min(1, dt * speed * 0.6);
        }
        a.h += angDiff(a.wh, a.h) * Math.min(1, dt * 2.5);
        const v = sp.speed * dt * speed;
        if (this._clear(a, a.h)) {
          a.x += Math.sin(a.h) * v;
          a.z += Math.cos(a.h) * v;
          a.phase += dt * speed * 10 * (sp.hop ? 0.6 : 1);
        } else {
          // blocked: look for the nearest open direction, or stop and graze
          const nh = this._freeHeading(a);
          if (nh === null) this._rest(a, 0.5);
          else { a.wh = nh; a.h += angDiff(nh, a.h) * 0.35; }
        }
      }
    }
    this._render();
  }

  _render() {
    const t = this.world.terrain;
    const counts = {};
    for (const k of KEYS) counts[k] = 0;
    const now = performance.now() * 0.001;
    for (const a of this.list) {
      const sp = SPECIES[a.sp], mesh = this.meshes[a.sp];
      const i = counts[a.sp]++;
      if (i >= CAP) continue;
      const moving = a.state !== 'idle';
      let y = sp.swim ? -0.02 + Math.sin(now * 2 + a.phase) * 0.006 : t.heightAt(a.x, a.z) + 0.004;
      let pitch = 0;
      if (moving && !sp.swim) {
        y += sp.hop ? Math.abs(Math.sin(a.phase)) * 0.028 : Math.abs(Math.sin(a.phase)) * 0.004;
        if (sp.hop) pitch = -Math.cos(a.phase) * 0.25;
      } else if (a.graze > 0) {
        pitch = sp.peck ? Math.max(0, Math.sin(now * 9 + a.phase)) * 0.6 * a.graze : (0.18 + Math.sin(now * 0.8 + a.phase) * 0.06) * a.graze;
      }
      _q.setFromEuler(_e.set(pitch, a.h, 0, 'YXZ'));
      _p.set(a.x, y, a.z);
      _s.setScalar(a.s * (SIZE[a.sp] ?? 0.8));
      mesh.setMatrixAt(i, _m.compose(_p, _q, _s));
      mesh.setColorAt(i, _c.setRGB(a.tint[0], a.tint[1], a.tint[2]));
    }
    for (const k of KEYS) {
      const m = this.meshes[k];
      m.count = Math.min(CAP, counts[k]);
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  _rest(a, t = null) {
    const sp = SPECIES[a.sp];
    a.state = 'idle';
    a.t = t ?? sp.idle[0] + this.rng.next() * (sp.idle[1] - sp.idle[0]);
    // never stop in the middle of a road: finish crossing first
    const w = this.world, tx = Math.floor(a.x), tz = Math.floor(a.z);
    if (a.crossing && w.roadAt(a.x, a.z, 0.05)) { a.state = 'walk'; a.t = 1.5; return; }
    a.crossing = false;
  }

  // Is the ground just ahead (a step and a bit beyond) somewhere it may go?
  _clear(a, h) {
    for (const d of [0.08, 0.2]) {
      if (!this._tileOk(a, a.x + Math.sin(h) * d, a.z + Math.cos(h) * d)) return false;
    }
    return true;
  }

  _freeHeading(a) {
    const side = this.rng.next() < 0.5 ? 1 : -1;
    for (let k = 1; k <= 6; k++) {
      for (const sgn of [side, -side]) {
        const h = a.h + sgn * k * 0.5;
        if (this._clear(a, h)) return h;
      }
    }
    return null;
  }

  pick(clientX, clientY) {
    let best = null, bd = 14;
    for (const a of this.list) {
      _v.set(a.x, this.world.terrain.heightAt(a.x, a.z) + 0.05, a.z);
      const p = this.game.renderer.worldToScreen(_v);
      if (p.behind) continue;
      const d = Math.hypot(p.x - clientX, p.y - clientY);
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }

  describe(a) {
    const sp = SPECIES[a.sp];
    const doing = a.state === 'flee' ? 'startled!' : a.state === 'walk' ? (sp.swim ? 'paddling' : 'wandering') : sp.swim ? 'bobbing on the water' : sp.peck ? 'pecking at seeds' : sp.graze ? 'grazing' : 'resting';
    return `${sp.name} · ${doing}`;
  }
}
