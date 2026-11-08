// Terrain: a finely subdivided, smooth-shaded surface whose vertex colours are
// "painted" — grass, sand and rock blend softly, and roads, rails, yards and
// farm fields are painted straight into the ground for a rustic, organic look.

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { MAT } from './materials.js';
import { BUILDINGS, produceOf } from '../defs.js';
import { makeNoise2D, fbm, hash2, clamp, smoothstep } from '../util/rng.js';
import { doorPoint, farmlandOf, plotOf, ownPlot, HALF } from '../world/world.js';
import { aabbOf, toLocal, rectDist } from '../world/geom.js';
import { primsIn, fieldAt } from '../world/streets.js';
import { roadSquares } from './roadsView.js';

export const SUB = 5;
const BASE_Y = -2.2;
const C = (h) => new THREE.Color(h);

const GRASS = [
  { a: C('#8db25a'), b: C('#5c8a3c'), meadow: C('#b8b56a'), dry: C('#a8a058') },  // spring
  { a: C('#84a84e'), b: C('#557f36'), meadow: C('#b3a85a'), dry: C('#a39752') },  // summer
  { a: C('#9aa055'), b: C('#77803f'), meadow: C('#b99a52'), dry: C('#a98a4c') },  // autumn
  { a: C('#909478'), b: C('#757c62'), meadow: C('#a29f86'), dry: C('#97907a') },  // winter
];
const SAND = C('#d2bf8c'), MUD = C('#958564'), DEEP = C('#5f5a48');
const ROCK_A = C('#9a948a'), ROCK_B = C('#7d776e');
const SOIL_T = C('#7a5a3c'), SOIL_B = C('#5a432f'), ROCK_S = C('#6e655a'), ROCK_S2 = C('#4e473f');
const DIRT = [C('#86663f'), C('#957349'), C('#a3825a'), C('#6f553a')];
const COBBLE = [C('#9d968a'), C('#857e72'), C('#aaa395'), C('#6e675c')];
const PAVED = [C('#827e78'), C('#78746f'), C('#cbbfa8'), C('#b3a890')];
const GRAVEL = [C('#8d8477'), C('#7a7166')];
const YARD = C('#a79064'), PACKED = C('#9a845f'), LAWN = C('#7fae4f'), STONE = C('#b4ac9d'), STONE2 = C('#a29a8b');
const SOIL = C('#6e5235'), SOIL_D = C('#5c442c');
const CROPS = [
  [C('#86b65a'), C('#9cc46a'), C('#7aa752')],
  [C('#d4b24e'), C('#7fae4f'), C('#c9a24a')],
  [C('#c79a45'), C('#b58a42'), C('#a8853f')],
  [C('#6f5a44'), C('#6a5640'), C('#74604a')],
];

// grazed grass for livestock, by season, and each crop's colours (cached)
const PASTURE = [[C('#86b45a'), C('#6f9e48')], [C('#7fa94c'), C('#6a9442')], [C('#93a052'), C('#7d8a45')], [C('#8a8f72'), C('#767c62')]];
const cropCols = new Map();
const cropOf = (P, season) => {
  if (!P.crop || season === 3) return CROPS[season];
  const k = P.name + season;
  if (!cropCols.has(k)) { const [c0, c1] = P.crop[season]; cropCols.set(k, [C(c0), C(c1), C(c0)]); }
  return cropCols.get(k);
};

const _a = new THREE.Color(), _b = new THREE.Color();

function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz;
  let t = L2 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = px - ax - dx * t, ez = pz - az - dz * t;
  return Math.sqrt(ex * ex + ez * ez);
}

