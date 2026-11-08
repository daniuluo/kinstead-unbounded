// Trees, bushes, rocks, grass tufts and wildflowers as instanced meshes.

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { MAT } from './materials.js';
import { TREE, homeField, farmlandOf, ownPlot } from '../world/world.js';
import { hash2 } from '../util/rng.js';
import { dressSpots } from '../world/streets.js';
import { BUILDINGS, produceOf } from '../defs.js';
import { streetPart } from '../config.js';
import { inRect, toLocal, toWorld } from '../world/geom.js';

function flat(g) { const n = g.index ? g.toNonIndexed() : g; n.deleteAttribute('uv'); n.computeVertexNormals(); return n; }

// Smooth, slightly lumpy shapes for foliage (less "low-poly toy", more natural).
function organic(g, lump = 0, cx = 0, cy = 0, cz = 0) {
  g.deleteAttribute('uv'); g.deleteAttribute('normal');
  g = mergeVertices(g, 1e-4);
  if (lump) {
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const dx = x - cx, dy = y - cy, dz = z - cz, L = Math.hypot(dx, dy, dz) || 1;
      const k = 1 + (hash2(Math.round(x * 1000), Math.round(z * 1000) + Math.round(y * 1000) * 7, 11) - 0.5) * lump;
      p.setXYZ(i, cx + dx * k, cy + dy * k, cz + dz * k);
    }
  }
  g.computeVertexNormals();
  return g;
}
const blob = (r, x, y, z, sy = 1, lump = 0.28) => organic(new THREE.IcosahedronGeometry(r, 2).scale(1, sy, 1).translate(x, y, z), lump, x, y, z);

const GEO = {
  trunk: organic(new THREE.CylinderGeometry(0.02, 0.036, 0.26, 7).translate(0, 0.13, 0)),
  pine: mergeGeometries([
    organic(new THREE.ConeGeometry(0.17, 0.28, 9).translate(0, 0.22, 0), 0.12, 0, 0.2, 0),
    organic(new THREE.ConeGeometry(0.13, 0.24, 9).translate(0, 0.36, 0), 0.12, 0, 0.34, 0),
    organic(new THREE.ConeGeometry(0.085, 0.2, 9).translate(0, 0.49, 0), 0.1, 0, 0.47, 0),
  ]),
  round: mergeGeometries([
    blob(0.15, 0, 0.33, 0, 0.9),
    blob(0.1, 0.08, 0.4, -0.03),
    blob(0.095, -0.08, 0.29, 0.05),
    blob(0.085, 0.02, 0.27, -0.09),
  ]),
  birch: mergeGeometries([
    blob(0.1, 0, 0.4, 0, 1.4, 0.3),
    blob(0.07, 0.045, 0.5, 0.02),
  ]),
  bush: mergeGeometries([blob(0.095, 0, 0.05, 0, 0.7), blob(0.065, 0.06, 0.04, 0.03, 0.75)]),
  rock: flat(new THREE.DodecahedronGeometry(0.1, 0).scale(1, 0.6, 0.85).translate(0, 0.03, 0)),
  tuft: flat(mergeGeometries([
    flat(new THREE.ConeGeometry(0.011, 0.075, 3).translate(0, 0.037, 0)),
    flat(new THREE.ConeGeometry(0.009, 0.06, 3).translate(0.018, 0.03, 0.01)),
    flat(new THREE.ConeGeometry(0.009, 0.065, 3).translate(-0.014, 0.032, -0.012)),
  ])),
  bloom: flat(new THREE.IcosahedronGeometry(0.013, 0).translate(0, 0.04, 0)),
  crop: flat(new THREE.IcosahedronGeometry(0.03, 0).scale(1, 0.75, 1).translate(0, 0.022, 0)),
  post: flat(new THREE.BoxGeometry(0.016, 0.085, 0.016).translate(0, 0.042, 0)),
  rail: flat(new THREE.BoxGeometry(1, 0.012, 0.01).translate(0, 0.058, 0)),
};
// crop tufts in farm fields, by season (mixed farming), and their fences
const CROP_TUFT = [['#7fae4f', '#8fbd5a'], ['#c9a640', '#6f9e45'], ['#c08f3e', '#a8823c'], ['#6f5a44', '#6f5a44']];
const FENCE_COL = '#7a5f42';
// an orchard's trees: blossom in spring, then leaves, and the fruit on them
const BLOSSOM = ['#f1dfe3', '#e8c6cf'];
const FRUIT_COL = ['#c8402f', '#e0b030', '#9ab830'];