export class TerrainView {
  constructor(world, scene) {
    this.world = world;
    this.scene = scene;
    this.season = 1;
    this.seasonW = 0;
    this._pending = [];
    this._areas = new Map();
    this.n1 = makeNoise2D(world.seed + 11);
    this.n2 = makeNoise2D(world.seed + 12);
    this.n3 = makeNoise2D(world.seed + 13);
    this.group = new THREE.Group();
    scene.add(this.group);
    const N = world.N, V = N * SUB + 1;
    this.V = V;
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(V * V * 3);
    this.col = new Float32Array(V * V * 3);
    this.snow = new Float32Array(V * V).fill(1);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('snowMask', new THREE.BufferAttribute(this.snow, 1));
    const idx = new Uint32Array((V - 1) * (V - 1) * 6);
    let k = 0;
    for (let j = 0; j < V - 1; j++) for (let i = 0; i < V - 1; i++) {
      const a = j * V + i, b = (j + 1) * V + i, c = (j + 1) * V + i + 1, d = j * V + i + 1;
      idx[k++] = a; idx[k++] = b; idx[k++] = c; idx[k++] = a; idx[k++] = c; idx[k++] = d;
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.surface = new THREE.Mesh(geo, MAT.terrain);
    this.surface.receiveShadow = true;
    this.surface.castShadow = true;
    this.surface.name = 'terrain';
    this.sides = new THREE.Mesh(new THREE.BufferGeometry(), MAT.side);
    this.sides.receiveShadow = true;
    this.water = this._buildWater();
    this.waterSides = new THREE.Mesh(new THREE.BufferGeometry(), MAT.waterSide);
    this.group.add(this.surface, this.sides, this.water, this.waterSides);
    this.rebuild();
  }

  setSeason(s, w = 0) {
    if (s === this.season && w === (this.seasonW || 0)) return;
    this.season = s;
    this.seasonW = w;
    this.repaint();
  }

  // This season's grass, shading towards the next's.
  _grass() {
    const A = GRASS[this.season], B = GRASS[(this.season + 1) % 4], w = this.seasonW || 0;
    if (!w) return A;
    return { a: A.a.clone().lerp(B.a, w), b: A.b.clone().lerp(B.b, w), meadow: A.meadow.clone().lerp(B.meadow, w), dry: A.dry.clone().lerp(B.dry, w) };
  }

  rebuild() {
    const { terrain: t } = this.world;
    const V = this.V;
    for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
      const x = i / SUB, z = j / SUB, o = (j * V + i) * 3;
      this.pos[o] = x; this.pos[o + 1] = t.heightAt(x, z); this.pos[o + 2] = z;
    }
    const g = this.surface.geometry;
    g.attributes.position.needsUpdate = true;
    g.computeVertexNormals();
    g.computeBoundingSphere();
    g.computeBoundingBox();
    this._shapeNoise();
    this.repaint();
    this._buildSides();
  }

  // The parts of the ground colour that only depend on the lie of the land
  // (its noise, slope and rock), worked out once for each shape of the
  // terrain, so a repaint (a season step, a new building) only mixes colours.
  _shapeNoise() {
    const V = this.V, P = this.pos, n = V * V, step = 1 / SUB;
    const N1 = this._n1 = new Float64Array(n), MEAD = this._mead = new Float64Array(n);
    const ROCK = this._rock = new Float64Array(n), FINE = this._fine = new Float64Array(n);
    for (let j = 0; j < V; j++) {
      for (let i = 0; i < V; i++) {
        const vi = j * V + i, o = vi * 3;
        const x = i * step, z = j * step, h = P[o + 1];
        const hl = P[(j * V + Math.max(0, i - 1)) * 3 + 1], hr = P[(j * V + Math.min(V - 1, i + 1)) * 3 + 1];
        const hu = P[(Math.max(0, j - 1) * V + i) * 3 + 1], hd = P[(Math.min(V - 1, j + 1) * V + i) * 3 + 1];
        const slope = Math.hypot(hr - hl, hd - hu) / (2 * step);
        N1[vi] = Math.min(1, Math.max(0, fbm(this.n1, x * 0.13, z * 0.13, 3) * 0.75 + 0.5));
        const n2 = this.n2(x * 0.07, z * 0.07);
        MEAD[vi] = n2 > 0.3 ? Math.min(0.55, (n2 - 0.3) * 1.8) : 0;
        ROCK[vi] = Math.max(smoothstep(0.55, 0.95, slope), smoothstep(2.4, 3.2, h));
        FINE[vi] = 1 + (this.n3(x * 1.7, z * 1.7) * 0.5 + hash2(i, j, 5) - 0.5) * 0.07;
      }
    }
  }