const FOLIAGE = {
  pine: [['#2f5236', '#36593b', '#2b4a33'], ['#2c4e33', '#335538', '#294630'], ['#304d34', '#38573b', '#2c4631'], ['#2f4a37', '#36523d', '#2a4231']],
  round: [
    ['#6a8f45', '#5f8640', '#75974d', '#e3b7c0'],
    ['#5b7d3e', '#4f7037', '#668546', '#56783b'],
    ['#b5682e', '#c48a3a', '#9a4a2a', '#a8923a', '#b87a34'],
    ['#7a6d60', '#6e6256', '#857868'],
  ],
  birch: [['#8aa556', '#93ad5e'], ['#7f9a4f', '#738f47'], ['#d4ac3c', '#dcb94a', '#c79c34'], ['#8a7e70', '#968a7c']],
  bush: [['#617f43', '#57773d', '#6a8748'], ['#4f6e3a', '#57763e', '#48663a'], ['#8a7a3a', '#97713a', '#6f6f3a'], ['#666b5a', '#6f7462']],
};
// clipped box hedges stay green the year round, a little duller in winter
const HEDGE = [['#4c7a3a', '#477238', '#52803e'], ['#46703a', '#416a36', '#4b763c'], ['#4f6e38', '#4a6834', '#557438'], ['#4b5f45', '#475a41', '#506449']];
const TUFT = ['#6f9447', '#5f8a40', '#9a8f4a', '#7a8068'];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep01 = (v) => { v = clamp01(v); return v * v * (3 - 2 * v); };
const BLOOMS = ['#f2ede0', '#e2b84a', '#c9536b', '#9c74c9', '#e3a0b4'];

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler(), _c = new THREE.Color();
const _c1 = new THREE.Color(), _c2 = new THREE.Color();
// a colour part way from a to b
const mixC = (a, b, t) => (t <= 0 ? a : t >= 1 ? b : _c1.set(a).lerp(_c2.set(b), t));

export class NatureView {
  constructor(world, scene) {
    this.world = world;
    this.scene = scene;
    this.season = 1;
    this.seasonW = 0;
    const mk = (geo, mat, max, shadow = true) => {
      const m = new THREE.InstancedMesh(geo, mat, Math.max(1, max));
      m.castShadow = shadow; m.receiveShadow = true;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      scene.add(m);
      return m;
    };
    const N = world.N;
    this.cap = N * N * 4;
    this.meshes = {
      trunk: mk(GEO.trunk, MAT.trunk, this.cap),
      pine: mk(GEO.pine, MAT.foliage, this.cap),
      round: mk(GEO.round, MAT.foliage, this.cap),
      birch: mk(GEO.birch, MAT.foliage, this.cap),
      bush: mk(GEO.bush, MAT.foliage, this.cap),
      rock: mk(GEO.rock, MAT.rock, this.cap),
      tuft: mk(GEO.tuft, MAT.grass, N * N * 3, false),
      bloom: mk(GEO.bloom, MAT.grass, N * N * 3, false),
      crop: mk(GEO.crop, MAT.grass, 30000, false),
      post: mk(GEO.post, MAT.trunk, 8000),
      rail: mk(GEO.rail, MAT.trunk, 8000),
    };
    this.rebuild();
  }