  // ------------------------------------------------------------ painting
  // The ground's colour everywhere, or (area: [x0, z0, x1, z1] in tiles)
  // just there: every layer is worked out per point, so a part repainted
  // comes out exactly as a whole repaint would.
  repaint(area = null) {
    const w = this.world, N = w.N, V = this.V;
    const P = this.pos, col = this.col, snow = this.snow;
    const g = this._grass();
    const N1 = this._n1, MEAD = this._mead, ROCK = this._rock, FINE = this._fine;
    const i0 = area ? Math.max(0, Math.floor(area[0] * SUB)) : 0, i1 = area ? Math.min(V - 1, Math.ceil(area[2] * SUB)) : V - 1;
    const j0 = area ? Math.max(0, Math.floor(area[1] * SUB)) : 0, j1 = area ? Math.min(V - 1, Math.ceil(area[3] * SUB)) : V - 1;
    if (i0 > i1 || j0 > j1) return;
    this._clip = area ? [i0, i1, j0, j1] : null;
    if (!area) {
      // everything is up to date after this
      this._pending = [];
      this._areas = new Map();
      for (const b of w.buildings.values()) this._areas.set(b.id, TerrainView.areaOf(b));
    }
    // smooth tree-density field at the corners of each unit square
    const count = new Uint8Array(N * N);
    for (const tr of w.trees) { const tx = Math.floor(tr.x), tz = Math.floor(tr.z); if (tx >= 0 && tz >= 0 && tx < N && tz < N && count[tz * N + tx] < 255) count[tz * N + tx]++; }
    const forest = new Float32Array((N + 1) * (N + 1));
    for (let z = 0; z <= N; z++) for (let x = 0; x <= N; x++) {
      let s = 0;
      for (const [dx, dz] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) { const tx = x + dx, tz = z + dz; if (tx >= 0 && tz >= 0 && tx < N && tz < N) s += Math.min(3, count[tz * N + tx]); }
      forest[z * (N + 1) + x] = s / 4;
    }
    const forestAt = (x, z) => {
      const fx = Math.min(N - 1e-4, x), fz = Math.min(N - 1e-4, z);
      const ix = Math.floor(fx), iz = Math.floor(fz), u = fx - ix, v = fz - iz, S1 = N + 1;
      return (forest[iz * S1 + ix] * (1 - u) + forest[iz * S1 + ix + 1] * u) * (1 - v) + (forest[(iz + 1) * S1 + ix] * (1 - u) + forest[(iz + 1) * S1 + ix + 1] * u) * v;
    };
    const step = 1 / SUB;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const vi = j * V + i, o = vi * 3;
        const x = i * step, z = j * step, h = P[o + 1];
        // grass
        _a.copy(g.a).lerp(g.b, N1[vi]);
        if (MEAD[vi] > 0) _a.lerp(g.meadow, MEAD[vi]);
        const fo = forestAt(x, z);
        if (fo > 0) _a.lerp(g.b, Math.min(0.45, fo * 0.3)).multiplyScalar(1 - Math.min(0.12, fo * 0.06));
        _a.lerp(g.dry, smoothstep(0.35, 0.0, h) * 0.3);
        // rock on steep or high ground
        const rock = ROCK[vi];
        if (rock > 0) { _b.copy(ROCK_A).lerp(ROCK_B, hash2(i >> 1, j >> 1, 9)); _a.lerp(_b, rock); }
        if (h > 1.9) _a.lerp(ROCK_A, smoothstep(1.9, 3.0, h) * 0.3);
        // shores and lake beds
        const wl = CONFIG.WATER_LEVEL;
        if (h < wl + 0.22) _a.lerp(SAND, smoothstep(wl + 0.22, wl + 0.06, h) * 0.85);
        if (h < wl) { _b.copy(MUD).lerp(DEEP, clamp(-h / 0.8, 0, 1)); _a.lerp(_b, smoothstep(wl, wl - 0.15, h)); }
        const f = FINE[vi];
        col[o] = _a.r * f; col[o + 1] = _a.g * f; col[o + 2] = _a.b * f;
        snow[vi] = 1;
      }
    }
    this._paintBuildings();
    this._paintFields();
    this._paintRoads();
    this._paintRails();
    this._clip = null;
    const geo = this.surface.geometry, C = geo.attributes.color, S = geo.attributes.snowMask;
    // a part repainted only sends its own rows to the graphics card
    if (area) { C.addUpdateRange(j0 * V * 3, (j1 - j0 + 1) * V * 3); S.addUpdateRange(j0 * V, (j1 - j0 + 1) * V); }
    else { C.clearUpdateRanges(); S.clearUpdateRanges(); }
    C.needsUpdate = true;
    S.needsUpdate = true;
  }

  // Where a building paints the ground (its yard and the path from its
  // door to the street), as it stands now: [x0, z0, x1, z1].
  static areaOf(b) { return aabbOf(plotOf(b), 2); }

  // A building has come, gone or changed: the ground where it stood and
  // where it stands now wants repainting (see repaintPending).
  markBuilding(b, gone = false) {
    const was = this._areas.get(b.id), now = gone ? null : TerrainView.areaOf(b);
    if (was) this._pending.push(was);
    if (now) this._pending.push(now);
    if (gone) this._areas.delete(b.id); else this._areas.set(b.id, now);
  }

  get pending() { return this._pending.length > 0; }

  // Repaint the ground marked by markBuilding: each patch on its own (those
  // that overlap as one), or the lot when that's most of the map.
  repaintPending() {
    const list = this._pending;
    if (!list.length) return;
    this._pending = [];
    const out = [];
    for (let a of list) {
      for (let k = 0; k < out.length; k++) {
        const o = out[k];
        if (a[0] > o[2] || o[0] > a[2] || a[1] > o[3] || o[1] > a[3]) continue;
        a = [Math.min(a[0], o[0]), Math.min(a[1], o[1]), Math.max(a[2], o[2]), Math.max(a[3], o[3])];
        out.splice(k, 1);
        k = -1;
      }
      out.push(a);
    }
    const N = this.world.N;
    if (out.length > 8 || out.reduce((s, a) => s + (a[2] - a[0]) * (a[3] - a[1]), 0) > N * N * 0.3) { this.repaint(); return; }
    for (const a of out) this.repaint(a);
  }

  // One point of farmland: furrows of a crop (or the season's bare soil), or
  // grazed grass for livestock. lx, lz: where it lies across and along the farm.
  _fieldPaint(vi, i, j, P, season, lx, lz, E, a) {
    // shading from this season into the next as it turns (see setSeason)
    const next = (season + 1) % 4, sw = this.seasonW || 0;
    const bare = (season === 3 ? 1 - sw : 0) + (next === 3 ? sw : 0);
    if (P.kind === 'livestock' || P.kind === 'orchard') {
      const k = this.n3(i * 0.31, j * 0.31) * 0.5 + 0.5;
      const [g0, g1] = PASTURE[season], [n0, n1] = PASTURE[next];
      _b.copy(g0).lerp(g1, k);
      _a.copy(n0).lerp(n1, k);
      _b.lerp(_a, sw);
      // an orchard's grass is a little darker in the shade along its rows of trees
      if (P.kind === 'orchard') { const d = (((lz + 0.75) % 0.42) + 0.42) % 0.42; if (d < 0.1 || d > 0.32) _b.multiplyScalar(0.9); }
      this._blend(vi, _b, a * 0.85);
      return;
    }
    const row = Math.floor((lz + 10) / 0.2 + 1e-4) % 2;
    const plot = Math.floor((lx + E) / ((2 * E) / 3));
    const k = ((plot % 3) + 3) % 3;
    _b.copy(SOIL).lerp(SOIL_D, hash2(i, j, 2) * 0.6);
    if (row === 0) { this._blend(vi, _b, a, 0.9); return; }
    // the furrows go to bare earth for the winter and come back in spring
    _a.copy(cropOf(P, season)[k]).lerp(cropOf(P, next)[k], sw).lerp(_b, bare);
    this._blend(vi, _a, a, bare > 0.5 ? 0.9 : 1);
  }

  // A farm's farmland: its own field behind the yard and its fields beyond
  // the plot, furrowed as one in the farm's frame, with soft edges where it
  // meets anything else (the yard too).
  _paintFields() {
    const w = this.world, season = this.season;
    for (const farm of w.buildings.values()) {
      if (!BUILDINGS[farm.type].fields) continue;
      const land = farmlandOf(w, farm);
      if (!land.length) continue;
      const P = produceOf(farm), F = ownPlot(farm);
      // (each point once, however many of the farm's fields it is near: soft
      // only at the edge of the farmland as a whole)
      const done = new Set();
      for (const R of land) {
        const [x0, z0, x1, z1] = aabbOf(R, 0.1);
        this._range(x0, z0, x1, z1, (vi, px, pz, i, j) => {
          if (done.has(vi)) return;
          let out = Infinity;
          for (const Q of land) { out = Math.min(out, rectDist(Q, px, pz)); if (!out) break; }
          if (out > 0.1) return;
          done.add(vi);
          const a = smoothstep(0.1, -0.02, out);
          const [lx, lz] = toLocal(F, px, pz);
          this._fieldPaint(vi, i, j, P, season, lx, lz, 1, a);
        });
      }
    }
  }

  _range(x0, z0, x1, z1, fn) {
    const V = this.V, c = this._clip;
    let i0 = Math.max(0, Math.floor(x0 * SUB)), i1 = Math.min(V - 1, Math.ceil(x1 * SUB));
    let j0 = Math.max(0, Math.floor(z0 * SUB)), j1 = Math.min(V - 1, Math.ceil(z1 * SUB));
    // (only the part being repainted)
    if (c) { i0 = Math.max(i0, c[0]); i1 = Math.min(i1, c[1]); j0 = Math.max(j0, c[2]); j1 = Math.min(j1, c[3]); }
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * V + i, i / SUB, j / SUB, i, j);
  }

  _blend(vi, color, a, snowK = null) {
    if (a <= 0.001) return;
    const o = vi * 3, c = this.col;
    c[o] += (color.r - c[o]) * a; c[o + 1] += (color.g - c[o + 1]) * a; c[o + 2] += (color.b - c[o + 2]) * a;
    if (snowK !== null) this.snow[vi] += (snowK - this.snow[vi]) * a;
  }

  _paintBuildings() {
    const w = this.world, season = this.season, next = (season + 1) % 4, sw = this.seasonW || 0;
    // fields go to bare earth for the winter, and come back in spring
    const bare = (season === 3 ? 1 - sw : 0) + (next === 3 ? sw : 0);
    for (const b of w.buildings.values()) {
      const def = BUILDINGS[b.type];
      const R = plotOf(b), Ex = R.hw, Ez = R.hd;
      const kind = b.con && b.con.kind !== 'upgrade' ? 'packed' : def.ground ? def.ground : def.fields && !def.fruit ? 'farm' : b.type === 'plaza' ? 'plaza'
        : (b.type === 'lumber' || b.type === 'workshop') ? 'packed'
          : (def.park && b.type !== 'plaza') ? 'lawn'
            : (b.type === 'station' || b.type === 'coachstop' || def.seat) ? 'stone' : 'yard';
      const [ax0, az0, ax1, az1] = aabbOf(R, 0.14);
      this._range(ax0, az0, ax1, az1, (vi, x, z, i, j) => {
        const [lx, lz] = toLocal(R, x, z);
        const edge = Math.min(Ex - Math.abs(lx), Ez - Math.abs(lz));
        const nz = this.n3(x * 2.3, z * 2.3) * 0.06;
        let a;
        switch (kind) {
          case 'plaza': case 'stone': {
            a = smoothstep(-0.02, 0.07, edge + nz * 0.5) * (kind === 'stone' ? 0.75 : 1);
            _b.copy(STONE).lerp(STONE2, hash2(i, j, 3));
            this._blend(vi, _b, a, 0.55);
            break;
          }
          case 'packed': a = smoothstep(-0.08, 0.2, edge + nz) * 0.85; this._blend(vi, PACKED, a, 0.7); break;
          case 'lawn': a = smoothstep(-0.1, 0.18, edge + nz) * 0.55; this._blend(vi, LAWN, a); break;
          case 'farm': {
            a = smoothstep(-0.08, 0.18, edge + nz) * 0.6;
            // (its field behind the yard is painted with its other fields)
            this._blend(vi, YARD, a * 0.5);
            break;
          }
          default: {
            a = smoothstep(-0.12, 0.25, edge + nz) * 0.32;
            _b.copy(YARD);
            this._blend(vi, _b, a * (0.6 + 0.4 * (this.n3(x * 4, z * 4) * 0.5 + 0.5)));
          }
        }
      });
      // worn footpath from the door to the road
      if (b.access) {
        const d = doorPoint(b);
        const ax = b.access.x - d.x, az = b.access.z - d.z;
        const len = Math.hypot(ax, az) || 1, ux = ax / len, uz = az / len;
        const p0x = d.x - ux * 0.28, p0z = d.z - uz * 0.28, p1x = d.x + ux * 0.32, p1z = d.z + uz * 0.32;
        const stone = b.level >= 1 && kind !== 'yard';
        this._range(Math.min(p0x, p1x) - 0.2, Math.min(p0z, p1z) - 0.2, Math.max(p0x, p1x) + 0.2, Math.max(p0z, p1z) + 0.2, (vi, x, z, i, j) => {
          const dist = segDist(x, z, p0x, p0z, p1x, p1z) + this.n3(x * 4, z * 4) * 0.03;
          const a = 1 - smoothstep(0.06, 0.13, dist);
          _b.copy(stone ? COBBLE[(hash2(i, j, 4) * 3) | 0] : DIRT[(hash2(i, j, 4) * 3) | 0]);
          this._blend(vi, _b, a * 0.9, 0.5);
        });
      }
    }
  }

  _paintRoads() {
    const w = this.world, t = w.terrain;
    const V = this.V, clip = this._clip || [0, V - 1, 0, V - 1];
    if (!this._cov || this._cov.length !== V * V) { this._cov = new Float32Array(V * V); this._lvl = new Uint8Array(V * V); this._dn = new Float32Array(V * V); }
    const cov = this._cov, lvl = this._lvl, dn = this._dn;
    for (let j = clip[2]; j <= clip[3]; j++) cov.fill(0, j * V + clip[0], j * V + clip[1] + 1);
    const HW = [0, 0.2, 0.27, 0.32], SOFT = [0, 0.05, 0.035, 0.028];
    // the unit squares a road reaches (and those round them, where its
    // shoulder is), in the part being repainted: the road's own field there,
    // as wide as each level's painted shoulder
    const x0 = clip[0] / SUB, x1 = clip[1] / SUB, z0 = clip[2] / SUB, z1 = clip[3] / SUB;
    const squares = new Set();
    for (const k of roadSquares(w)) {
      const x = k % 65536, z = Math.floor(k / 65536);
      if (x + 1.5 < x0 || x - 0.5 > x1 || z + 1.5 < z0 || z - 0.5 > z1) continue;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) squares.add((z + dz) * 65536 + x + dx);
    }
    for (const k of squares) {
      const x = k % 65536, z = Math.floor(k / 65536);
      const prims = primsIn(w, [x, z, x + 1, z + 1], 0.5);
      if (!prims.length) continue;
      this._range(x, z, x + 1, z + 1, (vi, px, pz) => {
        const [f, L] = fieldAt(prims, px, pz);
        if (!L) return;
        const hw = HW[L], sf = SOFT[L], d = f + HALF[L];
        if (d > hw + sf * 2 + 0.1) return;
        const rough = L === 1 ? this.n3(px * 3.1, pz * 3.1) * 0.06 + this.n1(px * 9, pz * 9) * 0.025 : this.n3(px * 5, pz * 5) * 0.012;
        const c = 1 - smoothstep(hw - sf, hw + sf, d + rough);
        if (c > cov[vi]) { cov[vi] = c; lvl[vi] = L; dn[vi] = d / hw; }
      });
    }
    for (let j = clip[2]; j <= clip[3]; j++) for (let vi = j * V + clip[0], ve = j * V + clip[1]; vi <= ve; vi++) {
      const c = cov[vi];
      if (c <= 0.001) continue;
      const L = lvl[vi], d = dn[vi];
      const i = vi % V, j = (vi / V) | 0;
      const hsh = hash2(i, j, 21);
      if (L === 1) {
        _b.copy(DIRT[0]).lerp(DIRT[1], hsh * 0.7);
        if (d < 0.45) _b.lerp(DIRT[2], (0.45 - d) * 0.5);
        if (d > 0.7) _b.lerp(DIRT[3], (d - 0.7) * 0.8);
        this._blend(vi, _b, Math.min(1, c * 1.1), 0.45);
      } else if (L === 2) {
        _b.copy(COBBLE[(hsh * 3) | 0]);
        if (d > 0.78) _b.lerp(COBBLE[3], 0.7);
        this._blend(vi, _b, c, 0.3);
      } else {
        if (d < 0.66) _b.copy(PAVED[0]).lerp(PAVED[1], hsh);
        else if (d < 0.74) _b.copy(PAVED[3]);
        else _b.copy(PAVED[2]).lerp(PAVED[3], hsh * 0.4);
        this._blend(vi, _b, c, 0.25);
      }
    }
    void t;
  }

  _paintRails() {
    const w = this.world;
    const done = new Set();
    for (const e of w.rails.edges.values()) for (let k = 0; k + 1 < e.pts.length; k++) {
      const [ax, az] = e.pts[k], [bx, bz] = e.pts[k + 1];
      this._range(Math.min(ax, bx) - 0.3, Math.min(az, bz) - 0.3, Math.max(ax, bx) + 0.3, Math.max(az, bz) + 0.3, (vi, px, pz, i, j) => {
        if (done.has(vi) || w.waterAt(px, pz)) return;
        let d = 9;
        for (const sg of w.rails.segsIn([px - 0.3, pz - 0.3, px + 0.3, pz + 0.3])) { const p = sg.e.pts[sg.i], q = sg.e.pts[sg.i + 1]; d = Math.min(d, segDist(px, pz, p[0], p[1], q[0], q[1])); }
        const a = 1 - smoothstep(0.17, 0.24, d + this.n3(px * 4, pz * 4) * 0.02);
        if (a <= 0) return;
        done.add(vi);
        _b.copy(GRAVEL[hash2(i, j, 8) < 0.5 ? 0 : 1]);
        this._blend(vi, _b, a * (w.roadAt(px, pz, 0.05) ? 0.5 : 0.95), 0.6);
      });
    }
  }

  // --------------------------------------------------------------- sides
  _buildSides() {
    const { terrain: t, N } = this.world;
    const W = CONFIG.WATER_LEVEL - 0.02;
    const pos = [], col = [], wpos = [];
    const quad = (arr, carr, a, b, cc, d, ca, cb, out) => {
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [cc[0] - a[0], cc[1] - a[1], cc[2] - a[2]];
      const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) { const tmp = b; b = d; d = tmp; }
      for (const p of [a, b, cc, a, cc, d]) {
        arr.push(p[0], p[1], p[2]);
        if (carr) { const c = p[3] === 1 ? ca : cb; carr.push(c.r, c.g, c.b); }
      }
    };
    const step = 1 / SUB;
    const edge = (x0, z0, x1, z1, out) => {
      const h0 = t.heightAt(x0, z0), h1 = t.heightAt(x1, z1);
      const m0 = h0 - 0.3 - hash2(Math.round(x0 * 9), Math.round(z0 * 9), 3) * 0.1;
      const m1 = h1 - 0.3 - hash2(Math.round(x1 * 9), Math.round(z1 * 9), 3) * 0.1;
      const j = hash2(Math.round((x0 + x1) * 3), Math.round((z0 + z1) * 3), 9) * 0.06;
      const soilT = SOIL_T.clone().multiplyScalar(1 + j);
      quad(pos, col, [x0, h0, z0, 1], [x1, h1, z1, 1], [x1, m1, z1, 0], [x0, m0, z0, 0], soilT, SOIL_B, out);
      const r1 = ROCK_S.clone().multiplyScalar(1 + j);
      quad(pos, col, [x0, m0, z0, 1], [x1, m1, z1, 1], [x1, BASE_Y, z1, 0], [x0, BASE_Y, z0, 0], r1, ROCK_S2, out);
      if (h0 < W || h1 < W) quad(wpos, null, [x0, W, z0], [x1, W, z1], [x1, Math.min(h1, W), z1], [x0, Math.min(h0, W), z0], null, null, out);
    };
    for (let k = 0; k < N * SUB; k++) {
      const a = k * step, b = (k + 1) * step;
      edge(a, 0, b, 0, [0, 0, -1]);
      edge(a, N, b, N, [0, 0, 1]);
      edge(0, a, 0, b, [-1, 0, 0]);
      edge(N, a, N, b, [1, 0, 0]);
    }
    const g = this.sides.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const wg = this.waterSides.geometry;
    wg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(wpos), 3));
    wg.computeVertexNormals();
    wg.computeBoundingSphere();
  }

  _buildWater() {
    const N = this.world.N;
    const geo = new THREE.PlaneGeometry(N, N, N * 2, N * 2);
    geo.rotateX(-Math.PI / 2);
    geo.translate(N / 2, CONFIG.WATER_LEVEL - 0.02, N / 2);
    const m = new THREE.Mesh(geo, MAT.water);
    m.receiveShadow = true;
    m.renderOrder = 2;
    return m;
  }

  dispose() {
    this.scene.remove(this.group);
    this.surface.geometry.dispose();
    this.sides.geometry.dispose();
    this.water.geometry.dispose();
    this.waterSides.geometry.dispose();
  }
}