  // The season, and how far it has turned towards the next (0 .. 1).
  setSeason(s, w = 0) {
    if (s === this.season && w === (this.seasonW || 0)) return;
    this.season = s;
    this.seasonW = w;
    this.rebuild();
  }

  rebuild() {
    const w = this.world, t = w.terrain, s = this.season, n = (s + 1) % 4, sw = this.seasonW || 0;
    const M = this.meshes;
    // each tree turns in its own time as the season shades into the next
    const turn = (h) => (sw <= 0 ? 0 : sw >= 1 ? 1 : clamp01((sw - h * 0.3) / 0.7));
    // trees bare in winter: how far, as the season turns
    const bareOf = (k) => (s === 3 ? 1 - k : 0) + (n === 3 ? k : 0);
    // flowers out in spring and summer, coming a few at a time (not before
    // the snow has gone) and going the same way
    const flowering = (s <= 1 ? 1 : 0) + ((n <= 1 ? 1 : 0) - (s <= 1 ? 1 : 0)) * (s === 3 ? smoothstep01((sw - 0.6) / 0.4) : sw);
    const counts = { trunk: 0, pine: 0, round: 0, birch: 0, bush: 0, rock: 0, tuft: 0, bloom: 0, crop: 0, post: 0, rail: 0 };
    const put = (key, x, y, z, sc, rot, color, sy = 1) => {
      const mesh = M[key];
      const i = counts[key]++;
      if (i >= mesh.instanceMatrix.count) return;
      _p.set(x, y, z); _q.setFromEuler(_e.set(0, rot, 0)); _s.set(sc, sc * sy, sc);
      mesh.setMatrixAt(i, _m.compose(_p, _q, _s));
      mesh.setColorAt(i, _c.set(color));
    };
    for (const tr of w.trees) {
      const y = t.heightAt(tr.x, tr.z) - 0.01;
      const h = hash2(Math.floor(tr.x * 100), Math.floor(tr.z * 100), 3);
      const pick = (arr) => arr[Math.floor(h * arr.length) % arr.length];
      const k = turn(hash2(Math.floor(tr.x * 100), Math.floor(tr.z * 100), 11)), both = (set) => mixC(pick(set[s]), pick(set[n]), k);
      switch (tr.k) {
        case TREE.PINE:
          put('trunk', tr.x, y, tr.z, tr.s, tr.r, '#6b4a2f');
          put('pine', tr.x, y, tr.z, tr.s, tr.r, both(FOLIAGE.pine));
          break;
        case TREE.ROUND: {
          put('trunk', tr.x, y, tr.z, tr.s, tr.r, '#6e4d31', 1.1);
          const bare = bareOf(k);
          const colOf = (q) => (q === 0 && h > 0.9 ? '#e3b7c0' : pick(FOLIAGE.round[q].slice(0, q === 0 ? 3 : undefined)));
          put('round', tr.x, y + bare * 0.04, tr.z, tr.s * (1 - bare * 0.3), tr.r, mixC(colOf(s), colOf(n), k));
          break;
        }
        case TREE.BIRCH:
          put('trunk', tr.x, y, tr.z, tr.s * 0.8, tr.r, '#e8e4da', 1.6);
          put('birch', tr.x, y, tr.z, tr.s * (1 - bareOf(k) * 0.25), tr.r, both(FOLIAGE.birch));
          break;
        case TREE.BUSH:
          put('bush', tr.x, y, tr.z, tr.s, tr.r, both(FOLIAGE.bush));
          break;
        case TREE.ROCK:
          put('rock', tr.x, y, tr.z, tr.s, tr.r, h > 0.5 ? '#9b968c' : '#8a857b');
          break;
        case TREE.PEBBLE:
          put('rock', tr.x, y, tr.z, tr.s * 0.45, tr.r, '#a39e94');
          break;
      }
    }
    // dressed streets: avenue trees, hedges, and shrubs and flowers on a
    // planted median (positions from roadDress.js; they keep clear of front
    // doors, so a building changing replants them: this.dressed)
    this.dressed = [...w.roads.edges.values()].some(e => streetPart(e.dress));
    if (this.dressed) {
      const sp = dressSpots(w);
      for (const tr of sp.trees) {
        const y = t.heightAt(tr.x, tr.z) - 0.01, h = hash2(Math.floor(tr.x * 100), Math.floor(tr.z * 100), 3);
        const k = turn(h), bare = bareOf(k), leaf = (q) => FOLIAGE.round[q][Math.floor(h * Math.min(3, FOLIAGE.round[q].length))];
        put('trunk', tr.x, y, tr.z, tr.s, tr.r, '#6e4d31', 1.3);
        put('round', tr.x, y + 0.03 + bare * 0.04, tr.z, tr.s * (1 - bare * 0.3), tr.r, mixC(leaf(s), leaf(n), k));
      }
      for (const hg of sp.hedges) {
        const hi = Math.floor(hash2(Math.floor(hg.x * 40), Math.floor(hg.z * 40), 5) * 3), c = mixC(HEDGE[s][hi], HEDGE[n][hi], sw);
        put('bush', hg.x, t.heightAt(hg.x, hg.z) - 0.005, hg.z, 0.62, hg.r, c, 0.9);
      }
      for (const sh of sp.shrubs) {
        const y = t.heightAt(sh.x, sh.z) + 0.04, h = hash2(Math.floor(sh.x * 100), Math.floor(sh.z * 100), 7);
        put('bush', sh.x, y, sh.z, 0.5, sh.r, mixC(FOLIAGE.bush[s][Math.floor(h * 3)], FOLIAGE.bush[n][Math.floor(h * 3)], turn(h)));
        if (hash2(Math.floor(sh.x * 70), Math.floor(sh.z * 70), 12) < flowering) for (const o of [-0.07, 0.07]) put('bloom', sh.x + o * Math.cos(sh.r), y + 0.005, sh.z + o * Math.sin(sh.r), 1, 0, BLOOMS[Math.floor(hash2(Math.floor(sh.x * 50), Math.floor(sh.z * 50), 8 + o) * BLOOMS.length)]);
      }
    }
    // boulevards: trees, hedges, clipped balls, shrubs, the flowers in their
    // beds and the grass of their medians (positions from boulevard.js)
    if (false) {
      const sp = { trees: [], hedges: [], balls: [], shrubs: [], blooms: [], tufts: [] };
      for (const tr of sp.trees) {
        const y = t.heightAt(tr.x, tr.z) - 0.01, h = hash2(Math.floor(tr.x * 100), Math.floor(tr.z * 100), 3);
        const k = turn(h), bare = bareOf(k), leaf = (q) => FOLIAGE.round[q][Math.floor(h * Math.min(3, FOLIAGE.round[q].length))];
        put('trunk', tr.x, y, tr.z, tr.s, tr.r, '#6e4d31', 1.35);
        put('round', tr.x, y + 0.03 + bare * 0.04, tr.z, tr.s * (1 - bare * 0.3), tr.r, mixC(leaf(s), leaf(n), k));
      }
      for (const hg of sp.hedges) {
        const hi = Math.floor(hash2(Math.floor(hg.x * 40), Math.floor(hg.z * 40), 5) * 3), c = mixC(HEDGE[s][hi], HEDGE[n][hi], sw);
        put('bush', hg.x, t.heightAt(hg.x, hg.z) - 0.005, hg.z, 0.66, hg.r, c, 1);
      }
      for (const b of sp.balls) {
        const c = mixC(HEDGE[s][0], HEDGE[n][0], sw), y = t.heightAt(b.x, b.z);
        put('trunk', b.x, y - 0.01, b.z, 0.3, b.r, '#5e432c', 0.6);
        put('bush', b.x, y + 0.035, b.z, 0.62, b.r, c, 1.15);
      }
      for (const sh of sp.shrubs) {
        const h = hash2(Math.floor(sh.x * 100), Math.floor(sh.z * 100), 7), c = mixC(HEDGE[s][1], HEDGE[n][1], sw);
        put('bush', sh.x, t.heightAt(sh.x, sh.z), sh.z, 0.45 + h * 0.1, sh.r, c, 0.85);
      }
      // bedding: each bed in its own pair of colours in spring and summer,
      // autumn's warmer ones, and nothing but the soil in winter
      const bedPal = [['#d9363a', '#f2d040'], ['#e88fae', '#f2ede0'], ['#9c74c9', '#f2d040'], ['#e8823f', '#d9536b'], ['#6a8ad9', '#f2ede0']];
      const autumn = ['#c8702a', '#8a2a3a', '#d8a030', '#9c74c9'];
      const leafy = [['#5f8a42', '#55803c'], ['#4f7a3a', '#5a8540'], ['#6a6a34', '#7a6232'], null];
      for (const bl of sp.blooms) {
        const q = hash2(Math.floor(bl.x * 90), Math.floor(bl.z * 90), 13);
        // the plants themselves, cut back to the soil for the winter
        const grown = s === 3 ? sw : n === 3 ? 1 - sw : 1;
        if (q >= grown) continue;
        const y = t.heightAt(bl.x, bl.z) + 0.024, lf = leafy[s] || leafy[0];
        put('crop', bl.x, y - 0.012, bl.z, 1.25, bl.r, lf[q < 0.5 ? 0 : 1]);
        const out = s === 2 ? (q < 0.6 ? 1 : 0) * (1 - sw) : flowering;
        if (q >= out) continue;
        const col = s === 2 ? autumn[Math.floor(q * 40) % autumn.length] : bedPal[Math.floor(bl.h * bedPal.length)][q < 0.5 ? 0 : 1];
        for (const o of [-0.016, 0.016]) put('bloom', bl.x + o * Math.cos(bl.r), y - 0.005, bl.z + o * Math.sin(bl.r), 1.25, 0, col);
      }
      for (const tf of sp.tufts) put('tuft', tf.x, t.heightAt(tf.x, tf.z), tf.z, tf.s, tf.r, mixC(TUFT[s], TUFT[n], sw));
    }
    // farmland (a farm's own field behind its yard and its fields beyond, as
    // one): rows of crop tufts in the farm's frame (none in winter, or on
    // grazing land) or an orchard's rows of fruit trees, and a post-and-rail
    // fence round the outside, with a gate from the yard
    const crops = [];   // the rectangles of crops (no tufts of wild grass there)
    for (const farm of w.buildings.values()) {
      const def = BUILDINGS[farm.type];
      if (!def.fields) continue;
      const land = farmlandOf(w, farm);
      if (!land.length) continue;
      const P = produceOf(farm), fruit = P.kind === 'orchard';
      const cols = P.crop && s < 3 ? P.crop[s] : CROP_TUFT[s];
      // the farm's frame: lx across it, lz from back to front (as its model)
      const F = ownPlot(farm), home = homeField(farm);
      const inLand = (px, pz, pad = 0) => land.some(R => inRect(R, px, pz, pad));
      // points of a lattice in the farm's frame (start + k * step) over a
      // rectangle, so rows run on from one field to the next
      const lattice = (R, ax, sx, az, sz, fn) => {
        const ls = R.pts.map(([px, pz]) => toLocal(F, px, pz));
        const l0 = Math.min(...ls.map(p => p[0])), l1 = Math.max(...ls.map(p => p[0])), m0 = Math.min(...ls.map(p => p[1])), m1 = Math.max(...ls.map(p => p[1]));
        for (let lz = az + Math.ceil((m0 - az) / sz) * sz; lz < m1; lz += sz) for (let lx = ax + Math.ceil((l0 - ax) / sx) * sx; lx < l1; lx += sx) fn(lx, lz);
      };
      // kept clear of what stands in its own field (see MODELS.farm)
      const clear = (lx, lz) => !((farm.level >= 2 && !fruit && Math.hypot(lx - 0.8, lz + 0.8) < 0.24) || (farm.level >= 3 && lx < -0.72 && lz < 0));
      const fruitCol = FRUIT_COL[farm.variant % FRUIT_COL.length];
      const seen = new Set();
      for (let ri = 0; ri < land.length; ri++) {
        const R = land[ri], own = R === home;
        // (each point once, inside the fence)
        const inside = (px, pz) => inRect(R, px, pz, -0.06) || (inRect(R, px, pz) && land.some((Q, qi) => qi !== ri && inRect(Q, px, pz, 0.1)));
        if (fruit) {
          lattice(R, -0.82, 0.38, -0.75, 0.42, (lx, lz) => {
            const key = Math.round(lx * 100) + ':' + Math.round(lz * 100);
            const [px, pz] = toWorld(F, lx, lz);
            if (seen.has(key) || !inside(px, pz)) return;
            seen.add(key);
            const h = hash2(Math.floor(px * 100), Math.floor(pz * 100), 13);
            const y = t.heightAt(px, pz) - 0.01, k = turn(h), bare = bareOf(k);
            const leaf = (q) => (q === 0 && h < 0.4 ? BLOSSOM[h < 0.2 ? 0 : 1] : FOLIAGE.round[q][Math.floor(h * Math.min(3, FOLIAGE.round[q].length))]);
            put('trunk', px, y, pz, 0.45, h * 6, '#6e4d31');
            put('round', px, y + 0.02 + bare * 0.03, pz, 0.36 * (1 - bare * 0.3), h * 6, mixC(leaf(s), leaf(n), k));
            if (s === 1 || s === 2) for (let q = 0; q < 2; q++) put('bloom', px + (hash2(ri, q * 7 + Math.round(lx * 100), 15) - 0.5) * 0.11, y + 0.06 + hash2(ri, q * 7 + Math.round(lz * 100), 16) * 0.04, pz + (hash2(ri, q * 7 + Math.round(lx * 100), 17) - 0.5) * 0.11, 1.1, 0, fruitCol);
          });
        } else if (P.kind !== 'livestock') {
          crops.push(R);
          if (s < 3) lattice(R, 0.055, 0.11, -0.1, 0.4, (lx, lz) => {
            const key = Math.round(lx * 1000) + ':' + Math.round(lz * 1000);
            const [qx0, qz0] = toWorld(F, lx, lz);
            if (seen.has(key) || !inside(qx0, qz0) || (own && !clear(lx, lz))) return;
            seen.add(key);
            const k = hash2(Math.round(lx * 100) + 977, Math.round(lz * 100) + farm.id * 131, 9);
            const px = qx0 + (k - 0.5) * 0.03, pz = qz0 + (hash2(Math.round(lx * 100), Math.round(lz * 100), 10) - 0.5) * 0.03;
            put('crop', px, t.heightAt(px, pz), pz, 0.85 + k * 0.35, k * 6, cols[k < 0.5 ? 0 : 1]);
          });
        }
        const rail = (x0, z0, x1, z1) => {
          const len = Math.hypot(x1 - x0, z1 - z0), mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, i = counts.rail++;
          if (i < M.rail.instanceMatrix.count) {
            _p.set(mx, t.heightAt(mx, mz), mz); _q.setFromEuler(_e.set(0, -Math.atan2(z1 - z0, x1 - x0), 0)); _s.set(len, 1, 1);
            M.rail.setMatrixAt(i, _m.compose(_p, _q, _s)); M.rail.setColorAt(i, _c.set(FENCE_COL));
          }
          for (let q = 0; q <= 2; q++) { const fx = x0 + (x1 - x0) * q / 2, fz = z0 + (z1 - z0) * q / 2; put('post', fx, t.heightAt(fx, fz), fz, 1, 0, FENCE_COL); }
        };
        // a fence wherever the farmland ends (an orchard's own plot has its
        // own fence), in pieces a field long; where its own field meets the
        // yard, a gate in the middle
        const e = 0.04, g = 0.1;
        for (let k = 0; k < 4; k++) {
          const [ax, az] = R.pts[k], [bx, bz] = R.pts[(k + 1) & 3], L = Math.hypot(bx - ax, bz - az), n2 = Math.max(1, Math.round(L));
          const ox = R.cx - (ax + bx) / 2, oz = R.cz - (az + bz) / 2, ol = Math.hypot(ox, oz) || 1;
          for (let q = 0; q < n2; q++) {
            let x0 = ax + ((bx - ax) * q) / n2, z0 = az + ((bz - az) * q) / n2, x1 = ax + ((bx - ax) * (q + 1)) / n2, z1 = az + ((bz - az) * (q + 1)) / n2;
            const mx = (x0 + x1) / 2 - (ox / ol) * 0.08, mz = (z0 + z1) / 2 - (oz / ol) * 0.08;
            if (land.some((Q, qi) => qi !== ri && inRect(Q, mx, mz))) continue;
            const yardSide = own && inRect(F, mx, mz) && !inRect(R, mx, mz);
            if (fruit && inRect(F, mx, mz)) continue;
            // (inset a little from the field's edge)
            const ix = (ox / ol) * e, iz = (oz / ol) * e;
            x0 += ix; z0 += iz; x1 += ix; z1 += iz;
            if (yardSide) {
              // a gate in the middle of the side the yard is on
              const [cx2, cz2] = [(x0 + x1) / 2, (z0 + z1) / 2], dx = (x1 - x0) / (L / n2), dz = (z1 - z0) / (L / n2);
              rail(x0, z0, cx2 - dx * g, cz2 - dz * g);
              rail(cx2 + dx * g, cz2 + dz * g, x1, z1);
              continue;
            }
            rail(x0, z0, x1, z1);
          }
        }
      }
    }
    // grass tufts and wildflowers on open land (not in fields of crops)
    const N = w.N;
    const open = (px, pz) => !w.roadAt(px, pz, 0.04) && !w.railAt(px, pz, 0.06) && !w.buildingAt(px, pz) && !crops.some(R => inRect(R, px, pz)) && !w.waterAt(px, pz);
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        if (t.isWater(x, z) || t.slope(x, z) > 0.6) continue;
        const avg = t.tileAvg(x, z);
        if (avg < 0.2 || avg > 2.4) continue;
        const nt = Math.floor(hash2(x, z, 41) * 3);
        for (let k = 0; k < nt; k++) {
          const px = x + hash2(x, z, 50 + k), pz = z + hash2(x, z, 60 + k);
          if (!open(px, pz)) continue;
          put('tuft', px, t.heightAt(px, pz), pz, 0.8 + hash2(x, z, 70 + k) * 0.6, hash2(x, z, 80 + k) * 6, mixC(TUFT[s], TUFT[n], sw));
        }
        if (hash2(x, z, 43) < 0.18 * flowering) {
          const fc = BLOOMS[Math.floor(hash2(x, z, 44) * BLOOMS.length)];
          for (let k = 0; k < 3; k++) {
            const px = x + 0.15 + hash2(x, z, 90 + k) * 0.7, pz = z + 0.15 + hash2(x, z, 95 + k) * 0.7;
            if (!open(px, pz)) continue;
            put('bloom', px, t.heightAt(px, pz), pz, 1, 0, fc);
          }
        }
      }
    }
    for (const [key, mesh] of Object.entries(M)) {
      mesh.count = Math.min(counts[key], mesh.instanceMatrix.count);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  dispose() {
    for (const m of Object.values(this.meshes)) { this.scene.remove(m); m.dispose(); }
  }
}
