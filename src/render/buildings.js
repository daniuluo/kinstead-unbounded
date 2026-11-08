// Procedural rustic building models. Every building is generated from its
// type, level and a per-building variant seed, so no two cottages match.
// Local space: origin at footprint centre, y=0 at the building's base level
// (the highest ground under its plot), +z faces the road. Yard props sit on
// the real terrain via c.gy(); structures get stone foundations on slopes.

import * as THREE from 'three';
import { GeoBuilder, shade, mix } from './geo.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BUILDINGS, produceOf } from '../defs.js';
import { RNG, hash2 } from '../util/rng.js';
import { CONFIG } from '../config.js';
import { PARK_MODELS, parkTree, blooms, spot } from './parks.js';
import { CIVIC_MODELS } from './civic.js';
import { formOf, planOf, roofFor, gableRoof, mansardRoof, gambrelRoof, parapetRoof, shapedGable, dormers, mansardDormers, porchOf, tallBay, balcony, turret, crest, wallGable, tower, bellcote } from './forms.js';
import { ownPlot } from '../world/world.js';
import { toWorld } from '../world/geom.js';

const fw = (b) => b.w ?? b.size, fd = (b) => b.d ?? b.size;

const WALLS = ['#e6d9bf', '#dccdb0', '#d8c29a', '#cdb795', '#e2d4ba', '#c9b48f', '#d6c4a8', '#bfae94', '#e0cfae', '#d2bc98', '#efe7d6'];
// painted plaster in many colours
const PAINTED = ['#c9d3b8', '#b4c6d2', '#e2b9a8', '#d9b36a', '#c99a78', '#cfc3dc', '#e6dca6', '#a9c4ae', '#e8c6c0', '#d6a77e',
  '#b9c9c0', '#e4cf8f', '#c0b3d0', '#d9c0a0', '#a8bccb', '#e3a98f', '#cbd6a8', '#f0d9b5'];
const STONE_WALLS = ['#a99f90', '#9a907f', '#b3a996', '#a39784', '#bdb3a0', '#8f8676', '#a8a294'];
const BRICK = ['#9a5640', '#8c4c38', '#a3624a', '#7e4a3a', '#b07454', '#93503e', '#a86c50'];
const CLAPBOARD = ['#7f98a3', '#8a4a3a', '#5e7a5a', '#c8b48a', '#e6e0d2', '#6f6a8a', '#a8804e', '#4f6a7a', '#b8c4a8'];
const WOOD = ['#7a5a3c', '#6e5034', '#86663f', '#755636', '#8a6a48', '#5e4630'];
const ROOF_TILE = ['#9c4a32', '#8a432e', '#a8573a', '#7d3b2a', '#94503a', '#b05a38', '#a86a40', '#8e3c30'];
const ROOF_SLATE = ['#5a5f63', '#4e5357', '#666a6b', '#55585e', '#4a5560', '#5a4e60', '#3f4a52'];
const ROOF_THATCH = ['#b8955a', '#a8854c', '#c2a064', '#9e7f4a', '#b08850'];
const ROOF_MOSS = ['#6b7a4a', '#5e6e44', '#74804f', '#3f4a3f'];
const ROOF_SHINGLE = ['#6f5a44', '#7b6247', '#665240', '#836a50', '#5c4a3c'];
const ROOF_COLOR = ['#6a7d8a', '#7a5a6a', '#4f6a5a', '#8a6a3a', '#5a6a7a'];
const ACCENT = ['#2f5a8a', '#8a2f2f', '#2f6a4a', '#c09040', '#5a3a6a', '#3f4f5a', '#6b3a2a', '#4f6a4a', '#7a6a4a', '#e8e0d0',
  '#1f4a6a', '#a04a2a', '#3a6a6a', '#7a3a5a', '#d0b060'];
const DOORS = ['#5c3d26', '#6b3a2a', '#3f4f5a', '#4a5a3a', '#6e4a2e', '#4e3828'];
const AWNING = ['#a8473a', '#3f6a8f', '#4f7a45', '#c08a3a', '#7a5a8a', '#b8653f', '#2f7a7a', '#a83a6a', '#6a8a2a'];
const FLOWER = ['#d9536b', '#e8b84a', '#e88fae', '#f2ede0', '#9c74c9', '#e8823f', '#d9363a', '#6a8ad9'];
const LEAF = ['#5f8a42', '#55803c', '#6a9448', '#4e7638'];
const CROP_TUFT = [['#7fae4f', '#8fbd5a'], ['#c9a640', '#6f9e45'], ['#c08f3e', '#a8823c'], ['#6f5a44', '#6f5a44']];
const TIMBER = '#4e3a2a';
const STONE = '#8f877a';
const STONE_D = '#756e63';
const GLASS = '#2f3a44';
const FENCE = '#7a5f42';
const WARM = [1.7, 1.2, 0.55];

const weighted = (r, table) => { let t = r.next() * table.reduce((a, b) => a + b[1], 0); for (const [k, w] of table) if ((t -= w) <= 0) return k; return table[0][0]; };

// Building styles a player can pick when upgrading (b.look overrides the
// style a building's seed would give it; everything else stays its own).
export const STYLES = [
  { id: 'timber', name: 'Timber frame' },
  { id: 'plaster', name: 'Limewash' },
  { id: 'painted', name: 'Painted' },
  { id: 'brick', name: 'Brick' },
  { id: 'stone', name: 'Stone' },
  { id: 'clapboard', name: 'Clapboard' },
];

function palette(seed, look = null) {
  const p = basePalette(seed);
  if (!look || !STYLES.some(s => s.id === look)) return p;
  const r = new RNG((seed ^ 0x2545f491) >>> 0);
  p.style = look;
  p.wall = look === 'painted' ? r.pick(PAINTED) : look === 'brick' ? p.brick : look === 'stone' ? p.stoneWall
    : look === 'clapboard' ? r.pick(['#7f98a3', '#5e7a5a', '#e6e0d2', '#6f6a8a', '#4f6a7a', '#b8c4a8', '#9fb3b8']) : r.pick(WALLS);
  p.timber = look === 'timber';
  p.stoneHouse = look === 'stone';
  if (look === 'stone' || look === 'brick') p.jetty = false;
  // models that reach for "stone" or "brick" directly get the chosen material
  p.forced = true;
  if (look !== 'stone') p.stoneWall = p.wall;
  if (look !== 'brick') p.brick = look === 'stone' ? shade(p.stoneWall, 0.9) : shade(p.wall, 0.85);
  p.lower = look === 'brick' || look === 'stone' ? p.wall : shade(p.wall, 0.88);
  if (look !== 'mixed') p.style = look;
  // ...and the architecture that goes with it, so a style changes the shape of
  // a building and where things go on it, not only its colours
  Object.assign(p, STYLE_ARCH[look](r, p));
  return p;
}

// What each style builds like: roof shape and pitch, where the door and the
// chimneys go, window size, porches, bays, jetties, dormers, and how far the
// house sits back from the street. A little variety within each style.
const STYLE_ARCH = {
  // Tudor: steep roofs (sometimes thatch), a jettied upper floor, small dark
  // leaded windows, one big central stack, the door to one side
  timber: (r, p) => {
    const thatch = r.chance(0.3);
    return { roofStyle: thatch ? 'thatch' : r.chance(0.5) ? 'crossgable' : 'gable', thatched: thatch, hip: false,
      roof: thatch ? p.thatch : r.pick(ROOF_TILE), pitch: r.float(1.22, 1.36), jetty: true, winW: r.float(0.054, 0.062), winH: 0.88,
      shutters: false, porch: false, bay: false, chimneyPos: 'center', doorPos: 'side', alongZ: false, flowerBoxes: true,
      frame: '#3a2a1f', arched: false, dormers: 0, setback: 0.16 };
  },
  // Limewashed cottage: thatch or a half-hipped roof, a stack up the gable
  // wall outside, a little porch, a deep front garden
  plaster: (r, p) => {
    const thatch = r.chance(0.65);
    return { roofStyle: thatch ? 'thatch' : 'halfhip', thatched: thatch, hip: false, roof: thatch ? p.thatch : r.pick(ROOF_TILE),
      pitch: r.float(1.08, 1.2), jetty: false, winW: r.float(0.054, 0.06), winH: 0.84, shutters: false, porch: true, bay: false,
      chimneyPos: 'outside', doorPos: 'side', alongZ: false, flowerBoxes: true, ivy: r.chance(0.4), arched: false, dormers: 0, setback: 0.21 };
  },
  // Georgian: a symmetrical front under a low hipped slate roof, a centred
  // door with a porch, tall shuttered windows, a chimney at each end
  painted: (r) => ({ roofStyle: 'hip', thatched: false, hip: true, roof: r.pick(ROOF_SLATE), pitch: r.float(0.82, 0.94), jetty: false,
    winW: r.float(0.07, 0.077), winH: 1.2, shutters: true, porch: true, bay: false, chimneyPos: 'ends', doorPos: 'center', alongZ: false,
    flowerBoxes: false, ivy: false, arched: false, dormers: 0, setback: 0.1 }),
  // Victorian brick: tile gables (some facing the street), bay windows,
  // arched window heads, paired end stacks, the door to one side
  brick: (r) => ({ roofStyle: r.chance(0.4) ? 'crossgable' : 'gable', thatched: false, hip: false, roof: r.chance(0.6) ? r.pick(ROOF_TILE) : r.pick(ROOF_SLATE),
    pitch: r.float(1.04, 1.18), jetty: false, winW: r.float(0.066, 0.074), winH: 1.14, shutters: false, porch: false, bay: true,
    chimneyPos: 'ends', doorPos: 'side', alongZ: r.chance(0.35), flowerBoxes: false, arched: true, dormers: 0, setback: 0.1 }),
  // Stone: low slate roofs (some saltbox), small deep-set arched windows,
  // a stack up the gable wall, a centred door with a porch, ivy
  stone: (r) => ({ roofStyle: r.chance(0.4) ? 'saltbox' : 'gable', thatched: false, hip: false, roof: r.pick(ROOF_SLATE),
    pitch: r.float(0.84, 0.95), jetty: false, winW: r.float(0.052, 0.058), winH: 0.84, shutters: false, porch: true, bay: false,
    chimneyPos: 'outside', doorPos: 'center', alongZ: false, ivy: r.chance(0.5), arched: true, dormers: 0, setback: 0.18 }),
  // Clapboard: a saltbox or gable under shingles, dormers, shutters, a
  // centred door with a deep porch, one central chimney
  clapboard: (r) => ({ roofStyle: r.chance(0.5) ? 'saltbox' : 'gable', thatched: false, hip: false, roof: r.pick(ROOF_SHINGLE),
    pitch: r.float(1.0, 1.12), jetty: false, winW: r.float(0.064, 0.07), winH: 1.04, shutters: true, porch: true, bay: false,
    chimneyPos: 'center', doorPos: 'center', alongZ: false, flowerBoxes: false, arched: false, dormers: 2, setback: 0.14 }),
};

function basePalette(seed) {
  const r = new RNG(seed);
  const style = weighted(r, [['plaster', 3], ['painted', 4], ['brick', 2], ['stone', 2], ['timber', 3], ['clapboard', 2], ['mixed', 3]]);
  const wall = style === 'painted' ? r.pick(PAINTED) : style === 'brick' ? r.pick(BRICK) : style === 'stone' ? r.pick(STONE_WALLS)
    : style === 'clapboard' ? r.pick(CLAPBOARD) : style === 'mixed' ? r.pick(r.chance(0.5) ? PAINTED : WALLS) : r.pick(WALLS);
  const roofStyle = weighted(r, [['gable', 5], ['hip', 2], ['thatch', 2], ['halfhip', 2], ['saltbox', 2], ['crossgable', 2]]);
  const roofSet = weighted(r, [['tile', 5], ['slate', 3], ['shingle', 3], ['moss', 1], ['color', 1]]);
  const roof = roofStyle === 'thatch' ? r.pick(ROOF_THATCH)
    : r.pick({ tile: ROOF_TILE, slate: ROOF_SLATE, shingle: ROOF_SHINGLE, moss: ROOF_MOSS, color: ROOF_COLOR }[roofSet]);
  const accent = r.pick(ACCENT);
  return {
    style,
    wall,
    lower: r.chance(0.5) ? r.pick(STONE_WALLS) : r.pick(BRICK),
    stoneWall: r.pick(STONE_WALLS),
    brick: r.pick(BRICK),
    wood: r.pick(WOOD),
    roof,
    roofStyle,
    thatch: r.pick(ROOF_THATCH),
    slate: r.pick(ROOF_SLATE),
    tile: r.pick(ROOF_TILE),
    door: r.chance(0.6) ? accent : r.pick(DOORS),
    accent,
    frame: r.chance(0.45) ? '#ece6da' : r.chance(0.5) ? '#5a4330' : accent,
    awning: r.pick(AWNING),
    awning2: r.chance(0.6) ? '#e9dfc9' : r.pick(AWNING),
    leaf: r.pick(LEAF),
    trim: r.chance(0.5) ? '#e9e0cc' : '#d8ccb4',
    timber: style === 'timber' || (style === 'mixed' && r.chance(0.4)),
    thatched: roofStyle === 'thatch',
    hip: roofStyle === 'hip',
    alongZ: r.chance(0.3),
    stoneHouse: style === 'stone',
    pitch: r.float(0.8, 1.3),
    winW: r.float(0.062, 0.09),
    winH: r.float(0.85, 1.15),
    jetty: r.chance(0.55),
    bay: r.chance(0.3),
    porch: r.chance(0.35),
    ivy: r.chance(0.25),
    extChimney: r.chance(0.3),
    chimneys: r.chance(0.3) ? 2 : 1,
    shutters: r.chance(0.45),
    flowerBoxes: r.chance(0.4),
    fence: weighted(r, [['rail', 3], ['picket', 3], ['stone', 2], ['hedge', 2], ['none', 2]]),
    tint: [r.float(-0.035, 0.035), r.float(-0.035, 0.035), r.float(-0.035, 0.035)],
  };
}

// Roof prism whose ridge can sit off-centre (saltbox) or be clipped (half-hip).
function roofShape(w, d, h, ridge, rz = 0) {
  const hw = w / 2, hd = d / 2, hr = ridge / 2;
  const A = [-hw, 0, -hd], B = [hw, 0, -hd], C = [hw, 0, hd], D = [-hw, 0, hd];
  const R1 = [-hr, h, rz], R2 = [hr, h, rz];
  const tris = [D, C, R2, D, R2, R1, B, A, R1, B, R1, R2, A, D, R1, C, B, R2];
  const pos = new Float32Array(tris.length * 3);
  tris.forEach((p, i) => { pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2]; });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return g;
}

function solidRoof(c, x, y, z, w, d, h, ridge, rz, color, alongZ, oh = 0.05) {
  const { gb } = c;
  gb.push(x, y, z, alongZ ? Math.PI / 2 : 0);
  if (alongZ) [w, d] = [d, w];
  const W = w + oh * 2, D = d + oh * 2;
  gb.box(0, -0.012, 0, W, 0.025, D, shade(color, 0.8));
  gb.add(roofShape(W, D, h, ridge, rz), color, new THREE.Matrix4());
  gb.pop();
}

// ---------------------------------------------------------------- helpers

export function win(c, x, y, z, w, h, face, lit = 0.75) {
  const { gb, rng } = c;
  const t = 0.018, o = 0.007;
  const fr = c.frame || '#5a4330';
  h *= c.winH || 1;
  // an arched window keeps its size: the top of it, frame and glass, is
  // rounded off rather than capped with a disc over the pane
  const R = c.arched && (face === 'f' || face === 'b') && h > w * 0.8 ? w / 2 : 0;
  const hr = h - R;
  if (face === 'f') gb.box(x, y - 0.012, z + 0.002, w + 0.024, hr + (R ? 0.012 : 0.024), t, fr);
  else if (face === 'b') gb.box(x, y - 0.012, z - 0.002, w + 0.024, hr + (R ? 0.012 : 0.024), t, fr);
  else if (face === 'r') gb.box(x + 0.002, y - 0.012, z, t, h + 0.024, w + 0.024, fr);
  else gb.box(x - 0.002, y - 0.012, z, t, h + 0.024, w + 0.024, fr);
  if (R) gb.arch(x, y + hr, face === 'f' ? z - 0.007 : z - 0.011, R + 0.012, t, 8, fr);
  if (rng.chance(lit)) gb.glow(WARM[0], WARM[1], WARM[2], 1 + rng.float(0.02, 0.95)); else gb.noGlow();
  if (face === 'f') gb.box(x, y, z + o, w, hr, t, GLASS);
  else if (face === 'b') gb.box(x, y, z - o, w, hr, t, GLASS);
  else if (face === 'r') gb.box(x + o, y, z, t, h, w, GLASS);
  else gb.box(x - o, y, z, t, h, w, GLASS);
  if (R) gb.arch(x, y + hr, face === 'f' ? z - 0.002 : z - 0.016, R, t, 8, GLASS);
  gb.noGlow();
  if (c.shutters && rng.chance(0.5) && (face === 'f' || face === 'b')) {
    const sz = face === 'f' ? z + 0.012 : z - 0.012;
    gb.box(x - w / 2 - 0.022, y - 0.006, sz, 0.026, h + 0.012, 0.01, c.shutters);
    gb.box(x + w / 2 + 0.022, y - 0.006, sz, 0.026, h + 0.012, 0.01, c.shutters);
  }
  if (c.flowerBoxes && face === 'f' && rng.chance(0.55)) {
    gb.box(x, y - 0.032, z + 0.022, w + 0.01, 0.024, 0.026, '#6b4a2f');
    for (let i = -1; i <= 1; i++) gb.sphere(x + i * w * 0.32, y - 0.004, z + 0.026, 0.015, rng.pick(FLOWER));
  }
}

// The way in, where it's drawn already (an engine bay, an open-fronted shed):
// remembered as the door villagers walk in and out of, facing +z at z.
function entrance(c, x, z) {
  if (c.doorAt) return;
  const p = new THREE.Vector3(x, 0, z + 0.015).applyMatrix4(c.gb.M), q = new THREE.Vector3(x, 0, z + 1).applyMatrix4(c.gb.M);
  const len = Math.hypot(q.x - p.x, q.z - p.z) || 1;
  c.doorAt = { x: p.x, y: p.y, z: p.z, dx: (q.x - p.x) / len, dz: (q.z - p.z) / len };
}

export function door(c, x, z, w, h, color) {
  const { gb } = c;
  // remember the main (first) door so villagers can walk in and out of it
  if (!c.doorAt) {
    const p = new THREE.Vector3(x, 0, z + 0.015).applyMatrix4(gb.M), q = new THREE.Vector3(x, 0, z + 1).applyMatrix4(gb.M);
    const len = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    c.doorAt = { x: p.x, y: p.y, z: p.z, dx: (q.x - p.x) / len, dz: (q.z - p.z) / len };
  }
  gb.box(x, 0, z + 0.004, w + 0.026, h + 0.018, 0.014, '#5a4330');
  gb.box(x, 0, z + 0.01, w, h, 0.014, color);
  const g = c.gy(x, z + 0.07);
  const top = 0.02;
  gb.cbox(x, Math.min(g, top) - 0.03, z + 0.06, w + 0.07, top - Math.min(g, top) + 0.03, 0.08, STONE, 0, 0.01);
}

function chimney(c, x, y0, top, z, kind = 'home', color = STONE) {
  const { gb } = c;
  gb.cbox(x, y0, z, 0.075, top - y0, 0.075, color, 0, 0.012);
  gb.cbox(x, top, z, 0.09, 0.028, 0.09, shade(color, 0.82), 0, 0.01);
  c.addSmoke(x, top + 0.04, z, kind);
}

// stone footing from the ground up to y=0 under a rectangle (only when needed)
export function footing(c, x, z, w, d, color = STONE) {
  let lo = 0;
  for (const [px, pz] of [[x - w / 2, z - d / 2], [x + w / 2, z - d / 2], [x - w / 2, z + d / 2], [x + w / 2, z + d / 2], [x, z]]) lo = Math.min(lo, c.gy(px, pz));
  if (lo > -0.015) return;
  const { gb } = c;
  if (lo > -0.12) { gb.cbox(x, lo - 0.04, z, w + 0.04, -lo + 0.045, d + 0.04, color, 0, 0.018); return; }
  // where the hill falls away it is a lower floor let into the hillside, not
  // a bare platform: flush stone walls in a lighter dressed stone, a string
  // course at the floor line, small lit windows wherever the wall stands
  // clear of the ground, and a door on the side most open to the slope
  const stone = shade(color, 1.16);
  gb.cbox(x, lo - 0.04, z, w + 0.012, -lo + 0.045, d + 0.012, stone, 0, 0.012);
  gb.box(x, -0.024, z, w + 0.05, 0.024, d + 0.05, shade(color, 1.32));
  const o = 0.008;
  const sides = [['f', 0, 1, w], ['b', 0, -1, w], ['r', 1, 0, d], ['l', -1, 0, d]];
  const wall = (nx, nz) => {
    const ex = x + (nx * w) / 2, ez = z + (nz * d) / 2;           // the middle of this wall at the floor line
    return { at: (u) => (nx ? [ex + nx * o, ez + u] : [ex + u, ez + nz * o]), mid: c.gy(ex, ez) };
  };
  let door = null;
  for (const [face, nx, nz] of sides) {
    const { at, mid } = wall(nx, nz);
    if (mid < -0.3 && (!door || mid < door.ground)) door = { face, at: at(0), ground: mid };
  }
  for (const [face, nx, nz, len] of sides) {
    const { at } = wall(nx, nz);
    const n = Math.max(1, Math.floor(len / 0.2));
    for (let i = 0; i < n; i++) {
      const u = -len / 2 + ((i + 0.5) * len) / n;
      const [px, pz] = at(u), ground = c.gy(px, pz);
      if (ground > -0.17 || (door && door.face === face && Math.abs(u) < 0.06)) continue;
      const h = Math.min(0.08, -ground * 0.4);
      win(c, px, ground + (-ground - h) * 0.55, pz, 0.06, h, face, 0.6);
    }
  }
  if (door) {
    const [px, pz] = door.at, dh = Math.min(0.16, -door.ground * 0.62), along = door.face === 'f' || door.face === 'b';
    gb.box(px, door.ground, pz, along ? 0.075 : 0.014, dh, along ? 0.014 : 0.075, '#4e3a2a');
    gb.box(px, door.ground + dh, pz, along ? 0.1 : 0.02, 0.02, along ? 0.02 : 0.1, shade(color, 1.32));
  }
}

function timber(c, w, d, h, floors) {
  const { gb } = c;
  const t = 0.024, o = 0.006;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) gb.box(sx * (w / 2 - t / 2 + o), 0, sz * (d / 2 - t / 2 + o), t, h, t, TIMBER);
  for (let f = 1; f <= floors; f++) {
    const y = (f * h) / floors - t;
    gb.box(0, y, d / 2 + o, w + 0.012, t, t * 0.6, TIMBER);
    gb.box(0, y, -d / 2 - o, w + 0.012, t, t * 0.6, TIMBER);
    gb.box(w / 2 + o, y, 0, t * 0.6, t, d + 0.012, TIMBER);
    gb.box(-w / 2 - o, y, 0, t * 0.6, t, d + 0.012, TIMBER);
  }
  const studs = Math.max(2, Math.round(w / 0.2));
  for (let i = 1; i < studs; i++) {
    const x = -w / 2 + (i * w) / studs;
    gb.box(x, 0, d / 2 + o, t * 0.7, h, t * 0.5, TIMBER);
  }
  // a pair of diagonal braces on the upper floor
  if (floors > 1) {
    const y0 = h / floors, fh = h / floors;
    const len = Math.hypot(w / studs, fh) * 0.95;
    const ang = Math.atan2(w / studs, fh);
    gb.boxC(-w / 2 + w / studs / 2, y0 + fh / 2, d / 2 + o, t * 0.6, len, t * 0.5, TIMBER, 0, 0, -ang);
    gb.boxC(w / 2 - w / studs / 2, y0 + fh / 2, d / 2 + o, t * 0.6, len, t * 0.5, TIMBER, 0, 0, ang);
  }
}

function thatchRoof(c, x, y, z, w, d, h, wall, color, alongZ) {
  const { gb } = c;
  gb.gable(x, y, z, w, d, h, wall, color, 0.075, alongZ, 0.065);
  // rounded ridge bundle
  gb.push(x, y + h + 0.02, z, alongZ ? Math.PI / 2 : 0);
  gb.cyl(-(alongZ ? d : w) / 2 - 0.08, 0, 0, 0.04, 0.04, (alongZ ? d : w) + 0.16, 7, shade(color, 0.88), 0, 0, -Math.PI / 2);
  gb.pop();
}

// little façade extras
function ivy(c, w, d, h) {
  const { gb, rng } = c;
  const n = rng.int(1, 3);
  for (let i = 0; i < n; i++) {
    const front = rng.chance(0.6);
    const ph = rng.float(0.12, h * 0.85), pw = rng.float(0.08, 0.2);
    const col = rng.pick(['#3f6a32', '#4f7a3a', '#5a8040']);
    if (front) gb.box(rng.float(-w / 2 + pw / 2, w / 2 - pw / 2), 0, d / 2 + 0.006, pw, ph, 0.012, col);
    else { const sd = rng.chance(0.5) ? 1 : -1; gb.box(sd * (w / 2 + 0.006), 0, rng.float(-d / 2 + pw / 2, d / 2 - pw / 2), 0.012, ph, pw, col); }
  }
}

function siding(c, w, d, y0, y1, color) {
  const { gb } = c;
  const col = shade(color, 0.86);
  for (let y = y0 + 0.04; y < y1 - 0.01; y += 0.045) {
    gb.box(0, y, d / 2 + 0.004, w + 0.008, 0.007, 0.006, col);
    gb.box(0, y, -d / 2 - 0.004, w + 0.008, 0.007, 0.006, col);
    gb.box(w / 2 + 0.004, y, 0, 0.006, 0.007, d + 0.008, col);
    gb.box(-w / 2 - 0.004, y, 0, 0.006, 0.007, d + 0.008, col);
  }
}

function quoins(c, w, d, h, color) {
  const { gb } = c;
  const col = shade(color, 1.18);
  for (let y = 0, k = 0; y < h - 0.02; y += 0.05, k++) {
    const l = k % 2 ? 0.05 : 0.035;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      gb.box(sx * (w / 2 - l / 2 + 0.004), y, sz * (d / 2 + 0.004), l, 0.04, 0.008, col);
      gb.box(sx * (w / 2 + 0.004), y, sz * (d / 2 - l / 2 + 0.004), 0.008, 0.04, l, col);
    }
  }
}


function bay(c, x, z, h, wall, roof) {
  const { gb } = c;
  gb.cbox(x, 0.03, z + 0.035, 0.18, h, 0.07, wall, 0, 0.008);
  gb.hip(x, 0.03 + h, z + 0.035, 0.18, 0.07, 0.05, roof, 0.015);
  gb.glow(WARM[0], WARM[1], WARM[2], 1 + c.rng.float(0.02, 0.9));
  gb.box(x, 0.03 + h * 0.3, z + 0.072, 0.13, h * 0.5, 0.008, GLASS);
  gb.noGlow();
}

// Something drawn only when `skip` is false: when it is, the drawing goes
// to a builder that keeps nothing, so the random picks run as before and the
// rest of the building comes out the same.
const NO_GB = new Proxy({}, { get: () => () => NO_GB });
function unseen(c, skip, draw) {
  if (!skip) return draw();
  const g = c.gb;
  c.gb = NO_GB;
  try { return draw(); } finally { c.gb = g; }
}

// A generic house body with roof, windows, door and optional chimney.
// Style comes from the palette: material (plaster, painted, brick, stone,
// timber-frame, clapboard or a stone/brick ground floor), roof shape and
// pitch, jettied upper floors, bay windows, porches, ivy, shutters and more.
// Does a wall face one of the streets along the building's sides (c.sides,
// from b.sides)? lx, lz: the wall's outward direction and ox, oz its middle,
// in the current frame; the wall must stand near that edge of the plot (not
// a party wall inside a row).
function facesStreet(c, lx, lz, ox, oz) {
  if (!c.sides || !c.box) return false;
  const e = c.gb.M.elements, B = c.box;
  const nx = e[0] * lx + e[8] * lz, nz = e[2] * lx + e[10] * lz;
  const px = e[0] * ox + e[8] * oz + e[12], pz = e[2] * ox + e[10] * oz + e[14];
  if (nx > 0.9) return !!(c.sides & 2) && B.x1 - px < 0.55;
  if (nx < -0.9) return !!(c.sides & 1) && px - B.x0 < 0.55;
  if (nz < -0.9) return !!(c.sides & 4) && pz - B.z0 < 0.55;
  return false;
}

export function house(c, o) {
  const { gb, rng, pal } = c;
  if (o.timber === undefined && pal.forced && pal.timber) o = { ...o, timber: true };
  const w = o.w, d = o.d, h = o.h, floors = o.floors || 1;
  const fancy = o.fancy !== false;
  const fh = h / floors;
  // The building's form (forms.js): every fancy house in the model takes its
  // roofs; the first one drawn (the model's main body, or o.main) its gable
  // to the street, dormers, porch, bay, balcony, turret and what stands on
  // its ridge. o.form: false for none of it, or features to leave out ({
  // turret: null }); o.roofLock keeps the roof asked for.
  const formed = fancy && o.form !== false && !!c.form;
  const main = formed && (o.main ?? !c.mainDone);
  if (main) c.mainDone = true;
  const F = main ? { ...c.form, ...(o.form || {}) } : null;
  let roofType = formed && !o.roofLock ? roofFor(c, o.roofType) : o.roofType;
  let alongZ = !!o.alongZ, rhK = 1;
  if (F && o.alongZ === undefined && F.front === 'gable' && ['gable', 'gambrel', 'halfhip', 'crossgable'].includes(roofType) && w <= 0.95 && d >= 0.34) {
    // the gable to the street: its pitch kept over the wider span
    alongZ = true;
    rhK = Math.min(1.35, Math.max(1, (w / d) * 0.85));
    if (roofType === 'crossgable') roofType = 'gable';
  }
  // a gabled bay would stand in front of a shopfront
  if (o.bareFront && roofType === 'crossgable') roofType = 'gable';
  // a mansard or a flat roof behind a parapet wants more than one storey under it
  if (floors < 2 && (roofType === 'mansard' || roofType === 'parapet')) roofType = 'hip';
  gb.push(o.x || 0, o.y || 0, o.z || 0, o.ry || 0);
  // where it stands in the model's frame, so an extension can be built on to it
  if (c.houses) {
    const pts = [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]].map(([x, z]) => new THREE.Vector3(x, 0, z).applyMatrix4(gb.M));
    const turned = Math.abs(Math.sin(o.ry || 0)) > 0.5;
    c.houses.push({
      x0: Math.min(...pts.map(p => p.x)), x1: Math.max(...pts.map(p => p.x)), z0: Math.min(...pts.map(p => p.z)), z1: Math.max(...pts.map(p => p.z)),
      h, floors, rh: o.rh ?? 0.24, roofType, ridgeX: !alongZ !== turned, wall: o.wall, roof: o.roof, timber: o.timber, plinth: o.plinth || null,
    });
  }
  footing(c, 0, 0, w, d, o.footColor || STONE);
  if (o.plinth) gb.cbox(0, 0, 0, w + 0.035, 0.08, d + 0.035, o.plinth, 0, 0.015);
  const mixedLower = fancy && pal.style === 'mixed' && floors >= 2;
  const jetty = fancy && o.timber && pal.jetty && floors >= 2 ? 0.035 : 0;
  if (mixedLower) {
    gb.cbox(0, 0, 0, w, fh, d, pal.lower, 0, 0.024);
    gb.cbox(0, fh, 0, w + jetty * 2, h - fh, d + jetty * 2, o.wall, 0, 0.02);
  } else if (jetty) {
    gb.cbox(0, 0, 0, w, fh, d, o.wall, 0, 0.024);
    gb.cbox(0, fh, 0, w + jetty * 2, h - fh, d + jetty * 2, o.wall, 0, 0.02);
    gb.box(0, fh - 0.012, 0, w + jetty * 2 + 0.01, 0.024, d + jetty * 2 + 0.01, TIMBER);
  } else gb.cbox(0, 0, 0, w, h, d, o.wall, 0, 0.024);
  if (o.timber) timber(c, w + jetty * 2, d + jetty * 2, h, floors);
  if (fancy && (pal.style === 'clapboard' || o.siding)) siding(c, w, d, 0, h, o.wall);
  if (fancy && (pal.style === 'brick' || pal.style === 'stone') && !o.timber) quoins(c, w, d, h, o.wall);
  if (fancy && pal.ivy && !o.shopWindow) ivy(c, w, d, h);
  const hw = w / 2, hd = d / 2;
  let nF = o.nFront || Math.max(1, Math.floor(w / 0.22));
  // a centred front door wants an odd number of bays so it stands in the middle
  if (!o.nFront && fancy && pal.doorPos === 'center' && nF % 2 === 0 && w / (nF + 1) >= 0.14) nF++;
  const nS = Math.max(1, Math.floor(d / 0.24));
  const doorX = o.doorX ?? (fancy && pal.doorPos === 'center' ? 0
    : (nF > 1 && (nF % 2 === 1 || (fancy && pal.doorPos === 'side'))) ? -hw + (w / nF) * 0.5 : 0);
  const rw = w + jetty * 2, rd = d + jetty * 2;
  const rh = (o.rh ?? 0.24) * (fancy ? pal.pitch : 1) * rhK;
  const trim = pal.style === 'stone' ? shade(o.wall, 1.14) : '#e3dccd';
  // a gable to the street finished with a shaped parapet (the form's, not on
  // timber; or o.gableFront)
  const shaped = alongZ && roofType === 'gable' ? o.gableFront || (F && F.gable && F.gable !== 'plain' && !o.timber && pal.style !== 'timber' ? F.gable : null) : null;
  // the ridge, for what stands on it: its height, where it runs (z, or x when
  // the ridge runs back) and how long it is
  let ridge = { y: h + rh, at: 0, len: alongZ ? rd : rw }, M = null, top = h + rh;
  if (roofType === 'hip') { gb.hip(0, h, 0, rw, rd, rh, o.roof, 0.06, alongZ); ridge.len = Math.max(0, alongZ ? rd - rw : rw - rd); }
  else if (roofType === 'thatch') { thatchRoof(c, 0, h, 0, rw, rd, rh, o.wall, o.roof, alongZ); ridge = null; }
  else if (roofType === 'flat') { gb.cbox(0, h, 0, rw + 0.03, 0.045, rd + 0.03, o.roof, 0, 0.01); ridge = { y: h + 0.045, at: 0, len: 0 }; top = h + 0.045; }
  else if (roofType === 'parapet') { top = parapetRoof(c, rw, rd, h, o.wall, o.roof, trim).top; ridge = { y: h, at: 0, len: 0 }; }
  else if (roofType === 'mansard') { M = mansardRoof(c, rw, rd, h, rh, o.roof, trim); top = M.top; ridge = { y: M.top, at: 0, len: Math.max(0, Math.abs(rw - rd)) }; }
  else if (roofType === 'gambrel') { const G = gambrelRoof(c, rw, rd, h, rh * 1.2, o.wall, o.roof, alongZ); top = G.top; ridge.y = top; ridge.knee = G.knee; }
  else if (roofType === 'halfhip') { solidRoof(c, 0, h, 0, rw, rd, rh, Math.max(0.05, (alongZ ? rd : rw) - (alongZ ? rw : rd) * 0.45), 0, o.roof, alongZ); ridge.len = Math.max(0.05, (alongZ ? rd : rw) - (alongZ ? rw : rd) * 0.45); }
  else if (roofType === 'saltbox') { solidRoof(c, 0, h, 0, rw, rd, rh * 1.1, alongZ ? rd : rw, (alongZ ? rw : rd) * 0.18, o.roof, alongZ); ridge = { y: h + rh * 1.1, at: (alongZ ? rw : rd) * 0.18, len: alongZ ? rd : rw }; top = ridge.y; }
  else {
    if (shaped) gableRoof(c, 0, h, 0, rw, rd, rh, o.wall, o.roof, 0.06, true, 0.012, 0.06);
    else gb.gable(0, h, 0, rw, rd, rh, o.wall, o.roof, 0.06, alongZ, 0.035);
    if (roofType === 'crossgable' && !alongZ && rw > 0.45) {
      // a gabled bay facing the street, on the side away from the door (clear
      // of it, when the door is in the middle)
      const sg = rng.chance(0.5) ? 1 : -1, gw = Math.min(0.26, rw * 0.38);
      const gx = Math.abs(doorX) > 0.05 ? -Math.sign(doorX) * rw * 0.22 : sg * Math.min(rw / 2 - gw / 2, Math.max(rw * 0.22, gw / 2 + 0.08));
      gb.cbox(gx, 0, rd / 2 - 0.02, gw, h, 0.09, o.wall, 0, 0.012);
      gb.gable(gx, h, rd / 2 - 0.02, gw, 0.13, rh * 0.85, o.wall, o.roof, 0.03, true, 0.03);
      win(c, gx, fh * 0.38, rd / 2 + 0.025, 0.07, 0.09, 'f', o.lit);
      if (floors > 1) win(c, gx, fh * 1.38, rd / 2 + 0.025, 0.07, 0.09, 'f', o.lit);
    }
  }
  if (shaped) top = Math.max(top, shapedGable(c, shaped, rd / 2, h - 0.01, rw, rh, o.wall, trim));

  const ww = o.ww || (fancy ? pal.winW : 0.075);
  // walls along a street at the side or back: every window, and a door on
  // the ground floor (the side door nearest the front; the back door in the
  // middle, unless the back is kept for one already)
  const onR = facesStreet(c, 1, 0, w / 2, 0), onL = facesStreet(c, -1, 0, -w / 2, 0), onB = !o.noBack && facesStreet(c, 0, -1, 0, -d / 2);
  const sideDoorH = Math.min(0.17, fh * 0.7), doorCol = o.door || pal.door;
  for (let f = 0; f < floors; f++) {
    const wh = Math.min(0.11, fh * 0.4);
    const wy = f * fh + fh * 0.38;
    const jz = f > 0 ? jetty : 0;
    for (let i = 0; i < nF; i++) {
      const u = -hw + (i + 0.5) * (w / nF);
      if (f === 0 && !o.noDoor && Math.abs(u - doorX) < 0.08) continue;
      const shop = f === 0 && o.shopWindow;
      // bareFront: the ground-floor front (or that many floors) is left for a shopfront
      if (f >= (o.bareFront === true ? 1 : o.bareFront || 0)) win(c, u, wy - (shop ? 0.02 : 0), hd + jz, shop ? ww * 1.6 : ww, shop ? wh * 1.3 : wh, 'f', o.lit);
      if (!o.noBack && (rng.chance(0.7) || onB)) {
        // o.backClear: stretches of the back wall kept for a door, a sign or
        // the like; o.backBars: the ground-floor windows barred
        const clear = o.backClear && o.backClear.some(([x0, x1, y0, y1]) => u >= x0 && u <= x1 && wy >= y0 && wy <= y1);
        if (onB && f === 0 && !o.backClear && i === nF >> 1 && nF > 1) { plainDoor(c, u, -hd, 0.075, sideDoorH, doorCol, 'b'); continue; }
        unseen(c, clear, () => win(c, u, wy, -hd - jz, ww, wh, 'b', o.lit));
        if (!clear && o.backBars && f === 0) for (let k = 1; k < 4; k++) gb.box(u - ww / 2 + (k * ww) / 4, wy, -hd - 0.014, 0.006, wh * (c.winH || 1), 0.006, IRON_D);
      }
    }
    for (let i = 0; i < nS; i++) {
      const u = -hd + (i + 0.5) * (d / nS);
      // o.bareSide: the ground floor of the left (1) or right (2) side kept
      // for a shopfront round the corner
      const bare = (k) => f === 0 && o.bareSide & k;
      const door = (k, on) => on && f === 0 && !bare(k) && i === nS - 1 && nS > 1 && !o.shopWindow;
      if (rng.chance(0.8) || onR) { if (door(2, onR)) plainDoor(c, hw, u, 0.075, sideDoorH, doorCol, 'r'); else unseen(c, bare(2), () => win(c, hw + jz, wy, u, ww, wh, 'r', o.lit)); }
      if (rng.chance(0.8) || onL) { if (door(1, onL)) plainDoor(c, -hw, u, 0.075, sideDoorH, doorCol, 'l'); else unseen(c, bare(1), () => win(c, -hw - jz, wy, u, ww, wh, 'l', o.lit)); }
    }
  }
  if (alongZ && !['hip', 'flat', 'parapet', 'mansard'].includes(roofType) && rh > 0.16) win(c, 0, h + rh * 0.22, rd / 2 + (shaped ? 0.026 : 0), 0.06, 0.07, 'f', o.lit);
  // the porch or door case (the form's, or a plain one if the style has porches)
  const porchKind = !o.noDoor && fancy && !o.shopWindow ? (F ? F.porch : pal.porch ? 'canopy' : null) : null;
  if (!o.noDoor) {
    const dh = Math.min(0.18, fh * 0.7);
    door(c, doorX, hd, o.doorW || 0.09, dh, o.door || pal.door);
    if (porchKind && !(porchKind === 'veranda' && (floors > 2 || w > 1.0))) porchOf(c, porchKind, doorX, hd, dh, o.wall, o.roof, w, fh * 0.85);
  }
  // a turret on a front corner (away from the door; on a corner shop, on
  // its corner, corbelled out over the shopfront), where the plot has room
  let turretAt = 0;
  if (F && F.turret && floors >= 2 && w >= 0.5 && d >= 0.36 && roofType !== 'thatch' && o.turret !== false) {
    const kind = o.shopWindow || o.noDoor ? 'oriel' : F.turret;
    const side = c.corner & 1 ? -1 : c.corner & 2 ? 1 : !o.noDoor && Math.abs(doorX) > 0.05 ? -Math.sign(doorX) : F.side;
    for (const r of [Math.min(0.09, w * 0.13), 0.065]) {
      const tx = side * (hw - r * 0.35), tz = hd + jetty - r * 0.35;
      if (!inPlot(c, tx, tz, r + 0.03)) continue;
      const y0 = kind === 'oriel' ? fh + 0.03 : 0, tt = h + Math.min(rh * 0.4, 0.12);
      if (!y0) footing(c, tx, tz, r * 2, r * 2);
      turret(c, kind, tx, tz, y0, tt, r, fh, o.wall, roofType === 'parapet' || roofType === 'flat' ? pal.slate : o.roof, o.lit);
      turretAt = side;
      break;
    }
  }
  // a bay window (canted on the ground floor, two storeys tall, or an oriel
  // over the ground floor), on the side away from the door
  const bayKind = fancy && w > 0.45 && !turretAt && porchKind !== 'veranda' ? (F ? F.bay : pal.bay ? 'canted' : null) : null;
  if (bayKind && (!o.shopWindow || (bayKind === 'oriel' && o.oriel !== false))) {
    const bx = o.shopWindow ? 0 : doorX > 0 ? -hw * 0.5 : hw * 0.5;
    if (bayKind === 'canted' && !o.shopWindow) bay(c, bx, hd, Math.min(0.16, fh * 0.6), o.wall, o.roof);
    else if (floors >= 2 && fh >= 0.2) tallBay(c, bx, hd + jetty, fh, floors, o.wall, o.roof, o.lit, bayKind === 'oriel' || o.shopWindow);
  }
  // a balcony along the first floor (an iron one in the middle, or a timber
  // gallery the width of the front), where no porch stands up to it
  if (F && F.balcony && floors >= 2 && w >= 0.5 && o.balcony !== false && !['portico', 'gabled', 'pediment', 'veranda'].includes(porchKind)) {
    if (F.balcony === 'gallery' && !o.shopWindow) balcony(c, 'gallery', 0, fh, hd + jetty, w * 0.9);
    else if (F.balcony === 'iron') balcony(c, 'iron', 0, fh, hd + jetty, Math.min(0.28, w * 0.42));
  }
  if (o.chimney) {
    // Stacks stand on the ridge: one at each end, one in the middle, one at
    // an end, or built up the outside of a gable wall. The style decides; a
    // building without one goes by its own seed.
    const kind = o.smokeKind || 'home', col = o.chimneyColor || (pal.style === 'brick' ? pal.brick : STONE);
    let pos = o.chimneyPos || (fancy ? pal.chimneyPos || (pal.extChimney ? 'outside' : pal.chimneys > 1 ? 'ends' : 'side') : 'side');
    if (pos === 'outside' && alongZ) pos = 'side';
    // over a flat roof or a mansard a stack need only clear the top
    const st = roofType === 'parapet' || roofType === 'flat' ? h + 0.16 : M ? M.top + 0.06 : h + rh + 0.08;
    if (pos === 'outside') {
      const ex = (rng.chance(0.5) ? 1 : -1) * (rw / 2 + 0.035);
      gb.cbox(ex, 0, 0, 0.07, st - 0.02, 0.1, STONE, 0, 0.01);
      gb.cbox(ex, st - 0.02, 0, 0.085, 0.03, 0.11, STONE_D, 0, 0.008);
      c.addSmoke(ex, st + 0.05, 0, kind);
    } else {
      const spots = pos === 'ends' ? [-0.34, 0.34] : pos === 'center' ? [rng.float(-0.05, 0.05)] : [(rng.chance(0.5) ? 1 : -1) * 0.3];
      for (const u of spots) chimney(c, alongZ ? 0 : u * w, h - 0.06, st, alongZ ? u * d : 0, kind, col);
    }
  }
  // dormers: as many as the model asks for, or the form's own across the
  // front slope (in the steep slope of a mansard, the low one of a gambrel)
  const dKind = F && F.dormer ? F.dormer : 'gable';
  const nD = o.dormers ?? (F && F.dormer && w >= 0.45 && rh >= 0.18 && !alongZ ? Math.max(1, Math.min(3, Math.round(w / 0.34))) : 0);
  if (nD && !alongZ && M) mansardDormers(c, Math.max(nD, Math.round(w / 0.24)), w * 0.9, rd, h, M, o.wall, o.roof, o.lit);
  else if (nD && !alongZ && roofType === 'gambrel') dormers(c, dKind, nD, w, rd / 2, h, rd / 2 * 0.52, h + ridge.knee, o.wall, o.roof, o.lit);
  else if (nD && !alongZ && (['gable', 'halfhip'].includes(roofType) || (roofType === 'hip' && o.dormers))) dormers(c, dKind, nD, roofType === 'gable' ? w : w * 0.7, rd / 2, h, 0, h + rh, o.wall, o.roof, o.lit);
  else if (nD && !alongZ && roofType === 'crossgable' && o.dormers) dormers(c, dKind, nD, w, rd / 2, h, 0, h + rh, o.wall, o.roof, o.lit);
  // on the ridge: a cupola (not on a cottage), finials or a weather vane
  if (F && F.crest && ridge && o.crest !== false) {
    const kind = F.crest === 'cupola' && ((c.cat === 'residential' && w < 0.8) || o.chimneyPos === 'center' || pal.chimneyPos === 'center') ? 'finials' : F.crest;
    if (kind !== 'finials' || ridge.len > 0.1) {
      gb.push(0, 0, 0, alongZ ? Math.PI / 2 : 0);
      crest(c, kind, ridge.y, ridge.at, ridge.len, o.wall, o.roof);
      gb.pop();
    }
  }
  gb.pop();
  return { doorX, h, rh, roofType, alongZ, top, turret: turretAt };
}

// Whether a point of the house being drawn (x, z in its frame) stands at
// least m inside the plot (c.box), so something there won't poke out of it.
function inPlot(c, x, z, m) {
  if (!c.box) return true;
  const e = c.gb.M.elements, B = c.box;
  const px = e[0] * x + e[8] * z + e[12], pz = e[2] * x + e[10] * z + e[14];
  return px - m >= B.x0 && px + m <= B.x1 && pz - m >= B.z0 && pz + m <= B.z1;
}

export function bush(c, x, z, s = 1, color) {
  const col = color || c.rng.pick(LEAF);
  const y = c.gy(x, z);
  c.gb.sphere(x, y + 0.045 * s, z, 0.075 * s, col, 1, 0.75);
  if (s > 0.9) c.gb.sphere(x + 0.04 * s, y + 0.035 * s, z + 0.03 * s, 0.05 * s, shade(col, 1.08), 1, 0.8);
}

function smallTree(c, x, z, s = 1) {
  const { gb, rng } = c;
  const y = c.gy(x, z);
  gb.cyl(x, y - 0.01, z, 0.016 * s, 0.026 * s, 0.2 * s, 6, '#5e432c');
  const col = rng.pick(LEAF);
  gb.sphere(x, y + 0.26 * s, z, 0.11 * s, col, 1);
  gb.sphere(x + 0.05 * s, y + 0.31 * s, z - 0.02 * s, 0.075 * s, shade(col, 1.08), 1);
  gb.sphere(x - 0.05 * s, y + 0.22 * s, z + 0.04 * s, 0.07 * s, shade(col, 0.92), 1);
}

function flowers(c, x, z, n = 5, spread = 0.08) {
  const { gb, rng } = c;
  for (let i = 0; i < n; i++) {
    const fx = x + rng.float(-spread, spread), fz = z + rng.float(-spread, spread);
    const y = c.gy(fx, fz);
    gb.box(fx, y, fz, 0.008, 0.032, 0.008, '#4f7a3a');
    gb.sphere(fx, y + 0.036, fz, 0.015, rng.pick(FLOWER));
  }
}

function barrel(c, x, z, s = 1) {
  const y = c.gy(x, z);
  c.gb.cyl(x, y, z, 0.03 * s, 0.033 * s, 0.078 * s, 9, '#6e4a2c');
  c.gb.cyl(x, y + 0.02 * s, z, 0.0335 * s, 0.0335 * s, 0.006, 9, '#3f342c');
  c.gb.cyl(x, y + 0.055 * s, z, 0.0335 * s, 0.0335 * s, 0.006, 9, '#3f342c');
}

function crate(c, x, z, s = 1, color = '#94714a') {
  c.gb.cbox(x, c.gy(x, z), z, 0.065 * s, 0.06 * s, 0.065 * s, color, c.rng.float(-0.4, 0.4), 0.006);
}

export function bench(c, x, z, ry = 0, y = c.gy(x, z)) {
  const { gb } = c;
  gb.push(x, y, z, ry);
  gb.box(0, 0.036, 0, 0.17, 0.014, 0.05, '#7a5636');
  gb.box(0, 0.05, -0.022, 0.17, 0.04, 0.01, '#7a5636');
  gb.box(-0.07, 0, 0, 0.012, 0.036, 0.045, '#3f342c');
  gb.box(0.07, 0, 0, 0.012, 0.036, 0.045, '#3f342c');
  gb.pop();
}

export function lamp(c, x, z, h = 0.32, y = c.gy(x, z)) {
  const { gb } = c;
  gb.cyl(x, y, z, 0.011, 0.016, h, 6, '#2f2c2a');
  gb.glow(2.2, 1.6, 0.8, 3.0);
  gb.box(x, y + h, z, 0.036, 0.046, 0.036, '#ffe2a0');
  gb.noGlow();
  gb.cone(x, y + h + 0.046, z, 0.032, 0.032, 4, '#2f2c2a', Math.PI / 4);
  c.addGlow(x, y + h + 0.022, z);
}

// Split-rail fence around a rectangle, leaving a gap on the front side.
export function fence(c, x0, z0, x1, z1, color = FENCE, gap = null) {
  const { gb } = c;
  const segs = [[x0, z0, x1, z0], [x1, z0, x1, z1], [x1, z1, x0, z1], [x0, z1, x0, z0]];
  for (const [ax, az, bx, bz] of segs) {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(2, Math.round(len / 0.16));
    const ry = Math.atan2(bx - ax, bz - az);
    let prev = null;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
      const inGap = gap && Math.abs(pz - gap.z) < 0.01 && Math.abs(az - bz) < 0.01 && Math.abs(px - gap.x) < gap.w;
      const y = c.gy(px, pz);
      if (!inGap) gb.box(px, y - 0.01, pz, 0.016, 0.075, 0.016, color, c.rng.float(-0.2, 0.2));
      if (prev && !inGap && !prev.gap) {
        const mx = (px + prev.x) / 2, mz = (pz + prev.z) / 2, my = (y + prev.y) / 2;
        const pitch = Math.atan2(y - prev.y, len / n);
        for (const ry2 of [0.03, 0.058]) gb.boxC(mx, my + ry2, mz, 0.01, 0.01, len / n + 0.01, color, -pitch, ry);
      }
      prev = { x: px, z: pz, y, gap: inGap };
    }
  }
}

// Low boundary around a plot, in the household's chosen style.
function boundary(c, kind, x0, z0, x1, z1, gapX = 0) {
  const { gb } = c;
  if (kind === 'rail') fence(c, x0, z0, x1, z1, FENCE, { x: gapX, z: z1, w: 0.12 });
  else if (kind === 'picket') fence(c, x0, z0, x1, z1, '#ece6da', { x: gapX, z: z1, w: 0.12 });
  else if (kind === 'stone' || kind === 'hedge') {
    const col = kind === 'stone' ? '#9a9284' : '#4a7036', ht = kind === 'stone' ? 0.05 : 0.07;
    const seg = (ax, az, bx, bz) => {
      const len = Math.hypot(bx - ax, bz - az), mx = (ax + bx) / 2, mz = (az + bz) / 2;
      gb.cbox(mx, c.gy(mx, mz) - 0.01, mz, Math.abs(bx - ax) + 0.04, ht, Math.abs(bz - az) + 0.04, col, 0, 0.012);
      void len;
    };
    seg(x0, z0, x1, z0); seg(x1, z0, x1, z1); seg(x0, z0, x0, z1);
    seg(x0, z1, gapX - 0.08, z1); seg(gapX + 0.08, z1, x1, z1);
  }
}

function vegPatch(c, x, z) {
  const { gb, rng } = c;
  const y = c.gy(x, z);
  gb.box(x, y - 0.01, z, 0.2, 0.025, 0.16, '#5e4430');
  for (let i = 0; i < 3; i++) for (let k = 0; k < 4; k++) gb.sphere(x - 0.07 + k * 0.046, y + 0.025, z - 0.05 + i * 0.05, 0.017, rng.pick(['#5f9a42', '#7fae4f', '#c9a640', '#b84a3a']), 0);
}

function washingLine(c, x, z) {
  const { gb, rng } = c;
  for (const sd of [-1, 1]) gb.box(x + sd * 0.13, c.gy(x + sd * 0.13, z), z, 0.012, 0.16, 0.012, '#5e432c');
  gb.box(x, c.gy(x, z) + 0.15, z, 0.26, 0.004, 0.004, '#d8d0c0');
  for (let i = 0; i < 3; i++) gb.box(x - 0.08 + i * 0.08, c.gy(x, z) + 0.09, z, 0.05, 0.06, 0.004, rng.pick(['#e8e0d0', '#6a8ad9', '#d9536b', '#e8b84a', '#9c74c9']));
}

function beehives(c, x, z) {
  for (let i = 0; i < 2; i++) {
    const bx = x + i * 0.07, y = c.gy(bx, z);
    c.gb.cbox(bx, y, z, 0.05, 0.06, 0.05, '#e3d8b8', 0, 0.006);
    c.gb.box(bx, y + 0.06, z, 0.06, 0.012, 0.06, '#8a6a48');
  }
}

function handcart(c, x, z) {
  const { gb } = c;
  const y = c.gy(x, z);
  gb.push(x, y, z, c.rng.float(0, Math.PI));
  gb.cbox(0, 0.04, 0, 0.12, 0.04, 0.08, '#86663f', 0, 0.006);
  for (const sd of [-1, 1]) gb.cyl(sd * 0.065, 0.035, 0, 0.035, 0.035, 0.01, 8, '#4e3a2a', 0, 0, Math.PI / 2);
  gb.box(0.1, 0.05, 0, 0.12, 0.008, 0.008, '#5e432c');
  gb.pop();
}

export function hedge(c, x, z, w, d, h = 0.075) {
  c.gb.cbox(x, c.gy(x, z) - 0.01, z, w, h + 0.01, d, '#4a7036', 0, 0.02);
}

export function sign(c, x, y, z, w, h, color, ry = 0) {
  c.gb.box(x, y, z, w, h, 0.014, color, ry);
}

export function logs(c, x, z, n = 3, ry = 0) {
  const { gb } = c;
  gb.push(x, c.gy(x, z), z, ry);
  for (let row = 0; row < n; row++) {
    const count = n - row;
    for (let i = 0; i < count; i++) {
      const lz = (i - (count - 1) / 2) * 0.046, ly = 0.022 + row * 0.04;
      gb.cyl(0.1, ly, lz, 0.022, 0.022, 0.2, 6, (i + row) % 2 ? '#7d5b3b' : '#6e4e31', 0, 0, Math.PI / 2);
      gb.cyl(0.104, ly, lz, 0.019, 0.019, 0.004, 6, '#cfae7c', 0, 0, Math.PI / 2);
    }
  }
  gb.pop();
}

function cropRows(c, x0, z0, x1, z1, cols) {
  // little tufts of crops following the furrows painted on the ground
  const { gb, rng } = c;
  if (!cols) return;
  for (let z = z0 + 0.1; z < z1 - 0.05; z += 0.4) {
    for (let x = x0 + 0.06; x < x1 - 0.04; x += 0.11) {
      const px = x + rng.float(-0.02, 0.02), pz = z + rng.float(-0.02, 0.02);
      const s = rng.float(0.8, 1.2);
      gb.sphere(px, c.gy(px, pz) + 0.02 * s, pz, 0.032 * s, rng.chance(0.5) ? cols[0] : cols[1], 0, 0.75);
    }
  }
}

// ---------------------------------------------------------------- models

const MODELS = {};

// Every home model by "home rank": 0 cottage, 1 family house, 2 townhouse,
// 3 manor house, 4 grand manor. Used by houses, villas and flats.
function homeModel(c, L) {
  const { gb, rng, pal } = c;
  c.flowerBoxes = L >= 1 && pal.flowerBoxes;
  const wall = pal.wall;
  let yard = null;
  if (L <= 1) yard = cottagePlan(c, L === 1);
  else if (L === 3) manorHouse(c);
  else if (L >= 4) grandManor(c);
  else townhouseFlats(c);
  if (yard) { cottageYard(c, yard); return; }
  // yard (manors have their own formal gardens): every household picks a few things
  if (L >= 3) return;
  if (pal.fence !== 'none') boundary(c, pal.fence, -0.45, -0.45, 0.45, 0.45, 0);
  const front = [[-0.33, 0.36], [0.33, 0.36]], back = [[-0.36, -0.37], [0.36, -0.37]], side = [[-0.4, -0.05], [0.4, -0.05]];
  const extras = [
    () => { const p = rng.pick(front); flowers(c, p[0], p[1], rng.int(4, 8), 0.07); },
    () => { const p = rng.pick(back); smallTree(c, p[0], p[1], rng.float(0.8, 1.15)); },
    () => { const p = rng.pick(back); vegPatch(c, p[0] * 0.9, p[1] + 0.04); },
    () => washingLine(c, rng.chance(0.5) ? -0.2 : 0.2, -0.41),
    () => { const p = rng.pick(back); beehives(c, p[0] - 0.03, p[1]); },
    () => { const p = rng.pick(side); logs(c, p[0], p[1], 3, Math.PI / 2); },
    () => barrel(c, rng.float(-0.38, 0.38), 0.41),
    () => { const p = rng.pick(front); bench(c, p[0], p[1] + 0.03, Math.PI); },
    () => { const p = rng.pick(side); handcart(c, p[0], p[1] + 0.2); },
    () => { const p = rng.pick(front); bush(c, p[0], p[1], rng.float(0.8, 1.2)); bush(c, p[0] + 0.07, p[1] - 0.04, 0.7); },
  ];
  const picks = new Set();
  const n = rng.int(2, 4);
  while (picks.size < n) picks.add(rng.int(0, extras.length - 1));
  for (const i of picks) extras[i]();
}

// Manor House, in one of its plans: a broad hipped block with wings coming
// forward and a columned porch; an E, three gables to the drive (the wings'
// and a porch tower's in the middle); Palladian, a pedimented centre under a
// cupola with low pavilions either side; a tower house, a square tower at
// one end rising over the roof; a court, the house set back between wings
// with a wall and gate piers across the front.
function manorHouse(c) {
  const { gb, rng, pal } = c;
  const F = c.form, plan = planOf(c, 5), side = F.side;
  const stone = pal.stoneHouse || rng.chance(0.5);
  const mwall = stone ? pal.stoneWall : pal.wall;
  const roof = pal.forced ? pal.roof : rng.chance(0.6) ? pal.slate : pal.roof;
  // hipped and classical, unless the style calls for gables (Tudor,
  // cottage, stone or clapboard manors get gabled wings facing the drive)
  const hipped = !pal.forced || pal.hip || pal.style === 'brick';
  const timber = !stone && pal.timber, white = '#e9e2d4';
  if (plan === 1) {
    // an E: the wings' gables and a porch tower's between them
    house(c, { x: 0, z: -0.19, w: 0.88, d: 0.44, h: 0.6, floors: 2, wall: mwall, roof, roofType: 'gable', roofLock: true, rh: 0.3, chimney: true, chimneyPos: 'ends', plinth: STONE, noDoor: true, nFront: 5, timber, form: { turret: null, front: 'eaves', bay: null, balcony: null } });
    for (const sx of [-0.33, 0.33]) house(c, { x: sx, z: -0.02, w: 0.22, d: 0.5, h: 0.6, floors: 2, wall: mwall, roof, roofType: 'gable', alongZ: true, rh: 0.32, noDoor: true, chimney: false, nFront: 1, timber, plinth: STONE, form: false });
    house(c, { x: 0, z: 0.13 - 0.1, w: 0.2, d: 0.2, h: 0.82, floors: 3, wall: mwall, roof, roofType: 'gable', alongZ: true, rh: 0.2, doorX: 0, doorW: 0.09, nFront: 1, chimney: false, timber, plinth: STONE, form: false });
    if (F.porch) porchOf(c, F.porch === 'veranda' ? 'pediment' : F.porch, 0, 0.13, 0.18, mwall, roof, 0.2, 0.24);
  } else if (plan === 2) {
    // Palladian: a pediment over the middle of the front, a cupola on the
    // roof, a pavilion either side joined on by a low wall
    const r = house(c, { x: 0, z: -0.15, w: 0.56, d: 0.48, h: 0.62, floors: 2, wall: mwall, roof, roofType: 'hip', roofLock: true, rh: 0.24, chimney: true, chimneyPos: 'ends', plinth: STONE, doorX: 0, doorW: 0.11, nFront: 3, form: { turret: null, crest: null, porch: 'portico', front: 'eaves', bay: null, balcony: null } });
    gb.box(0, 0.6, 0.095, 0.58, 0.03, 0.03, white);
    gb.gable(0, 0.63, 0.095, 0.38, 0.03, 0.11, white, white, 0.012, true);
    gb.push(0, 0, -0.15); crest(c, 'cupola', r.top, 0, 0, mwall, roof); gb.pop();
    for (const s of [-1, 1]) {
      house(c, { x: s * 0.385, z: -0.12, w: 0.15, d: 0.3, h: 0.32, floors: 1, wall: mwall, roof, roofType: 'hip', rh: 0.12, noDoor: true, chimney: false, nFront: 1, plinth: STONE, form: false });
      gb.cbox(s * 0.295, 0, -0.12, 0.04, 0.2, 0.2, mwall, 0, 0.006);
      gb.box(s * 0.295, 0.2, -0.12, 0.05, 0.02, 0.22, white);
    }
  } else if (plan === 3) {
    // a tower house: a square tower at one end, a storey over the roof,
    // battlemented in stone or under a pyramid with a weather vane
    const x0 = -side * 0.08, tw = 0.2, tx = x0 + side * (0.31 + tw / 2 - 0.02);
    house(c, { x: x0, z: -0.17, w: 0.62, d: 0.48, h: 0.6, floors: 2, wall: mwall, roof, roofType: hipped ? 'hip' : 'gable', rh: 0.3, chimney: true, plinth: STONE, doorX: -side * 0.08, doorW: 0.1, nFront: 3, timber, form: { turret: null } });
    footing(c, tx, -0.1, tw, tw);
    gb.cbox(tx, 0, -0.1, tw, 0.96, tw, mwall, 0, 0.012);
    for (let f = 0; f < 3; f++) { win(c, tx, f * 0.3 + 0.1, -0.1 + tw / 2, 0.06, 0.1, 'f', 0.8); win(c, tx + side * tw / 2, f * 0.3 + 0.1, -0.1, 0.06, 0.1, side > 0 ? 'r' : 'l', 0.8); }
    if (stone || pal.style === 'stone') {
      gb.box(tx, 0.94, -0.1, tw + 0.03, 0.03, tw + 0.03, shade(mwall, 0.9));
      for (const a of [-1, 0, 1]) for (const b2 of [-1, 1]) { gb.box(tx + a * 0.08, 0.97, -0.1 + b2 * 0.1, 0.04, 0.045, 0.025, mwall); gb.box(tx + b2 * 0.1, 0.97, -0.1 + a * 0.08, 0.025, 0.045, 0.04, mwall); }
    } else {
      gb.hip(tx, 0.96, -0.1, tw, tw, 0.2, roof, 0.03);
      crest(c, 'vane', 1.16, -0.1, 0.04, mwall, roof);
    }
  } else if (plan === 4) {
    // a court: the house set back between wings running out to the street,
    // a low wall and gate piers across the front, gravel within
    house(c, { x: 0, z: -0.29, w: 0.6, d: 0.4, h: 0.6, floors: 2, wall: mwall, roof, roofType: hipped ? 'hip' : 'gable', rh: 0.28, chimney: true, chimneyPos: 'ends', plinth: STONE, doorX: 0, doorW: 0.11, nFront: 3, timber, form: { turret: null, balcony: null } });
    for (const s of [-1, 1]) house(c, { x: s * 0.36, z: -0.07, w: 0.2, d: 0.66, h: 0.5, floors: 2, wall: mwall, roof, roofType: hipped ? 'hip' : 'gable', alongZ: true, rh: 0.2, noDoor: true, chimney: s > 0, nFront: 1, timber, plinth: STONE });
    gravel(c, 0, 0.12, 0.48, 0.3);
    for (const s of [-1, 1]) gb.cbox(s * 0.17, c.gy(s * 0.17, 0.4) - 0.01, 0.4, 0.2, 0.08, 0.04, STONE, 0, 0.008);
    gatePiers(c, 0, 0.4, 0.14, STONE);
    smallTree(c, rng.chance(0.5) ? -0.12 : 0.12, 0.14, 0.8);
    return;
  } else {
    house(c, {
      x: 0, z: -0.17, w: 0.88, d: 0.5, h: 0.6, floors: 2, wall: mwall, roof, roofType: hipped ? 'hip' : 'gable', rh: 0.3,
      chimney: true, chimneyPos: 'ends', plinth: STONE, doorX: 0, doorW: 0.11, nFront: 5, timber, form: { porch: null },
    });
    for (const sd of [-1, 1]) {
      footing(c, sd * 0.33, 0.15, 0.22, 0.26);
      gb.cbox(sd * 0.33, 0, 0.15, 0.22, 0.46, 0.26, mwall, 0, 0.016);
      if (hipped) gb.hip(sd * 0.33, 0.46, 0.15, 0.22, 0.26, 0.16, roof, 0.035);
      else gb.gable(sd * 0.33, 0.46, 0.15, 0.22, 0.26, 0.2, mwall, pal.roof, 0.035, true, 0.03);
      win(c, sd * 0.33, 0.08, 0.28, 0.07, 0.1, 'f');
      win(c, sd * 0.33, 0.29, 0.28, 0.07, 0.1, 'f');
    }
    for (const sd of [-1, 1]) gb.cyl(sd * 0.075, 0, 0.14, 0.014, 0.016, 0.26, 8, white);
    gb.gable(0, 0.26, 0.12, 0.22, 0.11, 0.07, white, roof, 0.02);
  }
  hedge(c, -0.27, 0.44, 0.3, 0.06); hedge(c, 0.27, 0.44, 0.3, 0.06);
  smallTree(c, rng.chance(0.5) ? -0.42 : 0.42, -0.43, 1.1);
}

// Grand Manor, in one of its plans: a three-storey centre between wings
// with a portico; a domed centre over a portico between balustraded wings;
// Jacobean, a long front with a tower at each corner and a shaped gable over
// the doors; a château, a mansard between round turrets on the front
// corners and a steep pavilion roof over the middle.
function grandManor(c) {
  const { gb, pal } = c;
  const F = c.form, plan = planOf(c, 4);
  const mwall = pal.stoneWall, roof = pal.forced ? pal.roof : pal.slate, white = '#ece6da';
  const hipped = !pal.forced || pal.hip || pal.style === 'brick' || pal.style === 'stone';
  const portico = (n, span, z, ph) => {
    for (let i = 0; i < n; i++) gb.cyl(-span / 2 + (i * span) / (n - 1), 0.02, z, 0.016, 0.019, ph, 8, white);
    gb.cbox(0, ph + 0.02, z - 0.01, span + 0.08, 0.035, 0.1, white, 0, 0.006);
    gb.gable(0, ph + 0.055, z - 0.03, span + 0.08, 0.14, 0.08, white, roof, 0.02);
    gb.cbox(0, -0.03, z + 0.01, span + 0.1, 0.05, 0.12, STONE, 0, 0.008);
  };
  if (plan === 1) {
    // a dome on a drum over the centre, balustraded flat-roofed wings
    house(c, { x: 0, z: -0.14, w: 0.5, d: 0.56, h: 0.88, floors: 3, wall: mwall, roof, roofType: 'parapet', rh: 0.2, chimney: false, plinth: STONE, doorX: 0, doorW: 0.12, nFront: 3, form: false });
    gb.cyl(0, 0.94, -0.14, 0.17, 0.18, 0.12, 12, mwall);
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; gb.box(Math.sin(a) * 0.18, 0.96, -0.14 + Math.cos(a) * 0.18, 0.025, 0.08, 0.012, GLASS, a); }
    gb.sphere(0, 1.06, -0.14, 0.17, '#5f7f86', 1, 0.85);
    gb.cyl(0, 1.2, -0.14, 0.025, 0.035, 0.08, 8, white);
    for (const sd of [-1, 1]) house(c, { x: sd * 0.36, z: -0.16, w: 0.22, d: 0.54, h: 0.62, floors: 2, wall: mwall, roof, roofType: 'parapet', rh: 0.2, noDoor: true, plinth: STONE, nFront: 1, chimney: false, form: false });
    portico(4, 0.3, 0.24, 0.36);
  } else if (plan === 2) {
    // Jacobean: a long front, square towers at its corners under ogee caps,
    // and a shaped gable over the doors
    house(c, { x: 0, z: -0.16, w: 0.84, d: 0.48, h: 0.8, floors: 3, wall: mwall, roof, roofType: 'gable', roofLock: true, rh: 0.3, chimney: true, chimneyPos: 'ends', plinth: STONE, doorX: 0, doorW: 0.12, nFront: 5, form: { turret: null, front: 'eaves', porch: 'arch', bay: null, balcony: null, crest: null, dormer: null } });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const tx = sx * 0.42, tz = -0.16 + sz * 0.24;
      gb.cbox(tx, 0, tz, 0.14, 1.0, 0.14, mwall, 0, 0.01);
      gb.box(tx, 0.98, tz, 0.16, 0.025, 0.16, shade(mwall, 0.9));
      gb.sphere(tx, 1.0, tz, 0.075, roof, 1, 1.3);
      gb.box(tx, 1.08, tz, 0.008, 0.06, 0.008, IRON_D);
      if (sz > 0) for (let f = 0; f < 3; f++) win(c, tx, f * 0.27 + 0.1, tz + 0.07, 0.05, 0.09, 'f', 0.8);
    }
    wallGable(c, F.gable !== 'plain' ? F.gable : 'dutch', 0, 0.08, 0.28, 0.8, 0.26, 0.3, mwall, roof, white, 0.8);
  } else if (plan === 3) {
    // a château: a mansard between round turrets on the front corners, and
    // a steep pavilion roof over the middle of the front
    house(c, { x: 0, z: -0.15, w: 0.72, d: 0.52, h: 0.82, floors: 3, wall: mwall, roof, roofType: 'mansard', rh: 0.36, dormers: 4, chimney: true, chimneyPos: 'ends', plinth: STONE, doorX: 0, doorW: 0.12, nFront: 5, form: false });
    for (const s of [-1, 1]) turret(c, 'round', s * 0.36, 0.08, 0, 0.98, 0.09, 0.27, mwall, roof, 0.8);
    gb.cbox(0, 0.6, 0.06, 0.24, 0.3, 0.1, mwall, 0, 0.01);
    gb.roof(0, 0.9, -0.02, 0.28, 0.26, 0.32, 0.04, roof);
    win(c, 0, 0.66, 0.11, 0.07, 0.1, 'f', 0.8);
    for (const s of [-1, 1]) gb.cyl(s * 0.07, 0, 0.16, 0.014, 0.016, 0.24, 8, white);
    gb.box(0, 0.24, 0.13, 0.2, 0.02, 0.1, white);
  } else {
    house(c, {
      x: 0, z: -0.13, w: 0.5, d: 0.6, h: 0.88, floors: 3, wall: mwall, roof, roofType: hipped ? 'hip' : 'gable', rh: 0.32, chimney: true,
      chimneyPos: 'ends', plinth: STONE, doorX: 0, doorW: 0.12, nFront: 3, form: { porch: null, turret: null, balcony: null },
    });
    for (const sd of [-1, 1]) {
      house(c, {
        x: sd * 0.36, z: -0.16, w: 0.22, d: 0.54, h: 0.62, floors: 2, wall: mwall, roof, roofType: hipped ? 'hip' : 'gable', rh: 0.2,
        alongZ: !hipped, noDoor: true, plinth: STONE, nFront: 1, chimney: false,
      });
    }
    for (let i = 0; i < 4; i++) gb.cyl(-0.15 + i * 0.1, 0.02, 0.24, 0.016, 0.019, 0.36, 8, white);
    gb.cbox(0, 0.38, 0.23, 0.38, 0.035, 0.1, white, 0, 0.006);
    gb.gable(0, 0.415, 0.21, 0.38, 0.14, 0.08, white, roof, 0.02);
    gb.cbox(0, -0.03, 0.25, 0.4, 0.05, 0.12, STONE, 0, 0.008);
  }
  hedge(c, -0.3, 0.45, 0.32, 0.055); hedge(c, 0.3, 0.45, 0.32, 0.055);
  lamp(c, -0.21, 0.43, 0.3); lamp(c, 0.21, 0.43, 0.3);
  for (const sd of [-1, 1]) { gb.cbox(sd * 0.43, c.gy(sd * 0.43, 0.3) - 0.01, 0.3, 0.08, 0.06, 0.08, STONE, 0, 0.01); smallTree(c, sd * 0.43, 0.3, 0.7); }
}

// Townhouse Flats: three storeys, in one of its plans: a wing coming forward
// at one side, or a balcony along the first floor; two gables to the
// street; a pedimented middle rising over the eaves; bays up all three
// floors either side of the door.
function townhouseFlats(c) {
  const { gb, rng, pal } = c;
  const F = c.form, plan = planOf(c, 4), side = F.side;
  const w = rng.float(0.8, 0.88), d = rng.float(0.6, 0.68), h = rng.float(0.82, 0.9), fz = -0.1 + d / 2, fh = h / 3;
  const stone = !pal.timber && rng.chance(0.4), wall = stone ? pal.stoneWall : pal.wall;
  const roof = rng.chance(0.55) ? pal.slate : pal.roof, trim = '#e3dccd';
  const r = house(c, {
    x: 0, z: -0.1, w, d, h, floors: 3, wall, roof, roofType: pal.hip ? 'hip' : 'gable', rh: rng.float(0.28, 0.34),
    alongZ: false, chimney: true, timber: pal.timber, plinth: STONE, dormers: plan || pal.hip ? 0 : rng.int(1, 2), doorX: plan ? 0 : undefined, nFront: plan === 1 ? 4 : plan ? 5 : undefined,
    form: plan ? { turret: null, bay: null, balcony: plan === 2 ? null : F.balcony, front: 'eaves' } : {},
  });
  if (plan === 1) {
    for (const x of [-w / 4, w / 4]) wallGable(c, F.gable, x, fz, w * 0.36, h, 0.24, d * 0.45, wall, roof, trim, 0.8);
  } else if (plan === 2) {
    // the middle three bays brought forward over the door and carried up
    // into a pediment, on pilasters either side of the door
    const pw = w * 0.4;
    for (const s of [-1, 1]) gb.box(s * (pw / 2 - 0.015), 0, fz + 0.015, 0.03, fh, 0.03, '#e3dccd');
    gb.cbox(0, fh - 0.01, fz + 0.015, pw, h + 0.05 - fh, 0.04, wall, 0, 0.006);
    for (let f = 0; f < 3; f++) for (const u of f ? [-pw / 3, 0, pw / 3] : [-pw / 3, pw / 3]) win(c, u, f * fh + fh * 0.38, fz + 0.036, 0.06, Math.min(0.11, fh * 0.4), 'f', 0.8);
    gb.box(0, h + 0.04, fz + 0.015, pw + 0.03, 0.02, 0.06, trim);
    gb.gable(0, h + 0.06, fz + 0.015, pw + 0.03, 0.05, 0.1, trim, trim, 0.01, true);
  } else if (plan === 3) {
    for (const x of [-w * 0.3, w * 0.3]) tallBay(c, x, fz, fh, 3, wall, roof, 0.8, false, 3, 0.18);
  } else if (rng.chance(0.4)) {
    // a wing come forward, on the side away from the door
    const wx = (Math.abs(r.doorX) > 0.05 ? -Math.sign(r.doorX) : side) * 0.3;
    footing(c, wx, 0.14, 0.26, 0.3);
    gb.cbox(wx, 0, 0.14, 0.26, 0.5, 0.3, pal.wall, 0, 0.018);
    gb.hip(wx, 0.5, 0.14, 0.26, 0.3, 0.16, pal.roof, 0.04);
    win(c, wx, 0.09, 0.29, 0.07, 0.09, 'f');
    win(c, wx, 0.32, 0.29, 0.07, 0.09, 'f');
  } else if (rng.chance(0.5) && !F.balcony) {
    gb.box(0, 0.29, fz + 0.05, 0.32, 0.022, 0.1, '#5e432c');
    for (let i = -2; i <= 2; i++) gb.box(i * 0.075, 0.31, fz + 0.095, 0.01, 0.065, 0.01, '#3a2f28');
    gb.box(0, 0.375, fz + 0.095, 0.32, 0.012, 0.014, '#3a2f28');
  }
}

// A cottage (two: a family house) on its plot, in one of its own plans
// (planOf). A cottage: a plain block; a long house with its byre at one end
// under a lower roof; an L, a cross wing coming forward with its gable to
// the street; a dormered cottage, its windows in the roof; an outshut under
// a catslide roof behind; a square cottage under a pyramid roof. A family
// house: a double pile (a lean-to at the side); an L; a narrow house with
// its gable to the street; a gabled bay in the middle of the front with the
// door in it; a square house with a veranda; a house with a low wing at the
// side. Laid out inside c.box, so it follows land deals. Returns where it
// stands, for the garden (see cottageYard).
function cottagePlan(c, two) {
  const { gb, rng, pal } = c;
  c.boxAware = true;
  const B = c.box, bw = B.x1 - B.x0, wall = pal.wall, F = c.form, side = F.side;
  let plan = planOf(c, 6);
  // the wider plans want the width of a whole plot
  if (bw < (two ? [0, 0.82, 0, 0, 0, 0.9] : [0, 0.86, 0.78, 0, 0, 0])[plan]) plan = 0;
  const jit = rng.float(0.12, 0.2);
  let front = B.z1 - (pal.setback != null ? pal.setback + (jit - 0.16) * 0.3 : jit);
  const thatch = pal.thatched && (!two || rng.chance(0.5));
  const roof = thatch ? pal.thatch : pal.roof, roofType = thatch ? 'thatch' : pal.hip ? 'hip' : 'gable';
  const base = { wall, roof, roofType, timber: pal.timber, chimney: two || rng.chance(0.8) };
  // a gable to the street: the form's own, if it has one
  const gableT = thatch ? 'thatch' : ['gable', 'gambrel', 'halfhip'].includes(F.roofs.gable) ? F.roofs.gable : 'gable';
  const centre = (w, pad = 0.11) => { const lo = B.x0 + pad + w / 2, hi = B.x1 - pad - w / 2; return Math.min(hi, Math.max(lo, (B.x0 + B.x1) / 2 + rng.float(-0.06, 0.06))); };
  // a cross wing with its gable to the street, coming forward by `fwd`
  const crossWing = (hx, w, d, h, floors, rh, ww, fwd) => {
    const wd = d + fwd, wx = hx + side * (w / 2 - ww / 2 + 0.015);
    house(c, { ...base, x: wx, z: front + fwd - wd / 2, w: ww, d: wd, h, floors, rh, alongZ: true, roofType: gableT, roofLock: true, noDoor: true, chimney: false, nFront: 1 });
    return { x0: wx - ww / 2, x1: wx + ww / 2, z1: front + fwd, x: wx };
  };
  if (!two) {
    if (plan === 1) {
      // a long house: the cottage at one end, the byre at the other under a lower roof
      const w = Math.min(rng.float(0.64, 0.72), bw - 0.2), d = rng.float(0.3, 0.34), h = 0.27, hx = centre(w, 0.1), rh = rng.float(0.22, 0.27);
      const mw = w * 0.64, bwid = w - mw, mx = hx - side * bwid / 2, bx = hx + side * mw / 2;
      const r = house(c, { ...base, x: mx, z: front - d / 2, w: mw, d, h, floors: 1, rh, alongZ: false, dormers: 0, doorX: -side * mw * 0.16 });
      house(c, { ...base, x: bx + side * 0.01, z: front - d / 2 - 0.01, w: bwid + 0.02, d: d - 0.02, h: h - 0.045, floors: 1, rh: rh * 0.84, alongZ: false, noDoor: true, bareFront: true, chimney: false, nFront: 1 });
      gb.box(bx + side * 0.01, 0, front - 0.02 + 0.006, 0.11, 0.17, 0.014, shade(pal.wood, 0.9));
      gb.box(bx + side * 0.01, 0.084, front - 0.02 + 0.014, 0.11, 0.008, 0.006, '#3a2f28');
      return { x: mx, front, d, doorX: r.doorX };
    }
    if (plan === 2) {
      // an L: a cross wing coming forward at one end, its gable to the street
      const w = Math.min(rng.float(0.46, 0.52), bw - 0.24), d = rng.float(0.3, 0.34), h = rng.float(0.28, 0.31), hx = centre(w), rh = rng.float(0.22, 0.27);
      front -= 0.06;
      const r = house(c, { ...base, x: hx, z: front - d / 2, w, d, h, floors: 1, rh, alongZ: false, dormers: 0, doorX: -side * w * 0.16 });
      const wing = crossWing(hx, w, d, h, 1, rh * 1.05, Math.min(0.22, w * 0.45), 0.12);
      return { x: hx, front, d, doorX: r.doorX, wing };
    }
    if (plan === 3) {
      // a dormered cottage: its upper rooms in the roof
      const w = Math.min(rng.float(0.5, 0.58), bw - 0.22), d = rng.float(0.34, 0.38), h = 0.31, hx = centre(w);
      const r = house(c, { ...base, x: hx, z: front - d / 2, w, d, h, floors: 1, rh: 0.3, alongZ: false, dormers: w > 0.54 ? 3 : 2, chimney: true });
      return { x: hx, front, d, doorX: r.doorX };
    }
    if (plan === 4) {
      // an outshut along the back under a catslide roof
      const w = Math.min(rng.float(0.46, 0.52), bw - 0.22), d = rng.float(0.3, 0.33), h = rng.float(0.29, 0.32), hx = centre(w);
      const r = house(c, { ...base, roofType: thatch ? 'thatch' : 'gable', roofLock: true, x: hx, z: front - d / 2, w, d, h, floors: 1, rh: rng.float(0.22, 0.27), alongZ: false, dormers: 0 });
      const od = 0.15, oz = front - d - od / 2 + 0.01, oh = 0.17;
      footing(c, hx, oz, w - 0.02, od);
      gb.cbox(hx, 0, oz, w - 0.02, oh, od, shade(wall, 0.95), 0, 0.014);
      gb.wedge(hx, oh, oz - 0.012, w + 0.07, od + 0.05, h - oh + 0.025, roof, Math.PI);
      win(c, hx + side * w * 0.25, 0.06, oz - od / 2, 0.06, 0.07, 'b');
      return { x: hx, front, d: d + od, doorX: r.doorX };
    }
    if (plan === 5) {
      // a square cottage under a pyramid roof, its stack in the middle
      const w = Math.min(rng.float(0.42, 0.46), bw - 0.22), d = w - rng.float(0, 0.03), h = rng.float(0.3, 0.33), hx = centre(w);
      house(c, { ...base, x: hx, z: front - d / 2, w, d, h, floors: 1, rh: rng.float(0.2, 0.26), roofType: thatch ? 'thatch' : 'hip', alongZ: false, dormers: 0, chimney: true, chimneyPos: 'center', doorX: 0, nFront: 3 });
      return { x: hx, front, d, doorX: 0 };
    }
    const w = Math.min(rng.float(0.44, 0.54), bw - 0.22), d = rng.float(0.34, 0.4), h = rng.float(0.28, 0.33), hx = centre(w);
    const r = house(c, { ...base, x: hx, z: front - d / 2, w, d, h, floors: 1, rh: rng.float(0.2, 0.29), alongZ: pal.alongZ || undefined, dormers: 0 });
    return { x: hx, front, d, doorX: r.doorX };
  }
  if (plan === 1) {
    // an L: a cross wing of two storeys coming forward, a bay in its gable end
    const w = Math.min(rng.float(0.5, 0.56), bw - 0.26), d = rng.float(0.36, 0.4), h = rng.float(0.52, 0.56), hx = centre(w), rh = rng.float(0.26, 0.3);
    front -= 0.07;
    const r = house(c, { ...base, x: hx, z: front - d / 2, w, d, h, floors: 2, rh, alongZ: false, doorX: -side * w * 0.14, form: { turret: null, bay: null } });
    const wing = crossWing(hx, w, d, h, 2, rh * 1.08, Math.min(0.26, w * 0.48), 0.14);
    if (F.b < 0.6) bay(c, wing.x, front + 0.14, 0.15, wall, roof);
    return { x: hx, front, d, doorX: r.doorX, wing };
  }
  if (plan === 2) {
    // narrow and deep, its gable to the street, the door to one side
    const w = Math.min(rng.float(0.4, 0.46), bw - 0.24), d = rng.float(0.5, 0.56), h = rng.float(0.54, 0.58), hx = centre(w);
    const r = house(c, { ...base, roofType: gableT, roofLock: true, x: hx, z: front - d / 2, w, d, h, floors: 2, rh: rng.float(0.26, 0.3), alongZ: true, doorX: side * w * 0.22, nFront: 2, plinth: rng.chance(0.5) ? STONE : null });
    return { x: hx, front, d, doorX: r.doorX };
  }
  if (plan === 3) {
    // a gabled bay in the middle of the front, the door in it
    const w = Math.min(rng.float(0.56, 0.62), bw - 0.22), d = rng.float(0.38, 0.42), h = rng.float(0.52, 0.56), hx = centre(w), rh = rng.float(0.26, 0.3);
    front -= 0.05;
    house(c, { ...base, x: hx, z: front - d / 2, w, d, h, floors: 2, rh, alongZ: false, noDoor: true, doorX: 0, nFront: 3, main: false, dormers: F.dormer ? 2 : 0 });
    const bd = 0.13;
    house(c, { ...base, chimney: false, x: hx, z: front + 0.08 - bd / 2, w: 0.22, d: bd, h, floors: 2, rh: rh * 0.92, alongZ: true, roofType: gableT, roofLock: true, doorX: 0, nFront: 1, main: true });
    return { x: hx, front: front + 0.08, d: d + 0.08, doorX: 0 };
  }
  if (plan === 4) {
    // a square house under a hipped roof, a dormer in it and a veranda along the front
    const w = Math.min(rng.float(0.5, 0.54), bw - 0.22), d = w - 0.02, h = rng.float(0.54, 0.58), hx = centre(w);
    const r = house(c, {
      ...base, x: hx, z: front - d / 2, w, d, h, floors: 2, rh: rng.float(0.22, 0.26), roofType: thatch ? 'thatch' : 'hip', alongZ: false, chimney: true, chimneyPos: 'center',
      doorX: side * w * 0.22, nFront: 2, dormers: 1, form: { porch: 'veranda', dormer: F.dormer || 'hip', turret: null },
    });
    return { x: hx, front, d, doorX: r.doorX };
  }
  if (plan === 5) {
    // a low wing at the side, set back a little from the front
    const w = Math.min(rng.float(0.44, 0.5), bw - 0.44), d = rng.float(0.4, 0.44), h = rng.float(0.52, 0.56), ww = 0.2;
    const cx = centre(w + ww - 0.02), hx = cx - side * (ww - 0.02) / 2, wx = hx + side * (w / 2 + ww / 2 - 0.02);
    const r = house(c, { ...base, x: hx, z: front - d / 2, w, d, h, floors: 2, rh: rng.float(0.26, 0.3), alongZ: pal.alongZ || undefined, form: { turret: null } });
    house(c, { ...base, x: wx, z: front - 0.05 - (d - 0.08) / 2, w: ww + 0.02, d: d - 0.08, h: 0.27, floors: 1, rh: 0.17, alongZ: false, noDoor: true, chimney: false, nFront: 1 });
    return { x: hx, front, d, doorX: r.doorX, wing: { x0: wx - ww / 2, x1: wx + ww / 2, z1: front - 0.05 } };
  }
  // a double pile, and a lean-to at the side where there's room
  const w = Math.min(rng.float(0.5, 0.6), bw - 0.22), d = rng.float(0.4, 0.46), h = rng.float(0.52, 0.58), hx = centre(w);
  const r = house(c, {
    ...base, x: hx, z: front - d / 2, w, d, h, floors: 2, rh: rng.float(0.27, 0.33), alongZ: pal.alongZ || undefined, plinth: rng.chance(0.5) ? STONE : null, dormers: pal.dormers || undefined,
  });
  if (rng.chance(0.5)) {
    const ew = 0.2, ed = 0.28, ez = front - d + ed / 2 + 0.02;
    const sides = [1, -1].filter(sd => sd > 0 ? hx + w / 2 + ew + 0.08 < B.x1 : hx - w / 2 - ew - 0.08 > B.x0);
    if (sides.length) {
      const sd = rng.pick(sides), ex = hx + sd * (w / 2 + ew / 2 - 0.02);
      footing(c, ex, ez, ew, ed);
      gb.cbox(ex, 0, ez, ew, 0.24, ed, shade(wall, 0.96), 0, 0.016);
      gb.wedge(ex, 0.24, ez, ew + 0.05, ed + 0.05, 0.09, pal.roof, sd > 0 ? Math.PI / 2 : -Math.PI / 2);
      win(c, ex, 0.08, ez + ed / 2, 0.065, 0.085, 'f');
    }
  }
  return { x: hx, front, d, doorX: r.doorX };
}

// Front garden with a path to the door, a back garden with whatever the
// household fancies. Laid out inside c.box, so it follows land deals.
function cottageYard(c, y) {
  const { gb, rng, pal } = c;
  const B = c.box;
  const dx = y.x + y.doorX;
  if (pal.fence !== 'none') boundary(c, pal.fence, B.x0 + 0.04, B.z0 + 0.04, B.x1 - 0.04, B.z1 - 0.04, dx);
  const pz = (y.front + B.z1 - 0.04) / 2;
  gb.box(dx, c.gy(dx, pz) - 0.008, pz, 0.07, 0.012, Math.max(0.02, B.z1 - 0.06 - y.front), '#b9a888');
  const fz = (y.front + B.z1) / 2;
  for (const x of [B.x0 + 0.14, B.x1 - 0.14]) {
    if (Math.abs(x - dx) < 0.12) continue;
    // (not where a wing comes forward)
    if (y.wing && x > y.wing.x0 - 0.08 && x < y.wing.x1 + 0.08 && fz < y.wing.z1 + 0.08) continue;
    const r = rng.next();
    if (r < 0.45) flowers(c, x, fz, rng.int(4, 7), 0.06);
    else if (r < 0.75) bush(c, x, fz, rng.float(0.7, 1));
  }
  const z0 = B.z0 + 0.1, z1 = y.front - y.d - 0.06;
  if (z1 - z0 < 0.08) return;
  const bz = (z0 + z1) / 2;
  const slots = [B.x0 + 0.17, (B.x0 + B.x1) / 2, B.x1 - 0.17];
  const things = [
    (x) => vegPatch(c, x, bz),
    (x) => washingLine(c, x, bz),
    (x) => gardenShed(c, x, bz),
    (x) => smallTree(c, x, bz, rng.float(0.8, 1.1)),
    (x) => beehives(c, x - 0.035, bz),
    (x) => logs(c, x - 0.1, bz, 2, 0),
    (x) => henHouse(c, x, bz),
    (x) => bench(c, x, bz, 0),
  ];
  const order = [0, 1, 2].sort(() => rng.next() - 0.5);
  const used = new Set();
  const n = rng.int(2, 3);
  for (let k = 0; k < n; k++) {
    let t = rng.int(0, things.length - 1);
    while (used.has(t)) t = (t + 1) % things.length;
    used.add(t);
    things[t](slots[order[k]]);
  }
}

function gardenShed(c, x, z) {
  const { gb, pal } = c;
  const y = c.gy(x, z);
  gb.cbox(x, y, z, 0.14, 0.12, 0.11, pal.wood, 0, 0.008);
  gb.wedge(x, y + 0.12, z, 0.17, 0.14, 0.05, shade(pal.roof, 0.9), 0);
  gb.box(x, y, z + 0.056, 0.045, 0.09, 0.006, '#4e3828');
}

function henHouse(c, x, z) {
  const { gb } = c;
  const y = c.gy(x, z);
  for (const sx of [-1, 1]) gb.box(x + sx * 0.045, y, z - 0.03, 0.012, 0.05, 0.012, '#5e432c');
  gb.cbox(x, y + 0.05, z - 0.03, 0.12, 0.07, 0.08, '#a8804e', 0, 0.006);
  gb.wedge(x, y + 0.12, z - 0.03, 0.14, 0.1, 0.04, '#6f5a44', 0);
  gb.box(x, y + 0.015, z + 0.035, 0.03, 0.006, 0.07, '#7a5a3c', 0, -0.5);
  for (let i = 0; i < 2; i++) gb.sphere(x - 0.03 + i * 0.07, y + 0.02, z + 0.07, 0.018, i ? '#f2ede0' : '#a8653a', 0);
}

MODELS.house = (c, L) => homeModel(c, Math.min(L, 1));
MODELS.villa = (c, L) => {
  if (L === 0) { c.flowerBoxes = c.pal.flowerBoxes; villa(c); } else homeModel(c, L + 2);
};
MODELS.flats = (c, L) => {
  if (L === 0) homeModel(c, 2); else if (L === 1) tenement(c); else mansionBlock(c);
};

MODELS.market = (c, L) => {
  const { gb, rng, pal } = c;
  const awnA = pal.awning, awnB = '#e9dfc9';
  const stall = (x, z, ry, s = 1) => marketStall(c, x, z, ry, s, awnA);
  // the stalls and the Market Hall's arcade are open: shoppers wander among them
  if (L === 0 || L >= 3) c.openAir = true;
  if (L === 0) {
    // the stalls, set out in the market's own way: two at angles; a row
    // along the street; round a market cross; or a striped tent and a cart.
    // (The front corners stay clear: a neighbour whose door faces the market
    // is walked to across them, from the street.)
    const plan = planOf(c, 4);
    if (plan === 1) {
      for (let i = 0; i < 3; i++) marketStall(c, -0.22 + i * 0.22, -0.2, 0, 0.5, i === 1 ? ownPick(c, AWNING, 3) : awnA);
      handcart(c, -0.02, 0.12); crate(c, -0.34, -0.4); barrel(c, 0.36, -0.4);
    } else if (plan === 2) {
      // a market cross on its steps, stalls either side facing it
      const y = c.gy(0, 0);
      for (let k = 0; k < 3; k++) gb.cbox(0, y - 0.02 + k * 0.035, 0, 0.24 - k * 0.06, 0.04, 0.24 - k * 0.06, STONE, Math.PI / 4, 0.006);
      gb.cyl(0, y + 0.1, 0, 0.018, 0.024, 0.3, 6, '#b8b0a2');
      gb.box(0, y + 0.38, 0, 0.08, 0.016, 0.016, '#b8b0a2');
      gb.sphere(0, y + 0.42, 0, 0.02, '#b8b0a2', 0);
      stall(-0.22, -0.2, Math.PI / 2, 0.7);
      stall(0.22, -0.2, -Math.PI / 2, 0.7);
      for (const x of [-0.12, 0.12]) basket(c, x, 0.3, rng.pick(['#c8402f', '#e0b030', '#9ab830']));
    } else if (plan === 3) {
      // a striped tent on poles, a cart of produce beside it
      const tx = -0.12, tz = -0.08, ty = c.gy(tx, tz);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) gb.box(tx + sx * 0.2, ty, tz + sz * 0.16, 0.016, 0.24, 0.016, '#5e432c');
      gb.cone(tx, ty + 0.24, tz, 0.3, 0.2, 4, awnA, Math.PI / 4);
      gb.cone(tx, ty + 0.37, tz, 0.105, 0.072, 4, awnB, Math.PI / 4);
      gb.box(tx, ty + 0.44, tz, 0.008, 0.06, 0.008, '#5e432c');
      gb.cbox(tx, ty, tz, 0.3, 0.12, 0.14, '#86613e', 0, 0.008);
      for (let i = 0; i < 6; i++) gb.sphere(tx - 0.12 + i * 0.048, ty + 0.14, tz, 0.02, rng.pick(['#b8402f', '#d98a32', '#7aa34a', '#d9c050']), 1);
      handcart(c, 0.18, -0.3); crate(c, 0.34, -0.42); crate(c, 0.26, -0.4, 0.8, '#a88458');
    } else {
      stall(-0.14, 0.06, 0);
      stall(0.22, -0.22, -Math.PI / 2, 0.85);
      crate(c, 0.26, 0.3); crate(c, 0.35, 0.22, 0.8, '#a88458'); barrel(c, -0.4, -0.32);
      if (rng.chance(0.6)) bench(c, -0.3, -0.28, Math.PI / 2);
    }
  } else if (L === 1) {
    const T = tallOf(c, 1), body = { z: -0.09, w: 0.72, d: 0.56, h: 0.5 + T * 0.25, floors: 2 + T, nFront: 3, timber: pal.timber, alongZ: pal.alongZ || undefined }, P = backPlan(c, body, { hoist: true });
    house(c, {
      ...body, wall: pal.wall, roof: pal.roof, roofType: 'gable',
      rh: 0.28, chimney: rng.chance(0.5), shopWindow: true, doorX: 0, lit: 0.9, backClear: P.clear, bareSide: c.corner,
    });
    for (let i = 0; i < 7; i++) gb.boxC(-0.3 + i * 0.1, 0.28, 0.24, 0.1, 0.014, 0.15, i % 2 ? awnB : awnA, 0.45);
    // the shop sign is a fascia over the shopfront, between the awning and the windows above
    sign(c, 0, 0.288, 0.2, 0.26, 0.05, '#5e432c');
    crate(c, -0.34, 0.36); crate(c, -0.25, 0.38, 0.9, '#a88458'); barrel(c, 0.36, 0.36);
    cornerShop(c, 'market', L, { x0: 0, w: body.w, fz: body.z + body.d / 2, d: body.d }, { fascia: '#5e432c', letter: '#e9dfc9', lit: true, awning: awnA });
    // round the back: a crate on the hoist to the store, more by the door
    shopBack(c, P, { fascia: '#5e432c', letter: '#e9dfc9', load: 'crate' });
    backSpots(c, P, 2).forEach((p, i) => (i ? barrel(c, p.x, p.z, 0.8) : backCrate(c, p.x, p.z, '#a88458')));
  } else if (L >= 3) {
    // Market Hall, in one of its plans: an open arcade below and the hall
    // above under a hipped roof with a clock lantern; Gothic, the hall's
    // steep gable to the street with a great window in it and a flèche;
    // classical, a pediment to the street over arches, a cupola on the
    // ridge; a market shed of iron and glass; or a market house of timber,
    // the hall on posts, jettied under a tile roof.
    const plan = planOf(c, 5), pier = '#cfc6b4';
    const arcade = (col) => {
      footing(c, 0, -0.04, 0.9, 0.76);
      gb.cbox(0, -0.01, -0.04, 0.9, 0.05, 0.76, STONE, 0, 0.01);
      for (let i = 0; i < 5; i++) for (const z of [-0.39, 0.31]) gb.cbox(-0.4 + i * 0.2, 0.04, z, 0.055, 0.26, 0.055, col, 0, 0.008);
      for (const x of [-0.4, 0.4]) for (const z of [-0.16, 0.08]) gb.cbox(x, 0.04, z, 0.055, 0.26, 0.055, col, 0, 0.008);
    };
    const hallWindows = (y, h) => {
      for (let i = 0; i < 5; i++) { win(c, -0.36 + i * 0.18, y, 0.35, 0.08, h, 'f', 0.9); win(c, -0.36 + i * 0.18, y, -0.43, 0.08, h, 'b', 0.9); }
      for (let i = 0; i < 3; i++) { win(c, 0.46, y, -0.24 + i * 0.2, 0.08, h, 'r', 0.9); win(c, -0.46, y, -0.24 + i * 0.2, 0.08, h, 'l', 0.9); }
    };
    if (plan === 1) {
      // Gothic: the hall's gable to the street, a great pointed window in it
      arcade(pier);
      gb.cbox(0, 0.3, -0.04, 0.92, 0.36, 0.78, pal.stoneWall, 0, 0.02);
      const arched = c.arched; c.arched = true;
      hallWindows(0.38, 0.17);
      c.arched = arched;
      gb.gable(0, 0.66, -0.04, 0.92, 0.78, 0.46, pal.stoneWall, pal.slate, 0.05, true, 0.035);
      gb.glow(1.4, 1.1, 0.7, 1.1); gb.arch(0, 0.76, 0.352, 0.11, 0.012, 10, GLASS); gb.box(0, 0.68, 0.358, 0.22, 0.08, 0.012, GLASS); gb.noGlow();
      for (let k = -1; k <= 1; k++) gb.box(k * 0.07, 0.68, 0.366, 0.008, 0.19, 0.006, pier);
      gb.cyl(0, 1.1, -0.1, 0.035, 0.05, 0.08, 6, pal.slate);
      gb.cone(0, 1.18, -0.1, 0.04, 0.2, 6, pal.slate);
    } else if (plan === 2) {
      // classical: round arches, a pediment to the street, a cupola
      arcade(STUCCO);
      for (let i = 0; i < 4; i++) gb.arch(-0.3 + i * 0.2, 0.22, 0.3, 0.075, 0.03, 8, STUCCO);
      gb.cbox(0, 0.3, -0.04, 0.92, 0.36, 0.78, STUCCO, 0, 0.02);
      hallWindows(0.41, 0.13);
      gb.box(0, 0.64, -0.04, 0.96, 0.03, 0.82, '#ece6da');
      gb.gable(0, 0.67, -0.04, 0.92, 0.78, 0.2, STUCCO, pal.slate, 0.04, true, 0.035);
      gb.gable(0, 0.67, 0.36, 0.94, 0.03, 0.2, '#ece6da', '#ece6da', 0.01, true);
      wallClock(c, 0, 0.74, 0.38, 0.045);
      gb.cyl(0, 0.84, -0.1, 0.07, 0.07, 0.1, 8, '#ece6da');
      gb.sphere(0, 0.94, -0.1, 0.075, '#5f8f7e', 1, 0.85);
      gb.box(0, 1.0, -0.1, 0.008, 0.06, 0.008, IRON_D);
    } else if (plan === 3) {
      // a market shed: iron columns, glass roofs, brick ends with lunettes
      footing(c, 0, -0.04, 0.92, 0.8);
      gb.cbox(0, -0.01, -0.04, 0.92, 0.04, 0.8, STONE, 0, 0.01);
      for (let i = 0; i < 4; i++) for (const z of [-0.4, -0.04, 0.32]) gb.cyl(-0.42 + i * 0.28, 0.03, z, 0.012, 0.016, 0.44, 6, '#2f3a3a');
      for (const z of [-0.4, 0.32]) gb.box(0, 0.47, z, 0.9, 0.03, 0.03, '#2f3a3a');
      for (const s of [-1, 1]) {
        gb.cbox(s * 0.44, 0.03, -0.04, 0.05, 0.44, 0.76, pal.brick, 0, 0.008);
        gb.glow(1.5, 1.2, 0.7, 1.1);
        gb.box(s * 0.468, 0.12, -0.04, 0.01, 0.18, 0.3, GLASS);
        gb.noGlow();
        gb.gable(s * 0.44, 0.47, -0.04, 0.05, 0.8, 0.26, pal.brick, pal.brick, 0.005, false);
      }
      glassRoof(c, 0, 0.5, -0.04, 0.84, 0.8, 0.26, true, 8);
      gb.box(0, 0.76, -0.04, 0.86, 0.02, 0.025, '#2f3a3a');
      gb.glow(1.5, 1.2, 0.7, 1.1);
      for (const z of [-0.43, 0.35]) gb.box(0, 0.25, z, 0.78, 0.14, 0.01, GLASS);
      gb.noGlow();
    } else if (plan === 4) {
      // a timber market house: the hall on posts, jettied, under tiles
      footing(c, 0, -0.04, 0.84, 0.66);
      gb.cbox(0, -0.01, -0.04, 0.84, 0.04, 0.66, STONE, 0, 0.01);
      for (let i = 0; i < 4; i++) for (const z of [-0.33, 0.25]) gb.box(-0.36 + i * 0.24, 0.03, z, 0.04, 0.27, 0.04, TIMBER);
      for (const x of [-0.36, 0.36]) gb.box(x, 0.03, -0.04, 0.04, 0.27, 0.04, TIMBER);
      gb.push(0, 0.3, -0.04);
      gb.cbox(0, 0, 0, 0.9, 0.3, 0.72, pal.forced ? pal.wall : '#e6d9bf', 0, 0.01);
      timber(c, 0.9, 0.72, 0.3, 1);
      gb.pop();
      gb.box(0, 0.29, -0.04, 0.92, 0.024, 0.74, TIMBER);
      hallWindows(0.38, 0.1);
      gb.gable(0, 0.6, -0.04, 0.9, 0.72, 0.34, pal.forced ? pal.wall : '#e6d9bf', pal.tile, 0.05, false, 0.035);
      gb.cbox(0, 0.84, -0.04, 0.1, 0.12, 0.1, TIMBER, 0, 0.008);
      gb.roof(0, 0.96, -0.04, 0.13, 0.13, 0.1, 0, pal.tile);
    } else {
      // open arcade below, hall above, clock lantern on the roof
      arcade(pier);
      gb.cbox(0, 0.3, -0.04, 0.92, 0.36, 0.78, pal.brick, 0, 0.02);
      hallWindows(0.41, 0.13);
      gb.hip(0, 0.66, -0.04, 0.92, 0.78, 0.26, pal.slate, 0.05);
      gb.cbox(0, 0.86, -0.04, 0.15, 0.15, 0.15, '#e9e2d4', 0, 0.01);
      gb.glow(1.2, 1.1, 0.8, 1.02); gb.cyl(0, 0.935, 0.036, 0.045, 0.045, 0.01, 12, '#efe8da', 0, Math.PI / 2); gb.noGlow();
      gb.roof(0, 1.01, -0.04, 0.18, 0.18, 0.15, 0, pal.slate);
    }
    const goods = ['#b8402f', '#d98a32', '#7aa34a', '#d9c050'];
    for (let i = 0; i < 3; i++) {
      const x = -0.25 + i * 0.25;
      gb.cbox(x, 0.04, -0.04, 0.16, 0.08, 0.1, '#86613e', 0, 0.008);
      for (let k = 0; k < 4; k++) gb.sphere(x - 0.05 + k * 0.034, 0.135, -0.04, 0.018, rng.pick(goods), 1);
    }
    lamp(c, -0.44, 0.44, 0.3); lamp(c, 0.44, 0.44, 0.3);
  } else {
    const body = { z: -0.09, w: 0.88, d: 0.68, h: 0.8, floors: 3, nFront: 4 }, P = backPlan(c, body, { hoist: true });
    house(c, {
      ...body, wall: rng.chance(0.5) ? pal.stoneWall : pal.wall, roof: pal.slate,
      roofType: 'hip', rh: 0.28, chimney: true, shopWindow: true, doorX: 0, lit: 0.9, plinth: STONE_D, doorW: 0.13, backClear: P.clear, bareSide: c.corner,
    });
    shopBack(c, P, { fascia: '#3b2f2a', load: 'crate' });
    for (let i = 0; i < 9; i++) gb.boxC(-0.4 + i * 0.1, 0.29, 0.3, 0.1, 0.014, 0.15, i % 2 ? awnB : awnA, 0.45);
    sign(c, 0, 0.298, 0.26, 0.42, 0.06, '#3b2f2a');
    gb.glow(1.8, 1.4, 0.6, 3.1); gb.box(0, 0.312, 0.268, 0.34, 0.03, 0.01, '#e0c070'); gb.noGlow();
    lamp(c, -0.4, 0.42, 0.3); lamp(c, 0.4, 0.42, 0.3);
    crate(c, -0.27, 0.42); barrel(c, 0.27, 0.42);
    cornerShop(c, 'market', L, { x0: 0, w: body.w, fz: body.z + body.d / 2, d: body.d }, { fascia: '#3b2f2a', lit: true, len: 0.44 });
  }
};

MODELS.bakery = (c, L) => {
  const { gb, rng, pal } = c;
  const T = tallOf(c, L), H = [T ? 0.56 : 0.34, 0.52 + T * 0.26, 0.62][Math.min(L, 2)];
  // the back door at the left end, the oven at the right under its stack
  const body = { z: -0.07, w: [0.64, 0.76, 0.88][Math.min(L, 2)], d: [0.52, 0.58, 0.64][Math.min(L, 2)], h: H, floors: (L ? 2 : 1) + T, nFront: 3, timber: pal.timber };
  const P = backPlan(c, body, { side: -1, yard: true });
  house(c, {
    ...body, wall: pal.forced || rng.chance(0.5) ? pal.wall : '#e2cfa8', roof: pal.thatched ? pal.thatch : pal.tile, roofType: pal.thatched ? 'thatch' : 'gable', rh: 0.26,
    shopWindow: true, doorX: 0, lit: 0.85, backClear: P.clear, bareSide: c.corner,
  });
  chimney(c, 0.2, 0.1, H + 0.36, -0.24, 'work', '#8f4f3a');
  // bread sign on a post
  const sx = 0.36, sz = 0.36, sy = c.gy(sx, sz);
  gb.box(sx, sy, sz, 0.016, 0.32, 0.016, '#3f342c');
  gb.box(sx, sy + 0.3, sz, 0.016, 0.016, 0.11, '#3f342c');
  gb.cyl(sx, sy + 0.22, sz + 0.05, 0.05, 0.05, 0.014, 12, '#c9944a', 0, Math.PI / 2);
  for (let i = 0; i < 3; i++) gb.sphere(-0.36 + i * 0.05, c.gy(-0.36 + i * 0.05, 0.4) + 0.025, 0.4, 0.028, '#e2d4b4', 1, 0.8);
  if (L) {
    for (let i = 0; i < 6; i++) gb.boxC(-0.25 + i * 0.1, 0.28, 0.27, 0.1, 0.014, 0.13, i % 2 ? '#e9dfc9' : pal.awning, 0.45);
    const tx = -0.34, tz = 0.36, ty = c.gy(tx, tz);
    gb.cyl(tx, ty, tz, 0.055, 0.055, 0.065, 10, '#e9dfc9');
    gb.cyl(tx, ty + 0.065, tz, 0.006, 0.006, 0.13, 4, '#3f342c');
    gb.cone(tx, ty + 0.18, tz, 0.11, 0.05, 8, pal.awning);
  }
  if (L >= 2) {
    chimney(c, -0.24, 0.1, H + 0.32, -0.26, 'work', '#8f4f3a');
    sign(c, 0, H - 0.08, 0.26, 0.34, 0.07, '#5e432c');
    gb.glow(1.8, 1.4, 0.6, 3.1); gb.box(0, H - 0.065, 0.268, 0.28, 0.035, 0.01, '#e0c070'); gb.noGlow();
    lamp(c, 0.42, 0.44, 0.3);
  }
  cornerShop(c, 'bakery', L, { x0: 0, w: body.w, fz: body.z + body.d / 2, d: body.d }, { fascia: '#5e432c', letter: '#e9dfc9', lit: L >= 1, awning: L ? pal.awning : null });
  // round the back: the bread oven built out from the wall under its stack,
  // and sacks of flour by the back door
  shopBack(c, P, { fascia: '#5e432c', letter: '#e9dfc9' });
  breadOven(c, 0.2, P.zb, '#9a5a42');
  for (const p of backSpots(c, P, 3)) sack(c, p.x, p.z, '#ece6da');
};

// A bread oven built out from a back wall at (x, zb): a brick base with the
// ash door in it and the dome of the oven over it.
function breadOven(c, x, zb, brick) {
  const { gb } = c;
  const od = Math.max(0.045, Math.min(0.065, zb + 0.47)), z = zb - od / 2 + 0.01;
  footing(c, x, z, 0.18, od);
  gb.cbox(x, 0, z, 0.18, 0.09, od, brick, 0, 0.01);
  gb.sphere(x, 0.09, zb, od, shade(brick, 1.06), 1, 0.9);
  gb.box(x, 0.022, zb - od + 0.008, 0.06, 0.04, 0.006, '#2a2018');
}

MODELS.tavern = (c, L) => {
  const { gb, rng, pal } = c;
  if (L === 0) {
    const T = tallOf(c, L, 1);
    house(c, {
      z: -0.09, w: 0.74, d: 0.56, h: 0.58 + T * 0.28, floors: 2 + T, wall: pal.wall, roof: pal.thatched ? pal.thatch : pal.tile,
      roofType: pal.thatched ? 'thatch' : 'gable', rh: 0.3, timber: true, chimney: true, lit: 0.95, plinth: STONE, bareSide: c.corner,
    });
  } else if (L >= 2) {
    // Coaching Inn: tall inn, a stable wing with a carriage arch, and a coach waiting outside
    house(c, {
      x: -0.17, z: -0.12, w: 0.6, d: 0.66, h: 0.86, floors: 3, wall: pal.wall, roof: pal.slate,
      roofType: 'gable', rh: 0.32, timber: true, chimney: true, lit: 0.95, plinth: STONE, dormers: 1, nFront: 3, bareSide: c.corner & 1,
    });
    footing(c, 0.3, -0.12, 0.34, 0.66);
    gb.cbox(0.3, 0, -0.12, 0.34, 0.5, 0.66, pal.wall, 0, 0.016);
    gb.gable(0.3, 0.5, -0.12, 0.34, 0.66, 0.22, pal.wall, pal.slate, 0.04, true, 0.03);
    gb.box(0.3, 0, 0.205, 0.18, 0.24, 0.012, '#2a2018');
    gb.cyl(0.3, 0.24, 0.205, 0.09, 0.09, 0.012, 10, '#2a2018', 0, Math.PI / 2);
    for (let i = 0; i < 2; i++) win(c, 0.22 + i * 0.16, 0.33, 0.21, 0.07, 0.1, 'f', 0.95);
    const cx = 0.1, cz = 0.4, cy = c.gy(cx, cz);
    gb.push(cx, cy, cz, Math.PI / 2);
    gb.cbox(0, 0.05, 0, 0.12, 0.1, 0.2, '#3f5466', 0, 0.01);
    gb.box(0, 0.15, 0, 0.13, 0.015, 0.22, '#2a2826');
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) gb.cyl(sx * 0.068, 0.035, sz * 0.07, 0.035, 0.035, 0.01, 8, '#2a2018', 0, 0, Math.PI / 2);
    gb.pop();
  } else {
    house(c, {
      x: -0.07, z: -0.1, w: 0.8, d: 0.62, h: 0.84, floors: 3, wall: pal.wall, roof: pal.slate,
      roofType: 'gable', rh: 0.32, timber: true, chimney: true, lit: 0.95, plinth: STONE, dormers: 2, bareSide: c.corner & 1,
    });
    footing(c, 0.4, -0.14, 0.18, 0.44);
    gb.cbox(0.4, 0, -0.14, 0.18, 0.27, 0.44, pal.wood, 0, 0.012);
    gb.wedge(0.4, 0.27, -0.14, 0.23, 0.48, 0.09, '#5e4a36', Math.PI / 2);
    gb.box(0.4, 0, 0.081, 0.12, 0.17, 0.012, '#2f241b');
  }
  // hanging sign
  const px = 0.36, pz = 0.38, py = c.gy(px, pz);
  gb.box(px, py, pz, 0.018, 0.4, 0.018, '#3a2f28');
  gb.box(px - 0.06, py + 0.38, pz, 0.14, 0.018, 0.018, '#3a2f28');
  sign(c, px - 0.08, py + 0.27, pz, 0.11, 0.09, '#3f4f5a');
  gb.cyl(px - 0.08, py + 0.31, pz + 0.01, 0.022, 0.022, 0.012, 8, '#d0a03a', 0, Math.PI / 2);
  barrel(c, -0.4, 0.34); barrel(c, -0.33, 0.4, 0.9);
  const tx = -0.1, tz = 0.38, ty = c.gy(tx, tz);
  gb.box(tx, ty, tz, 0.016, 0.065, 0.016, '#3f342c');
  gb.cyl(tx, ty + 0.065, tz, 0.055, 0.055, 0.01, 8, '#7a5636');
  lamp(c, 0.14, 0.42, 0.26);
  // a pub on a street corner: the bar's windows down the side street under
  // a painted fascia, and a lantern on the corner (the inn's wings take the
  // right-hand side)
  if (c.corner) {
    const B = [{ x0: 0, w: 0.74, fz: 0.19, d: 0.56 }, { x0: -0.07, w: 0.8, fz: 0.21, d: 0.62 }, { x0: -0.17, w: 0.6, fz: 0.21, d: 0.66 }][Math.min(L, 2)];
    const paint = ownPick(c, ['#2f4a3a', '#5a2a2a', '#2a2f4a', '#3a2a1f'], 13);
    cornerFronts(c, B, { fascia: paint, riser: shade(paint, 0.8), trim: shade(paint, 1.5), facing: paint, lit: true, skip: L ? 1 : 0, len: 0.34 });
    for (const s of [-1, 1]) {
      if (!(c.corner & (s < 0 ? 1 : 2)) || (L && s > 0)) continue;
      const x = B.x0 + s * (B.w / 2 + 0.03), z = B.fz + 0.03;
      gb.box(B.x0 + s * (B.w / 2 + 0.012), 0.34, B.fz + 0.012, 0.05, 0.008, 0.008, IRON_D, s * Math.PI / 4);
      gb.glow(2.2, 1.6, 0.8, 3.0); gb.box(x, 0.29, z, 0.03, 0.045, 0.03, '#ffe2a0'); gb.noGlow();
      gb.cone(x, 0.335, z, 0.024, 0.02, 4, IRON_D);
      c.addGlow(x, 0.31, z);
    }
  }
};

// ----------------------------------------------------------- the high street
// A shop for each trade (defs TRADES), standing at the front of its plot
// like the market and the bakery: a house whose ground floor is a
// shopfront, the trade's sign over the door and its goods out on the
// pavement. Each sets its front (fz) about the same distance back, so a row
// of them makes a street.

const FASCIA = ['#2f3e2a', '#3b2f2a', '#2a3a4a', '#4a2a2a', '#2f2f3a', '#1f3a3a'];
const GOLD = '#d0a03a', IRON_D = '#2f2c2a', STUCCO = '#ebe4d6';
// A pick of the building's own that stays the same at every level (c.rng
// changes with the level).
export const ownPick = (c, list, salt = 0) => new RNG(((c.variant || 0) ^ (0x9e3779 + salt * 7919)) >>> 0).pick(list);

// The body of a shop: a house with the front of its ground floor (or of
// `bare` floors) left bare for the shopfront. Its stack stands on the ridge
// (one built up the outside of a gable wall would stand off the plot).
// `back` plans the back of it (see backPlan), which the shop draws when it
// has set out its front (shopBack). Returns that plan (or the body's outline)
// with the house as it was drawn (P.r: its roof, top...).
function shopBody(c, o, bare = 1, back = null) {
  const p = c.pal.chimneyPos || (c.pal.extChimney ? 'outside' : c.pal.chimneys > 1 ? 'ends' : 'side');
  const P = back ? backPlan(c, { nFront: 3, ...o }, back) : { x0: o.x || 0, zb: (o.z || 0) - o.d / 2, w: o.w, d: o.d, h: o.h, floors: o.floors || 1, fh: o.h / (o.floors || 1) };
  P.r = house(c, { nFront: 3, doorX: 0, lit: 0.9, chimneyPos: p === 'outside' ? 'side' : p, bareSide: c.corner, ...o, shopWindow: true, bareFront: bare, noDoor: true, backClear: back && P.clear, backBars: back && back.bars });
  return P;
}

// A storey more, for a shop whose form has one (F.tall), below level `max`.
const tallOf = (c, L, max = 2) => (c.form && c.form.tall && L < max ? 1 : 0);

// The shop's name put up a second way, as its form has it (F.sign): a
// blade sign standing out from the wall at the first floor, the name
// painted in a band along the front over the shop, or a board along the
// eaves. P: the body (shopBody), sf: its shopfront (for the colours); s: the
// end of the front the blade goes (away from the hanging sign).
function shopSign(c, P, sf, s = -1) {
  const { gb } = c, kind = c.form && c.form.sign;
  if (!kind || !P || P.floors < 2) return;
  const fz = P.zb + P.d, x0 = P.x0, fascia = sf.fascia || '#2a2a30', letter = sf.letter || '#e0c070';
  if (kind === 'blade') {
    const x = x0 + s * (P.w / 2 - 0.035), y = P.fh + 0.03, bh = Math.min(0.2, P.fh * 0.8);
    gb.box(x, y + bh - 0.02, fz + 0.04, 0.008, 0.008, 0.08, IRON_D);
    gb.box(x, y + 0.01, fz + 0.04, 0.008, 0.008, 0.08, IRON_D);
    gb.box(x, y, fz + 0.075, 0.016, bh, 0.07, fascia);
    gb.glow(1.8, 1.4, 0.6, 3.1);
    for (const e of [-1, 1]) gb.box(x + e * 0.009, y + 0.02, fz + 0.075, 0.003, bh - 0.04, 0.03, letter);
    gb.noGlow();
  } else if (kind === 'band') {
    const y = P.fh + 0.012, bw = Math.min(P.w - 0.08, 0.6);
    gb.box(x0, y, fz + 0.004, bw, 0.04, 0.008, fascia);
    gb.box(x0, y + 0.012, fz + 0.009, bw * 0.78, 0.016, 0.004, letter);
  } else if (kind === 'eaves') {
    const y = P.h + 0.01, bw = Math.min(P.w * 0.62, 0.42);
    for (const e of [-1, 1]) gb.box(x0 + e * bw * 0.4, y - 0.02, fz - 0.02, 0.01, 0.05, 0.01, IRON_D);
    gb.box(x0, y + 0.02, fz - 0.02, bw, 0.065, 0.012, fascia);
    gb.glow(1.8, 1.4, 0.6, 3.1); gb.box(x0, y + 0.035, fz - 0.012, bw * 0.8, 0.03, 0.004, letter); gb.noGlow();
  }
}

// ----------------------------------------------------------- corner shops
// A shop on a street corner (c.corner: 1 its left side, 2 its right; see
// World._cornerOf) carries its shopfront round onto the side street: from
// the front corner back, windows on a riser under the fascia with the
// trade's goods in them (o.wares, called with the windows as at the front),
// an awning over them if the front has one (o.awning) and the pavement
// allows, and some of its goods out on the side pavement (o.out, called in
// the side wall's frame, x along the wall and z out into the street, with
// the length and the room there). A pilaster stands on the corner where the
// two fronts meet. B is the body ({ x0, w, fz, d }); o.skip: a side (-1 or
// 1) kept plain. Nothing goes further out than 0.07 inside the plot's side
// (o.lim, its half-width), so a corner shop is the same size as any other.
function cornerFronts(c, B, o = {}) {
  const { gb } = c;
  const h = o.h || 0.26, trim = o.trim || '#e3dccd', lim = (o.lim || 0.5) - 0.07;
  for (const s of [-1, 1]) {
    if (!(c.corner & (s < 0 ? 1 : 2)) || o.skip === s) continue;
    const xw = B.x0 + s * B.w / 2, len = Math.min(B.d - 0.1, o.len || 0.36), room = lim - Math.abs(xw);
    gb.push(xw, 0, B.fz - 0.02 - len / 2, s * Math.PI / 2);
    if (o.facing) gb.box(0, 0, 0.003, len + 0.03, h, 0.006, o.facing);
    const sf = shopfront(c, 0, 0, len, h, { fascia: o.fascia, trim, riser: o.riser, letter: o.letter, lit: o.lit, bow: o.bow && room >= 0.07, noDoor: true });
    if (o.wares) o.wares(sf);
    if (o.awning && room >= 0.05) awning(c, 0, sf.top - 0.004, 0, len + 0.01, o.awning, undefined, Math.min(0.15, room - 0.005));
    if (o.out && room >= 0.09) o.out(len, room);
    gb.pop();
    // the corner itself: a pilaster up to the fascias, and their return
    gb.box(xw, 0, B.fz - 0.004, 0.034, h, 0.034, trim);
    gb.box(xw, h - 0.06, B.fz - 0.004, 0.044, 0.06, 0.044, o.fascia || '#3b2f2a');
  }
}

// cornerFronts for a trade: its goods in the windows and on the pavement.
function cornerShop(c, trade, L, B, o = {}) {
  if (!c.corner) return;
  cornerFronts(c, B, { ...o, wares: WARES[trade] && ((sf) => WARES[trade](c, sf, L)), out: SIDE_OUT[trade] && ((len, room) => SIDE_OUT[trade](c, len, room)) });
}

// What each trade sets out in a shop window (sf, from shopfront), for a
// shopfront round a corner or a shop with homes over it.
const WARES = {
  grocer(c, sf) {
    for (const p of sf.panes) fruitTray(c, p.m, 0.05, p.z + 0.022, p.w - 0.02);
  },
  market(c, sf) { WARES.grocer(c, sf); },
  butcher(c, sf, L) {
    for (const p of sf.panes) {
      if (L) c.gb.box(p.m, 0.05, p.z + 0.012, p.w, 0.014, 0.04, '#e8e4dc');
      meatRail(c, p.m, sf.top - 0.014, p.z + 0.02, p.w - 0.02);
    }
  },
  cobbler(c, sf, L) {
    const BOOT = ['#2a2420', '#5e3a2a', '#3a2a20', '#7a4a2a', '#8a2f2f'];
    for (const p of sf.panes) for (const y of L ? [0.05, 0.11] : [0.05]) {
      if (y > 0.05) c.gb.box(p.m, y - 0.006, p.z + 0.006, p.w, 0.006, 0.02, '#5e432c');
      const n = Math.max(2, Math.floor(p.w / 0.032));
      for (let i = 0; i < n; i++) boot(c, p.m - p.w / 2 + (i + 0.5) * (p.w / n), y, p.z + 0.008, c.rng.pick(BOOT), 0.85);
    }
  },
  draper(c, sf) {
    for (const p of sf.panes) {
      const n = Math.max(1, Math.round(p.w / 0.11));
      for (let i = 0; i < n; i++) dummyAt(c, p.m - p.w / 2 + (i + 0.5) * (p.w / n), p.z + 0.02, c.rng.pick(PAINTED));
    }
  },
  ironmonger(c, sf) {
    for (const p of sf.panes) {
      const n = Math.max(2, Math.floor(p.w / 0.05));
      for (let i = 0; i < n; i++) pail(c, p.m - p.w / 2 + (i + 0.5) * (p.w / n), 0.05, p.z + 0.02, 0.8);
    }
  },
  chemist(c, sf, L) {
    let k = c.rng.int(0, 3);
    for (const p of sf.panes) {
      const n = Math.max(1, Math.round(p.w / 0.16)), u = p.w / n;
      for (let i = 0; i < n; i++) {
        const x = p.m - p.w / 2 + (i + 0.5) * u;
        if (L) for (const y of [0.075, 0.13]) { bottleShelf(c, x - u / 2 + 0.01, x - 0.04, y, p.z + 0.01); bottleShelf(c, x + 0.04, x + u / 2 - 0.01, y, p.z + 0.01); }
        carboy(c, x, 0.05, p.z + 0.032, k++, L ? 1.3 : 1);
      }
    }
  },
  stationer(c, sf) {
    for (const p of sf.panes) for (const y of [0.05, 0.1]) bookShelf(c, p.m - p.w / 2 + 0.006, p.m + p.w / 2 - 0.006, y, p.z + 0.01);
  },
  coffeehouse(c, sf) {
    for (const p of sf.panes) {
      const n = Math.max(2, Math.round(p.w / 0.07));
      for (let i = 0; i < n; i++) c.gb.cyl(p.m - p.w / 2 + (i + 0.5) * (p.w / n), 0.05, p.z + 0.02, 0.018, 0.012, 0.03, 8, i % 2 ? '#e8d8c0' : '#8a5a3a');
    }
  },
  postoffice(c, sf) {
    for (const p of sf.panes) {
      const n = Math.max(3, Math.round(p.w / 0.055));
      for (let i = 0; i < n; i++) c.gb.box(p.m - p.w / 2 + (i + 0.5) * (p.w / n), 0.07 + (i % 2) * 0.03, p.z + 0.004, 0.028, 0.02, 0.003, i % 3 === 1 ? '#c8a878' : '#ece6d6');
    }
  },
  bakery(c, sf) {
    for (const p of sf.panes) for (const y of [0.05, 0.1]) {
      c.gb.box(p.m, y, p.z + 0.012, p.w - 0.01, 0.006, 0.026, '#5e432c');
      const n = Math.max(2, Math.floor(p.w / 0.034));
      for (let i = 0; i < n; i++) c.gb.sphere(p.m - p.w / 2 + (i + 0.5) * (p.w / n), y + 0.016, p.z + 0.012, 0.014, i % 3 ? '#c9944a' : '#e2c48a', 0, 0.75);
    }
  },
};

// A tilted tray of fruit and greens in a window, w long, its foot at y.
function fruitTray(c, x, y, z, w) {
  const { gb, rng } = c;
  const COL = ['#c8402f', '#e08a2f', '#7aa34a', '#d9c050', '#8a3a6a', '#a8c060'];
  gb.boxC(x, y + 0.03, z, w, 0.008, 0.05, '#86613e', 0.6);
  const n = Math.max(2, Math.round(w / 0.03));
  for (let row = 0; row < 2; row++) {
    const col = rng.pick(COL);
    for (let i = 0; i < n; i++) gb.sphere(x - w / 2 + (i + 0.5) * (w / n), y + 0.044 + row * 0.022, z + 0.012 - row * 0.02, 0.013, col, 0);
  }
}

// What each trade puts out on the pavement of a side street (in the frame
// cornerFronts calls it in: x along the wall, z out into the street).
const SIDE_OUT = {
  grocer(c, len, room) { const z = room / 2; sack(c, -len * 0.28, z); basket(c, -len * 0.05, z, c.rng.pick(['#c8402f', '#e0b030', '#9ab830'])); sack(c, len * 0.2, z, '#b8a070'); },
  market(c, len, room) { const z = room / 2; backCrate(c, -len * 0.25, z, '#a88458'); barrel(c, len * 0.15, z, 0.8); },
  cobbler(c, len, room) { const z = room / 2; boot(c, -len * 0.15, c.gy(-len * 0.15, z), z, '#2a2420', 1.3); },
  draper(c, len, room) { clothStand(c, -len * 0.12, room / 2 + 0.02); },
  ironmonger(c, len, room) { const z = room / 2; pail(c, -len * 0.25, c.gy(-len * 0.25, z), z); ropeCoil(c, -len * 0.02, z); pail(c, len * 0.2, c.gy(len * 0.2, z), z, 0.9); },
  chemist(c, len, room) { const z = room / 2; for (const x of [-len * 0.25, len * 0.2]) { c.gb.cyl(x, c.gy(x, z), z, 0.02, 0.016, 0.03, 7, '#a8603a'); flowers(c, x, z, 3, 0.012); } },
  stationer(c, len, room) { newsBoard(c, -len * 0.15, room / 2, Math.PI / 2 + 0.2); },
  coffeehouse(c, len, room) { if (room >= 0.1) cafeTable(c, -len * 0.08, room / 2 + 0.005); },
  bakery(c, len, room) { const z = room / 2, x = -len * 0.15, y = c.gy(x, z); c.gb.cyl(x, y, z, 0.034, 0.026, 0.035, 8, '#a8804e'); for (let k = 0; k < 4; k++) c.gb.sphere(x + Math.cos(k * 1.6) * 0.014, y + 0.04, z + Math.sin(k * 1.6) * 0.014, 0.014, '#c9944a', 0); },
};


// ------------------------------------------------------------- shop backs
// From the yard a shop still shows its trade: the back door at one end bay,
// the name painted along the wall between the floors in the fascia's
// colours, a hoist up the other end bay for the stock at the bigger shops,
// and the trade's own things by the door (see each shop).

// Plans the back of a house body `o` before it's built, so its back windows
// keep clear (o.backClear) of what goes on the wall. k.hoist: loading doors
// up the far end bay; k.stack: that bay kept for a stack up the wall;
// k.yard: its ground floor kept; k.wide: the ground floor of the bay next to
// the door kept for a wide window; k.side: which end the door goes (else
// the building's own pick); k.sign: false for no painted name.
function backPlan(c, o, k = {}) {
  const { pal } = c;
  const w = o.w, d = o.d, h = o.h, floors = o.floors || 1, fh = h / floors, nF = o.nFront || 3, bw = w / nF;
  const timber = o.timber ?? (pal.forced && pal.timber);
  const jetty = o.fancy !== false && timber && pal.jetty && floors >= 2 ? 0.035 : 0;
  const side = k.side || ownPick(c, [-1, 1], 11);
  const bay = (i) => -w / 2 + (i + 0.5) * bw, di = side > 0 ? nF - 1 : 0;
  const door = bay(di), far = bay(nF - 1 - di), next = bay(nF > 1 ? di - side : di);
  const hoist = k.hoist && floors > 1 && nF > 1 ? far : null, stack = k.stack && nF > 1 ? far : null;
  const clear = [[door - bw / 2, door + bw / 2, 0, fh]];
  const keep = (x, y0, y1) => clear.push([x - bw / 2, x + bw / 2, y0, y1]);
  if (hoist !== null) keep(far, fh, h);
  if (stack !== null) keep(far, 0, h);
  if (k.yard && nF > 1) keep(far, 0, fh);
  if (k.escape && nF > 1) keep(far, fh, h);
  if (k.wide && nF > 1) keep(next, 0, fh);
  // the name goes on a board along the wall over the ground-floor windows
  // (on the jetty over them); a single storey has it in place of the window
  // next to the door, as its eaves come down over the wall
  const wtop = fh * 0.38 + Math.min(0.11, fh * 0.4) * (c.winH || 1) + 0.014;
  let sign = null;
  if (k.sign !== false) {
    const sw = Math.min(w - 0.1, 0.52);
    if (floors === 1) { if (!k.wide) { sign = { x: next, w: bw * 0.86, y: fh * 0.38, h: 0.07, z: 0 }; keep(next, 0, fh); } }
    else if (jetty) sign = { x: 0, w: sw, y: fh + 0.016, h: 0.055, z: jetty };
    else sign = { x: 0, w: sw, y: Math.max(fh + 0.004, wtop), h: 0.06, z: 0 };
  }
  return { x0: o.x || 0, zb: (o.z || 0) - d / 2, w, d, h, floors, fh, nF, bw, side, door, far, next, hoist, sign, jetty, clear };
}

// Draws the back planned by backPlan: the door (o.door, o.doorW, o.studs),
// the painted name (o.fascia, o.letter) and the hoist with o.load hanging
// on it ('sack', 'crate' or 'bolt'). A bay's x in the model: P.x0 + P.door.
function shopBack(c, P, o = {}) {
  const { gb, pal } = c;
  const zb = P.zb, x = P.x0 + P.door, dw = o.doorW || 0.08, dh = Math.min(0.17, P.fh * 0.66);
  gb.box(x, 0, zb - 0.004, dw + 0.026, dh + 0.018, 0.014, '#5a4330');
  gb.box(x, 0, zb - 0.01, dw, dh, 0.014, o.door || pal.door);
  if (o.studs) for (const u of [-0.25, 0.25]) for (let y = 0.03; y < dh - 0.01; y += 0.035) gb.box(x + u * dw, y, zb - 0.018, 0.006, 0.006, 0.004, '#8a8a84');
  const sd = Math.max(0.012, Math.min(0.04, zb + 0.465)), g = Math.min(c.gy(x, zb - sd / 2), 0.02);
  gb.cbox(x, g - 0.03, zb - sd / 2, dw + 0.05, 0.02 - g + 0.03, sd, STONE, 0, 0.008);
  if (P.sign && o.fascia) {
    const S = P.sign, z = zb - S.z;
    gb.box(P.x0 + S.x, S.y, z - 0.012, S.w, S.h, 0.012, o.fascia);
    gb.box(P.x0 + S.x, S.y + S.h * 0.3, z - 0.019, S.w * 0.74, S.h * 0.4, 0.004, o.letter || '#e0c070');
  }
  if (P.hoist !== null) {
    const hx = P.x0 + P.hoist, zw = zb - P.jetty;
    // boarded loading doors one over another, in white-painted frames
    for (let f = 1; f < P.floors; f++) {
      const y = f * P.fh + 0.02, hh = Math.min(0.17, P.fh - 0.07);
      gb.box(hx, y - 0.01, zw - 0.004, 0.094, hh + 0.02, 0.014, '#e3dccd');
      gb.box(hx, y, zw - 0.011, 0.076, hh, 0.012, o.hoistDoor || '#7a5232');
      gb.box(hx, y, zw - 0.018, 0.004, hh, 0.004, '#3a2f28');
      gb.boxC(hx, y + hh / 2, zw - 0.018, 0.005, hh * 1.05, 0.003, '#5e3e26', 0, 0, 0.42);
    }
    // a beam out under the eaves with its pulley, and the rope down to a load
    // (as far out as the yard behind allows)
    const by = P.h - 0.05, out = Math.max(0.025, Math.min(0.055, zw + 0.45)), rz = zw - out + 0.008;
    gb.box(hx, by, zw - out / 2, 0.022, 0.022, out, TIMBER);
    gb.cyl(hx + 0.004, by - 0.012, rz, 0.013, 0.013, 0.008, 8, IRON_D, 0, 0, Math.PI / 2);
    const r = Math.max(0.014, Math.min(0.03, (out - 0.01) / 0.85)), ly = by - 0.15;
    if (o.load) {
      gb.box(hx, ly + r, rz, 0.004, by - 0.024 - ly - r, 0.004, '#b89a5a');
      if (o.load === 'crate') gb.cbox(hx, ly - r * 0.6, rz, r * 1.7, r * 1.6, r * 1.6, '#94714a', 0, 0.004);
      else if (o.load === 'bolt') gb.cyl(hx + 0.04, ly + r * 0.3, rz, r * 0.6, r * 0.6, 0.08, 8, o.boltColor || '#7a3a5a', 0, 0, Math.PI / 2);
      else gb.blob(hx, ly, rz, r * 0.9, r * 1.3, r * 0.85, '#c8b088');
    } else gb.box(hx, by - 0.06, rz, 0.004, 0.036, 0.004, '#b89a5a');
  }
}

// Spots for the trade's things by the back door ({ x, z } on the ground),
// up to n of them along the wall beside it. They stand close in under the
// eaves (each no more than 0.05 deep), so the building takes no more room on
// its plot than it did; behind the tallest, which come right to the back of
// their plots, there is no room for them.
function backSpots(c, P, n = 3) {
  const out = [], dx = P.x0 + P.door, z = P.zb - 0.025;
  if (P.zb < -0.433) return out;
  for (const u of [0.1, -0.1, 0.17, -0.17]) {
    const x = dx + P.side * u;
    if (Math.abs(x - P.x0) <= P.w / 2 - 0.035 && out.length < n) out.push({ x, z });
  }
  return out;
}

// A stack built up the back wall (at x, zb) from the ground to over the
// eaves, smoking while the shop works: brick for a smoke-house or an oven,
// or a tin flue (o.tin) on brackets for a still or a kitchen range.
function backFlue(c, x, zb, top, o = {}) {
  const { gb } = c;
  if (o.tin) {
    const z = zb - 0.022, col = o.color || '#5a5a5e', y0 = o.y0 || 0.08;
    gb.cyl(x, y0, z, 0.011, 0.011, top - y0, 6, col);
    for (let y = y0 + 0.08; y < top - 0.05; y += 0.16) gb.box(x, y, zb - 0.012, 0.008, 0.008, 0.022, IRON_D);
    gb.cone(x, top, z, 0.024, 0.03, 6, col);
    c.addSmoke(x, top + 0.04, z, 'work');
    return;
  }
  const dd = Math.max(0.04, Math.min(0.055, zb + 0.48)), col = o.color || '#8f4f3a';
  gb.cbox(x, 0, zb - dd / 2 + 0.01, 0.08, top, dd, col, 0, 0.008);
  gb.cbox(x, top, zb - dd / 2 + 0.01, 0.095, 0.026, dd + 0.012, shade(col, 0.8), 0, 0.006);
  c.addSmoke(x, top + 0.05, zb - dd / 2 + 0.01, 'work');
}

// A wide window on the back wall (at x, y, zb), lit while the trade works
// at it: a cobbler's bench, a dispensary (tinted, glow [r, g, b]).
function backWindow(c, x, y, zb, w, h, glow = WARM) {
  const { gb } = c;
  const fr = c.frame || '#5a4330';
  gb.box(x, y - 0.012, zb - 0.002, w + 0.024, h + 0.024, 0.018, fr);
  gb.glow(glow[0], glow[1], glow[2], 1.4);
  gb.box(x, y, zb - 0.007, w, h, 0.018, GLASS);
  gb.noGlow();
  const n = Math.max(2, Math.round(w / 0.05));
  for (let i = 1; i < n; i++) gb.box(x - w / 2 + (i * w) / n, y, zb - 0.017, 0.006, h, 0.004, fr);
  gb.box(x, y + h * 0.55, zb - 0.017, w, 0.006, 0.004, fr);
}

// An iron fire escape down the far bay of the back wall: a landing and a
// door out at every floor over the ground, flights between the landings
// and a ladder let down towards the yard.
function fireEscape(c, P) {
  const { gb } = c;
  const x = P.x0 + P.far, zb = P.zb, ed = Math.max(0.016, Math.min(0.045, zb + 0.478)), lw = Math.min(0.17, P.bw * 0.85), z = zb - ed / 2;
  for (let f = 1; f < P.floors; f++) {
    const y = f * P.fh, s = (f % 2 ? 1 : -1) * P.side;
    gb.box(x, y + 0.004, zb - 0.004, 0.07, Math.min(0.16, P.fh - 0.07), 0.012, '#3a3a3e');
    gb.box(x, y, z, lw + 0.02, 0.006, ed, IRON_D);
    gb.box(x, y + 0.05, zb - ed + 0.002, lw + 0.02, 0.005, 0.004, IRON_D);
    for (const e of [-1, 1]) gb.box(x + e * (lw / 2 + 0.008), y, zb - ed + 0.002, 0.004, 0.05, 0.004, IRON_D);
    if (f > 1) {
      // the flight up from the landing below, and its handrail
      const len = Math.hypot(lw, P.fh), a = Math.atan2(P.fh, lw) * s;
      gb.boxC(x, y - P.fh / 2, z, len, 0.008, ed * 0.7, IRON_D, 0, 0, a);
      gb.boxC(x, y - P.fh / 2 + 0.045, zb - ed + 0.002, len, 0.004, 0.004, IRON_D, 0, 0, a);
    }
  }
  // the ladder down from the first landing, drawn up out of reach
  const lx = x + P.side * (lw / 2 - 0.02), y0 = 0.1;
  for (const e of [-1, 1]) gb.box(lx + e * 0.014, y0, zb - ed + 0.006, 0.004, P.fh - y0, 0.004, IRON_D);
  for (let y = y0 + 0.02; y < P.fh - 0.01; y += 0.03) gb.box(lx, y, zb - ed + 0.006, 0.03, 0.004, 0.004, IRON_D);
}

// Skylights in the back slope of a roof (one solidRoof would draw: its
// eaves 0.05 out, the ridge over the middle of the house at z = zc), at
// each of xs: a frame with lit glass in it.
function roofLights(c, x0, h, zc, rd, rh, xs) {
  const { gb } = c;
  const hd = rd / 2 + 0.05, a = Math.atan2(rh, hd), t = 0.42;
  const ys = h + rh * t, zs = zc - hd * (1 - t), ny = Math.cos(a), nz = -Math.sin(a);
  for (const x of xs) {
    gb.boxC(x0 + x, ys + ny * 0.004, zs + nz * 0.004, 0.09, 0.012, 0.13, '#4a4a4e', -a);
    gb.glow(WARM[0], WARM[1], WARM[2], 1.3);
    gb.boxC(x0 + x, ys + ny * 0.009, zs + nz * 0.009, 0.074, 0.008, 0.112, GLASS, -a);
    gb.noGlow();
    gb.boxC(x0 + x, ys + ny * 0.014, zs + nz * 0.014, 0.004, 0.004, 0.112, '#4a4a4e', -a);
  }
}

// Things by a shop's back door.
function backCrate(c, x, z, color = '#94714a') {
  c.gb.cbox(x, c.gy(x, z), z, 0.058, 0.05, 0.044, color, 0, 0.005);
}
function greensCrate(c, x, z) {
  backCrate(c, x, z, '#a88458');
  const y = c.gy(x, z) + 0.05;
  for (let i = 0; i < 4; i++) c.gb.sphere(x + ((i % 2) - 0.5) * 0.026, y + 0.008, z + ((i >> 1) - 0.5) * 0.018, 0.015, i % 3 ? '#6a9a3a' : '#8ab04a', 0);
}
function meatSafe(c, x, z) {
  const { gb } = c;
  const y = c.gy(x, z);
  for (const sx of [-1, 1]) gb.box(x + sx * 0.026, y, z, 0.008, 0.05, 0.008, '#5e432c');
  gb.cbox(x, y + 0.05, z, 0.064, 0.07, 0.05, '#8a6a48', 0, 0.004);
  gb.box(x, y + 0.06, z - 0.026, 0.046, 0.05, 0.004, '#3a3a3e');
}
function hideFrame(c, x, z, ry = 0) {
  const { gb } = c;
  gb.push(x, c.gy(x, z), z, ry);
  for (const s of [-1, 1]) gb.box(s * 0.05, 0, 0, 0.01, 0.13, 0.01, '#5e432c');
  gb.box(0, 0.125, 0, 0.11, 0.01, 0.01, '#5e432c');
  gb.box(0, 0.045, 0, 0.08, 0.08, 0.005, '#8a5a32');
  gb.pop();
}
function bale(c, x, z, color = '#c8b088') {
  const y = c.gy(x, z);
  c.gb.cbox(x, y, z, 0.07, 0.05, 0.042, color, 0, 0.012);
  c.gb.box(x, y + 0.049, z, 0.006, 0.004, 0.044, '#7a6a4a');
}
function drum(c, x, z, color = '#a8382a') {
  const y = c.gy(x, z);
  c.gb.cyl(x, y, z, 0.026, 0.026, 0.075, 9, color);
  for (const k of [0.02, 0.055]) c.gb.cyl(x, y + k, z, 0.028, 0.028, 0.005, 9, shade(color, 0.75));
}
function leaningBars(c, x, zb, n = 5) {
  for (let i = 0; i < n; i++) c.gb.boxC(x - 0.04 + i * 0.02, 0.1, zb - 0.02, 0.006, 0.2, 0.006, i % 2 ? '#4a4a4e' : '#3a3634', 0.18);
}
function wickerCarboy(c, x, z) {
  const { gb } = c;
  const y = c.gy(x, z);
  gb.cyl(x, y, z, 0.026, 0.024, 0.05, 8, '#a8804e');
  gb.sphere(x, y + 0.05, z, 0.022, '#7aa88a', 0, 0.7);
  gb.cyl(x, y + 0.058, z, 0.007, 0.008, 0.022, 6, '#9ab8a8');
}
function paperBundles(c, x, z, n = 3) {
  const y = c.gy(x, z);
  for (let i = 0; i < n; i++) {
    c.gb.box(x, y + i * 0.024, z, 0.06, 0.022, 0.036, i % 2 ? '#ece6d6' : '#ddd5c2', (i - 1) * 0.12);
    c.gb.box(x, y + i * 0.024 + 0.0225, z, 0.004, 0.002, 0.038, '#8a6a48', (i - 1) * 0.12);
  }
}
function churn(c, x, z) {
  const { gb } = c;
  const y = c.gy(x, z);
  gb.cyl(x, y, z, 0.022, 0.024, 0.05, 8, '#b8c0c4');
  gb.cyl(x, y + 0.05, z, 0.012, 0.022, 0.018, 8, '#b8c0c4');
  gb.cyl(x, y + 0.068, z, 0.014, 0.014, 0.008, 8, '#8a9296');
}

// A shopfront across the wall face at z (facing +z), w wide and h tall:
// pilasters at the ends, display windows on a stall riser either side of
// the shop door (the door villagers use), lit in the evening, and a fascia
// board along the top with the name in a lighter strip, lit after dark when
// o.lit. o.bow: bowed windows standing out from the wall. Returns the
// windows' front panes ({ m: centre, w: width, z: face }) for goods to be
// set out in, and the height of the window tops.
function shopfront(c, x, z, w, h, o = {}) {
  const { gb, rng, pal } = c;
  const trim = o.trim || '#e3dccd', fascia = o.fascia || rng.pick(FASCIA), riser = o.riser || shade(fascia, 1.3);
  const dx = x + (o.doorX || 0), dw = o.doorW || 0.085, top = h - 0.06;
  // its style, the shop's own (forms.js): plain; pilasters with consoles under
  // the fascia's ends; transom lights over the windows; or the windows brought
  // forward either side of the door, so it stands back in a lobby between
  // their glazed returns
  const st = o.style || (c.form && c.form.shopfront) || 'plain', recess = st === 'recessed' && !o.noDoor && !o.bow ? 0.035 : 0;
  const a = x - w / 2 + 0.024, b = x + w / 2 - 0.024, gap = dw / 2 + 0.018 + (recess ? 0.006 : 0);
  const spans = o.noDoor ? [[a, b]] : [[a, dx - gap], [dx + gap, b]].filter(([s, e]) => e - s > 0.05);
  const panes = [], z0 = z;
  for (const [s, e] of spans) {
    const m = (s + e) / 2, sw = e - s;
    if (o.bow) { panes.push(bowWindow(c, m, z, sw, top, trim, riser)); continue; }
    z = z0 + recess;
    if (recess) gb.box(m, top - 0.012, z0 + recess / 2 + 0.006, sw + 0.008, 0.012, recess + 0.012, shade(trim, 0.85));
    gb.box(m, 0, z + 0.008, sw, 0.05, 0.02, riser);
    gb.glow(WARM[0], WARM[1], WARM[2], 1 + rng.float(0.02, 0.3));
    gb.box(m, 0.05, z + 0.006, sw, top - 0.05, 0.012, GLASS);
    gb.noGlow();
    const n = Math.max(1, Math.round(sw / 0.075));
    for (let i = 1; i < n; i++) gb.box(s + (i * sw) / n, 0.05, z + 0.013, 0.007, top - 0.05, 0.006, trim);
    gb.box(m, top - 0.04, z + 0.013, sw, 0.007, 0.006, trim);
    if (st === 'transom') {
      const ty = 0.05 + (top - 0.05) * 0.68;
      gb.box(m, ty, z + 0.014, sw, 0.01, 0.008, trim);
      for (let i = 1; i < n * 2; i += 2) gb.box(s + (i * sw) / (n * 2), ty, z + 0.013, 0.005, top - 0.04 - ty, 0.006, trim);
    }
    panes.push({ m, w: sw, z: z + 0.016 });
  }
  z = z0;
  const pw = st === 'pilasters' ? 0.036 : 0.026;
  for (const sd of [-1, 1]) gb.box(x + sd * (w / 2 - pw / 2), 0, z + 0.01, pw, h, pw, trim);
  if (st === 'pilasters') for (const sd of [-1, 1]) gb.cbox(x + sd * (w / 2 - 0.018), top - 0.012, z + 0.03, 0.03, 0.085, 0.04, shade(trim, 0.92), 0, 0.006);
  if (recess) {
    // the lobby: the windows' glazed returns and a tiled floor
    gb.glow(WARM[0], WARM[1], WARM[2], 1.1);
    for (const sd of [-1, 1]) gb.box(dx + sd * (gap - 0.004), 0.05, z + recess / 2 + 0.006, 0.008, top - 0.05, recess, GLASS);
    gb.noGlow();
    gb.box(dx, 0.001, z + recess / 2 + 0.01, gap * 2, 0.006, recess + 0.01, '#d8d0bc');
  }
  gb.box(x, top, z + 0.012, w, 0.06, 0.03, fascia);
  gb.box(x, h, z + 0.016, w + 0.03, st === 'pilasters' ? 0.02 : 0.014, st === 'pilasters' ? 0.05 : 0.04, shade(trim, 0.9));
  if (o.lit) gb.glow(1.8, 1.4, 0.6, 3.1);
  gb.box(x, top + 0.016, z + 0.028, w * 0.6, 0.026, 0.006, o.letter || '#e0c070');
  gb.noGlow();
  if (!o.noDoor) door(c, dx, z, dw, Math.min(0.17, top), o.door || pal.door);
  return { panes, top, fascia, letter: o.letter || '#e0c070' };
}

// A bowed window standing out from the wall at z, sw wide: a front pane and
// two angled side panes on a riser, under a lead top.
function bowWindow(c, m, z, sw, top, trim, riser) {
  const { gb, rng } = c;
  const p = Math.min(0.05, sw * 0.3), fw2 = sw * 0.6, sl = (sw - fw2) / 2, len = Math.hypot(sl, p), ang = Math.atan2(p, sl);
  const sides = [[m, z + p, fw2, 0], [m - fw2 / 2 - sl / 2, z + p / 2, len, -ang], [m + fw2 / 2 + sl / 2, z + p / 2, len, ang]];
  for (const [px, pz, pw, ry] of sides) gb.box(px, 0, pz, pw, 0.05, 0.02, riser, ry);
  gb.glow(WARM[0], WARM[1], WARM[2], 1 + rng.float(0.02, 0.3));
  for (const [px, pz, pw, ry] of sides) gb.box(px, 0.05, pz, pw, top - 0.05, 0.012, GLASS, ry);
  gb.noGlow();
  for (const sd of [-1, 0, 1]) gb.box(m + (sd * fw2) / 2, 0.05, z + p + 0.006, sd ? 0.01 : 0.007, top - 0.05, 0.008, trim);
  gb.box(m, top, z + p / 2, sw + 0.012, 0.02, p + 0.02, shade(trim, 0.85));
  return { m, w: fw2, z: z + p + 0.01 };
}

// A striped canvas awning sloping out from the wall at z, its top edge at
// y, with a scalloped valance along the front.
function awning(c, x, y, z, w, colA, colB = '#e9dfc9', depth = 0.15) {
  const { gb } = c;
  const k = Math.max(3, Math.round(w / 0.1)), sw = w / k, a = 0.45;
  const cy = y - (Math.sin(a) * depth) / 2, cz = z + (Math.cos(a) * depth) / 2 + 0.006;
  const fy = y - Math.sin(a) * depth, fzz = z + Math.cos(a) * depth + 0.006;
  for (let i = 0; i < k; i++) {
    const sx = x - w / 2 + (i + 0.5) * sw, col = i % 2 ? colB : colA;
    gb.boxC(sx, cy, cz, sw, 0.012, depth, col, a);
    gb.box(sx, fy - 0.026, fzz, sw * 0.92, 0.028, 0.006, col);
  }
}

// A sign on an iron arm off the wall at (x, y, z), hung side-on so it reads
// from along the street: a board, or the trade's emblem (a boot, a mortar
// and pestle, a coffee pot, a key, an open book, a pair of shears).
function hangSign(c, x, y, z, kind, color = '#3f4f5a') {
  const { gb } = c;
  gb.box(x, y, z + 0.065, 0.01, 0.01, 0.13, IRON_D);
  gb.boxC(x, y - 0.03, z + 0.03, 0.008, 0.008, 0.08, IRON_D, -0.75);
  const hz = z + 0.1, by = y - 0.02;
  gb.box(x, by, hz, 0.004, 0.02, 0.004, IRON_D);
  if (kind === 'boot') {
    gb.box(x, by - 0.08, hz - 0.012, 0.018, 0.08, 0.034, color);
    gb.box(x, by - 0.08, hz + 0.02, 0.018, 0.026, 0.046, color);
  } else if (kind === 'mortar') {
    gb.cyl(x, by - 0.05, hz, 0.034, 0.024, 0.042, 8, color);
    gb.cyl(x, by - 0.0085, hz, 0.036, 0.036, 0.006, 8, shade(color, 0.85));
    gb.boxC(x, by + 0.005, hz + 0.012, 0.009, 0.07, 0.009, '#e8e0d0', 0.5);
  } else if (kind === 'pot') {
    gb.cyl(x, by - 0.064, hz, 0.02, 0.028, 0.058, 8, color);
    gb.cone(x, by - 0.006, hz, 0.02, 0.022, 8, color);
    gb.boxC(x, by - 0.04, hz + 0.034, 0.008, 0.008, 0.034, color, -0.8);
    gb.boxC(x, by - 0.035, hz - 0.03, 0.006, 0.04, 0.006, color);
  } else if (kind === 'key') {
    gb.cyl(x + 0.006, by - 0.03, hz - 0.034, 0.022, 0.022, 0.012, 10, color, 0, 0, Math.PI / 2);
    gb.box(x, by - 0.035, hz + 0.018, 0.012, 0.012, 0.08, color);
    gb.box(x, by - 0.058, hz + 0.046, 0.012, 0.03, 0.014, color);
  } else if (kind === 'book') {
    for (const s of [-1, 1]) gb.boxC(x, by - 0.035, hz + s * 0.022, 0.012, 0.05, 0.044, color, s * 0.25);
    for (const s of [-1, 1]) gb.boxC(x, by - 0.032, hz + s * 0.02, 0.016, 0.042, 0.036, '#ece6d6', s * 0.25);
  } else if (kind === 'shears') {
    for (const s of [-1, 1]) gb.boxC(x, by - 0.05, hz, 0.008, 0.1, 0.012, color, s * 0.45);
    for (const s of [-1, 1]) gb.cyl(x + 0.005, by - 0.095, hz + s * 0.026, 0.014, 0.014, 0.01, 8, color, 0, 0, Math.PI / 2);
  } else gb.box(x, by - 0.09, hz, 0.012, 0.09, 0.11, color);
}

// Tiered trestles of produce: rows of apples, carrots, cabbages and the
// like banked up towards the window.
function produce(c, x, z, w) {
  const { gb, rng } = c;
  const y = c.gy(x, z), a = 0.45, ta = Math.tan(a);
  const COL = ['#c8402f', '#e08a2f', '#7aa34a', '#5f8a3a', '#d9c050', '#8a3a6a', '#a8c060'];
  for (const s of [-1, 1]) gb.box(x + s * (w / 2 - 0.012), y, z, 0.016, 0.09, 0.11, '#5e432c');
  gb.boxC(x, y + 0.08, z, w, 0.012, 0.13, '#86613e', a);
  const n = Math.max(2, Math.round(w / 0.042));
  for (let row = 0; row < 3; row++) {
    const dz = 0.04 - row * 0.04, col = rng.pick(COL);
    for (let i = 0; i < n; i++) gb.sphere(x - w / 2 + (i + 0.5) * (w / n), y + 0.086 - dz * ta + 0.018, z + dz, 0.019, col, 0);
  }
}

function sack(c, x, z, color = '#c8b088') {
  const y = c.gy(x, z);
  c.gb.blob(x, y + 0.032, z, 0.03, 0.036, 0.027, color);
  c.gb.box(x, y + 0.062, z, 0.014, 0.014, 0.014, shade(color, 0.8));
}

// A wicker basket heaped with fruit.
function basket(c, x, z, color) {
  const { gb } = c;
  const y = c.gy(x, z);
  gb.cyl(x, y, z, 0.034, 0.026, 0.035, 8, '#a8804e');
  for (let k = 0; k < 4; k++) gb.sphere(x + Math.cos(k * 1.6) * 0.014, y + 0.04, z + Math.sin(k * 1.6) * 0.014, 0.014, color, 0);
}

// A tea chest, banded with tin.
function teaChest(c, x, z, s = 1) {
  const y = c.gy(x, z);
  c.gb.cbox(x, y, z, 0.07 * s, 0.07 * s, 0.07 * s, '#9a6a40', 0, 0.004);
  c.gb.box(x, y + 0.03 * s, z, 0.074 * s, 0.008, 0.074 * s, '#8a8a84');
}

// The butcher's block on the pavement, a cleaver left in it.
function choppingBlock(c, x, z) {
  const { gb } = c;
  const y = c.gy(x, z);
  gb.cyl(x, y, z, 0.042, 0.048, 0.085, 9, '#8a6a48');
  gb.cyl(x, y + 0.085, z, 0.043, 0.043, 0.006, 9, '#c8a888');
  gb.box(x + 0.01, y + 0.088, z, 0.004, 0.03, 0.03, '#b8bcc0');
  gb.box(x + 0.01, y + 0.118, z, 0.007, 0.007, 0.045, '#5e432c');
}

// An iron rail along a shopfront (at z, height y, w long) hung with joints
// of meat, with birds and game between them at a poulterer's.
function meatRail(c, x, y, z, w, birds = false) {
  const { gb, rng } = c;
  gb.box(x, y, z, w, 0.008, 0.008, IRON_D);
  const n = Math.max(2, Math.round(w / 0.06));
  for (let i = 0; i < n; i++) {
    const jx = x - w / 2 + (i + 0.5) * (w / n);
    gb.box(jx, y - 0.014, z, 0.003, 0.014, 0.003, '#8a8a84');
    if (birds && i % 2) {
      gb.blob(jx, y - 0.038, z, 0.017, 0.026, 0.016, rng.pick(['#f2ede0', '#c8a070', '#8a6a48']));
      gb.box(jx, y - 0.016, z, 0.012, 0.008, 0.004, '#d9a030');
    } else {
      gb.blob(jx, y - 0.046, z, 0.021, 0.033, 0.019, rng.pick(['#a8352e', '#b84a3a', '#8a2a26', '#c0604a']), rng.float(-0.5, 0.5));
      gb.sphere(jx, y - 0.02, z, 0.012, '#e8d0b8');
    }
  }
}

// A boot or shoe seen side-on, toe to +x.
function boot(c, x, y, z, color, s = 1) {
  c.gb.box(x - 0.005 * s, y, z, 0.01 * s, 0.03 * s, 0.012 * s, color);
  c.gb.box(x + 0.004 * s, y, z, 0.024 * s, 0.011 * s, 0.012 * s, color);
}

// Bolts of cloth stood in a rack, in every colour.
function clothStand(c, x, z) {
  const { gb, rng } = c;
  const y = c.gy(x, z);
  gb.box(x, y, z, 0.15, 0.012, 0.06, '#5e432c');
  gb.box(x, y + 0.08, z - 0.03, 0.15, 0.012, 0.012, '#5e432c');
  for (const s of [-1, 1]) gb.box(x + s * 0.07, y, z - 0.03, 0.012, 0.09, 0.012, '#5e432c');
  for (let i = 0; i < 5; i++) gb.cyl(x - 0.056 + i * 0.028, y + 0.012, z - 0.006, 0.012, 0.012, 0.085, 6, rng.pick(PAINTED.concat(ACCENT)), 0, -0.25);
}

// A tailor's dummy on its stand.
function dummy(c, x, z, color) {
  const { gb } = c;
  const y = c.gy(x, z);
  gb.cyl(x, y, z, 0.022, 0.024, 0.008, 8, IRON_D);
  gb.cyl(x, y, z, 0.004, 0.004, 0.06, 4, IRON_D);
  gb.cyl(x, y + 0.055, z, 0.018, 0.034, 0.05, 8, color);
  gb.cyl(x, y + 0.105, z, 0.02, 0.014, 0.03, 8, color);
  gb.sphere(x, y + 0.142, z, 0.008, '#c8b088');
}

// Galvanised ware: a pail, a tin bath, a dustbin; and a coil of rope.
function pail(c, x, y, z, s = 1) {
  c.gb.cyl(x, y, z, 0.026 * s, 0.02 * s, 0.048 * s, 8, '#a4acb0');
  c.gb.box(x, y + 0.048 * s, z, 0.05 * s, 0.004, 0.004, '#5a5a5e');
}
function tinBath(c, x, z, ry = 0) {
  const y = c.gy(x, z);
  c.gb.cbox(x, y, z, 0.14, 0.05, 0.08, '#9aa4a8', ry, 0.024);
  c.gb.box(x, y + 0.05, z, 0.11, 0.004, 0.055, '#6a7276', ry);
}
function dustbin(c, x, z) {
  const y = c.gy(x, z);
  c.gb.cyl(x, y, z, 0.03, 0.027, 0.08, 9, '#9aa4a8');
  c.gb.cyl(x, y + 0.08, z, 0.033, 0.033, 0.008, 9, '#848e92');
  c.gb.box(x, y + 0.088, z, 0.02, 0.008, 0.008, '#5a5a5e');
}
function ropeCoil(c, x, z) {
  const y = c.gy(x, z);
  c.gb.cyl(x, y, z, 0.034, 0.036, 0.022, 10, '#b89a5a');
  c.gb.cyl(x, y + 0.022, z, 0.016, 0.016, 0.003, 8, '#5e4a36');
}
// A box mangle with its rollers and wheel.
function mangle(c, x, z) {
  const { gb } = c;
  const y = c.gy(x, z);
  for (const s of [-1, 1]) gb.box(x + s * 0.04, y, z, 0.01, 0.12, 0.04, '#3a3a3e');
  for (const k of [0.07, 0.096]) gb.cyl(x - 0.04, y + k, z, 0.012, 0.012, 0.08, 8, '#d8d0c0', 0, 0, -Math.PI / 2);
  gb.cyl(x + 0.052, y + 0.08, z, 0.03, 0.03, 0.006, 10, '#3a3a3e', 0, 0, Math.PI / 2);
}
function wheelbarrow(c, x, z, ry = 0) {
  const { gb } = c;
  gb.push(x, c.gy(x, z), z, ry);
  gb.cbox(0, 0.03, 0, 0.08, 0.04, 0.11, '#4f6a5a', 0, 0.006);
  gb.cyl(0.006, 0.022, 0.075, 0.022, 0.022, 0.012, 8, '#3a2a1f', 0, 0, Math.PI / 2);
  for (const s of [-1, 1]) gb.box(s * 0.03, 0.035, -0.09, 0.008, 0.008, 0.08, '#5e432c');
  gb.pop();
}

// A carboy: a great glass jar of coloured water, lit from behind at night.
const CARBOY = [['#c8302a', [2.4, 0.5, 0.45]], ['#2f8a4a', [0.5, 2.0, 0.7]], ['#2f5ab8', [0.55, 0.9, 2.4]], ['#d9a030', [2.2, 1.5, 0.4]]];
function carboy(c, x, y, z, k, s = 1) {
  const { gb } = c;
  const [col, g] = CARBOY[k % CARBOY.length];
  gb.glow(g[0], g[1], g[2], 3.05);
  gb.sphere(x, y + 0.026 * s, z, 0.026 * s, col, 1);
  gb.noGlow();
  gb.cyl(x, y + 0.046 * s, z, 0.008 * s, 0.01 * s, 0.02 * s, 6, '#cfd8dc');
  gb.cone(x, y + 0.066 * s, z, 0.012 * s, 0.018 * s, 6, GOLD);
}
// A row of little bottles on a shelf in a window.
function bottleShelf(c, s, e, y, z) {
  const { gb, rng } = c;
  gb.box((s + e) / 2, y, z, e - s, 0.006, 0.02, '#5e432c');
  for (let x = s + 0.01; x < e - 0.006; x += 0.016) gb.cyl(x, y + 0.006, z, 0.005, 0.006, 0.02, 5, rng.pick(['#2f6a4a', '#7a3a2a', '#2f4a7a', '#d8d0b8', '#5a3a6a']));
}
// A penny weighing machine.
function weighingMachine(c, x, z) {
  const { gb } = c;
  const y = c.gy(x, z);
  gb.box(x, y, z, 0.06, 0.012, 0.06, '#5a5a5e');
  gb.cbox(x, y + 0.012, z - 0.022, 0.036, 0.11, 0.022, '#8a2f2f', 0, 0.004);
  gb.cyl(x, y + 0.1, z - 0.01, 0.017, 0.017, 0.006, 10, '#ece6da', 0, Math.PI / 2);
}

// Books on a shelf in a shop window, from s to e at height y.
function bookShelf(c, s, e, y, z) {
  const { gb, rng } = c;
  gb.box((s + e) / 2, y, z, e - s, 0.006, 0.022, '#5e432c');
  for (let x = s + 0.006; x < e - 0.012;) {
    const bw = rng.float(0.008, 0.013);
    gb.box(x + bw / 2, y + 0.006, z, bw, rng.float(0.022, 0.032), 0.016, rng.pick(['#8a2f2f', '#2f5a8a', '#2f6a4a', '#c09040', '#5a3a6a', '#e8e0d0', '#3a3a3e']));
    x += bw + 0.002;
  }
}
// A newsagent's board with the day's bills.
function newsBoard(c, x, z, ry = 0) {
  const { gb } = c;
  gb.push(x, c.gy(x, z), z, ry);
  for (const s of [-1, 1]) {
    gb.boxC(0, 0.05, s * 0.014, 0.07, 0.1, 0.006, '#3a3a3e', -s * 0.14);
    gb.boxC(0, 0.058, s * 0.018, 0.056, 0.06, 0.002, '#ece6d6', -s * 0.14);
  }
  gb.pop();
}
// A red pillar box at the kerb.
function pillarBox(c, x, z) {
  const { gb } = c;
  const y = c.gy(x, z);
  gb.cyl(x, y, z, 0.026, 0.03, 0.11, 10, '#b8302a');
  gb.cyl(x, y + 0.11, z, 0.033, 0.033, 0.012, 10, '#9a2622');
  gb.sphere(x, y + 0.122, z, 0.025, '#b8302a', 0, 0.5);
  gb.box(x, y + 0.084, z + 0.027, 0.026, 0.006, 0.006, '#1a1a1a');
}
// A barrow of second-hand books.
function bookBarrow(c, x, z) {
  const { gb, rng } = c;
  gb.push(x, c.gy(x, z), z, 0);
  gb.cbox(0, 0.05, 0, 0.16, 0.025, 0.08, '#6e5034', 0, 0.006);
  for (const s of [-1, 1]) gb.cyl(s * 0.06, 0.04, 0.046, 0.04, 0.04, 0.01, 8, '#3a2a1f', 0, Math.PI / 2);
  for (const s of [-1, 1]) gb.box(s * 0.07, 0, -0.03, 0.01, 0.05, 0.01, '#5e432c');
  for (let i = 0; i < 7; i++) gb.box(-0.06 + i * 0.02, 0.075, rng.float(-0.015, 0.015), 0.016, 0.012, 0.03, rng.pick(['#8a2f2f', '#2f5a8a', '#2f6a4a', '#c09040', '#5a3a6a']), rng.float(-0.3, 0.3));
  gb.pop();
}

// A café table with two chairs, under a parasol if one is given.
export function cafeTable(c, x, z, parasol = null) {
  const { gb } = c;
  const y = c.gy(x, z);
  gb.cyl(x, y, z, 0.006, 0.012, 0.055, 5, IRON_D);
  gb.cyl(x, y + 0.055, z, 0.032, 0.032, 0.008, 10, '#ece6da');
  for (const s of [-1, 1]) {
    gb.box(x + s * 0.05, y, z, 0.026, 0.032, 0.026, '#5e432c');
    gb.box(x + s * 0.062, y + 0.032, z, 0.006, 0.035, 0.026, '#5e432c');
  }
  if (parasol) {
    gb.cyl(x, y + 0.063, z, 0.004, 0.004, 0.12, 4, '#ece6da');
    gb.cone(x, y + 0.16, z, 0.075, 0.035, 8, parasol);
  }
}
// A palm or bay tree in a tub.
export function tubPlant(c, x, z, palm = false) {
  const { gb } = c;
  const y = c.gy(x, z);
  gb.cyl(x, y, z, 0.028, 0.022, 0.042, 8, palm ? '#a8603a' : '#4e5a4a');
  gb.cyl(x, y + 0.04, z, 0.006, 0.008, 0.06, 5, '#6e5034');
  if (palm) for (let k = 0; k < 5; k++) gb.boxC(x + Math.cos(k * 1.26) * 0.028, y + 0.1, z + Math.sin(k * 1.26) * 0.028, 0.06, 0.006, 0.018, '#4f7a3a', 0, -k * 1.26, -0.45);
  else gb.sphere(x, y + 0.12, z, 0.04, '#3f6a32', 1);
}

// Greengrocer: a low shop under a green-and-white awning, the produce
// banked up on trestles out front and sacks of potatoes at the door. The
// Fruiterer is two storeys with baskets of fruit and its name lit at night;
// Grocery & Provisions is three, in brick, with tea chests, a barrow and a
// lamp.
MODELS.grocer = (c, L) => {
  const { rng, pal } = c;
  const T = tallOf(c, L), W = [0.62, 0.74, 0.84][L], D = [0.46, 0.54, 0.58][L], H = [T ? 0.58 : 0.36, 0.54 + T * 0.27, 0.8][L], fz = [0.1, 0.12, 0.14][L];
  const thatch = !L && pal.thatched;
  const P = shopBody(c, {
    z: fz - D / 2, w: W, d: D, h: H, floors: L + 1 + T, wall: pal.wall,
    roof: thatch ? pal.thatch : L === 2 ? pal.slate : pal.roof, roofType: thatch ? 'thatch' : L === 2 ? 'hip' : 'gable', rh: L === 2 ? 0.26 : 0.27,
    chimney: true, timber: L < 2 && pal.timber,
  }, 1, { hoist: true });
  const sf = shopfront(c, 0, fz, W - 0.04, 0.26, { fascia: rng.pick(['#2f4a2a', '#3a4a2a', '#2a3a2a']), lit: L >= 1 });
  const awn = rng.pick(['#4f7a45', '#3f6a3a', '#6a8a2a']);
  awning(c, 0, sf.top - 0.004, fz, W - 0.02, awn);
  shopSign(c, P, sf);
  const pz = fz + 0.21;
  produce(c, -W * 0.26, pz, W * 0.34);
  produce(c, W * 0.26, pz, W * 0.34);
  sack(c, W / 2 - 0.01, pz + 0.02); sack(c, W / 2 - 0.05, pz + 0.07, '#b8a070');
  if (L === 0) { crate(c, -W / 2 + 0.01, pz + 0.04); crate(c, -W / 2 + 0.05, pz + 0.08, 0.85, '#a88458'); }
  else {
    for (let i = 0; i < 3; i++) basket(c, -0.08 + i * 0.08, pz + 0.07 + (i % 2) * 0.02, rng.pick(['#c8402f', '#e0b030', '#9ab830', '#8a3a6a']));
    if (L === 1) basket(c, -W / 2 + 0.02, pz + 0.04, '#e08a2f');
  }
  if (L === 2) { teaChest(c, -W / 2 + 0.02, pz + 0.06); teaChest(c, -W / 2 + 0.02, pz + 0.06 - 0.075, 0.9); handcart(c, 0.32, 0.42); }
  cornerShop(c, 'grocer', L, { x0: 0, w: W, fz, d: D }, { fascia: sf.fascia, lit: L >= 1, awning: awn });
  // round the back: sacks hoisted to the store over the shop, and crates of
  // greens and potatoes by the back door
  shopBack(c, P, { fascia: sf.fascia, letter: sf.letter, load: 'sack' });
  backSpots(c, P, 3).forEach((p, i) => (i === 1 ? sack(c, p.x, p.z) : greensCrate(c, p.x, p.z)));
};

// A butcher's: joints hung on a rail across the window, a blind rolled up
// under the fascia, the door to one side and the block out on the pavement.
// The Family Butcher has a white-tiled front with a marble slab in the
// window; the Butcher & Poulterer is three storeys, with birds and game
// hung along a second rail over the fascia.
MODELS.butcher = (c, L) => {
  const { gb, rng, pal } = c;
  const T = tallOf(c, L), W = [0.64, 0.74, 0.84][L], D = [0.48, 0.54, 0.58][L], H = [0.5, 0.54, 0.8][L] + T * 0.26, fz = [0.1, 0.12, 0.14][L];
  // brick under a tiled roof (slate at the top), unless the town chose a style
  const own = !pal.forced;
  const P = shopBody(c, {
    z: fz - D / 2, w: W, d: D, h: H, floors: (L === 2 ? 3 : 2) + T, wall: own ? pal.brick : pal.wall,
    roof: L === 2 ? pal.slate : own ? pal.tile : pal.roof, roofType: L === 2 ? 'hip' : 'gable', rh: 0.26, chimney: true, timber: !own && pal.timber,
  }, 1, { stack: true });
  const tile = '#ece8de', sh = 0.26, sw = W - 0.04;
  if (!L) gb.box(0, 0, fz + 0.003, W, sh, 0.006, '#6a2a24');
  else {
    // glazed white tiles up to the fascia, with a green band at the foot
    gb.box(0, 0, fz + 0.003, W, sh, 0.006, tile);
    gb.box(0, 0, fz + 0.005, W, 0.05, 0.006, '#2f5a4a');
  }
  const z = fz + (L ? 0.006 : 0);
  const sf = shopfront(c, 0, z, sw, sh, { fascia: L ? '#1f3a3a' : '#5a2a22', trim: L ? tile : '#e3dccd', riser: L ? '#2f5a4a' : '#7a5a3c', lit: L >= 1, doorX: sw / 2 - 0.08 });
  const p = sf.panes[0];
  if (L) gb.box(p.m, 0.05, p.z + 0.012, p.w, 0.014, 0.04, '#e8e4dc');
  meatRail(c, p.m, sf.top - 0.014, p.z + 0.02, p.w - 0.02);
  // the striped blind, rolled up for the day
  gb.cyl(sw / 2 + 0.01, sf.top - 0.004, z + 0.036, 0.011, 0.011, W - 0.02, 8, rng.pick(['#2f5a8a', '#3a4a7a']), 0, 0, Math.PI / 2);
  if (L === 2) meatRail(c, 0, sh + 0.085, z + 0.03, W - 0.1, true);
  hangSign(c, sw / 2 - 0.02, sh + 0.05, z, 'board', '#7a2a2a');
  shopSign(c, P, sf);
  gb.cyl(sw / 2 - 0.014, sh - 0.045, z + 0.1, 0.018, 0.018, 0.004, 8, GOLD, 0, 0, Math.PI / 2);
  choppingBlock(c, -W * 0.22, fz + 0.24);
  crate(c, W * 0.12, fz + 0.26, 0.9, L ? '#e8e4dc' : '#94714a');
  if (L) { barrel(c, -W / 2 + 0.02, fz + 0.3); lamp(c, W / 2 - 0.02, 0.42, 0.28); }
  cornerShop(c, 'butcher', L, { x0: 0, w: W, fz, d: D }, { fascia: sf.fascia, trim: L ? tile : '#e3dccd', riser: L ? '#2f5a4a' : '#7a5a3c', facing: L ? tile : '#6a2a24', lit: L >= 1 });
  // round the back: the smoke-house flue up the wall, a meat safe and the
  // scrubbing pails by the door
  shopBack(c, P, { fascia: sf.fascia, letter: sf.letter });
  backFlue(c, P.x0 + P.far, P.zb, H + 0.14, { color: own ? shade(pal.brick, 0.9) : '#8f4f3a' });
  backSpots(c, P, 3).forEach((p, i) => (i ? pail(c, p.x, c.gy(p.x, p.z), p.z) : meatSafe(c, p.x, p.z)));
};

// A cobbler's: a narrow little shop with a bow window full of boots, a boot
// hung over the door and a bench outside with a last on it. The Boot & Shoe
// Shop is two storeys with two windows of boots on shelves and a great
// gilded boot over the door.
MODELS.cobbler = (c, L) => {
  const { gb, rng, pal } = c;
  const T = tallOf(c, L), W = L ? 0.68 : 0.52, D = L ? 0.52 : 0.44, H = L ? 0.54 + T * 0.26 : T ? 0.56 : 0.34, fz = L ? 0.12 : 0.1;
  const thatch = !L && pal.thatched;
  const P = shopBody(c, {
    z: fz - D / 2, w: W, d: D, h: H, floors: L + 1 + T, wall: pal.wall, roof: thatch ? pal.thatch : pal.roof, roofType: thatch ? 'thatch' : 'gable',
    rh: L ? 0.3 : 0.28, chimney: true, timber: pal.timber, nFront: L ? 3 : 2, alongZ: true,
  }, 1, { wide: true });
  const sw = W - 0.04, dx = L ? 0 : sw / 2 - 0.07;
  const sf = shopfront(c, 0, fz, sw, 0.25, { bow: !L, doorX: dx, fascia: rng.pick(['#3b2f2a', '#2a2420', '#4a2a2a']), lit: L >= 1 });
  const BOOT = ['#2a2420', '#5e3a2a', '#3a2a20', '#7a4a2a', '#8a2f2f'];
  for (const p of sf.panes) {
    for (const y of L ? [0.05, 0.11] : [0.05]) {
      if (y > 0.05) gb.box(p.m, y - 0.006, p.z + 0.006, p.w, 0.006, 0.02, '#5e432c');
      const n = Math.max(2, Math.floor(p.w / 0.032));
      for (let i = 0; i < n; i++) boot(c, p.m - p.w / 2 + (i + 0.5) * (p.w / n), y, p.z + 0.008, rng.pick(BOOT), 0.85);
    }
  }
  hangSign(c, dx + (L ? 0.1 : -0.075), 0.31, fz, 'boot', L ? GOLD : '#2a2420');
  shopSign(c, P, sf);
  bench(c, -W * 0.2, fz + 0.2, Math.PI);
  const ly = c.gy(-W * 0.2, fz + 0.2);
  gb.box(-W * 0.2 - 0.04, ly + 0.05, fz + 0.2, 0.016, 0.03, 0.016, '#6e5034');
  boot(c, -W * 0.2 - 0.04, ly + 0.08, fz + 0.2, '#5e3a2a');
  boot(c, W * 0.22, c.gy(W * 0.22, fz + 0.24), fz + 0.24, '#2a2420', 1.3);
  if (L) { crate(c, W / 2 - 0.02, fz + 0.24, 0.9, '#7a5a3c'); lamp(c, -W / 2 + 0.01, 0.42, 0.28); }
  cornerShop(c, 'cobbler', L, { x0: 0, w: W, fz, d: D }, { fascia: sf.fascia, lit: L >= 1, bow: !L, h: 0.25, len: L ? 0.34 : 0.26 });
  // round the back: the workshop window over the bench, lit while he works,
  // and a hide drying on a frame
  shopBack(c, P, { fascia: sf.fascia, letter: sf.letter });
  backWindow(c, P.x0 + P.next, 0.07, P.zb, P.bw * 0.78, Math.min(0.12, P.fh * 0.42));
  const hs = backSpots(c, P, 2);
  if (hs[0]) hideFrame(c, hs[0].x, hs[0].z - 0.005);
  if (hs[1]) backCrate(c, hs[1].x, hs[1].z, '#7a5a3c');
};

// A tailor's: a tall narrow shop with a dummy at the door, bolts of cloth on
// a stand and shears on the bracket. The Draper & Outfitter is three
// storeys with a striped awning over two windows; the Drapery Emporium has
// plate glass up two floors, its name lit over the showroom and a flag on
// the ridge.
MODELS.draper = (c, L) => {
  const { gb, rng, pal } = c;
  const T = tallOf(c, L, 1), W = [0.6, 0.76, 0.86][L], D = [0.5, 0.56, 0.58][L], H = [0.54 + T * 0.27, 0.8, 0.84][L], fz = [0.1, 0.12, 0.14][L];
  const trim = '#e3dccd';
  // painted stucco under slate (stone at the top), dormers in the roof
  const own = !pal.forced;
  const P = shopBody(c, {
    z: fz - D / 2, w: W, d: D, h: H, floors: (L ? 3 : 2) + T, wall: own ? (L === 2 ? pal.stoneWall : ownPick(c, PAINTED, 3)) : pal.wall, roof: own ? pal.slate : pal.roof,
    roofType: L === 1 ? 'hip' : 'gable', rh: L === 2 ? 0.3 : 0.26, chimney: true, timber: !own && pal.timber, dormers: L === 2 ? 3 : 2, plinth: L === 2 ? STONE : null,
    oriel: L !== 2, balcony: L !== 2,
  }, L === 2 ? 2 : 1, { hoist: true });
  const sw = W - 0.04, fascia = rng.pick(['#2a2a4a', '#3a1f2a', '#1f3a3a', '#3b2f2a']);
  const sf = shopfront(c, 0, fz, sw, 0.26, { fascia, lit: L >= 1, doorW: L === 2 ? 0.11 : 0.085 });
  // dummies in the windows, in the latest colours
  for (const p of sf.panes) dummyAt(c, p.m, p.z + 0.02, rng.pick(PAINTED));
  if (L === 1) awning(c, 0, sf.top - 0.004, fz, W - 0.02, pal.awning);
  if (L === 2) {
    // the showroom over the shop: plate glass between piers, the name lit above
    const y0 = H / 3, fh = H / 3, n = 3, bw = (W - 0.04) / n;
    for (let i = 0; i < n; i++) {
      const x = -W / 2 + 0.02 + (i + 0.5) * bw;
      gb.glow(WARM[0], WARM[1], WARM[2], 1 + rng.float(0.02, 0.3));
      gb.box(x, y0 + 0.03, fz + 0.006, bw - 0.03, fh - 0.09, 0.012, GLASS);
      gb.noGlow();
      gb.box(x, y0 + 0.03 + (fh - 0.09) * 0.72, fz + 0.013, bw - 0.03, 0.007, 0.006, trim);
      gb.box(x, y0 + 0.03, fz + 0.013, 0.007, fh - 0.09, 0.006, trim);
    }
    for (let i = 0; i <= n; i++) gb.box(-W / 2 + 0.02 + i * bw, y0, fz + 0.01, 0.026, fh, 0.026, trim);
    gb.box(0, y0 + fh - 0.06, fz + 0.012, W - 0.02, 0.05, 0.03, fascia);
    gb.glow(1.8, 1.4, 0.6, 3.1); gb.box(0, y0 + fh - 0.048, fz + 0.028, W * 0.6, 0.024, 0.006, '#e0c070'); gb.noGlow();
    // a flag on the ridge
    const ft = P.r.top - 0.02;
    gb.box(0, ft, fz - D / 2, 0.01, 0.24, 0.01, IRON_D);
    gb.box(0.05, ft + 0.16, fz - D / 2, 0.09, 0.055, 0.004, rng.pick(['#a8473a', '#3f6a8f', '#7a3a5a']));
    lamp(c, -W / 2 + 0.01, 0.42, 0.3); lamp(c, W / 2 - 0.01, 0.42, 0.3);
  }
  hangSign(c, (L ? sw / 2 : sw / 2 - 0.02) - 0.01, 0.3, fz, 'shears', GOLD);
  if (L < 2) shopSign(c, P, sf);
  clothStand(c, -W * 0.24, fz + 0.24);
  if (L < 2) dummy(c, W * 0.2, fz + 0.24, rng.pick(PAINTED));
  if (L === 1) clothStand(c, W * 0.24 + 0.06, fz + 0.29);
  cornerShop(c, 'draper', L, { x0: 0, w: W, fz, d: D }, { fascia, lit: L >= 1, awning: L === 1 ? pal.awning : null });
  // round the back: bolts of cloth hoisted up to the stock room, and bales
  // in sacking by the back door
  shopBack(c, P, { fascia, letter: sf.letter, load: 'bolt', boltColor: ownPick(c, PAINTED, 12) });
  for (const p of backSpots(c, P, 2)) bale(c, p.x, p.z);
};
// A dummy in a shop window: just the bodice, showing over the riser.
function dummyAt(c, x, z, color) {
  const { gb } = c;
  gb.cyl(x, 0.05, z, 0.004, 0.004, 0.03, 4, IRON_D);
  gb.cyl(x, 0.07, z, 0.016, 0.03, 0.05, 8, color);
  gb.cyl(x, 0.12, z, 0.018, 0.013, 0.03, 8, color);
  gb.sphere(x, 0.156, z, 0.007, '#c8b088');
}

// An ironmonger's: pails hung along a rail over the shop, a tin bath and
// coils of rope by the door, a ladder leant on the wall and a key on the
// bracket. The Hardware Merchant is three storeys of brick, with a mangle,
// a wheelbarrow and galvanised bins out front.
MODELS.ironmonger = (c, L) => {
  const { gb, rng, pal } = c;
  const own = !pal.forced;
  // tarred weatherboards, with an open-fronted store at the side at first
  const T = tallOf(c, L, 1), W = L ? 0.84 : 0.56, D = L ? 0.58 : 0.52, H = L ? 0.8 : 0.54 + T * 0.27, fz = L ? 0.14 : 0.11, bx = L ? 0 : -0.13;
  const P = shopBody(c, {
    x: bx, z: fz - D / 2, w: W, d: D, h: H, floors: (L ? 3 : 2) + T, wall: own ? ownPick(c, ['#4f5a52', '#5a5048', '#46525a'], 5) : pal.wall,
    roof: own ? pal.slate : pal.roof, roofType: 'gable', rh: 0.26, chimney: true, timber: !own && pal.timber, siding: own, plinth: L ? STONE : null,
  }, 1, { hoist: L >= 1, yard: true });
  const sw = W - 0.04, dx = L ? 0 : -sw / 2 + 0.08;
  const sf = shopfront(c, bx, fz, sw, 0.26, { fascia: rng.pick(['#2a3a2a', '#2f2f3a', '#3a2a1f']), doorX: dx, lit: L >= 1 });
  if (!L) {
    // the store: posts carrying a lean-to roof, ladders, pails and timber inside
    const lx = bx + W / 2 + 0.12, lz = fz - 0.2, lw = 0.22, ld = 0.4;
    for (const z of [lz - ld / 2 + 0.02, lz + ld / 2 - 0.02]) gb.box(lx + lw / 2 - 0.02, 0, z, 0.024, 0.25, 0.024, '#4e3a2a');
    gb.box(lx, 0.25, lz + ld / 2 - 0.02, lw, 0.022, 0.022, '#4e3a2a');
    gb.cbox(lx, -0.01, lz, lw, 0.02, ld, '#8a7a62', 0, 0.004);
    gb.wedge(lx, 0.26, lz, ld + 0.04, lw + 0.04, 0.08, pal.slate, Math.PI / 2);
    ladder(c, lx - 0.02, lz - ld / 2 + 0.05, 0.3, 0, 0.12);
    plankStack(c, lx + 0.02, lz + 0.02, 3, Math.PI / 2);
    for (let i = 0; i < 3; i++) pail(c, lx - 0.06 + (i % 2) * 0.05, 0.01 + Math.floor(i / 2) * 0.048, lz + 0.12, 0.9);
  }
  // tools and pails in the window
  for (const p of sf.panes) {
    const n = Math.max(2, Math.floor(p.w / 0.05));
    for (let i = 0; i < n; i++) pail(c, p.m - p.w / 2 + (i + 0.5) * (p.w / n), 0.05, p.z + 0.02, 0.8);
  }
  // pails, lanterns and a kettle hung along a rail over the shop
  const ry = 0.37, rz = fz + 0.05;
  gb.box(bx, ry, rz, W - 0.06, 0.008, 0.008, IRON_D);
  for (const s of [-1, 1]) gb.box(bx + s * (W / 2 - 0.04), ry - 0.003, fz + 0.025, 0.008, 0.008, 0.05, IRON_D);
  const n = Math.round((W - 0.1) / 0.07);
  for (let i = 0; i < n; i++) {
    const x = bx - W / 2 + 0.05 + (i + 0.5) * ((W - 0.1) / n);
    gb.box(x, ry - 0.012, rz, 0.003, 0.012, 0.003, IRON_D);
    if (i % 3 === 1) { gb.cyl(x, ry - 0.05, rz, 0.016, 0.02, 0.034, 6, '#3a3a3e'); gb.cone(x, ry - 0.016, rz, 0.016, 0.012, 6, '#3a3a3e'); }
    else pail(c, x, ry - 0.06, rz, 0.85);
  }
  hangSign(c, bx + dx + 0.1, 0.32, fz, 'key', GOLD);
  shopSign(c, P, sf, 1);
  if (L) ladder(c, W / 2 - 0.04, fz + 0.06, 0.4, 0, 0.18);
  const pz = fz + 0.24;
  tinBath(c, bx - W * 0.12, pz, 0.2);
  ropeCoil(c, bx + W * 0.16, pz); pail(c, bx + W * 0.16 + 0.06, c.gy(bx + W * 0.16 + 0.06, pz), pz);
  if (L) {
    mangle(c, -W / 2 + 0.06, pz + 0.04);
    wheelbarrow(c, W * 0.28, pz + 0.04, Math.PI / 2);
    dustbin(c, -W * 0.3, pz + 0.04); dustbin(c, -W * 0.3 + 0.07, pz + 0.05);
    lamp(c, W / 2 - 0.01, 0.43, 0.28);
  } else { crate(c, bx - W / 2 + 0.04, pz + 0.04, 0.9); dustbin(c, 0.3, pz + 0.04); }
  cornerShop(c, 'ironmonger', L, { x0: bx, w: W, fz, d: D }, { fascia: sf.fascia, lit: L >= 1, skip: L ? 0 : 1 });
  // round the back: bar iron leant against the wall, a crate hoisted up to
  // the store and drums of paraffin by the door
  shopBack(c, P, { fascia: sf.fascia, letter: sf.letter, load: 'crate' });
  leaningBars(c, P.x0 + P.far, P.zb, L ? 6 : 5);
  backSpots(c, P, L ? 2 : 1).forEach((p, i) => drum(c, p.x, p.z, i ? '#3f5a7a' : '#a8382a'));
};

// An apothecary's: bow windows either side of the door with great coloured
// carboys in them, lit at night, herbs in pots on the step and a mortar and
// pestle on the bracket. The Chemist & Druggist has a flat shopfront with
// shelves of bottles round the carboys; the Dispensing Chemist is three
// storeys of stone, with a penny weighing machine on the pavement.
MODELS.chemist = (c, L) => {
  const { gb, rng, pal } = c;
  const T = tallOf(c, L), W = [0.58, 0.72, 0.84][L], D = [0.48, 0.54, 0.58][L], H = [0.52, 0.54, 0.8][L] + T * 0.26, fz = [0.1, 0.12, 0.14][L];
  // cream stucco under a hipped slate roof (stone at the top)
  const own = !pal.forced;
  const P = shopBody(c, {
    z: fz - D / 2, w: W, d: D, h: H, floors: (L === 2 ? 3 : 2) + T, wall: own ? (L === 2 ? pal.stoneWall : STUCCO) : pal.wall, roof: own ? pal.slate : pal.roof,
    roofType: 'hip', rh: 0.24, chimney: true, timber: !own && pal.timber, plinth: L ? STONE : null,
  }, 1, { wide: true });
  const sw = W - 0.04, k0 = rng.int(0, 3);
  const sf = shopfront(c, 0, fz, sw, 0.26, { bow: !L, fascia: rng.pick(['#1f3a3a', '#2a2a4a', '#3a1f2a']), lit: L >= 1, letter: L === 2 ? '#ece6d6' : null });
  sf.panes.forEach((p, i) => {
    if (L) for (const y of [0.075, 0.13]) { bottleShelf(c, p.m - p.w / 2 + 0.01, p.m - 0.04, y, p.z + 0.01); bottleShelf(c, p.m + 0.04, p.m + p.w / 2 - 0.01, y, p.z + 0.01); }
    carboy(c, p.m, 0.05, p.z + 0.032, k0 + i, L ? 1.3 : 1);
  });
  hangSign(c, sw / 2 - 0.03, 0.31, fz, 'mortar', GOLD);
  shopSign(c, P, sf);
  for (const s of [-1, 1]) { const x = s * 0.09, z = fz + 0.12; gb.cyl(x, c.gy(x, z), z, 0.02, 0.016, 0.03, 7, '#a8603a'); flowers(c, x, z, 3, 0.012); }
  if (L === 2) { weighingMachine(c, -W * 0.3, fz + 0.26); lamp(c, W / 2 - 0.01, 0.42, 0.3); }
  else if (L) bench(c, -W * 0.24, fz + 0.26, Math.PI);
  cornerShop(c, 'chemist', L, { x0: 0, w: W, fz, d: D }, { fascia: sf.fascia, letter: sf.letter, lit: L >= 1, bow: !L });
  // round the back: the dispensary window, tinted green, the tin flue of
  // the still up the wall and carboys in wicker by the door
  shopBack(c, P, { fascia: sf.fascia, letter: sf.letter });
  backWindow(c, P.x0 + P.next, 0.07, P.zb, P.bw * 0.74, Math.min(0.12, P.fh * 0.42), [0.6, 1.9, 1.0]);
  backFlue(c, P.x0 + (P.next + P.far) / 2, P.zb, H + 0.12, { tin: true, y0: 0.06 });
  for (const p of backSpots(c, P, 2)) wickerCarboy(c, p.x, p.z);
};

// A stationer's: books on shelves in the window, the day's bills on a board
// by the door, a pillar box at the kerb and an open book on the bracket.
// The Bookseller & Library is three storeys with an oriel window over the
// shop and a barrow of second-hand books out front.
MODELS.stationer = (c, L) => {
  const { gb, rng, pal } = c;
  const T = tallOf(c, L, 1), W = L ? 0.76 : 0.6, D = L ? 0.54 : 0.5, H = L ? 0.8 : 0.54 + T * 0.27, fz = L ? 0.12 : 0.1;
  const P = shopBody(c, {
    z: fz - D / 2, w: W, d: D, h: H, floors: (L ? 3 : 2) + T, wall: pal.wall, roof: L ? pal.slate : pal.forced ? pal.roof : pal.tile, roofType: 'halfhip', rh: 0.3,
    chimney: true, timber: pal.timber, nFront: L ? 3 : 2, dormers: 2, oriel: !L, balcony: !L,
  }, 1, {});
  const sw = W - 0.04;
  const sf = shopfront(c, 0, fz, sw, 0.26, { fascia: rng.pick(['#2a3a4a', '#3b2f2a', '#4a2a2a', '#2f3e2a']), lit: L >= 1 });
  for (const p of sf.panes) for (const y of [0.05, 0.1]) bookShelf(c, p.m - p.w / 2 + 0.006, p.m + p.w / 2 - 0.006, y, p.z + 0.01);
  hangSign(c, sw / 2 - 0.02, 0.31, fz, 'book', rng.pick(['#8a2f2f', '#2f5a8a', '#2f6a4a']));
  if (!L) shopSign(c, P, sf);
  newsBoard(c, -W * 0.18, fz + 0.2, 0.2);
  pillarBox(c, W / 2 - 0.06, fz + 0.27);
  if (L) {
    // an oriel window over the shop door
    const oy = H / 3 + 0.02, oz = fz + 0.035;
    gb.cbox(0, oy, oz, 0.24, 0.17, 0.07, pal.wall, 0, 0.008);
    gb.wedge(0, oy - 0.04, oz, 0.24, 0.07, 0.04, shade(pal.wall, 0.85), Math.PI);
    gb.glow(WARM[0], WARM[1], WARM[2], 1 + rng.float(0.02, 0.4));
    gb.box(0, oy + 0.03, oz + 0.036, 0.2, 0.11, 0.008, GLASS);
    for (const s of [-1, 1]) gb.box(s * 0.121, oy + 0.03, oz, 0.008, 0.11, 0.05, GLASS);
    gb.noGlow();
    for (const s of [-1, 0, 1]) gb.box(s * 0.066, oy + 0.03, oz + 0.04, 0.007, 0.11, 0.006, '#e3dccd');
    gb.hip(0, oy + 0.17, oz, 0.24, 0.07, 0.04, pal.roof, 0.01);
    bookBarrow(c, W * 0.12, fz + 0.27);
    lamp(c, -W / 2 + 0.01, 0.42, 0.28);
  }
  cornerShop(c, 'stationer', L, { x0: 0, w: W, fz, d: D }, { fascia: sf.fascia, lit: L >= 1 });
  // round the back: skylights in the roof over the bindery and bundles of
  // paper by the back door
  shopBack(c, P, { fascia: sf.fascia, letter: sf.letter });
  if (['halfhip', 'gable'].includes(P.r.roofType) && !P.r.alongZ) roofLights(c, 0, H, fz - D / 2, D + P.jetty * 2, P.r.rh, L ? [-0.16, 0, 0.16] : [-0.09, 0.09]);
  for (const p of backSpots(c, P, 2)) paperBundles(c, p.x, p.z, 3);
};

// A coffee house: a bow window either side of the door, a coffee pot on
// the bracket, a bench and bay trees in tubs. The Tea Rooms are painted,
// with a striped awning and tables out on the pavement; the Grand Café has a
// glazed winter garden across its front, parasols over the tables and palms
// in tubs.
MODELS.coffeehouse = (c, L) => {
  const { gb, rng, pal } = c;
  const T = tallOf(c, L), W = [0.66, 0.76, 0.86][L], D = [0.5, 0.54, 0.5][L], H = [0.54, 0.56, 0.82][L] + T * 0.27, fz = [0.1, 0.11, 0.06][L];
  const wall = pal.forced ? pal.wall : L === 2 ? STUCCO : ownPick(c, PAINTED, 8);
  const P = shopBody(c, {
    z: fz - D / 2, w: W, d: D, h: H, floors: (L === 2 ? 3 : 2) + T, wall, roof: L ? pal.slate : pal.roof, roofType: L === 2 ? 'hip' : 'gable', rh: 0.26,
    chimney: true, timber: !L && pal.timber,
  }, 1, {});
  const sw = W - 0.04, pastel = ownPick(c, ['#c87a8a', '#7a9ac8', '#8ab08a', '#c8a050'], 9);
  let fascia = '#2a2a30';
  if (L < 2) {
    const sf = shopfront(c, 0, fz, sw, 0.26, { bow: !L, fascia: L ? shade(pastel, 0.6) : rng.pick(['#3b2f2a', '#2f3e2a', '#4a2a2a']), lit: L >= 1 });
    fascia = sf.fascia;
    for (const p of sf.panes) for (let i = 0; i < 2; i++) gb.cyl(p.m + (i - 0.5) * p.w * 0.45, 0.05, p.z + 0.02, 0.018, 0.012, 0.03, 8, i ? '#e8d8c0' : '#8a5a3a');
    if (L) awning(c, 0, sf.top - 0.004, fz, W - 0.02, pastel);
    else hangSign(c, sw / 2 - 0.03, 0.31, fz, 'pot', GOLD);
    shopSign(c, P, sf);
  } else {
    // the winter garden: a glasshouse across the front with its doors in
    // the middle, and a canopy over them
    const gw = W - 0.06, gd = 0.14, gh = 0.27, gz = fz + gd / 2;
    footing(c, 0, gz, gw, gd);
    gb.cbox(0, 0, gz, gw, 0.04, gd, STONE, 0, 0.008);
    gb.glow(WARM[0], WARM[1], WARM[2], 1.05 + rng.float(0, 0.2));
    gb.box(0, 0.04, fz + gd - 0.006, gw, gh - 0.06, 0.012, GLASS);
    for (const s of [-1, 1]) gb.box(s * (gw / 2 - 0.006), 0.04, gz, 0.012, gh - 0.06, gd, GLASS);
    gb.noGlow();
    const n = 6;
    for (let i = 0; i <= n; i++) gb.box(-gw / 2 + (i * gw) / n, 0.04, fz + gd, 0.01, gh - 0.06, 0.01, '#ece6da');
    gb.box(0, gh - 0.02, gz, gw + 0.02, 0.02, gd + 0.02, '#ece6da');
    glassRoof(c, 0, gh, gz, gw, gd, 0.04, false, 6);
    door(c, 0, fz + gd, 0.1, 0.17, '#3f4f5a');
    gb.box(0, 0.22, fz + gd + 0.05, 0.22, 0.012, 0.1, '#3a3a3e');
    for (const s of [-1, 1]) gb.box(s * 0.1, 0.22 - 0.06, fz + gd + 0.09, 0.008, 0.06, 0.008, '#3a3a3e');
    gb.box(0, H / 3 + 0.05, fz + 0.012, W * 0.6, 0.05, 0.02, '#2a2a30');
    gb.glow(1.8, 1.4, 0.6, 3.1); gb.box(0, H / 3 + 0.062, fz + 0.024, W * 0.5, 0.026, 0.006, '#e0c070'); gb.noGlow();
  }
  const tz = L === 2 ? fz + 0.3 : fz + 0.24;
  if (L) {
    cafeTable(c, -W * 0.26, tz, L === 2 ? pastel : null);
    cafeTable(c, W * 0.26, tz, L === 2 ? '#e9dfc9' : null);
    tubPlant(c, -W / 2 + 0.01, tz + 0.08, L === 2); tubPlant(c, W / 2 - 0.01, tz + 0.08, L === 2);
    if (L === 2) lamp(c, 0, 0.44, 0.28);
  } else {
    bench(c, -W * 0.22, tz, Math.PI);
    tubPlant(c, -0.08, fz + 0.1); tubPlant(c, 0.08, fz + 0.1);
    barrel(c, W * 0.24, tz + 0.02, 0.9);
  }
  cornerShop(c, 'coffeehouse', L, { x0: 0, w: W, fz, d: D }, { fascia, lit: L >= 1, bow: !L, awning: L === 1 ? pastel : null });
  // round the back: the kitchen range's stovepipe up the wall, sacks of
  // coffee and the milk churns by the back door
  shopBack(c, P, { fascia });
  backFlue(c, P.x0 + (P.next + P.far) / 2, P.zb, H + 0.1, { tin: true, color: '#2a2a2e', y0: 0.04 });
  backSpots(c, P, 3).forEach((p, i) => (i === 1 ? sack(c, p.x, p.z, '#9a7a4a') : churn(c, p.x, p.z)));
};

// A savings bank: a solid stone block, rusticated below with tall windows,
// railings along the pavement; in one of its plans: under a hipped slate
// roof with a pedimented door case and the name in a gable over it; a temple
// front of four columns the height of the building under a pediment; a dome
// over the banking hall behind a parapet; or an Italian palazzo, a low roof
// on a deep cornice and arched windows. The Town Bank is three storeys: behind
// a balustrade with a portico of four columns; a rotunda on its corner under
// a dome; a mansard with a clock in a pediment; or a giant colonnade across
// the front under an attic.
MODELS.bank = (c, L) => {
  const { gb, pal } = c;
  const F = c.form, plan = planOf(c, 4);
  const wall = pal.stoneWall, trim = '#ece6da';
  const W = L ? 0.86 : 0.76, D = L ? 0.56 : 0.54, H = L ? 0.84 : 0.58, floors = L ? 3 : 2, fz = L ? 0.11 : 0.1, fh = H / floors;
  const roofType = L ? ['flat', 'parapet', 'mansard', 'parapet'][plan] : ['hip', 'parapet', 'parapet', 'hip'][plan];
  const body = { z: fz - D / 2, w: W, d: D, h: H, floors, nFront: L ? 5 : 3, fancy: false }, P = backPlan(c, body, { sign: false });
  house(c, {
    ...body, wall, roof: pal.slate, roofType, rh: !L && plan === 3 ? 0.12 : L && plan === 2 ? 0.3 : 0.2, dormers: L && plan === 2 ? 4 : 0, doorX: 0,
    noDoor: true, bareFront: true, chimney: true, chimneyPos: 'ends', plinth: STONE, lit: 0.8, backClear: P.clear, backBars: true, bareSide: c.corner,
  });
  // rusticated stone on the ground floor, tall windows either side of the door
  for (let y = 0.05; y < fh - 0.02; y += 0.045) gb.box(0, y, fz + 0.002, W, 0.006, 0.006, shade(wall, 0.84));
  const wx = L ? [0.22, 0.36] : [0.24];
  const arched = c.arched;
  if (!L && plan === 3) c.arched = true;
  for (const s of [-1, 1]) for (const x of wx) win(c, s * x, 0.06, fz + 0.004, 0.075, 0.15, 'f', 0.8);
  c.arched = arched;
  const name = (y, w) => {
    gb.box(0, y, fz + 0.012, w, 0.04, 0.016, '#2a2a30');
    gb.glow(1.8, 1.4, 0.6, 3.1); gb.box(0, y + 0.011, fz + 0.022, w * 0.8, 0.02, 0.006, GOLD); gb.noGlow();
  };
  const balustrade = (y) => {
    const bal = (x, z, len, alongZ) => {
      gb.box(x, y, z, alongZ ? 0.03 : len, 0.012, alongZ ? len : 0.03, trim);
      gb.box(x, y + 0.05, z, alongZ ? 0.034 : len + 0.004, 0.014, alongZ ? len + 0.004 : 0.034, trim);
      const n = Math.round(len / 0.03);
      for (let i = 0; i < n; i++) { const u = -len / 2 + (i + 0.5) * (len / n); gb.cyl(alongZ ? x : x + u, y + 0.012, alongZ ? z + u : z, 0.006, 0.007, 0.038, 5, trim); }
    };
    const zf = fz - 0.01, zb = fz - D + 0.01;
    bal(0, zf, W, false); bal(0, zb, W, false);
    for (const s of [-1, 1]) bal(s * (W / 2 - 0.01), fz - D / 2, D - 0.02, true);
    for (const s of [-1, 1]) for (const z of [zf, zb]) { gb.cyl(s * (W / 2 - 0.01), y + 0.064, z, 0.012, 0.018, 0.03, 7, trim); gb.sphere(s * (W / 2 - 0.01), y + 0.1, z, 0.014, trim, 0); }
  };
  if (L) {
    if (plan === 1) {
      // a rotunda on the corner, under a dome
      const s = c.corner & 1 ? -1 : c.corner & 2 ? 1 : F.side;
      turret(c, 'dome', s * (W / 2 - 0.06), fz - 0.06, 0, H + 0.1, 0.11, fh, wall, '#5f8f7e', 0.8);
      portico(c, 0, fz, 0.3, fh + 0.01, 4, pal.slate, trim);
    } else if (plan === 2) {
      // a clock in a pediment over the portico, a mansard behind
      portico(c, 0, fz, 0.36, fh + 0.01, 4, pal.slate, trim);
      gb.cbox(0, H - 0.04, fz - 0.03, 0.3, 0.14, 0.06, wall, 0, 0.008);
      gb.gable(0, H + 0.1, fz - 0.03, 0.32, 0.07, 0.08, wall, trim, 0.015, true);
      wallClock(c, 0, H + 0.03, fz + 0.002, 0.045);
    } else if (plan === 3) {
      // a giant colonnade across the front, an attic over it
      for (let i = 0; i < 6; i++) gb.cyl(-W / 2 + 0.06 + (i * (W - 0.12)) / 5, fh, fz + 0.05, 0.02, 0.023, fh * 2 - 0.02, 8, trim);
      gb.box(0, fh - 0.01, fz + 0.04, W + 0.02, 0.02, 0.09, trim);
      gb.box(0, H - 0.04, fz + 0.04, W + 0.02, 0.05, 0.09, trim);
      gb.cbox(0, H + 0.01, fz - D / 2 + 0.02, W - 0.04, 0.12, D - 0.06, wall, 0, 0.006);
      gb.box(0, H + 0.13, fz - D / 2 + 0.02, W, 0.025, D - 0.02, trim);
      gb.hip(0, H + 0.155, fz - D / 2 + 0.02, W - 0.12, D - 0.14, 0.1, pal.slate, 0);
      portico(c, 0, fz + 0.06, 0.2, fh - 0.03, 2, pal.slate, trim);
    } else {
      portico(c, 0, fz, 0.36, fh + 0.01, 4, pal.slate, trim);
      // a balustrade round the roof, urns on the corners, the roof low behind it
      gb.hip(0, H + 0.045, fz - D / 2, W - 0.12, D - 0.12, 0.13, pal.slate, 0);
      balustrade(H + 0.04);
    }
    if (plan === 1) balustrade(H + 0.07);
    // the name in gilt letters along the first floor
    if (plan !== 3) name(fh - 0.045, W * 0.62);
  } else if (plan === 1) {
    // a temple front: four columns the height of the bank, a pediment
    portico(c, 0, fz, 0.46, H - 0.04, 4, pal.slate, trim);
    gb.gable(0, H + 0.05, fz + 0.07, 0.5, 0.03, 0.1, trim, trim, 0.01, true);
    name(fh + 0.02, 0.3);
  } else if (plan === 2) {
    // the banking hall's dome over the parapet, a door case under a pediment
    gb.cyl(0, H + 0.04, fz - D / 2 - 0.02, 0.15, 0.16, 0.08, 10, wall);
    gb.sphere(0, H + 0.12, fz - D / 2 - 0.02, 0.15, '#5f8f7e', 1, 0.8);
    gb.cyl(0, H + 0.24, fz - D / 2 - 0.02, 0.02, 0.025, 0.06, 6, trim);
    for (const s of [-1, 1]) gb.box(s * 0.08, 0, fz + 0.01, 0.026, 0.26, 0.026, trim);
    gb.box(0, 0.26, fz + 0.012, 0.22, 0.025, 0.035, trim);
    gb.gable(0, 0.285, fz + 0.012, 0.22, 0.035, 0.06, trim, trim, 0.01, true);
    name(fh + 0.03, 0.32);
  } else if (plan === 3) {
    // a palazzo: a deep cornice on brackets under the low roof
    gb.box(0, H - 0.035, fz - D / 2, W + 0.08, 0.04, D + 0.08, trim);
    for (let i = 0; i < 9; i++) gb.box(-W / 2 + 0.02 + (i * (W - 0.04)) / 8, H - 0.06, fz + 0.025, 0.014, 0.03, 0.03, trim);
    portico(c, 0, fz, 0.2, 0.22, 2, pal.slate, trim);
    name(fh + 0.03, 0.3);
  } else {
    portico(c, 0, fz, 0.2, 0.22, 2, pal.slate, trim);
    gb.cbox(0, H - 0.03, fz - 0.11, 0.34, 0.12, 0.22, wall, 0, 0.006);
    gb.gable(0, H + 0.09, fz - 0.11, 0.34, 0.22, 0.09, wall, pal.slate, 0.02, true, 0.025);
    gb.box(0, H + 0.0, fz + 0.002, 0.26, 0.05, 0.008, '#2a2a30');
    gb.glow(1.8, 1.4, 0.6, 3.1); gb.box(0, H + 0.014, fz + 0.007, 0.2, 0.02, 0.006, GOLD); gb.noGlow();
  }
  door(c, 0, fz, L ? 0.12 : 0.1, L ? 0.2 : 0.19, '#3a2f28');
  frontage(c, -W / 2 - 0.02, W / 2 + 0.02, fz + 0.3, [0], 'railings');
  lamp(c, -0.11, fz + 0.32, 0.3); lamp(c, 0.11, fz + 0.32, 0.3);
  // on a street corner the banking hall shows down the side street too:
  // rusticated, with its tall windows and the name in gilt over them
  for (const s of [-1, 1]) {
    if (!(c.corner & (s < 0 ? 1 : 2))) continue;
    gb.push(s * W / 2, 0, fz - D / 2, s * Math.PI / 2);
    for (let y = 0.05; y < fh - 0.02; y += 0.045) gb.box(0, y, 0.002, D, 0.006, 0.006, shade(wall, 0.84));
    for (const x of L ? [-0.16, 0, 0.16] : [-0.12, 0.12]) win(c, x, 0.06, 0.004, 0.075, 0.15, 'f', 0.8);
    gb.box(0, fh - 0.05, 0.012, D * 0.7, 0.04, 0.016, '#2a2a30');
    gb.glow(1.8, 1.4, 0.6, 3.1); gb.box(0, fh - 0.039, 0.022, D * 0.56, 0.02, 0.006, GOLD); gb.noGlow();
    gb.pop();
  }
  // round the back: bars on the ground-floor windows and a studded iron door
  shopBack(c, P, { door: '#3a3a3e', studs: true, doorW: 0.085 });
};

// The sign each high-street trade hangs out, and what it sets out on the
// pavement in front of a shop with homes above (see MODELS.shophouse).
const SHOP_SIGNS = {
  grocer: ['board', '#2f4a2a'], butcher: ['board', '#7a2a2a'], cobbler: ['boot', '#2a2420'], draper: ['shears', GOLD], ironmonger: ['key', GOLD],
  chemist: ['mortar', GOLD], stationer: ['book', '#2f5a8a'], coffeehouse: ['pot', GOLD], postoffice: ['board', '#a8282a'],
};
function pavementWares(c, flavor, x, z) {
  const { rng } = c;
  if (flavor === 'grocer') { produce(c, x - 0.08, z, 0.22); sack(c, x + 0.1, z); sack(c, x + 0.16, z + 0.03, '#b8a070'); }
  else if (flavor === 'butcher') { choppingBlock(c, x - 0.08, z); crate(c, x + 0.08, z, 0.9, '#e8e4dc'); }
  else if (flavor === 'cobbler') { bench(c, x - 0.06, z + 0.02, Math.PI); boot(c, x + 0.12, c.gy(x + 0.12, z), z, '#2a2420', 1.4); }
  else if (flavor === 'draper') { clothStand(c, x - 0.08, z + 0.02); dummy(c, x + 0.12, z, rng.pick(PAINTED)); }
  else if (flavor === 'ironmonger') { tinBath(c, x - 0.08, z, 0.2); pail(c, x + 0.06, c.gy(x + 0.06, z), z); ropeCoil(c, x + 0.13, z); }
  else if (flavor === 'chemist') { for (let i = 0; i < 3; i++) { const px = x - 0.08 + i * 0.08; c.gb.cyl(px, c.gy(px, z), z, 0.02, 0.016, 0.03, 7, '#a8603a'); flowers(c, px, z, 3, 0.012); } }
  else if (flavor === 'stationer') { newsBoard(c, x - 0.06, z, 0.2); pillarBox(c, x + 0.12, z + 0.02); }
  else if (flavor === 'coffeehouse') { cafeTable(c, x - 0.1, z); cafeTable(c, x + 0.12, z); }
  else if (flavor === 'postoffice') pillarBox(c, x + 0.08, z + 0.02);
}

// A clock face on a wall facing +z, lit at night.
export function wallClock(c, x, y, z, r = 0.04) {
  const { gb } = c;
  gb.cyl(x, y, z, r, r, 0.014, 12, '#3a3a3e', 0, Math.PI / 2);
  gb.glow(1.2, 1.1, 0.8, 1.02); gb.cyl(x, y, z + 0.006, r * 0.8, r * 0.8, 0.012, 12, '#efe8da', 0, Math.PI / 2); gb.noGlow();
}

// A post office: a red fascia with its name lit, a red door, a clock over
// the shop, a pillar box at the kerb and the postman's red handcart. The
// General Post Office is three storeys of stone with the clock in a
// pediment, a telegraph pole on the roof and the red mail van outside.
MODELS.postoffice = (c, L) => {
  const { gb, pal } = c;
  const T = tallOf(c, L, 1), W = L ? 0.86 : 0.66, D = L ? 0.56 : 0.52, H = L ? 0.84 : 0.54 + T * 0.27, fz = L ? 0.11 : 0.11, red = '#a8282a';
  const P = shopBody(c, {
    z: fz - D / 2, w: W, d: D, h: H, floors: (L ? 3 : 2) + T, wall: pal.forced ? pal.wall : L ? pal.stoneWall : '#efe9dc', roof: pal.slate, roofType: L ? 'hip' : 'gable',
    rh: 0.24, chimney: true, plinth: L ? STONE : null, timber: !L && pal.timber, nFront: L ? 4 : 2,
  }, 1, {});
  const sf = shopfront(c, 0, fz, W - 0.04, 0.26, { fascia: red, riser: '#6a1a1c', letter: '#ece6d6', lit: true, door: red, doorW: L ? 0.11 : 0.085 });
  // postcards and parcels in the windows
  for (const p of sf.panes) for (let i = 0; i < 3; i++) gb.box(p.m + (i - 1) * p.w * 0.3, 0.07 + (i % 2) * 0.03, p.z + 0.004, 0.028, 0.02, 0.003, i === 1 ? '#c8a878' : '#ece6d6');
  if (L) {
    // the clock in a pediment over the middle, a telegraph pole on the roof
    gb.cbox(0, H - 0.04, fz - 0.03, 0.26, 0.14, 0.06, pal.stoneWall, 0, 0.008);
    gb.gable(0, H + 0.1, fz - 0.03, 0.28, 0.07, 0.07, pal.stoneWall, '#ece6da', 0.015);
    wallClock(c, 0, H + 0.04, fz + 0.002, 0.042);
    const px = W * 0.25, pz = fz - 0.3;
    gb.cyl(px, H, pz, 0.008, 0.01, 0.42, 5, '#5e432c');
    for (const k of [0.3, 0.38]) {
      gb.box(px, H + k, pz, 0.16, 0.01, 0.012, '#5e432c');
      for (const u of [-0.06, -0.02, 0.02, 0.06]) gb.cyl(px + u, H + k + 0.01, pz, 0.005, 0.006, 0.014, 5, '#e8e2d4');
    }
    coach(c, -0.14, fz + 0.25, Math.PI / 2, red, true);
  } else {
    wallClock(c, 0, 0.34, fz + 0.002, 0.036);
    // the postman's handcart
    const hx = -W * 0.26, hz = fz + 0.25;
    gb.push(hx, c.gy(hx, hz), hz, 0.15);
    gb.cbox(0, 0.045, 0, 0.12, 0.07, 0.08, red, 0, 0.006);
    for (const s of [-1, 1]) gb.cyl(s * 0.065, 0.04, 0, 0.04, 0.04, 0.01, 8, '#2a2420', 0, 0, Math.PI / 2);
    gb.box(0.11, 0.07, 0, 0.1, 0.008, 0.008, '#5e432c');
    gb.pop();
  }
  pillarBox(c, W / 2 - 0.05, fz + 0.29);
  lamp(c, -W / 2 + 0.01, 0.43, 0.28);
  if (!L) shopSign(c, P, sf);
  cornerShop(c, 'postoffice', L, { x0: 0, w: W, fz, d: D }, { fascia: red, riser: '#6a1a1c', letter: '#ece6d6', lit: true });
  // round the back: the red loading doors for the mail under a canopy, and
  // mail sacks waiting for the van
  shopBack(c, P, { fascia: red, letter: '#ece6d6', door: red, doorW: 0.12 });
  const dx = P.x0 + P.door, cd = Math.max(0.025, Math.min(0.05, P.zb + 0.46)), cy = Math.min(0.17, P.fh * 0.66) + 0.03;
  gb.box(dx, cy, P.zb - cd / 2, 0.18, 0.012, cd, pal.slate);
  for (const s of [-1, 1]) gb.boxC(dx + s * 0.07, cy - 0.02, P.zb - cd / 2, 0.006, 0.006, cd, IRON_D, 0.6);
  for (const p of backSpots(c, P, 3)) { sack(c, p.x, p.z, '#d8d4c8'); gb.box(p.x + 0.012, c.gy(p.x, p.z) + 0.05, p.z - 0.02, 0.012, 0.016, 0.003, red); }
};

// Counting House: a Georgian front of brick five windows wide, symmetrical,
// a door case with a fanlight, brass plates by the door and railings along
// the area; under a hipped roof, a mansard with a balcony, or behind a
// parapet with a pedimented middle (or, in stone, a Dutch gable over it).
// Chambers is three storeys of brick banded with stone: a gabled centre bay
// of arched windows over a porch; two gabled bays with oriels; a round tower
// on a corner under a cone; or a mansard with a clock in a pediment. The
// Office Building is five storeys (six, for some) flat topped behind a
// cornice: giant pilasters and a lift house; a domed corner; a mansard over
// the top floor; the top floor set back under a clock tower; oriels up every
// floor; or a shaped gable over the middle. Stone, brick or white faience.
MODELS.offices = (c, L) => {
  const { gb, rng, pal } = c;
  const F = c.form, trim = '#ece6da';
  const plates = (x, z, n) => { for (let i = 0; i < n; i++) gb.box(x, 0.06 + i * 0.026, z + 0.004, 0.024, 0.018, 0.004, GOLD); };
  if (L === 0) {
    const plan = planOf(c, 4);
    const W = 0.78, D = 0.52, H = 0.56, fz = 0.08, fh = H / 2;
    const wall = pal.forced ? pal.wall : plan === 3 ? pal.stoneWall : pal.brick;
    const roofType = ['hip', 'mansard', 'parapet', 'gable'][plan];
    const body = { z: fz - D / 2, w: W, d: D, h: H, floors: 2, nFront: 5, fancy: false }, P = backPlan(c, body, { sign: false });
    house(c, { ...body, wall, roof: pal.slate, roofType, rh: plan === 1 ? 0.3 : 0.22, dormers: plan === 1 ? 3 : 0, doorX: 0, noDoor: true, bareFront: true, chimney: true, chimneyPos: 'ends', plinth: STONE, lit: 0.8, backClear: P.clear });
    // the clerks' way in at the back, its brass plates polished
    shopBack(c, P, { door: '#2a2a30' });
    for (let i = 0; i < 2; i++) gb.box(P.x0 + P.door - P.side * 0.07, 0.07 + i * 0.026, P.zb - 0.004, 0.024, 0.018, 0.004, GOLD);
    for (let i = 0; i < 5; i++) if (i !== 2) win(c, -W / 2 + (i + 0.5) * (W / 5), fh * 0.38, fz, 0.075, 0.11, 'f', 0.8);
    if (plan === 1) balcony(c, 'iron', 0, fh, fz, 0.42);
    else if (plan === 2) {
      // the middle three bays brought forward over the ground floor, under a
      // pediment over the parapet
      gb.cbox(0, fh - 0.01, fz + 0.012, 0.48, H + 0.03 - fh, 0.024, wall, 0, 0.004);
      for (const u of [-0.16, 0, 0.16]) win(c, u, fh + fh * 0.38, fz + 0.024, 0.075, 0.11, 'f', 0.8);
      gb.gable(0, H + 0.06, fz + 0.012, 0.52, 0.04, 0.12, trim, trim, 0.01, true);
    } else if (plan === 3) wallGable(c, F.gable === 'plain' ? 'dutch' : F.gable, 0, fz, 0.34, H, 0.24, 0.26, wall, pal.slate, trim, 0.8);
    // the door case: pilasters, a cornice and a fanlight
    for (const s of [-1, 1]) gb.box(s * 0.065, 0, fz + 0.008, 0.02, 0.22, 0.02, trim);
    gb.box(0, 0.22, fz + 0.01, 0.16, 0.022, 0.03, trim);
    gb.glow(WARM[0], WARM[1], WARM[2], 1.1); gb.arch(0, 0.18, fz + 0.002, 0.042, 0.01, 8, GLASS); gb.noGlow();
    door(c, 0, fz, 0.085, 0.17, rng.pick(['#2f3e2a', '#2a2a30', '#4a2a2a']));
    plates(0.1, fz, 3);
    frontage(c, -W / 2, W / 2, fz + 0.12, [0], 'railings');
    gb.box(0, 0.3, fz + 0.05, 0.01, 0.01, 0.1, IRON_D);
    gb.glow(2.2, 1.6, 0.8, 3.0); gb.box(0, 0.25, fz + 0.1, 0.03, 0.04, 0.03, '#ffe2a0'); gb.noGlow();
    c.addGlow(0, 0.27, fz + 0.1);
  } else if (L === 1) {
    const plan = planOf(c, 4);
    const W = 0.82, D = 0.54, H = 0.84, fz = 0.09, fh = H / 3;
    const wall = pal.forced ? pal.wall : pal.brick, band = pal.style === 'stone' ? shade(pal.wall, 1.15) : STONE;
    const roofType = ['gable', 'gable', 'parapet', 'mansard'][plan];
    const body = { z: fz - D / 2, w: W, d: D, h: H, floors: 3, nFront: 2, fancy: false }, P = backPlan(c, body, { sign: false, escape: true });
    house(c, { ...body, wall, roof: pal.slate, roofType, rh: plan === 3 ? 0.32 : 0.34, dormers: plan === 3 ? 3 : 0, doorX: 0, noDoor: true, bareFront: true, chimney: true, chimneyPos: 'ends', plinth: STONE, lit: 0.8, backClear: P.clear });
    shopBack(c, P, { door: '#2a2a30' });
    fireEscape(c, P);
    for (const s of [-1, 1]) win(c, s * W / 4, fh * 0.38, fz, 0.075, 0.11, 'f', 0.8);
    for (let k = 1; k < 3; k++) gb.box(0, k * fh - 0.012, fz + 0.002, W + 0.006, 0.018, 0.008, band);
    const arched = c.arched; c.arched = true;
    if (plan === 1) {
      // two gabled bays, an oriel in each over the ground floor
      for (const s of [-1, 1]) {
        wallGable(c, 'plain', s * W / 4, fz, 0.3, H, 0.22, 0.27, wall, pal.slate, trim, 0.7);
        tallBay(c, s * W / 4, fz, fh, 3, wall, pal.slate, 0.85, true, 3, 0.16);
      }
    } else if (plan === 2) {
      // a round tower on a front corner under a cone, the parapet over the rest
      const s = c.corner & 1 ? -1 : c.corner & 2 ? 1 : F.side;
      turret(c, 'round', s * (W / 2 - 0.04), fz - 0.03, 0, H + 0.12, 0.1, fh, wall, pal.slate, 0.85);
      for (let k = 1; k < 3; k++) for (const u of [-0.12, 0.12]) win(c, u - s * 0.06, k * fh + fh * 0.3, fz, 0.06, 0.13, 'f', 0.85);
    } else if (plan === 3) {
      // a clock in a pediment over the middle of the mansard
      gb.cbox(0, H - 0.02, fz - 0.03, 0.26, 0.16, 0.06, wall, 0, 0.006);
      gb.gable(0, H + 0.14, fz - 0.03, 0.28, 0.07, 0.08, wall, trim, 0.015, true);
      wallClock(c, 0, H + 0.06, fz + 0.002, 0.045);
      for (let k = 1; k < 3; k++) for (const s of [-1, 1]) win(c, s * 0.055, k * fh + fh * 0.3, fz, 0.06, 0.13, 'f', 0.85);
    } else {
      // the gabled centre bay, its windows arched
      const bw = 0.26, bz = fz + 0.03;
      footing(c, 0, bz, bw, 0.06);
      gb.cbox(0, 0, bz, bw, H, 0.06, wall, 0, 0.008);
      gb.gable(0, H, bz - 0.02, bw, 0.1, 0.22, wall, pal.slate, 0.025, true, 0.025);
      for (let k = 1; k < 3; k++) for (const s of [-1, 1]) win(c, s * 0.055, k * fh + fh * 0.3, bz + 0.03, 0.06, 0.13, 'f', 0.85);
      win(c, 0, H + 0.04, bz + 0.03, 0.05, 0.09, 'f', 0.6);
      // iron cresting along the ridge
      for (let i = 0; i < 9; i++) gb.box(-W / 2 + 0.06 + i * ((W - 0.12) / 8), H + 0.34, fz - D / 2, 0.006, 0.04, 0.006, IRON_D);
    }
    c.arched = arched;
    const bz = plan === 0 ? fz + 0.03 : fz;
    for (const s of [-1, 1]) gb.box(s * 0.06, 0, bz + 0.07, 0.014, 0.21, 0.014, trim);
    gb.gable(0, 0.21, bz + 0.06, 0.16, 0.08, 0.06, trim, pal.slate, 0.015);
    door(c, 0, bz, 0.09, 0.18, rng.pick(['#2f3e2a', '#2a2a30', '#4a2a2a']));
    plates(0.1, bz, 4);
    frontage(c, -W / 2, W / 2, fz + 0.2, [0], 'railings');
    lamp(c, -0.16, fz + 0.22, 0.28); lamp(c, 0.16, fz + 0.22, 0.28);
  } else {
    const plan = planOf(c, 6);
    const W = 0.84, D = 0.56, fh = 0.25, fz = 0.1;
    const floors = 5 + (plan === 2 || plan === 4 ? F.tall : 0), H = floors * fh;
    const mat = pal.forced ? 0 : F.a < 0.5 ? 0 : F.a < 0.8 ? 1 : 2;
    const wall = pal.forced ? pal.wall : [pal.stoneWall, pal.brick, '#e8e2d2'][mat];
    const roofType = plan === 2 ? 'mansard' : plan === 5 ? 'gable' : 'flat';
    const body = { z: fz - D / 2, w: W, d: D, h: plan === 3 ? H - fh : H, floors: plan === 3 ? floors - 1 : floors, nFront: 4, fancy: false }, P = backPlan(c, body, { sign: false, escape: true });
    house(c, { ...body, wall, roof: pal.slate, roofType, rh: plan === 2 ? 0.3 : 0.26, dormers: plan === 2 ? 4 : 0, doorX: 0, noDoor: true, bareFront: true, chimney: true, chimneyPos: 'ends', plinth: STONE, lit: 0.85, backClear: P.clear });
    shopBack(c, P, { door: '#2a2a30' });
    fireEscape(c, P);
    const top = body.h;
    // the ground floor: a cornice over it, the door case and the name
    gb.box(0, fh - 0.02, fz + 0.01, W, 0.02, 0.03, trim);
    for (const s of [-1, 1]) for (const x of [0.16, 0.32]) win(c, s * x, 0.07, fz, 0.1, 0.13, 'f', 0.85);
    gb.cbox(0, -0.02, fz + 0.05, 0.22, 0.04, 0.1, STONE, 0, 0.008);
    for (const s of [-1, 1]) gb.box(s * 0.075, 0.02, fz + 0.01, 0.03, 0.2, 0.03, shade(wall, 1.15));
    gb.box(0, 0.22, fz + 0.012, 0.18, 0.025, 0.035, shade(wall, 1.15));
    door(c, 0, fz, 0.11, 0.18, '#3a2f28');
    gb.box(0, fh * 1.1, fz + 0.012, 0.3, 0.04, 0.016, '#2a2a30');
    gb.glow(1.8, 1.4, 0.6, 3.1); gb.box(0, fh * 1.1 + 0.01, fz + 0.022, 0.24, 0.02, 0.006, GOLD); gb.noGlow();
    plates(0.1, fz + 0.02, 5);
    if (plan === 0 || plan === 3) {
      // a giant order of pilasters up the front, a cornice
      for (const s of [-1, 0, 1]) gb.box(s * (W / 2 - 0.012), fh, fz + 0.008, s ? 0.03 : 0.024, top - fh - 0.04, 0.02, shade(wall, 1.12));
      gb.box(0, top - 0.05, fz + 0.012, W + 0.04, 0.05, 0.04, trim);
    }
    if (plan === 0) {
      // the lift house and a flag on the roof
      gb.cbox(-0.18, H + 0.04, fz - D / 2 - 0.06, 0.18, 0.13, 0.16, wall, 0, 0.008);
      gb.box(-0.18, H + 0.17, fz - D / 2 - 0.06, 0.2, 0.02, 0.18, trim);
      gb.box(0.25, H + 0.04, fz - 0.06, 0.01, 0.26, 0.01, IRON_D);
      gb.box(0.3, H + 0.24, fz - 0.06, 0.09, 0.055, 0.004, rng.pick(['#a8473a', '#3f6a8f', '#2f6a4a']));
    } else if (plan === 1) {
      // a domed corner, a storey over the cornice
      const s = c.corner & 1 ? -1 : c.corner & 2 ? 1 : F.side;
      gb.box(0, H - 0.04, fz - D / 2, W + 0.04, 0.04, D + 0.04, trim);
      turret(c, 'dome', s * (W / 2 - 0.06), fz - 0.06, 0, H + fh * 0.8, 0.1, fh, wall, '#5f8f7e', 0.85);
    } else if (plan === 3) {
      // the top floor set back, a clock tower over the door
      gb.cbox(0, top + 0.04, fz - D / 2 - 0.03, W - 0.16, fh, D - 0.2, wall, 0, 0.008);
      for (const u of [-0.24, -0.08, 0.08, 0.24]) win(c, u, top + 0.1, fz - 0.13, 0.07, 0.1, 'f', 0.85);
      gb.box(0, top + 0.04 + fh, fz - D / 2 - 0.03, W - 0.12, 0.03, D - 0.16, trim);
      gb.cbox(0, top, fz - 0.06, 0.18, fh + 0.24, 0.12, wall, 0, 0.008);
      wallClock(c, 0, top + fh * 0.6, fz + 0.002, 0.05);
      gb.roof(0, top + fh + 0.24, fz - 0.06, 0.2, 0.14, 0.14, 0.04, '#5f8f7e');
    } else if (plan === 4) {
      // oriels up every floor over the ground, a heavy cornice
      for (const x of [-0.24, 0.24]) tallBay(c, x, fz, fh, floors, wall, pal.slate, 0.85, true, floors, 0.18);
      gb.box(0, H - 0.05, fz - D / 2 + 0.01, W + 0.06, 0.05, D + 0.06, trim);
    } else if (plan === 5) {
      wallGable(c, F.gable === 'plain' ? 'stepped' : F.gable, 0, fz, 0.36, H, 0.3, 0.28, wall, pal.slate, trim, 0.85);
      for (let k = 1; k < floors; k++) gb.box(0, k * fh - 0.01, fz + 0.004, W, 0.014, 0.01, trim);
    } else {
      gb.box(0, H - 0.03, fz - D / 2, W + 0.04, 0.03, D + 0.04, trim);
    }
    lamp(c, -W / 2 + 0.02, 0.43, 0.3); lamp(c, W / 2 - 0.02, 0.43, 0.3);
  }
};

// A farm: barn and yard by the road, fields behind growing crops (or grass
// for livestock: a field shelter for sheep and cattle, a hen house for
// poultry). A homestead (a farm joined with a house) has its farmhouse in
// the yard too.
function farmstead(c, L, home) {
  const { gb, rng, pal } = c;
  const P = produceOf({ flavor: c.flavor }), stock = P.kind === 'livestock';
  const F = c.form;
  // the farm's own ways (forms.js): its barn (a gable barn with doors in
  // its end, a gambrel Dutch barn, or a long barn with a cart entry in its
  // side), an oast house beside it or not, its silo (concrete, timber
  // staves under a cone, or a brick tower), its mill (a tower mill or a
  // post mill), and which end of the yard the barn stands
  const barnKind = planOf(c, 3), oast = F.b > 0.62 && !home, siloKind = planOf(c, 3, 1), postMill = F.a > 0.5;
  const barnCol = rng.pick(['#8f3e2c', '#83402e', '#7a5a3c', '#9a4a34']);
  const flip = !home && F.side > 0 ? -1 : 1;
  const barnX = (home ? 0.44 : -0.32) * flip, barnW = home ? 0.66 : 0.72, bz = 0.5, bf = bz + 0.25;
  if (home) {
    house(c, {
      x: -0.5, z: 0.5, w: 0.6, d: 0.44, h: L >= 3 ? 0.52 : 0.32, floors: L >= 3 ? 2 : 1, wall: L >= 3 ? pal.stoneWall : pal.wall,
      roof: L >= 3 ? pal.slate : pal.thatched ? pal.thatch : pal.roof,
      roofType: L >= 3 ? 'hip' : pal.thatched ? 'thatch' : 'gable', rh: 0.24, chimney: true, timber: L < 3 && pal.timber,
    });
  }
  footing(c, barnX, bz, barnW, 0.5);
  if (barnKind === 2) {
    // a long barn, its ridge along the yard, a cart entry in its side
    gb.cbox(barnX, 0, bz, barnW, 0.32, 0.5, barnCol, 0, 0.02);
    gb.gable(barnX, 0.32, bz, barnW, 0.5, 0.26, barnCol, '#4e463e', 0.05, false, 0.035);
    gb.cbox(barnX, 0, bf - 0.02, 0.26, 0.42, 0.12, barnCol, 0, 0.012);
    gb.gable(barnX, 0.42, bf - 0.02, 0.26, 0.12, 0.12, barnCol, '#4e463e', 0.03, true, 0.025);
    gb.box(barnX, 0, bf + 0.042, 0.2, 0.3, 0.012, shade(barnCol, 0.7));
    gb.box(barnX, 0.15, bf + 0.05, 0.2, 0.012, 0.008, '#d8ccb4');
    c.doorAt ||= { x: barnX, y: 0, z: bf + 0.06, dx: 0, dz: 1 };
  } else {
    gb.cbox(barnX, 0, bz, barnW, 0.4, 0.5, barnCol, 0, 0.02);
    if (barnKind === 1) {
      // a gambrel Dutch barn, a hay hood over the loft door
      gb.push(barnX, 0, bz);
      gambrelRoof(c, barnW, 0.5, 0.4, 0.36, barnCol, '#4e463e', true, 0.05);
      gb.pop();
      gb.box(barnX, 0.5, bf + 0.004, 0.12, 0.1, 0.012, shade(barnCol, 0.7));
      gb.wedge(barnX, 0.62, bf + 0.04, 0.16, 0.1, 0.05, '#4e463e', Math.PI);
    } else gb.gable(barnX, 0.4, bz, barnW, 0.5, 0.3, barnCol, '#4e463e', 0.05, true, 0.035);
    gb.box(barnX, 0, bf + 0.005, 0.24, 0.27, 0.012, '#d8ccb4');
    gb.box(barnX, 0, bf + 0.012, 0.2, 0.25, 0.012, shade(barnCol, 0.7));
    gb.box(barnX, 0.0, bf + 0.018, 0.25, 0.012, 0.01, '#d8ccb4', 0, 0, 0.84);
    c.doorAt ||= { x: barnX, y: 0, z: bf + 0.02, dx: 0, dz: 1 };
  }
  if (oast) {
    // an oast house against the barn's end: the round kiln, its cowl
    const ox = barnX - flip * (barnW / 2 + 0.1), oz = bz - 0.1, y = c.gy(ox, oz);
    gb.cyl(ox, Math.min(0, y) - 0.02, oz, 0.11, 0.12, 0.38 - Math.min(0, y), 10, '#b8704a');
    gb.cone(ox, 0.36, oz, 0.13, 0.26, 10, '#7d3b2a');
    gb.cbox(ox, 0.6, oz, 0.05, 0.07, 0.06, '#ece6da', 0, 0.004);
    gb.wedge(ox, 0.67, oz, 0.07, 0.08, 0.03, '#ece6da', Math.PI / 2);
  }
  if (!home) {
    // an open cart shed beside the barn
    const sx = 0.6 * flip, sz = 0.52, sy = c.gy(sx, sz);
    if (!oast || flip > 0 === (barnX > 0)) {
      for (const ox of [-0.18, 0.18]) for (const oz of [-0.14, 0.14]) gb.box(sx + ox, sy - 0.01, sz + oz, 0.03, 0.24, 0.03, '#4e3a2a');
      gb.gable(sx, sy + 0.23, sz, 0.44, 0.36, 0.12, '#6e5034', pal.roof, 0.04);
      if (L >= 1) gb.cbox(sx, sy, sz + 0.02, 0.26, 0.07, 0.12, '#6b4a2f', 0, 0.008);
    }
  }
  // the fields behind, fenced, with a gate from the yard; an estate keeps an
  // orchard down one side
  const fx0 = L >= 3 ? -0.72 : -0.92, fx1 = 0.92, fz0 = L >= 1 ? -0.92 : -0.6, fz1 = 0.06;
  c.work = [-0.96, -0.96, 0.96, -0.04];
  // the crops of this season, shading into the next's as it turns
  const tufts = (s) => (s === 3 || !P.crop ? CROP_TUFT[s] : P.crop[s]);
  const cA = tufts(c.season), cB = tufts((c.season + 1) % 4);
  // in the town the field is drawn with the farm's fields beyond the plot,
  // as one fenced farmland (see TerrainView._paintFields and NatureView)
  if (!c.inWorld) {
    if (!stock) cropRows(c, fx0, fz0, fx1, fz1, c.seasonW ? cA.map((col, i) => mix(col, cB[i], c.seasonW)) : cA);
    fence(c, fx0 - 0.04, fz0 - 0.03, fx1 + 0.04, fz1 + 0.03, FENCE, { x: 0, z: fz1 + 0.03, w: 0.12 });
  }
  if (stock && P.animal === 'chicken') {
    // a hen house on legs
    const hx = 0.3, hz = -0.3, hy = c.gy(hx, hz);
    for (const ox of [-0.09, 0.09]) for (const oz of [-0.06, 0.06]) gb.box(hx + ox, hy, hz + oz, 0.02, 0.07, 0.02, '#4e3a2a');
    gb.cbox(hx, hy + 0.07, hz, 0.24, 0.12, 0.17, shade(barnCol, 1.1), 0, 0.01);
    gb.gable(hx, hy + 0.19, hz, 0.26, 0.19, 0.08, shade(barnCol, 1.1), '#4e463e', 0.02);
    gb.box(hx + 0.08, hy, hz + 0.1, 0.04, 0.012, 0.12, '#6e5034', 0.5);
  } else if (stock) {
    // an open field shelter and a water trough
    const hx = 0.35, hz = -0.42, hy = c.gy(hx, hz);
    gb.cbox(hx, hy, hz - 0.1, 0.42, 0.2, 0.03, '#6e5034', 0, 0.006);
    for (const ox of [-0.2, 0.2]) gb.box(hx + ox, hy, hz + 0.08, 0.025, 0.2, 0.025, '#4e3a2a');
    gb.gable(hx, hy + 0.2, hz, 0.46, 0.26, 0.1, '#6e5034', pal.roof, 0.03);
    gb.cbox(-0.2, c.gy(-0.2, -0.2), -0.2, 0.2, 0.05, 0.06, '#6b4a2f', 0, 0.008);
  }
  if (L >= 1) {
    // a silo, and hay in the yard
    const sx = (home ? -0.045 : 0.2) * flip, sz = home ? 0.44 : 0.4, sy = c.gy(sx, sz);
    if (siloKind === 1) {
      // timber staves bound in iron, under a cone
      gb.cyl(sx, sy - 0.02, sz, 0.11, 0.12, 0.56, 10, '#8a6a48');
      for (const k of [0.12, 0.28, 0.44]) gb.cyl(sx, sy + k, sz, 0.123, 0.123, 0.012, 10, IRON_D);
      gb.cone(sx, sy + 0.54, sz, 0.14, 0.18, 10, '#4e463e');
    } else if (siloKind === 2) {
      // a square brick tower silo under a pyramid
      gb.cbox(sx, sy - 0.02, sz, 0.2, 0.62, 0.2, '#9a5640', 0, 0.01);
      gb.roof(sx, sy + 0.6, sz, 0.24, 0.24, 0.12, 0, '#4e463e');
    } else {
      gb.cyl(sx, sy - 0.02, sz, 0.12, 0.13, 0.64, 12, '#b8b0a0');
      gb.sphere(sx, sy + 0.62, sz, 0.125, '#6f7f8a', 1, 0.6);
    }
    for (let i = 0; i < 2; i++) {
      const hx = ((home ? 0.62 : 0.66) + i * 0.15) * flip, hz = 0.17, hy = c.gy(hx, hz);
      gb.cyl(hx, hy - 0.01, hz, 0.065, 0.075, 0.08, 9, '#cfa944');
      gb.sphere(hx, hy + 0.07, hz, 0.068, '#c9a240', 1, 0.7);
    }
  }
  if (L >= 2 && !stock) {
    // a windmill in the far corner of the fields: a tower mill, or a post mill
    const mx = 0.8, mz = -0.8, my = c.gy(mx, mz);
    let hubY;
    if (postMill) {
      gb.cyl(mx, my - 0.02, mz, 0.08, 0.1, 0.12, 6, '#8a7a62');
      gb.box(mx, my + 0.1, mz, 0.03, 0.22, 0.03, '#4e3a2a');
      gb.cbox(mx, my + 0.3, mz, 0.2, 0.3, 0.24, '#e3d8c2', 0, 0.01);
      gb.gable(mx, my + 0.6, mz, 0.2, 0.24, 0.1, '#e3d8c2', '#5e4a36', 0.02, true, 0.02);
      hubY = my + 0.5;
    } else {
      gb.cyl(mx, my - 0.03, mz, 0.1, 0.17, 0.8, 9, '#ddd2bc');
      gb.cone(mx, my + 0.77, mz, 0.13, 0.18, 9, '#5e4a36');
      hubY = my + 0.72;
    }
    gb.glow(WARM[0], WARM[1], WARM[2], 1.3); gb.box(mx, my + 0.32, mz + (postMill ? 0.122 : 0.125), 0.04, 0.06, 0.02, GLASS); gb.noGlow();
    const blades = new GeoBuilder();
    for (let i = 0; i < 4; i++) {
      const an = (i * Math.PI) / 2;
      blades.boxC(Math.cos(an) * 0.19, Math.sin(an) * 0.19, 0, 0.36, 0.014, 0.014, '#4e3a2a', 0, 0, an);
      blades.boxC(Math.cos(an) * 0.22 + Math.cos(an + Math.PI / 2) * 0.04, Math.sin(an) * 0.22 + Math.sin(an + Math.PI / 2) * 0.04, 0, 0.27, 0.065, 0.006, '#e3d8c2', 0, 0, an);
    }
    blades.cyl(0, 0, -0.02, 0.028, 0.028, 0.05, 6, '#3a2f28', 0, Math.PI / 2);
    c.spin = { geo: blades.build(), x: mx, y: hubY, z: mz + (postMill ? 0.15 : 0.19), speed: 1.2 };
  }
  if (L >= 3) {
    // an orchard down the side of the fields, and a dovecote in the yard
    for (let i = 0; i < 4; i++) smallTree(c, -0.86, -0.8 + i * 0.26, 0.75);
    const dx = -0.88 * (home ? 1 : 1), dz = 0.16, dy = c.gy(dx, dz);
    if (F.a < 0.5) {
      gb.cyl(dx, dy - 0.02, dz, 0.06, 0.07, 0.32, 8, '#e3dccb');
      gb.cone(dx, dy + 0.3, dz, 0.09, 0.1, 8, '#4e463e');
    } else {
      // a square dovecote on a post
      gb.box(dx, dy, dz, 0.025, 0.24, 0.025, '#5e432c');
      gb.cbox(dx, dy + 0.24, dz, 0.1, 0.1, 0.1, '#e3dccb', 0, 0.006);
      gb.roof(dx, dy + 0.34, dz, 0.13, 0.13, 0.08, 0, '#4e463e');
    }
  }
}
MODELS.farm = (c, L) => farmstead(c, L, false);
MODELS.homestead = (c, L) => farmstead(c, L, true);

MODELS.lumber = (c, L) => {
  const { gb, rng, pal } = c;
  house(c, {
    x: -0.12, z: -0.18, w: 0.52, d: 0.42, h: 0.3, wall: pal.wood, roof: rng.pick(ROOF_SHINGLE), roofType: 'gable', rh: 0.2,
    chimney: rng.chance(0.6), lit: 0.6,
  });
  // log-cabin texture: horizontal logs on the front wall
  for (let k = 0; k < 4; k++) gb.cyl(-0.12 - 0.27, 0.04 + k * 0.07, -0.18 + 0.215, 0.018, 0.018, 0.54, 6, '#6e4e31', 0, 0, -Math.PI / 2);
  logs(c, 0.32, -0.05, 4, 0);
  logs(c, 0.26, 0.32, 3, Math.PI / 2);
  const bx = -0.28, bz = 0.28, by = c.gy(bx, bz);
  gb.cyl(bx, by, bz, 0.045, 0.05, 0.065, 9, '#6e4e31');
  gb.box(bx, by + 0.065, bz, 0.008, 0.065, 0.008, '#4a3a2c', 0, 0.4);
  for (let i = 0; i < 6; i++) { const px = -0.1 + rng.float(-0.12, 0.12), pz = 0.3 + rng.float(-0.06, 0.06); gb.box(px, c.gy(px, pz), pz, 0.045, 0.012, 0.016, '#c29b64', rng.float(0, 3)); }
  if (L >= 1) {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const px = 0.2 + sx * 0.21, pz = 0.2 + sz * 0.15; gb.box(px, c.gy(px, pz) - 0.01, pz, 0.026, 0.28, 0.026, '#4e3a2a'); }
    gb.gable(0.2, 0.27, 0.2, 0.5, 0.38, 0.13, '#6e5034', rng.pick(ROOF_SHINGLE), 0.04);
    gb.cbox(0.2, c.gy(0.2, 0.2), 0.2, 0.32, 0.075, 0.09, '#86663f', 0, 0.008);
    gb.cyl(0.2, c.gy(0.2, 0.2) + 0.075, 0.2, 0.055, 0.055, 0.01, 12, '#a8acb2', 0, Math.PI / 2);
    for (let k = 0; k < 4; k++) gb.box(-0.36, c.gy(-0.36, 0.0) + k * 0.018, 0.0, 0.09, 0.016, 0.3, '#c9a46a');
  } else smallTree(c, 0.4, -0.4, 0.95);
  if (L >= 2) {
    // a timber crane and more stacked planks
    const kx = 0.38, kz = -0.36, ky = c.gy(kx, kz);
    gb.box(kx, ky - 0.01, kz, 0.03, 0.55, 0.03, '#4e3a2a');
    gb.box(kx - 0.12, ky + 0.52, kz, 0.3, 0.025, 0.025, '#4e3a2a');
    gb.box(kx - 0.24, ky + 0.3, kz, 0.004, 0.22, 0.004, '#2a2620');
    gb.box(kx - 0.24, ky + 0.26, kz, 0.16, 0.04, 0.04, '#7d5b3b');
    for (let k = 0; k < 5; k++) gb.box(-0.12, c.gy(-0.12, -0.42) + k * 0.018, -0.42, 0.28, 0.016, 0.09, k % 2 ? '#c9a46a' : '#b8925a');
  }
};

MODELS.fishery = (c, L) => {
  const { gb, rng } = c;
  const hutCol = c.form.b < 0.3 ? '#2f2c2a' : rng.pick(['#6f8a95', '#7f989c', '#8f7a5e', '#6f8a7a']);
  house(c, {
    x: -0.1, z: -0.16, w: L ? 0.6 : 0.48, d: L ? 0.48 : 0.4, h: L ? 0.36 : 0.28, wall: hutCol, roof: rng.pick(ROOF_SHINGLE),
    roofType: 'gable', rh: 0.2, chimney: L >= 1, smokeKind: 'work', lit: 0.6, siding: c.form.b < 0.6,
  });
  const rx = 0.3, rz = 0.18, ry = c.gy(rx, rz);
  for (const sx of [-1, 1]) gb.box(rx + sx * 0.12, ry, rz, 0.016, 0.2, 0.016, '#4e3a2a');
  gb.box(rx, ry + 0.19, rz, 0.27, 0.012, 0.012, '#4e3a2a');
  for (let i = 0; i < 4; i++) gb.box(rx - 0.08 + i * 0.055, ry + 0.11, rz, 0.022, 0.065, 0.008, '#93a6b0');
  const boat = (x, z, rot) => {
    gb.push(x, c.gy(x, z), z, rot);
    gb.roof(0, 0.0, 0, 0.13, 0.32, 0.065, 0, '#6e4a2c', 0);
    gb.box(0, 0.0, 0, 0.11, 0.035, 0.24, '#7d5b3b');
    gb.box(0, 0.035, 0, 0.1, 0.008, 0.022, '#4a3a2c');
    gb.pop();
  };
  boat(-0.32, 0.32, 0.3);
  if (L === 1) boat(0.34, 0.4, -0.2);
  barrel(c, 0.4, -0.34); crate(c, 0.33, -0.22);
  if (L >= 2) {
    // smokehouse and a cargo crane
    const hx = 0.32, hz = -0.3;
    footing(c, hx, hz, 0.2, 0.2);
    gb.cbox(hx, 0, hz, 0.2, 0.32, 0.2, '#7a6a58', 0, 0.012);
    gb.roof(hx, 0.32, hz, 0.24, 0.24, 0.12, 0, '#4e463e');
    c.addSmoke(hx, 0.48, hz, 'work');
    crate(c, 0.1, 0.42); crate(c, 0.17, 0.4, 0.85);
  }
  if (L) landing(c, L);
};

// A fishery's landing stage out over the water beside it: a timber jetty
// with a boat tied up, or at the Harbour a stone pier with bollards and a
// lamp at its head, boats moored along it and a crane at its root swinging
// the catch ashore. It's drawn in a frame turned so the water lies to -z,
// and goes where its root is clear of the hut and the smokehouse. It reaches
// beyond the plot, so it's drawn after the model is fitted to its plot.
function landing(c, L) { c.beyond.push((cc) => landingNow(cc, L)); }
function landingNow(c, L) {
  const { gb } = c;
  const [sx, sz] = waterSide(c);
  const th = Math.atan2(-sx, -sz), co = Math.cos(th), si = Math.sin(th);
  const harbour = L >= 2, half = harbour ? 0.1 : 0.065, root = -0.36;
  const taken = [[-0.42, 0.22, -0.42, 0.1], ...(harbour ? [[0.2, 0.44, -0.42, -0.18]] : [])];
  const clear = (u) => [-half - 0.04, 0, half + 0.04, harbour ? -half - 0.2 : 0].every((du) => {
    const x = (u + du) * co + -0.42 * si, z = -(u + du) * si + -0.42 * co;
    return !taken.some(([x0, x1, z0, z1]) => x > x0 - 0.03 && x < x1 + 0.03 && z > z0 - 0.03 && z < z1 + 0.03);
  });
  const jx = [0.24, -0.24, 0.32, -0.32, 0].find(clear) ?? 0.28;
  gb.push(0, 0, 0, th);
  const wy = c.waterY();
  // out across the shore and the shallows (which show as wet sand) until it
  // stands in open water, however wide the beach (to a point)
  let tip = -0.5 - (harbour ? 0.62 : 0.4);
  for (let z = -0.5; z > -2.2; z -= 0.05) if (c.gy(jx, z) < wy - 0.12) { tip = Math.min(tip, z - (harbour ? 0.34 : 0.24)); break; }
  tip = Math.max(tip, -2.4);
  // ...but never over a neighbour's plot (another harbour along the shore,
  // say), its boats and all: short of it, or no pier where it can't start
  const room = harbour ? half + 0.075 + 0.06 : half + 0.12;
  for (let z = -0.5; z >= tip; z -= 0.04) {   // (from the edge of its own plot)
    if ([-room, 0, room].some(dx => c.takenAt(jx + dx, z))) { tip = z + 0.06; break; }
  }
  if (root - tip < 0.3) { gb.pop(); return; }
  const deck = Math.max(wy + 0.07, c.gy(jx, root)), len = root - tip, mz = (root + tip) / 2;
  if (harbour) {
    // dressed stone from the bed, a lighter coping along the top
    const bed = Math.min(c.gy(jx, tip), c.gy(jx, mz), wy) - 0.12;
    gb.cbox(jx, bed, mz, half * 2, deck - bed - 0.016, len, STONE, 0, 0.012);
    gb.box(jx, deck - 0.016, mz, half * 2 + 0.014, 0.016, len + 0.014, '#a9a194');
    for (const s of [-1, 1]) for (const k of [0.3, 0.7]) {
      const x = jx + s * (half - 0.022), z = root - len * k;
      gb.cyl(x, deck, z, 0.011, 0.014, 0.028, 7, IRON_D);
      gb.sphere(x, deck + 0.028, z, 0.012, IRON_D, 0);
    }
    lamp(c, jx, tip + 0.05, 0.26, deck);
    // the crane on the quay beside the pier's root, its jib out over the water
    const kx = jx + (jx > 0 ? -1 : 1) * (half + 0.09), kz = -0.43, ky = c.gy(kx, kz);
    gb.box(kx, ky, kz, 0.026, 0.42, 0.026, TIMBER);
    gb.box(kx, ky + 0.4, kz - 0.1, 0.022, 0.022, 0.24, TIMBER);
    gb.box(kx, ky + 0.2, kz - 0.2, 0.004, 0.2, 0.004, '#2a2620');
    gb.cbox(kx, ky + 0.14, kz - 0.2, 0.07, 0.06, 0.07, '#a88458', 0, 0.006);
  } else {
    // piles driven into the bed, a deck of planks across them
    for (let z = root - 0.02; z >= tip + 0.01; z -= 0.14) for (const s of [-1, 1]) {
      const px = jx + s * (half - 0.012), g = c.gy(px, z);
      if (g < deck - 0.03) gb.cyl(px, g - 0.04, z, 0.011, 0.013, deck - g + 0.05, 6, '#5e4630');
    }
    const n = Math.round(len / 0.045);
    for (let i = 0; i < n; i++) gb.box(jx, deck - 0.018, root - (i + 0.5) * (len / n), half * 2, 0.018, len / n, i % 2 ? '#8a6a44' : '#7d5f3c');
    for (const s of [-1, 1]) gb.cyl(jx + s * (half - 0.012), deck, tip + 0.02, 0.011, 0.012, 0.06, 6, '#5e4630');
  }
  // boats tied up alongside towards its head, where there's water under them
  const spots = harbour ? [[1, 0.16, true], [-1, 0.24, false], [1, 0.46, false]] : [[ownSide(c), 0.17, false]];
  for (const [s, k, sail] of spots) {
    const x = jx + s * (half + 0.075), z = tip + k;
    if (c.gy(x, z) < wy - 0.06) mooredBoat(c, x, z, wy, sail);
  }
  gb.pop();
}
const ownSide = (c) => (((c.variant || 0) >> 3) & 1 ? 1 : -1);

// A boat afloat at y, along z: a clinker hull with a pointed bow, its
// thwarts, and (sail) a mast with the sail furled half down.
function mooredBoat(c, x, z, y, sail) {
  const { gb } = c;
  gb.push(x, y, z, 0);
  gb.cbox(0, -0.02, 0, 0.1, 0.05, 0.24, '#6e4a2c', 0, 0.012);
  gb.cbox(0, -0.02, 0.12, 0.07, 0.05, 0.07, '#6e4a2c', Math.PI / 4, 0.01);
  gb.box(0, 0.03, 0, 0.082, 0.006, 0.2, '#9a7a54');
  for (const k of [-0.06, 0.04]) gb.box(0, 0.03, k, 0.086, 0.012, 0.02, '#5e432c');
  if (sail) {
    gb.cyl(0, 0.03, 0.04, 0.005, 0.007, 0.32, 5, '#5e432c');
    gb.box(0.004, 0.12, -0.02, 0.006, 0.18, 0.11, '#e3d6b8');
  }
  gb.pop();
}

MODELS.workshop = (c, L) => {
  const { gb, rng, pal } = c;
  if (L === 0) {
    house(c, {
      z: -0.1, w: 0.64, d: 0.5, h: 0.36, wall: pal.stoneWall, roof: pal.slate, roofType: 'gable', rh: 0.22,
      chimney: true, smokeKind: 'work', lit: 0.6,
    });
    crate(c, 0.34, 0.32); crate(c, 0.4, 0.24, 0.8); crate(c, 0.36, 0.28, 0.6, '#7a5a3c');
    const wx = -0.34, wz = 0.32;
    gb.cyl(wx, c.gy(wx, wz) + 0.075, wz, 0.075, 0.075, 0.014, 10, '#5e432c', 0.4, Math.PI / 2, 0);
  } else if (L === 1) {
    house(c, {
      z: -0.17, w: 0.66, d: 0.42, h: 0.38, wall: pal.stoneWall, roof: pal.slate, roofType: 'gable', rh: 0.2, lit: 0.5,
      noDoor: true,
    });
    door(c, 0.24, 0.04, 0.08, 0.17, '#4e3a2a');
    for (const sx of [-1, 1]) gb.box(sx * 0.3, c.gy(sx * 0.3, 0.2) - 0.01, 0.2, 0.026, 0.3, 0.026, '#4e3a2a');
    gb.wedge(0, 0.28, 0.12, 0.68, 0.24, 0.09, '#4e5357');
    gb.cbox(-0.12, 0, 0.06, 0.2, 0.13, 0.13, STONE_D, 0, 0.012);
    gb.glow(2.6, 0.9, 0.2, 2.0); gb.box(-0.12, 0.13, 0.06, 0.13, 0.02, 0.085, '#ff7a2a'); gb.noGlow();
    const ax = 0.13, az = 0.18, ay = c.gy(ax, az);
    gb.box(ax, ay, az, 0.05, 0.055, 0.04, '#34322f');
    gb.box(ax, ay + 0.055, az, 0.1, 0.03, 0.05, '#45423e');
    chimney(c, -0.12, 0.2, 0.7, -0.06, 'heavy', STONE_D);
    c.addGlow(-0.12, 0.16, 0.06, 'forge');
  } else {
    // the Manufactory, in one of its plans: a brick shed under a sawtooth
    // roof of north lights, a tall round stack; a four-storey mill with its
    // stair tower and a square stack; a shed with a monitor roof (a raised
    // run of windows along its ridge) and a water tank on legs; or an engine
    // house, its gable to the street round a great arched window, an
    // octagonal stack beside it
    const plan = planOf(c, 4);
    const stack = (x, z, h, kind) => {
      if (kind === 'square') {
        gb.cbox(x, 0, z, 0.12, h, 0.12, '#7f3f2e', 0, 0.01);
        for (const k of [0.3, 0.6, 0.9]) if (k < h) gb.box(x, k, z, 0.135, 0.02, 0.135, '#5f3022');
        gb.cbox(x, h, z, 0.15, 0.05, 0.15, '#5f3022', 0, 0.008);
      } else {
        gb.cyl(x, 0, z, 0.065, 0.085, h, kind === 'oct' ? 8 : 10, '#7f3f2e');
        gb.cyl(x, h, z, 0.075, 0.075, 0.045, kind === 'oct' ? 8 : 10, '#5f3022');
      }
      c.addSmoke(x, h + 0.07, z, 'heavy');
    };
    if (plan === 1) {
      // a four-storey mill, its stair tower to one end under a pyramid
      house(c, { x: -0.06, z: -0.12, w: 0.74, d: 0.5, h: 0.9, floors: 4, wall: pal.brick, roof: pal.slate, roofType: 'hip', rh: 0.14, nFront: 5, doorX: 0, doorW: 0.13, chimney: false, fancy: false, lit: 0.9, plinth: STONE });
      for (let f = 1; f < 4; f++) gb.box(-0.06, f * 0.225 - 0.008, -0.12, 0.76, 0.014, 0.52, '#d8ccb4');
      gb.cbox(0.38, 0, -0.06, 0.16, 1.06, 0.16, pal.brick, 0, 0.01);
      for (let f = 0; f < 4; f++) win(c, 0.38, f * 0.25 + 0.12, 0.02, 0.05, 0.1, 'f', 0.8);
      gb.roof(0.38, 1.06, -0.06, 0.2, 0.2, 0.14, 0, pal.slate);
      stack(-0.38, -0.42, 1.2, 'square');
    } else if (plan === 2) {
      // a shed under a monitor roof, and a water tank on legs
      footing(c, -0.06, -0.08, 0.78, 0.7);
      gb.cbox(-0.06, 0, -0.08, 0.78, 0.4, 0.7, pal.brick, 0, 0.02);
      gb.gable(-0.06, 0.4, -0.08, 0.8, 0.72, 0.14, pal.brick, '#4e5357', 0.04, false, 0.03);
      gb.cbox(-0.06, 0.48, -0.08, 0.7, 0.1, 0.22, '#5a5a5e', 0, 0.006);
      gb.glow(WARM[0], WARM[1], WARM[2], 1.2);
      for (const s of [-1, 1]) gb.box(-0.06, 0.5, -0.08 + s * 0.112, 0.66, 0.06, 0.008, GLASS);
      gb.noGlow();
      gb.gable(-0.06, 0.58, -0.08, 0.74, 0.26, 0.06, '#5a5a5e', '#4e5357', 0.02, false, 0.02);
      for (let i = 0; i < 4; i++) {
        win(c, -0.38 + i * 0.21, 0.1, 0.27, 0.12, 0.16, 'f', 0.9);
        win(c, -0.38 + i * 0.21, 0.1, -0.43, 0.12, 0.16, 'b', 0.9);
      }
      for (const s of [-1, 1]) win(c, -0.06 + s * 0.39, 0.1, -0.08, 0.12, 0.16, s > 0 ? 'r' : 'l', 0.9);
      door(c, -0.06, 0.27, 0.15, 0.2, '#2f241b');
      const tx = 0.4, tz = -0.36;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) gb.box(tx + sx * 0.05, 0, tz + sz * 0.05, 0.016, 0.62, 0.016, '#3a3a3e');
      gb.cyl(tx, 0.62, tz, 0.09, 0.09, 0.16, 10, '#6a6a70');
      gb.cone(tx, 0.78, tz, 0.095, 0.05, 10, '#4e5357');
      stack(0.38, 0.06, 0.9, 'round');
    } else if (plan === 3) {
      // an engine house: its gable to the street round a great arched window
      house(c, { x: -0.1, z: -0.1, w: 0.52, d: 0.64, h: 0.62, floors: 2, wall: pal.brick, roof: pal.slate, roofType: 'gable', alongZ: true, rh: 0.26, nFront: 2, noDoor: true, chimney: false, fancy: false, lit: 0.9, plinth: STONE });
      gb.glow(WARM[0], WARM[1], WARM[2], 1.2); gb.arch(-0.1, 0.52, 0.222, 0.1, 0.012, 10, GLASS); gb.box(-0.1, 0.16, 0.228, 0.2, 0.36, 0.012, GLASS); gb.noGlow();
      for (let k = -1; k <= 1; k++) gb.box(-0.1 + k * 0.065, 0.16, 0.236, 0.008, 0.36, 0.006, '#d8ccb4');
      door(c, -0.1, 0.22, 0.12, 0.15, '#2f241b');
      gb.cbox(0.26, 0, -0.06, 0.2, 0.3, 0.44, pal.brick, 0, 0.012);
      gb.wedge(0.26, 0.3, -0.06, 0.48, 0.24, 0.1, '#4e5357', -Math.PI / 2);
      win(c, 0.26, 0.08, 0.16, 0.1, 0.12, 'f', 0.9);
      win(c, 0.36, 0.08, -0.06, 0.1, 0.12, 'r', 0.9);
      stack(0.34, -0.38, 1.15, 'oct');
    } else {
      footing(c, 0, -0.08, 0.9, 0.7);
      gb.cbox(0, 0, -0.08, 0.9, 0.52, 0.7, pal.brick, 0, 0.022);
      // the sawtooth roof: three north lights across the shed
      for (let i = 0; i < 3; i++) gb.wedge(-0.3 + i * 0.3, 0.52, -0.08, 0.72, 0.3, 0.17, '#4e5357', Math.PI / 2);
      for (let f = 0; f < 2; f++) for (let i = 0; i < 4; i++) {
        win(c, -0.33 + i * 0.22, 0.09 + f * 0.22, 0.27, 0.11, 0.11, 'f', 0.9);
        win(c, -0.33 + i * 0.22, 0.09 + f * 0.22, -0.43, 0.11, 0.11, 'b', 0.9);
      }
      door(c, 0, 0.27, 0.15, 0.2, '#2f241b');
      stack(0.34, -0.32, 1.15, 'round');
    }
    crate(c, -0.4, 0.4); crate(c, -0.31, 0.42, 0.8); barrel(c, 0.4, 0.4);
  }
};
// The village well, the water tower and the waterworks, each its own way
// (planOf). The well: a well-head under a little roof with its windlass; a
// pump on a stone plinth with a trough; or a well-head under a great winding
// wheel. The water tower: a timber tank on raking legs; an iron tank on a
// brick tower; or a round stone tower under a cone. The waterworks: the pump
// house with an open round cistern; a covered reservoir under turf, its
// vents and steps; or a tall Italianate water tower beside the pump house.
MODELS.well = (c, L) => {
  const { gb, pal } = c;
  const plan = planOf(c, 3);
  if (L === 0) {
    if (plan === 1) {
      // a village pump on a stone plinth, its trough before it
      footing(c, 0, -0.02, 0.24, 0.24);
      gb.cbox(0, -0.02, -0.02, 0.22, 0.06, 0.22, STONE, 0, 0.01);
      gb.cbox(0, 0.04, -0.06, 0.07, 0.3, 0.07, '#3f4a3a', 0, 0.006);
      gb.boxC(0, 0.32, 0.0, 0.012, 0.012, 0.16, '#3f4a3a', -0.5);
      gb.box(0, 0.2, -0.01, 0.025, 0.025, 0.06, '#3f4a3a');
      gb.cbox(0, -0.01, 0.12, 0.26, 0.07, 0.1, STONE, 0, 0.008);
      gb.box(0, 0.05, 0.12, 0.22, 0.006, 0.07, '#3f7f9f');
    } else if (plan === 2) {
      // a well-head under a great winding wheel
      footing(c, 0, 0, 0.3, 0.3);
      gb.cyl(0, -0.02, 0, 0.14, 0.155, 0.14, 12, STONE);
      gb.cyl(0, 0.115, 0, 0.125, 0.125, 0.004, 12, '#2f5468');
      for (const sz of [-1, 1]) gb.box(0, 0.08, sz * 0.13, 0.03, 0.34, 0.024, '#4e3a2a');
      gb.box(0, 0.4, 0, 0.03, 0.03, 0.3, '#4e3a2a');
      gb.cyl(0.04, 0.33, 0, 0.13, 0.13, 0.016, 12, '#6e4a2c', Math.PI / 2, Math.PI / 2);
      gb.cyl(0.04, 0.33, 0, 0.11, 0.11, 0.02, 12, '#8a6a48', Math.PI / 2, Math.PI / 2);
    } else {
      footing(c, 0, 0, 0.3, 0.3);
      gb.cyl(0, -0.02, 0, 0.14, 0.155, 0.14, 12, STONE);
      gb.cyl(0, 0.115, 0, 0.125, 0.125, 0.004, 12, '#2f5468');
      for (const sx of [-1, 1]) gb.box(sx * 0.13, 0.08, 0, 0.024, 0.27, 0.024, '#4e3a2a');
      gb.gable(0, 0.34, 0, 0.36, 0.24, 0.11, '#6e4a2c', pal.thatched ? pal.thatch : pal.roof, 0.03);
      gb.cyl(0.13, 0.28, 0, 0.013, 0.013, 0.26, 6, '#4e3a2a', 0, 0, Math.PI / 2);
      gb.cyl(0.03, 0.19, 0, 0.024, 0.02, 0.04, 7, '#6e4a2c');
    }
    bench(c, 0, 0.36, 0);
    flowers(c, -0.32, -0.32, 6, 0.07);
    bush(c, 0.34, -0.32);
  } else if (L >= 2) {
    // Waterworks: the brick pump house and its engine chimney
    house(c, { x: -0.18, z: -0.12, w: 0.5, d: 0.5, h: 0.4, wall: pal.brick, roof: pal.slate, roofType: 'gable', rh: 0.18, lit: 0.8, plinth: STONE, nFront: 2, form: { turret: null } });
    if (plan !== 2) chimney(c, -0.36, 0.3, 0.95, -0.3, 'heavy', '#7f3f2e');
    const tx = 0.27, tz = 0.12, ty = c.gy(tx, tz);
    if (plan === 1) {
      // a covered reservoir: a turfed mound, vents and a stair house
      footing(c, tx, tz, 0.4, 0.44);
      gb.cbox(tx, ty - 0.02, tz, 0.4, 0.12, 0.44, STONE, 0, 0.012);
      gb.cbox(tx, ty + 0.1, tz, 0.38, 0.05, 0.42, '#6f9a45', 0, 0.03);
      for (const u of [-0.1, 0.1]) { gb.cyl(tx + u, ty + 0.15, tz - 0.08, 0.025, 0.025, 0.07, 8, '#6a6a70'); gb.cone(tx + u, ty + 0.22, tz - 0.08, 0.035, 0.03, 8, '#4a4a4e'); }
      gb.cbox(tx + 0.1, ty + 0.1, tz + 0.12, 0.1, 0.12, 0.1, pal.brick, 0, 0.006);
      gb.wedge(tx + 0.1, ty + 0.22, tz + 0.12, 0.12, 0.12, 0.03, pal.slate, 0);
    } else if (plan === 2) {
      // a tall water tower, its tank in a brick drum under a pyramid
      const wx = 0.28, wz = -0.2, H = 0.9;
      footing(c, wx, wz, 0.24, 0.24);
      gb.cbox(wx, 0, wz, 0.22, H, 0.22, pal.brick, 0, 0.012);
      for (let k = 0; k < 3; k++) win(c, wx, 0.12 + k * 0.26, wz + 0.11, 0.04, 0.12, 'f', 0.5);
      gb.cbox(wx, H, wz, 0.3, 0.22, 0.3, pal.brick, 0, 0.012);
      gb.box(wx, H + 0.2, wz, 0.33, 0.025, 0.33, '#d8ccb4');
      gb.roof(wx, H + 0.225, wz, 0.34, 0.34, 0.16, 0, pal.slate);
      chimney(c, -0.38, 0.3, 0.8, -0.3, 'heavy', '#7f3f2e');
      gb.cyl(tx - 0.02, ty - 0.02, tz + 0.12, 0.12, 0.13, 0.16, 12, STONE);
      gb.cyl(tx - 0.02, ty + 0.14, tz + 0.12, 0.11, 0.11, 0.01, 12, '#3f7f9f');
    } else {
      footing(c, tx, tz, 0.4, 0.4);
      gb.cyl(tx, ty - 0.02, tz, 0.19, 0.2, 0.24, 16, STONE);
      gb.cyl(tx, ty + 0.2, tz, 0.17, 0.17, 0.02, 16, '#3f7f9f');
      gb.cyl(tx, ty + 0.21, tz, 0.2, 0.2, 0.025, 16, '#8a8275');
      for (let k = 0; k < 4; k++) gb.box(tx - 0.2 + k * 0.13, ty + 0.235, tz + 0.2, 0.01, 0.06, 0.01, '#3a3a3e');
    }
  } else {
    const H = 0.66;
    if (plan === 1) {
      // an iron tank on a brick tower
      footing(c, 0, 0, 0.3, 0.3);
      gb.cbox(0, 0, 0, 0.28, H, 0.28, pal.brick, 0, 0.012);
      for (let k = 0; k < 2; k++) win(c, 0, 0.14 + k * 0.28, 0.14, 0.05, 0.12, 'f', 0.5);
      for (const s of [-1, 1]) win(c, s * 0.14, 0.4, 0, 0.05, 0.12, s > 0 ? 'r' : 'l', 0.5);
      gb.box(0, H - 0.02, 0, 0.34, 0.03, 0.34, '#d8ccb4');
      gb.cyl(0, H + 0.01, 0, 0.22, 0.22, 0.24, 14, '#6f7f86');
      for (let k = 0; k < 3; k++) gb.cyl(0, H + 0.05 + k * 0.08, 0, 0.224, 0.224, 0.01, 14, '#4a5560');
      gb.cone(0, H + 0.25, 0, 0.23, 0.08, 14, '#4a5560');
    } else if (plan === 2) {
      // a round stone tower under a cone
      footing(c, 0, 0, 0.36, 0.36);
      gb.cyl(0, 0, 0, 0.15, 0.17, H + 0.18, 12, pal.stoneWall);
      gb.glow(WARM[0], WARM[1], WARM[2], 1.2);
      for (const a of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) gb.box(Math.sin(a) * 0.162, 0.4, Math.cos(a) * 0.162, 0.04, 0.1, 0.012, GLASS, a);
      gb.noGlow();
      gb.cyl(0, H + 0.18, 0, 0.19, 0.19, 0.04, 12, STONE_D);
      gb.cone(0, H + 0.22, 0, 0.2, 0.22, 12, pal.roof);
    } else {
      footing(c, 0, 0, 0.46, 0.46);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) gb.box(sx * 0.19, 0, sz * 0.19, 0.032, H, 0.032, '#5e432c', 0, -sz * 0.08, sx * 0.08);
      gb.box(0, 0.3, 0.16, 0.32, 0.022, 0.022, '#5e432c');
      gb.box(0, 0.3, -0.16, 0.32, 0.022, 0.022, '#5e432c');
      gb.cyl(0, H, 0, 0.23, 0.23, 0.28, 14, '#86663f');
      for (let k = 0; k < 3; k++) gb.cyl(0, H + 0.04 + k * 0.085, 0, 0.235, 0.235, 0.013, 14, '#3f3d3a');
      gb.cone(0, H + 0.28, 0, 0.26, 0.15, 14, pal.roof);
    }
    house(c, { x: -0.32, z: 0.28, w: 0.2, d: 0.18, h: 0.15, wall: pal.stoneWall, roof: pal.slate, roofType: 'gable', rh: 0.08, noDoor: true, noBack: true, lit: 0, form: false });
  }
};

// The herbalist's cottage among its beds; the Clinic, a two-storey house of
// healing (the form's own roofs, porch and bays); the Hospital, in one of
// its plans: a tall centre between wings with a canopied entrance; a long
// range with a clock turret over the middle; or wards in pavilions either
// side of the entrance block, joined by a corridor.
MODELS.clinic = (c, L) => {
  const { gb, rng, pal } = c;
  const redCross = (x, y, z, s = 1) => {
    sign(c, x, y, z, 0.14 * s, 0.14 * s, '#f5f0e6');
    gb.glow(1.6, 0.3, 0.3, 3.0);
    gb.box(x, y + 0.055 * s, z + 0.008, 0.09 * s, 0.028 * s, 0.008, '#b83a32');
    gb.box(x, y + 0.024 * s, z + 0.008, 0.028 * s, 0.09 * s, 0.008, '#b83a32');
    gb.noGlow();
  };
  if (L === 0) {
    house(c, {
      z: -0.12, w: 0.58, d: 0.46, h: 0.31, wall: pal.wall, roof: rng.pick(ROOF_MOSS), roofType: 'thatch', rh: 0.23,
      chimney: true, timber: pal.timber,
    });
    // the herb beds: in rows across the front, or a round bed with a sundial
    if (c.form.b < 0.5) {
      for (let i = 0; i < 3; i++) {
        const bx = -0.3 + i * 0.3, bz = 0.34;
        gb.cbox(bx, c.gy(bx, bz) - 0.01, bz, 0.22, 0.05, 0.12, '#5e432c', 0, 0.008);
        for (let k = 0; k < 4; k++) gb.sphere(bx - 0.075 + k * 0.05, c.gy(bx, bz) + 0.055, bz, 0.024, i === 1 ? '#8f74b8' : '#5f8a42', 1);
      }
    } else {
      const bx = -0.22, bz = 0.3, y = c.gy(bx, bz);
      gb.cyl(bx, y - 0.01, bz, 0.15, 0.15, 0.04, 10, '#5e432c');
      for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; gb.sphere(bx + Math.cos(a) * 0.1, y + 0.045, bz + Math.sin(a) * 0.1, 0.024, k % 2 ? '#8f74b8' : '#5f8a42', 1); }
      gb.cyl(bx, y + 0.03, bz, 0.016, 0.02, 0.07, 6, STONE);
      gb.box(bx, y + 0.1, bz, 0.04, 0.006, 0.04, '#c9a43a');
      for (let i = 0; i < 2; i++) beehives(c, 0.22 + i * 0.12, 0.34);
    }
    const sx = 0.36, sz = 0.1;
    sign(c, sx, 0.2, sz, 0.1, 0.1, '#e9e0cc');
    gb.box(sx, 0.225, sz + 0.009, 0.06, 0.018, 0.006, '#4f7a45');
    gb.box(sx, 0.204, sz + 0.009, 0.018, 0.06, 0.006, '#4f7a45');
  } else if (L >= 2) {
    const plan = planOf(c, 3), white = '#ece4d4';
    if (plan === 1) {
      // a long range under a hipped roof, a clock turret over the middle
      const r = house(c, { z: -0.12, w: 0.88, d: 0.5, h: 0.8, floors: 3, wall: white, roof: pal.slate, roofType: 'hip', rh: 0.22, chimney: true, chimneyPos: 'ends', plinth: STONE, doorX: 0, doorW: 0.13, lit: 0.95, nFront: 5, form: { turret: null, crest: null, porch: 'portico', front: 'eaves' } });
      gb.cbox(0, r.top - 0.06, -0.12, 0.14, 0.18, 0.14, white, 0, 0.01);
      wallClock(c, 0, r.top + 0.04, -0.05, 0.04);
      gb.roof(0, r.top + 0.12, -0.12, 0.18, 0.18, 0.14, 0, pal.slate);
      redCross(-0.3, 0.33, 0.135, 0.9);
    } else if (plan === 2) {
      // pavilion wards either side of the entrance block, a corridor between
      house(c, { z: -0.04, w: 0.36, d: 0.4, h: 0.62, floors: 2, wall: white, roof: pal.slate, roofType: 'hip', rh: 0.2, chimney: true, plinth: STONE, doorX: 0, doorW: 0.12, lit: 0.95, nFront: 2, form: { turret: null, porch: 'pediment', bay: null, balcony: null, front: 'eaves' } });
      for (const s of [-1, 1]) {
        house(c, { x: s * 0.34, z: -0.12, w: 0.24, d: 0.66, h: 0.56, floors: 2, wall: white, roof: pal.slate, roofType: 'gable', alongZ: true, rh: 0.2, noDoor: true, plinth: STONE, nFront: 1, lit: 0.95, form: false });
        gb.cbox(s * 0.2, 0, -0.3, 0.1, 0.24, 0.1, white, 0, 0.008);
        tallBay(c, s * 0.34, 0.21, 0.28, 2, white, pal.slate, 0.95, false, 2, 0.12);
      }
      redCross(0, 0.38, 0.165, 0.9);
    } else {
      // three storeys with two wings and a canopied entrance
      house(c, {
        z: -0.12, w: 0.56, d: 0.62, h: 0.84, floors: 3, wall: white, roof: pal.slate, roofType: 'hip', rh: 0.26,
        chimney: true, plinth: STONE, doorX: 0, doorW: 0.13, lit: 0.95, nFront: 3, form: { porch: null, turret: null, balcony: null },
      });
      for (const sd of [-1, 1]) house(c, { x: sd * 0.37, z: -0.16, w: 0.2, d: 0.56, h: 0.58, floors: 2, wall: white, roof: pal.slate, roofType: 'hip', rh: 0.16, noDoor: true, plinth: STONE, nFront: 1, lit: 0.95 });
      gb.box(0, 0.24, 0.24, 0.26, 0.02, 0.12, pal.slate);
      for (const sd of [-1, 1]) gb.cyl(sd * 0.11, 0, 0.29, 0.012, 0.012, 0.24, 6, '#e9e2d4');
      redCross(0, 0.6, 0.198);
    }
    bench(c, -0.33, 0.42); bench(c, 0.33, 0.42); lamp(c, 0.2, 0.44, 0.3); lamp(c, -0.2, 0.44, 0.3);
  } else {
    house(c, {
      z: -0.1, w: 0.8, d: 0.6, h: 0.56, floors: 2, wall: '#ece4d4', roof: pal.tile, roofType: 'hip', rh: 0.26,
      chimney: true, plinth: STONE, doorX: 0, doorW: 0.12, lit: 0.9, form: { turret: null, balcony: null },
    });
    redCross(c.form.side * 0.24, 0.3, 0.21);
    bench(c, -0.3, 0.38); lamp(c, 0.36, 0.4, 0.3);
    bush(c, 0.22, 0.38); bush(c, -0.42, 0.22);
  }
};

// A schoolhouse (the form's own roofs and porch) with a bell on the ridge: a
// bell-cote, a cupola or a little spire. The Academy: a clock tower over the
// entrance with a spire, a lantern or battlements, or set at one end.
MODELS.school = (c, L) => {
  const { gb, rng, pal } = c;
  const F = c.form, wall = rng.pick(['#a8573a', '#b8704a', '#d8b878', '#cfae86']);
  const H = [0.36, 0.52, 0.74][Math.min(L, 2)], W = [0.72, 0.84, 0.9][Math.min(L, 2)];
  const r = house(c, {
    z: -0.15, w: W, d: L >= 2 ? 0.56 : 0.48, h: H, floors: L >= 2 ? 3 : L ? 2 : 1, wall: L >= 2 ? pal.stoneWall : wall,
    roof: pal.slate, roofType: L >= 2 ? 'hip' : 'gable', rh: 0.24, doorX: L >= 2 && F.side ? 0 : undefined, doorW: 0.11, lit: 0.6, plinth: STONE,
    form: { turret: null, crest: null, balcony: null },
  });
  if (L >= 2) {
    // Academy: a clock tower over the entrance (or at one end), crowned its own way
    const kind = ['spire', 'lantern', 'battlement', 'pyramid'][planOf(c, 4)], tx = F.b < 0.7 ? 0 : F.side * (W / 2 - 0.1);
    tower(c, kind, tx, 0.12 - (tx ? 0.08 : 0), 0.2, H + 0.32, pal.stoneWall, pal.slate, { clock: true });
    if (!tx) door(c, 0, 0.22, 0.08, 0.17, '#4e3424');
  } else {
    // the bell on the ridge: a bell-cote, a cupola, or a little spire
    const kind = planOf(c, 3), ry = r.top;
    if (kind === 1) {
      gb.push(0, 0, -0.15); crest(c, 'cupola', ry, 0, 0, '#e9e0cc', pal.slate); gb.pop();
    } else if (kind === 2) {
      gb.cbox(0, ry - 0.06, -0.15, 0.1, 0.12, 0.1, '#e9e0cc', 0, 0.01);
      gb.cone(0, ry + 0.06, -0.15, 0.075, 0.24, 8, pal.slate, Math.PI / 8);
    } else {
      gb.cbox(0, H + 0.09, -0.15, 0.13, 0.17, 0.13, '#e9e0cc', 0, 0.01);
      gb.box(0, H + 0.26, -0.15, 0.14, 0.012, 0.14, '#4e3a2a');
      gb.cyl(0, H + 0.18, -0.15, 0.026, 0.037, 0.045, 7, '#c08a3a');
      gb.roof(0, H + 0.27, -0.15, 0.17, 0.17, 0.13, 0, pal.slate);
    }
  }
  const fx = 0.4, fz = 0.36, fy = c.gy(fx, fz);
  gb.box(fx, fy, fz, 0.011, 0.44, 0.011, '#cfcfcf');
  gb.box(fx + 0.045, fy + 0.36, fz, 0.085, 0.055, 0.004, rng.pick(AWNING));
  if (L) {
    const px = -0.32, pz = 0.08, py = c.gy(px, pz);
    gb.box(px - 0.1, py, pz, 0.022, 0.15, 0.022, '#5e432c');
    gb.box(px + 0.1, py, pz, 0.022, 0.15, 0.022, '#5e432c');
    gb.box(px, py + 0.14, pz, 0.24, 0.016, 0.016, '#5e432c');
    gb.box(px - 0.04, py + 0.05, pz, 0.05, 0.008, 0.03, '#a8473a');
    gb.box(px + 0.04, py + 0.05, pz, 0.05, 0.008, 0.03, '#3f6a8f');
  }
  fence(c, -0.47, 0.2, 0.47, 0.47, FENCE, { x: 0, z: 0.47, w: 0.12 });
};

// A watch post: a stone tower, crowned its own way (a pyramid, battlements,
// a lookout gallery under a cone); the Guardhouse and the Constabulary set it
// at either end of the station.
MODELS.watch = (c, L) => {
  const { gb, rng, pal } = c;
  const F = c.form, kind = planOf(c, 3);
  const flag = rng.pick(['#a8473a', '#3f6a8f', '#c08a3a']);
  const tower = (x, z, H, s) => {
    footing(c, x, z, 0.3 * s, 0.3 * s);
    gb.cbox(x, 0, z, 0.3 * s, H, 0.3 * s, pal.stoneWall, 0, 0.02);
    win(c, x, H * 0.6, z + 0.15 * s, 0.055, 0.085, 'f', 0.9);
    win(c, x + 0.15 * s, H * 0.6, z, 0.055, 0.085, 'r', 0.9);
    c.addGlow(x, H * 0.6 + 0.045, z + 0.17 * s);
    if (kind === 1) {
      // battlements and a flag
      gb.cbox(x, H, z, 0.36 * s, 0.04, 0.36 * s, STONE_D, 0, 0.012);
      for (const sx of [-1, 0, 1]) for (const sz of [-1, 1]) { gb.box(x + sx * 0.13 * s, H + 0.04, z + sz * 0.16 * s, 0.06 * s, 0.06, 0.04 * s, pal.stoneWall); gb.box(x + sz * 0.16 * s, H + 0.04, z + sx * 0.13 * s, 0.04 * s, 0.06, 0.06 * s, pal.stoneWall); }
      gb.box(x, H + 0.04, z, 0.011, 0.34, 0.011, '#2f2c2a');
      gb.box(x + 0.055, H + 0.28, z, 0.11, 0.065, 0.004, flag);
    } else if (kind === 2) {
      // a timber lookout gallery round the top under a cone
      gb.box(x, H, z, 0.36 * s, 0.02, 0.36 * s, '#6e5034');
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) gb.box(x + sx * 0.165 * s, H + 0.02, z + sz * 0.165 * s, 0.02, 0.14, 0.02, '#5e432c');
      gb.box(x, H + 0.08, z + 0.17 * s, 0.34 * s, 0.01, 0.01, '#5e432c'); gb.box(x + 0.17 * s, H + 0.08, z, 0.01, 0.01, 0.34 * s, '#5e432c');
      gb.cbox(x, H + 0.02, z, 0.24 * s, 0.14, 0.24 * s, pal.stoneWall, 0, 0.01);
      gb.cone(x, H + 0.16, z, 0.25 * s, 0.26, 8, pal.roof, Math.PI / 8);
      gb.box(x, H + 0.42, z, 0.011, 0.14, 0.011, '#2f2c2a');
      gb.box(x + 0.05, H + 0.5, z, 0.09, 0.05, 0.004, flag);
    } else {
      gb.cbox(x, H, z, 0.36 * s, 0.045, 0.36 * s, STONE_D, 0, 0.012);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) gb.cbox(x + sx * 0.14 * s, H + 0.045, z + sz * 0.14 * s, 0.075 * s, 0.075, 0.075 * s, pal.stoneWall, 0, 0.01);
      gb.roof(x, H + 0.12, z, 0.34 * s, 0.34 * s, 0.25, 0, pal.roof);
      gb.box(x, H + 0.35, z, 0.011, 0.22, 0.011, '#2f2c2a');
      gb.box(x + 0.055, H + 0.49, z, 0.11, 0.065, 0.004, flag);
    }
  };
  const side = F.side;
  if (L === 0 && F.b > 0.55) {
    // a round tower with a lean-to hut at its foot
    const H = 0.72 + F.a * 0.2, y = H;
    footing(c, 0, -0.08, 0.32, 0.32);
    gb.cyl(0, 0, -0.08, 0.15, 0.17, H, 10, pal.stoneWall);
    gb.glow(WARM[0], WARM[1], WARM[2], 1.3);
    for (const a of [-0.6, 0.6, Math.PI / 2, -Math.PI / 2, Math.PI]) gb.box(Math.sin(a) * 0.152, H * 0.6, -0.08 + Math.cos(a) * 0.152, 0.04, 0.08, 0.012, GLASS, a);
    gb.noGlow();
    c.addGlow(0, H * 0.6 + 0.04, 0.09);
    gb.cyl(0, y, -0.08, 0.18, 0.18, 0.035, 10, STONE_D);
    if (kind === 1) for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; gb.box(Math.sin(a) * 0.16, y + 0.035, -0.08 + Math.cos(a) * 0.16, 0.06, 0.05, 0.04, pal.stoneWall, a); }
    else gb.cone(0, y + 0.035, -0.08, 0.19, 0.3, 10, pal.roof);
    gb.box(0, y + (kind === 1 ? 0.04 : 0.32), -0.08, 0.011, 0.2, 0.011, '#2f2c2a');
    gb.box(0.055, y + (kind === 1 ? 0.18 : 0.46), -0.08, 0.11, 0.065, 0.004, flag);
    door(c, 0, 0.09, 0.075, 0.14, '#2f241b');
    const hx = side * 0.28;
    gb.cbox(hx, 0, -0.08, 0.2, 0.2, 0.24, pal.wood, 0, 0.01);
    gb.wedge(hx, 0.2, -0.08, 0.28, 0.24, 0.08, pal.roof, side > 0 ? Math.PI / 2 : -Math.PI / 2);
    barrel(c, -side * 0.33, 0.33); crate(c, side * 0.3, 0.3);
  } else if (L === 0) {
    tower(0, -0.05, 0.74 + F.a * 0.16, 1.05);
    door(c, 0, 0.108, 0.075, 0.14, '#2f241b');
    barrel(c, 0.33, 0.33); crate(c, -0.33, 0.33);
  } else if (L >= 2) {
    // Constabulary: two-storey brick station with a tall bell tower
    house(c, {
      x: -side * 0.12, z: -0.1, w: 0.68, d: 0.56, h: 0.58, floors: 2, wall: pal.brick, roof: pal.slate, roofType: 'hip', rh: 0.22,
      chimney: true, lit: 0.9, plinth: STONE, doorX: 0, form: { turret: null },
    });
    tower(side * 0.33, -0.3, 1.2, 0.9);
    sign(c, -side * 0.12, 0.42, 0.185, 0.3, 0.06, '#2f3e5a');
    gb.glow(1.0, 1.4, 2.2, 3.0); gb.box(-side * 0.12, 0.6, 0.19, 0.04, 0.05, 0.03, '#b8d0ff'); gb.noGlow();
    lamp(c, side * 0.36, 0.4, 0.3); lamp(c, -side * 0.42, 0.4, 0.3);
  } else {
    house(c, {
      x: -side * 0.1, z: -0.1, w: 0.64, d: 0.5, h: 0.38, wall: pal.stoneWall, roof: pal.slate, roofType: 'hip', rh: 0.2,
      chimney: true, lit: 0.8,
    });
    tower(side * 0.32, -0.3, 1.0, 0.95);
    lamp(c, side * 0.36, 0.38, 0.3);
  }
};

// A chapel (and the Church, in stone), in one of its plans: its tower at the
// street end with the door at its foot; the tower beside the front, the door
// in the gable under a porch; no tower, a bell-cote on the gable over a
// round window; or the tower over the middle of the nave. The tower is
// crowned its own way (a spire, a pyramid, a saddleback, an open belfry;
// battlements or a lantern on the Church); some have an apse at the east end.
MODELS.chapel = (c, L) => {
  const { gb, rng, pal } = c;
  if (L >= 2) { minster(c); return; }
  const F = c.form, plan = planOf(c, 4), side = F.side;
  const wall = L ? pal.stoneWall : '#ece4d4', roof = L ? pal.slate : pal.roof;
  const w = L ? 0.52 : 0.42, d = L ? 0.8 : 0.64, h = L ? 0.52 : 0.4;
  // (a chapel with an apse stands forward to make room for it)
  const apse = F.b > 0.5 && !L, z0 = apse ? 0 : plan === 0 ? -0.12 : -0.08, front = z0 + d / 2;
  const x0 = plan === 1 ? -side * 0.1 : 0;
  footing(c, x0, z0, w, d);
  gb.cbox(x0, 0, z0, w, h, d, wall, 0, 0.022);
  gb.gable(x0, h, z0, w, d, L ? 0.34 : 0.28, wall, roof, 0.05, true, 0.035);
  const stained = [[1.4, 0.5, 0.5], [0.5, 0.7, 1.6], [1.4, 1.1, 0.4]];
  for (let i = 0; i < 3; i++) {
    const zz = z0 - d / 2 + (i + 0.5) * (d / 3);
    for (const sd of [1, -1]) {
      const s = stained[(i + (sd > 0 ? 0 : 1)) % 3];
      gb.glow(s[0], s[1], s[2], 1.05 + rng.float(0, 0.2));
      gb.box(x0 + sd * (w / 2 + 0.007), h * 0.3, zz, 0.016, h * 0.45, 0.065, '#3f4a6e');
      gb.noGlow();
      if (L) gb.cbox(x0 + sd * (w / 2 + 0.022), 0, zz + d / 6, 0.045, h * 0.7, 0.055, STONE_D, 0, 0.01);
    }
  }
  if (apse) {
    // an apse at the east end, half round under a cone
    gb.cyl(x0, 0, z0 - d / 2, w * 0.36, w * 0.36, h * 0.85, 10, wall);
    gb.cone(x0, h * 0.85, z0 - d / 2, w * 0.39, 0.16, 10, roof);
  }
  const tw = L ? 0.22 : 0.17, th = L ? 1.05 : 0.68;
  const kinds = L ? ['spire', 'battlement', 'pyramid', 'lantern'] : ['spire', 'pyramid', 'saddle', 'belfry'];
  const kind = kinds[Math.floor(F.a * 4)];
  if (plan === 0) {
    // the tower at the street end, its door the way in
    const tz = z0 + d / 2 - tw / 2 + 0.03;
    tower(c, kind, x0, tz, tw, th, wall, roof, { cross: kind === 'spire', clock: L > 0, lit: 0.8 });
    door(c, x0, tz + tw / 2, 0.075, 0.16, '#4e3424');
  } else {
    // the door in the gable end, a porch or a round window over it
    door(c, x0, front, 0.08, 0.17, '#4e3424');
    gb.glow(1.5, 0.9, 1.4, 1.05); gb.cyl(x0, h + 0.08, front + 0.004, 0.06, 0.06, 0.012, 12, '#5a4a8a', 0, Math.PI / 2); gb.noGlow();
    if (plan !== 2) gb.gable(x0, 0.2, front + 0.06, 0.16, 0.12, 0.08, wall, roof, 0.02, true, 0.02);
    if (plan === 1) tower(c, kind, x0 + side * (w / 2 + tw / 2 - 0.01), front - tw / 2 - 0.02, tw, th, wall, roof, { cross: kind === 'spire', clock: L > 0, lit: 0.8 });
    else if (plan === 2) {
      bellcote(c, x0, h + (L ? 0.34 : 0.28) * 0.9, front - 0.01, wall, roof);
      gb.wedge(x0, 0.2, front + 0.05, 0.2, 0.1, 0.04, roof, 0);
      for (const s of [-1, 1]) gb.box(x0 + s * 0.08, 0, front + 0.09, 0.014, 0.2, 0.014, wall);
    } else {
      // the tower over the middle of the nave
      const tt = h + 0.3;
      gb.cbox(x0, h - 0.05, z0, tw, tt - h + 0.05 + (L ? 0.1 : 0.06), tw, wall, 0, 0.012);
      gb.box(x0, tt + (L ? 0.04 : 0) - 0.12, z0 + tw / 2 + 0.002, tw * 0.42, 0.1, 0.008, '#2a2826');
      gb.roof(x0, tt + (L ? 0.1 : 0.06), z0, tw + 0.04, tw + 0.04, L ? 0.42 : 0.3, 0, roof);
    }
  }
  for (let i = 0; i < (L ? 4 : 3); i++) {
    const gx = 0.36 * (i % 2 ? 1 : -1), gz = -0.4 + Math.floor(i / 2) * 0.17;
    if (Math.abs(gx - x0) < w / 2 + 0.06) continue;
    gb.cbox(gx, c.gy(gx, gz) - 0.01, gz, 0.055, 0.075, 0.017, '#a39e94', 0, 0.006);
  }
  bush(c, -0.38, 0.38); bush(c, 0.38, 0.38);
  if (L) lamp(c, 0.27, 0.43, 0.3);
};

// Minster: a big stone church with aisles, in one of its plans: twin west
// towers with spires and a rose window; a single west tower with a tall
// spire; or a great tower over the crossing, battlemented, with a rose
// window in the west front.
function minster(c) {
  const { gb, pal } = c;
  const wall = pal.stoneWall, roof = pal.slate, plan = planOf(c, 3);
  const w = 0.5, d = 0.86, h = 0.62, z0 = -0.08;
  footing(c, 0, z0, w + 0.1, d);
  gb.cbox(0, 0, z0, w, h, d, wall, 0, 0.02);
  gb.gable(0, h, z0, w, d, 0.36, wall, roof, 0.05, true, 0.035);
  for (const sd of [-1, 1]) {
    gb.cbox(sd * (w / 2 + 0.05), 0, z0 - 0.08, 0.1, h * 0.55, d - 0.24, wall, 0, 0.012);
    gb.wedge(sd * (w / 2 + 0.05), h * 0.55, z0 - 0.08, 0.14, d - 0.2, 0.07, roof, sd > 0 ? -Math.PI / 2 : Math.PI / 2);
    for (let i = 0; i < 4; i++) {
      gb.glow([1.4, 0.5, 1.4][i % 3], [0.5, 0.7, 1.1][i % 3], [0.5, 1.6, 0.4][i % 3], 1.08);
      gb.box(sd * (w / 2 + 0.006), h * 0.6, z0 - d / 2 + 0.15 + i * 0.18, 0.016, h * 0.3, 0.06, '#3f4a6e');
      gb.noGlow();
    }
  }
  const tz = z0 + d / 2 - 0.06;
  const rose = (y) => { gb.glow(1.6, 0.8, 1.6, 1.04); gb.cyl(0, y, tz + 0.06, 0.07, 0.07, 0.012, 14, '#5a4a8a', 0, Math.PI / 2); gb.noGlow(); };
  if (plan === 1) {
    // a single west tower with a tall spire, the door at its foot
    tower(c, 'spire', 0, tz, 0.22, 1.05, wall, roof, { cross: true, clock: true, lit: 0.8 });
    door(c, 0, tz + 0.11, 0.1, 0.2, '#4e3424');
  } else if (plan === 2) {
    // a great tower over the crossing, battlemented, and transepts
    for (const sd of [-1, 1]) {
      gb.cbox(sd * 0.36, 0, z0 - 0.12, 0.22, h * 0.9, 0.26, wall, 0, 0.012);
      gb.gable(sd * 0.36, h * 0.9, z0 - 0.12, 0.22, 0.26, 0.2, wall, roof, 0.03, false, 0.03);
      gb.glow(1.4, 0.7, 1.4, 1.06); gb.box(sd * 0.47, h * 0.35, z0 - 0.12, 0.012, h * 0.4, 0.08, '#3f4a6e'); gb.noGlow();
    }
    const cz = z0 - 0.12;
    gb.cbox(0, h - 0.05, cz, 0.26, 0.5, 0.26, wall, 0, 0.012);
    for (const s of [-1, 1]) gb.box(s * 0.132, h + 0.2, cz, 0.008, 0.14, 0.1, '#2a2826');
    gb.box(0, h + 0.2, cz + 0.132, 0.1, 0.14, 0.008, '#2a2826');
    gb.box(0, h + 0.43, cz, 0.3, 0.03, 0.3, shade(wall, 1.1));
    for (let i = 0; i < 3; i++) for (const s of [-1, 1]) { gb.box(-0.11 + i * 0.11, h + 0.46, cz + s * 0.14, 0.05, 0.05, 0.03, wall); gb.box(s * 0.14, h + 0.46, cz - 0.11 + i * 0.11, 0.03, 0.05, 0.05, wall); }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) gb.cone(sx * 0.14, h + 0.46, cz + sz * 0.14, 0.025, 0.14, 4, roof, Math.PI / 4);
    rose(0.5);
    door(c, 0, tz + 0.06, 0.1, 0.2, '#4e3424');
  } else {
    for (const sd of [-1, 1]) {
      gb.cbox(sd * 0.17, 0, tz, 0.16, 1.15, 0.16, wall, 0, 0.014);
      gb.roof(sd * 0.17, 1.15, tz, 0.19, 0.19, 0.4, 0, roof);
      gb.box(sd * 0.17, 0.75, tz + 0.081, 0.05, 0.12, 0.012, '#2a2826');
    }
    rose(0.46);
    door(c, 0, tz + 0.06, 0.1, 0.2, '#4e3424');
  }
  for (let i = 0; i < 4; i++) { const gx = 0.4 * (i % 2 ? 1 : -1), gz = -0.42 + Math.floor(i / 2) * 0.2; gb.cbox(gx, c.gy(gx, gz) - 0.01, gz, 0.055, 0.075, 0.017, '#a39e94', 0, 0.006); }
  lamp(c, 0.36, 0.44, 0.3); lamp(c, -0.36, 0.44, 0.3);
}

// (the town hall, the Capitol and the Parliament: see civic.js)





// ----------------------------------------------------- play and games
// Play areas, games lawns and playing fields: the parks people use rather
// than stroll in. Each lays itself out round the middle of its plot.

const PAINT = ['#c8423a', '#3f6a8f', '#4f7a45', '#d8a630', '#7a5a8a'];
const SAND = '#e0cf9a', LINE = '#f2efe6';

// An A-frame swing with n seats hanging from its beam, the beam along x.
export function swings(c, x, z, ry, n = 2, color = '#6e5034') {
  const { gb } = c;
  const w = 0.07 + n * 0.07, h = 0.2;
  gb.push(x, c.gy(x, z), z, ry);
  for (const s of [-1, 1]) for (const k of [-1, 1]) gb.boxC(s * w / 2, h / 2, k * 0.035, 0.012, h + 0.01, 0.012, color, k * 0.32);
  gb.box(0, h - 0.004, 0, w + 0.02, 0.014, 0.014, color);
  for (let i = 0; i < n; i++) {
    const sx = -w / 2 + 0.07 * (i + 1);
    for (const s of [-1, 1]) gb.box(sx + s * 0.016, 0.055, 0, 0.003, h - 0.06, 0.003, '#8a8a84');
    gb.box(sx, 0.05, 0, 0.044, 0.008, 0.022, PAINT[i % PAINT.length]);
  }
  gb.pop();
}
// A slide: a ladder up to a little platform and the chute down, facing +z.
export function slide(c, x, z, ry, color = '#c8423a') {
  const { gb } = c;
  gb.push(x, c.gy(x, z), z, ry);
  for (const s of [-1, 1]) gb.box(s * 0.022, 0, -0.1, 0.01, 0.17, 0.01, '#5a5a5e');
  for (let y = 0.03; y < 0.16; y += 0.035) gb.box(0, y, -0.1, 0.044, 0.006, 0.008, '#5a5a5e');
  gb.box(0, 0.16, -0.08, 0.06, 0.012, 0.05, '#5a5a5e');
  gb.boxC(0, 0.09, 0.03, 0.05, 0.01, 0.22, color, 0.72);
  for (const s of [-1, 1]) gb.boxC(s * 0.026, 0.1, 0.03, 0.006, 0.02, 0.22, shade(color, 0.8), 0.72);
  gb.pop();
}
export function seesaw(c, x, z, ry, color = '#3f6a8f') {
  const { gb } = c;
  gb.push(x, c.gy(x, z), z, ry);
  gb.box(0, 0, 0, 0.03, 0.04, 0.03, '#5e432c');
  gb.boxC(0, 0.045, 0, 0.24, 0.01, 0.03, color, 0, 0, 0.16);
  for (const s of [-1, 1]) gb.box(s * 0.1, 0.045 + s * -0.016 + 0.008, 0, 0.006, 0.03, 0.026, '#3a3a3e');
  gb.pop();
}
export function roundabout(c, x, z, color = '#d8a630') {
  const { gb } = c;
  const y = c.gy(x, z);
  gb.cyl(x, y, z, 0.012, 0.012, 0.03, 6, '#3a3a3e');
  gb.cyl(x, y + 0.03, z, 0.075, 0.075, 0.01, 10, color);
  for (let k = 0; k < 4; k++) { const a = (k / 4) * Math.PI * 2; gb.box(x + Math.cos(a) * 0.055, y + 0.04, z + Math.sin(a) * 0.055, 0.006, 0.04, 0.006, '#3a3a3e'); }
  gb.cyl(x, y + 0.075, z, 0.058, 0.058, 0.006, 10, '#3a3a3e');
}
export function sandpit(c, x, z, w, d) {
  const { gb } = c;
  const y = c.gy(x, z);
  gb.cbox(x, y - 0.01, z, w, 0.035, d, '#7a5a3c', 0, 0.006);
  gb.box(x, y, z, w - 0.03, 0.03, d - 0.03, SAND);
  gb.box(x - w * 0.2, y + 0.03, z + d * 0.1, 0.03, 0.02, 0.03, '#c8423a');
  gb.cone(x + w * 0.2, y + 0.03, z - d * 0.15, 0.03, 0.03, 6, shade(SAND, 0.95));
}
// A wooden climbing fort: a platform on posts with a pyramid roof, a
// scramble net up one side and a slide off the other, facing +z.
export function fort(c, x, z, roof) {
  const { gb } = c;
  const y = c.gy(x, z), h = 0.16;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) gb.box(x + sx * 0.07, y, z + sz * 0.07, 0.016, h + 0.14, 0.016, '#6e5034');
  gb.box(x, y + h, z, 0.17, 0.016, 0.17, '#86663f');
  for (const sx of [-1, 1]) gb.box(x + sx * 0.08, y + h + 0.016, z, 0.008, 0.04, 0.16, '#86663f');
  gb.box(x, y + h + 0.016, z - 0.08, 0.16, 0.04, 0.008, '#86663f');
  gb.roof(x, y + h + 0.14, z, 0.21, 0.21, 0.09, 0, roof);
  for (let i = 0; i < 4; i++) gb.boxC(x - 0.06 + i * 0.04, y + h / 2, z + 0.12, 0.004, h + 0.02, 0.004, '#c8b088', 0.5);
  for (let k = 0; k < 3; k++) gb.boxC(x, y + 0.03 + k * 0.05, z + 0.105 + k * 0.01, 0.14, 0.004, 0.004, '#c8b088');
  slide(c, x + 0.17, z, Math.PI / 2, '#d8a630');
}
// A shelter: posts carrying a hipped roof over a bench.
export function shelter(c, x, z, w, d, roof, ry = 0) {
  const { gb } = c;
  gb.push(x, c.gy(x, z), z, ry);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) gb.box(sx * (w / 2 - 0.015), 0, sz * (d / 2 - 0.015), 0.018, 0.2, 0.018, '#5e432c');
  gb.box(0, 0, -d / 2 + 0.03, w - 0.04, 0.12, 0.012, '#6e5034');
  gb.box(0, 0.035, -d / 2 + 0.06, w - 0.06, 0.01, 0.05, '#7a5636');
  gb.hip(0, 0.2, 0, w + 0.02, d + 0.02, 0.08, roof, 0.03);
  gb.pop();
}
// Mown stripes over a lawn (w across x, d across z), at the ground.
export function stripes(c, x, z, w, d, n, a = '#7fb04f', b = '#8fbd5a', alongZ = false) {
  for (let i = 0; i < n; i++) {
    const u = -0.5 + (i + 0.5) / n;
    const sx = alongZ ? x + u * w : x, sz = alongZ ? z : z + u * d;
    c.gb.box(sx, c.gy(sx, sz) - 0.006, sz, alongZ ? w / n : w, 0.01, alongZ ? d : d / n, i % 2 ? b : a);
  }
}
// A small timber pavilion with a veranda, facing +z.
export function pavilion(c, x, z, w, d, wall, roof, clock = false) {
  const { gb } = c;
  house(c, { x, z, w, d, h: 0.22, floors: 1, wall, roof, roofType: 'gable', rh: 0.14, nFront: 2, doorX: 0, chimney: false, fancy: false, lit: 0.7 });
  gb.box(x, -0.005, z + d / 2 + 0.05, w, 0.02, 0.1, '#86663f');
  for (const s of [-1, 1]) gb.box(x + s * (w / 2 - 0.015), 0, z + d / 2 + 0.09, 0.014, 0.18, 0.014, '#ece6da');
  gb.wedge(x, 0.18, z + d / 2 + 0.05, w + 0.02, 0.12, 0.04, roof, 0);
  if (clock) {
    // a clock turret on the ridge
    gb.cbox(x, 0.3, z, 0.07, 0.07, 0.07, '#ece6da', 0, 0.004);
    wallClock(c, x, 0.335, z + 0.036, 0.022);
    gb.roof(x, 0.37, z, 0.09, 0.09, 0.05, 0, roof);
  }
}



// Goalposts on the goal line at (x, z), the goal opening along z and the
// net (if any) behind, the way ry turns +z.
export function goal(c, x, z, ry, net) {
  const { gb } = c;
  gb.push(x, c.gy(x, z), z, ry);
  for (const s of [-1, 1]) gb.box(s * 0.09, 0, 0, 0.012, 0.1, 0.012, LINE);
  gb.box(0, 0.094, 0, 0.19, 0.012, 0.012, LINE);
  if (net) {
    gb.boxC(0, 0.05, -0.05, 0.18, 0.004, 0.11, '#c8c8c0', -0.75);
    for (const s of [-1, 1]) gb.boxC(s * 0.09, 0.045, -0.035, 0.003, 0.09, 0.07, '#c8c8c0');
  }
  gb.pop();
}


// A coach stop by the road, in one of its own kinds: a timber shelter under
// a lean-to roof; a cast-iron shelter with a glazed canopy and a timetable;
// a gabled shelter open to the road, benches either side; a little round
// kiosk under a pointed roof beside a canopy; or a brick waiting room with a
// canopy along its front. A sign post and a lamp; behind, a tree, a horse
// trough or a drinking fountain.
MODELS.coachstop = (c) => {
  const { gb, pal } = c;
  const F = c.form, kind = planOf(c, 5), z = 0.22;
  const roof = pal.thatched ? pal.thatch : pal.roof;
  // laid out where it's drawn (passengers wait in front of it, z > 0.2)
  c.boxAware = true;
  if (kind === 1) {
    // cast iron and glass
    footing(c, 0, z - 0.03, 0.5, 0.2);
    gb.cbox(0, -0.01, z - 0.04, 0.5, 0.025, 0.2, '#b8b0a2', 0, 0.004);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) gb.cyl(sx * 0.2, 0.015, z - 0.04 + sz * 0.07, 0.009, 0.011, 0.25, 6, '#2f4a3a');
    gb.box(0, 0.26, z - 0.04, 0.52, 0.016, 0.22, '#2f4a3a');
    gb.glow(1.4, 1.3, 1.0, 1.2); gb.hip(0, 0.276, z - 0.04, 0.5, 0.2, 0.05, '#a9c4c8', 0.01); gb.noGlow();
    gb.box(0, 0.03, z - 0.13, 0.42, 0.18, 0.008, '#a9c4c8');
    gb.box(-0.12, 0.12, z - 0.12, 0.1, 0.08, 0.01, '#e8e0cc');
  } else if (kind === 2) {
    // a gabled shelter, open to the road, a bench along each side
    footing(c, 0, z - 0.03, 0.46, 0.22);
    gb.cbox(0, 0, z - 0.12, 0.42, 0.24, 0.025, pal.wood, 0, 0.006);
    for (const sx of [-1, 1]) {
      gb.box(sx * 0.2, 0, z + 0.06, 0.024, 0.24, 0.024, '#3f342c');
      gb.box(sx * 0.2, 0, z - 0.1, 0.024, 0.24, 0.024, '#3f342c');
      gb.box(sx * 0.16, 0.06, z - 0.02, 0.05, 0.012, 0.16, '#7a5636');
    }
    gb.gable(0, 0.24, z - 0.02, 0.44, 0.26, 0.14, pal.wood, roof, 0.04, false, 0.03);
  } else if (kind === 3) {
    // a round kiosk under a pointed roof, a canopy beside it
    const kx = -0.2, kz = z - 0.14;
    gb.cyl(kx, 0, kz, 0.08, 0.085, 0.24, 8, '#2f4a3a');
    gb.glow(WARM[0], WARM[1], WARM[2], 1.2); gb.box(kx, 0.1, kz + 0.075, 0.06, 0.06, 0.012, GLASS); gb.noGlow();
    gb.cyl(kx, 0.24, kz, 0.1, 0.1, 0.02, 8, '#d8ccb4');
    gb.cone(kx, 0.26, kz, 0.1, 0.14, 8, roof);
    gb.box(kx, 0.4, kz, 0.006, 0.05, 0.006, IRON_D);
    for (const sx of [0.02, 0.22]) gb.box(sx, 0, z - 0.1, 0.02, 0.22, 0.02, '#3f342c');
    gb.box(0.12, 0.22, z - 0.04, 0.26, 0.016, 0.2, roof);
    bench(c, 0.12, z - 0.08, 0);
  } else if (kind === 4) {
    // a brick waiting room, a canopy along its front
    const rz = z - 0.15;
    footing(c, 0, rz, 0.46, 0.16);
    gb.cbox(0, 0, rz, 0.44, 0.24, 0.14, pal.brick, 0, 0.008);
    gb.hip(0, 0.24, rz, 0.46, 0.16, 0.08, pal.slate, 0.02);
    plainDoor(c, -0.1, rz + 0.07, 0.07, 0.16, pal.door);
    win(c, 0.1, 0.08, rz + 0.07, 0.08, 0.08, 'f', 0.8);
    for (const sx of [-1, 1]) win(c, sx * 0.22, 0.08, rz, 0.05, 0.08, sx > 0 ? 'r' : 'l', 0.8);
    gb.box(0, 0.2, rz + 0.13, 0.46, 0.012, 0.1, '#2f2f33');
    for (const sx of [-1, 1]) gb.boxC(sx * 0.18, 0.17, rz + 0.1, 0.006, 0.07, 0.006, IRON_D, 0.6);
  } else {
    footing(c, 0, z - 0.03, 0.5, 0.2);
    gb.cbox(0, 0, z - 0.11, 0.46, 0.24, 0.025, pal.wood, 0, 0.006);
    for (const sx of [-1, 1]) {
      gb.cbox(sx * 0.22, 0, z - 0.04, 0.025, 0.24, 0.16, pal.wood, 0, 0.006);
      gb.box(sx * 0.22, 0, z + 0.08, 0.024, 0.26, 0.024, '#3f342c');
    }
    gb.wedge(0, 0.24, z - 0.02, 0.54, 0.27, 0.055, roof);
  }
  if (kind !== 2 && kind !== 3 && kind !== 4) bench(c, 0, z - 0.05, 0);
  // the places to sit while waiting for the coach (see agents.js): on its
  // bench, facing the road, or along the sides of the gabled shelter facing in
  const sit = (x, sz, h, top = 0.05) => ({ x, y: c.gy(x, sz) + top, z: sz, h });
  if (kind === 2) c.seats = [-1, 1].flatMap(sx => [-0.04, 0.04].map(dz => sit(sx * 0.15, z - 0.02 + dz, -sx * Math.PI / 2, 0.072)));
  else if (kind === 3) c.seats = [-0.045, 0.045].map(dx => sit(0.12 + dx, z - 0.074, 0));
  else if (kind !== 4) c.seats = [-0.045, 0.045].map(dx => sit(dx, z - 0.044, 0));
  // the coach company's sign on its post, and a lamp
  const px = 0.34, pz = z + 0.15, py = c.gy(px, pz);
  gb.box(px, py, pz, 0.016, 0.32, 0.016, '#2f2c2a');
  gb.cyl(px, py + 0.32, pz, 0.045, 0.045, 0.013, 10, '#c9a040', 0, Math.PI / 2);
  gb.cyl(px, py + 0.32, pz + 0.013, 0.028, 0.028, 0.004, 10, '#2f4858', 0, Math.PI / 2);
  lamp(c, -0.34, z + 0.15, 0.3);
  // behind: a tree and a bed, a horse trough, or a drinking fountain
  const back = Math.floor(F.b * 3);
  if (back === 1) {
    const tx = -0.2, tz = -0.3, ty = c.gy(tx, tz);
    gb.cbox(tx, ty - 0.01, tz, 0.3, 0.07, 0.1, STONE, 0, 0.008);
    gb.box(tx, ty + 0.055, tz, 0.26, 0.008, 0.07, '#3f7f9f');
    smallTree(c, 0.3, -0.32, 1.0);
  } else if (back === 2) {
    const fx = 0, fz = -0.28, fy = c.gy(fx, fz);
    gb.cbox(fx, fy - 0.01, fz, 0.12, 0.05, 0.12, STONE, Math.PI / 4, 0.006);
    gb.cyl(fx, fy + 0.04, fz, 0.03, 0.04, 0.2, 6, '#b8b0a2');
    gb.cone(fx, fy + 0.24, fz, 0.05, 0.08, 6, '#b8b0a2');
    flowers(c, -0.3, -0.32, 6, 0.08); bush(c, 0.32, -0.34);
  } else {
    smallTree(c, -0.32, -0.32, 1.15);
    bush(c, 0.32, -0.34);
    flowers(c, 0.05, -0.32, 6, 0.08);
  }
};

MODELS.station = (c, L) => {
  const { gb, pal } = c;
  const k = c.railK ?? 2;
  const rk = (4 - k) % 4;
  gb.push(0, 0, 0, (k * Math.PI) / 2);
  footing(c, 0, 0.37, 0.96, 0.22);
  gb.cbox(0, 0, 0.37, 0.96, 0.075, 0.22, '#b8b0a2', 0, 0.01);
  gb.box(0, 0.075, 0.468, 0.96, 0.006, 0.03, '#d9c050');
  for (const px of [-0.32, 0, 0.32]) gb.box(px, 0.075, 0.33, 0.024, 0.26, 0.024, '#3f4a56');
  // the platform canopy, its own way: a lean-to, the same with a fretted
  // valance along its edge, or a gabled roof over the platform
  const canopy = planOf(c, 3), cr = L ? pal.slate : '#6e5034';
  if (canopy === 2) gb.gable(0, 0.33, 0.355, 0.9, 0.22, 0.07, '#d8ccb4', cr, 0.025, false, 0.025);
  else gb.wedge(0, 0.33, 0.37, 0.94, 0.28, 0.055, cr, Math.PI);
  if (canopy === 1) for (let i = 0; i < 16; i++) gb.box(-0.45 + i * 0.06, 0.3, 0.51, 0.04, 0.035, 0.006, '#e3dccd');
  bench(c, -0.16, 0.32, Math.PI); bench(c, 0.18, 0.32, Math.PI);
  lamp(c, -0.45, 0.42, 0.32); lamp(c, 0.45, 0.42, 0.32);
  house(c, {
    x: 0, z: -0.15, w: L ? 0.76 : 0.62, d: 0.38, h: L ? 0.48 : 0.33, floors: L ? 2 : 1, wall: L ? pal.brick : pal.wall,
    roof: pal.slate, roofType: 'hip', rh: 0.18, chimney: true, ry: (rk * Math.PI) / 2, lit: 0.9, plinth: STONE,
  });
  gb.box(0, (L ? 0.48 : 0.33) - 0.02, 0.045, 0.32, 0.065, 0.012, '#2f4858');
  if (L) {
    gb.cyl(0, 0.39, 0.055, 0.055, 0.055, 0.011, 12, '#efe8da', 0, Math.PI / 2);
    gb.box(0, 0.39, 0.065, 0.004, 0.038, 0.004, '#2a2826');
  }
  gb.pop();
};

// A gondola station, after La Paz's Mi Teleférico: a concrete deck on
// piers that the cabins glide across, under a broad modern roof, so a cable
// can come in from any side. transit.js draws the cable (1.05 above the
// floor), the bullwheel it turns round at the end of a line and the cabins,
// whose floors pass level with the deck (0.78 up). Over the wheel stands the
// drive, a white rounded hood with a band of the line's colour (c.tint, from
// b.tint: the colour of the line that calls there), which also runs round
// the deck's edge. Under the deck, a glazed booking office; the terminal's a
// glazed hall, its roof wider. At night it is lit all night: the office, the
// name board, strips of light under the roof over the cabins and the edge of
// the roof glowing in the line's colour. Stairs climb to the deck from the street, to
// the villagers' own scale (a step a fifth of a villager high), round the
// outside of the deck in flights with a landing at each corner. Where the
// cable must run higher to clear the roofs round about, the station stands
// that much taller (c.lift, from b.lift), its piers braced in steel, and
// from half a tile up a glass lift rises to the deck in place of the
// stairs. The way up goes on whichever side keeps it out from under the
// cabins (c.cables: the headings the cables leave on). c.stair: the way a
// villager walks it, from the street to the deck; c.deck: the deck's middle
// and height (see agents.js and transit.js).
const CONCRETE = '#c6c1b7', CONCRETE_D = '#a49e93', HOOD = '#f3f3f0', ROOF_W = '#eeede8', DECK_STEEL = '#5d6266', NO_LINE = '#7d8a92';
// A tall station's lift shaft (see gondolaWayUp): long, along the strip
// beside the deck, and as wide across as that strip has room for (narrower
// at an interchange); its car holds four in a row (agents.js)
export const LIFT = { long: 0.38, across: { gondola: 0.135, gondolahub: 0.115 } };
// (a line's colour as a light at night, k times as bright; none for no line)
const lineGlow = (tint, k = 1.4) => tint === NO_LINE ? [0, 0, 0, 0] : [...new THREE.Color(tint).toArray().map(v => v * k), 3.1];
MODELS.gondola = (c, L) => {
  const { gb } = c;
  const lift = c.lift || 0, tint = c.tint || NO_LINE;
  const DECK = 0.78 + lift, EAVE = 1.36 + lift, D = 0.33;
  footing(c, 0, 0, 0.92, 0.92);
  gb.box(0, 0, 0, 0.92, 0.02, 0.92, '#cdc8be');
  // under the deck: a booking office, or the terminal's hall, glazed between
  // concrete, with a band of the line's colour over its door
  if (L) {
    gb.box(-0.05, 0.02, -0.04, 0.5, 0.025, 0.48, CONCRETE_D);
    for (const [x, z] of [[-0.29, -0.27], [0.19, -0.27], [-0.29, 0.19], [0.19, 0.19]]) gb.box(x, 0.02, z, 0.04, 0.44, 0.04, CONCRETE);
    gb.glow(WARM[0], WARM[1], WARM[2], 3.05);
    gb.box(-0.05, 0.045, -0.04, 0.46, 0.39, 0.44, GLASS);
    gb.noGlow();
    gb.box(-0.05, 0.44, -0.04, 0.54, 0.035, 0.52, CONCRETE);
    gb.box(-0.05, 0.36, 0.19, 0.3, 0.05, 0.012, tint);
    door(c, -0.05, 0.19, 0.1, 0.22, '#3a4248');
  } else {
    gb.box(-0.09, 0.02, -0.07, 0.3, 0.02, 0.28, CONCRETE_D);
    gb.glow(WARM[0], WARM[1], WARM[2], 3.05);
    gb.box(-0.09, 0.04, -0.07, 0.28, 0.24, 0.26, GLASS);
    gb.noGlow();
    gb.box(-0.09, 0.28, -0.07, 0.32, 0.03, 0.3, CONCRETE);
    gb.box(-0.09, 0.24, 0.065, 0.2, 0.035, 0.008, tint);
    door(c, -0.02, 0.065, 0.07, 0.17, '#3a4248');
  }
  // the piers: concrete up to the deck, steel columns on to the roof; a tall
  // station's braced in steel
  const pw = lift > 1.5 ? 0.075 : 0.06;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    gb.box(sx * D, 0, sz * D, pw, DECK - 0.05, pw, CONCRETE);
    gb.box(sx * D, DECK, sz * D, 0.03, EAVE - DECK, 0.03, DECK_STEEL);
  }
  if (lift >= 1) {
    const bays = Math.ceil((DECK - 0.1) / 0.8), span = 2 * D, rise = (DECK - 0.1) / bays, len = Math.hypot(span, rise), a = Math.atan2(rise, span);
    for (let j = 0; j < bays; j++) {
      const y = 0.03 + rise * (j + 0.5);
      for (const sd of [-1, 1]) {
        gb.boxC(0, y, -D, len, 0.018, 0.014, DECK_STEEL, 0, 0, sd * a);
        gb.boxC(-D, y, 0, 0.014, 0.018, len, DECK_STEEL, sd * a);
      }
    }
  }
  // on a tall station a column up through the middle holds the drive
  if (lift >= 0.5) gb.box(0, DECK - 0.05, 0, 0.07, 0.47, 0.07, CONCRETE_D);
  // the deck: a concrete slab, its edge in the line's colour
  gb.box(0, DECK - 0.06, 0, 2 * D + 0.05, 0.06, 2 * D + 0.05, CONCRETE);
  for (const sd of [-1, 1]) {
    gb.box(0, DECK - 0.065, sd * (D + 0.027), 2 * D + 0.06, 0.045, 0.006, tint);
    gb.box(sd * (D + 0.027), DECK - 0.065, 0, 0.006, 0.045, 2 * D + 0.06, tint);
  }
  gondolaWayUp(c, L, DECK, D, DECK_STEEL, CONCRETE);
  gondolaDeck(c, L, DECK, D, DECK_STEEL);
  gondolaDrive(c, 0, 0, DECK, EAVE, tint);
  gondolaRoof(c, L ? 1.0 : 0.94, L ? 1.0 : 0.94, EAVE, tint);
  for (const s of [-1, 1]) c.addGlow(s * 0.2, DECK + 0.24, 0);
  // the name board under the deck, with the line's roundel, lit at night
  gb.box(-0.05, DECK - 0.2, D + 0.018, 0.3, 0.085, 0.012, '#2f3a40');
  gb.glow(...lineGlow(tint, 1.1));
  gb.cyl(-0.15, DECK - 0.157, D + 0.026, 0.03, 0.03, 0.006, 10, tint, 0, Math.PI / 2);
  gb.glow(1.5, 1.45, 1.3, 3.1);
  gb.box(0.02, DECK - 0.162, D + 0.026, 0.13, 0.012, 0.004, '#e8e6e0');
  gb.noGlow();
  c.deck = { x: 0, y: DECK, z: 0 };
};

// The drive over a gondola's bullwheel at (x, z): a white rounded hood with
// a band of the line's colour round it, just over the cable (0.36 over the
// deck, the cabins' hangers up to it), on a column up to the roof.
function gondolaDrive(c, x, z, DECK, EAVE, tint) {
  const { gb } = c;
  gb.cbox(x, DECK + 0.39, z, 0.36, 0.11, 0.36, HOOD, 0, 0.035);
  gb.box(x, DECK + 0.425, z, 0.364, 0.022, 0.364, tint);
  gb.box(x, DECK + 0.5, z, 0.07, EAVE - DECK - 0.5, 0.07, CONCRETE_D);
}

// A gondola station's broad modern roof, w by d over the middle of the plot
// at EAVE, its own way (planOf): a flat slab on a thin edge, a single pitch
// rising to the street, or a butterfly falling to a gutter down the middle;
// its edge in the line's colour, glowing in it at night, and strips of light
// under it, lit all night.
function gondolaRoof(c, w, d, EAVE, tint) {
  const { gb } = c;
  const plan = planOf(c, 3);
  gb.box(0, EAVE - 0.035, 0, w, 0.035, d, DECK_STEEL);
  gb.glow(2.0, 1.85, 1.55, 3.1);
  for (const x of w > 1.2 ? [-0.62, -0.38, 0.38, 0.62] : [-0.2, 0.2]) gb.box(x, EAVE - 0.042, 0, 0.03, 0.007, d * 0.8, '#fff4dc');
  gb.noGlow();
  if (plan === 1) gb.wedge(0, EAVE, 0, w, d, Math.min(0.2, d * 0.15), ROOF_W, Math.PI);
  else if (plan === 2) {
    gb.wedge(-w / 4, EAVE, 0, d, w / 2, Math.min(0.12, w * 0.08), ROOF_W, Math.PI / 2);
    gb.wedge(w / 4, EAVE, 0, d, w / 2, Math.min(0.12, w * 0.08), ROOF_W, -Math.PI / 2);
  } else gb.box(0, EAVE, 0, w, 0.045, d, ROOF_W);
  gb.glow(...lineGlow(tint));
  for (const sd of [-1, 1]) {
    gb.box(0, EAVE - 0.035, sd * (d / 2 + 0.004), w + 0.01, 0.03, 0.008, tint);
    gb.box(sd * (w / 2 + 0.004), EAVE - 0.035, 0, 0.008, 0.03, d + 0.01, tint);
  }
  gb.noGlow();
}

// A gondola interchange, where lines meet: the station four times over, a
// deck on piers with a berth in each quarter of it for a line of its own
// (c.berths: where each is, the headings its cables leave on and its line's
// colour), under one roof with a drive over each berth in its line's colour,
// so the lines' cabins never cross on it. A glazed booking hall under the
// deck, the way up as at a station (to the deck's front). c.stair, c.deck,
// c.seats and c.stand as at a station.
MODELS.gondolahub = (c) => {
  const { gb } = c;
  const lift = c.lift || 0;
  const DECK = 0.78 + lift, EAVE = 1.39 + lift, D = 0.85;
  if (!c.berths) c.berths = [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]].map(([x, z]) => ({ x, z, cables: [], tint: null }));
  const tint = (c.berths.find(B => B.tint) || {}).tint || NO_LINE;
  // (short of the plot's edge, as a 2×2 plot is nudged further)
  footing(c, 0, 0, 1.78, 1.78);
  gb.box(0, 0, 0, 1.78, 0.02, 1.78, '#cdc8be');
  // the booking hall under the back of the deck, glazed between concrete
  gb.box(0, 0.02, -0.3, 1.12, 0.03, 0.68, CONCRETE_D);
  for (const x of [-0.54, -0.18, 0.18, 0.54]) for (const z of [-0.62, 0.02]) gb.box(x, 0.02, z, 0.045, 0.48, 0.045, CONCRETE);
  gb.glow(WARM[0], WARM[1], WARM[2], 3.05);
  gb.box(0, 0.05, -0.3, 1.06, 0.43, 0.62, GLASS);
  gb.noGlow();
  gb.box(0, 0.48, -0.3, 1.16, 0.04, 0.72, CONCRETE);
  gb.box(0, 0.4, 0.035, 0.5, 0.05, 0.012, tint);
  door(c, 0, 0.035, 0.14, 0.24, '#3a4248');
  // the piers: round the edge (not in the middle of the front, where the way
  // up may come), concrete to the deck and steel on to the roof
  const pw = lift > 1.5 ? 0.08 : 0.065;
  for (const sx of [-1, 0, 1]) for (const sz of [-1, 0, 1]) {
    if (!(sx || sz) || (sx === 0 && sz === 1)) continue;
    gb.box(sx * D, 0, sz * D, pw, DECK - 0.05, pw, CONCRETE);
    gb.box(sx * D, DECK, sz * D, 0.035, EAVE - DECK, 0.035, DECK_STEEL);
  }
  if (lift >= 1) {
    const bays = Math.ceil((DECK - 0.1) / 0.8), rise = (DECK - 0.1) / bays, len = Math.hypot(D, rise), a = Math.atan2(rise, D);
    for (let j = 0; j < bays; j++) {
      const y = 0.03 + rise * (j + 0.5);
      for (const h of [-1, 1]) for (const sd of [-1, 1]) {
        gb.boxC(h * D / 2, y, -D, len, 0.018, 0.014, DECK_STEEL, 0, 0, sd * a);
        for (const sx of [-1, 1]) gb.boxC(sx * D, y, h * D / 2, 0.014, 0.018, len, DECK_STEEL, sd * a);
      }
    }
  }
  // the deck and its edge in the line's colour
  gb.box(0, DECK - 0.06, 0, 2 * D + 0.05, 0.06, 2 * D + 0.05, CONCRETE);
  for (const sd of [-1, 1]) {
    gb.box(0, DECK - 0.065, sd * (D + 0.027), 2 * D + 0.06, 0.045, 0.006, tint);
    gb.box(sd * (D + 0.027), DECK - 0.065, 0, 0.006, 0.045, 2 * D + 0.06, tint);
  }
  gondolaWayUp(c, true, DECK, D, DECK_STEEL, CONCRETE);
  gondolaDeck(c, true, DECK, D, DECK_STEEL);
  // a drive over each berth, in its line's colour; and the roof over all
  for (const B of c.berths) {
    if (lift >= 0.5) gb.box(B.x, DECK - 0.05, B.z, 0.07, 0.47, 0.07, CONCRETE_D);
    gondolaDrive(c, B.x, B.z, DECK, EAVE, B.tint || NO_LINE);
  }
  gb.box(0, EAVE - 0.035, 0, 2 * D, 0.03, 0.035, DECK_STEEL);
  gb.box(0, EAVE - 0.035, 0, 0.035, 0.03, 2 * D, DECK_STEEL);
  gondolaRoof(c, 1.86, 1.86, EAVE, tint);
  for (const B of c.berths) c.addGlow(B.x, DECK + 0.24, B.z);
  // the name board under the deck, with a roundel for each line, lit at night
  gb.box(0.3, DECK - 0.2, D + 0.018, 0.5, 0.09, 0.012, '#2f3a40');
  c.berths.forEach((B, k) => {
    gb.glow(...lineGlow(B.tint || NO_LINE, 1.1));
    gb.cyl(0.1 + k * 0.07, DECK - 0.155, D + 0.026, 0.026, 0.026, 0.006, 10, B.tint || NO_LINE, 0, Math.PI / 2);
  });
  gb.noGlow();
  c.deck = { x: 0, y: DECK, z: 0 };
};

// A gondola station's deck made welcoming to those waiting: railings round
// its edge (open where the cabins come and go, and where the stairs or the
// lift come up), benches along its quiet sides facing in, flower boxes on
// the rails, lamps in its quiet corners and a clock on the drive; at the
// terminal, benches with arms and a glazed screen behind them, and a board
// of the times by the way up. Nothing of it stands where the cabins pass
// (c.cables: the headings they leave on; the two cables G_OFF either side,
// a cabin 0.16 across). c.seats: the places on the benches (x, y, z in this
// frame, and h the way a villager sitting there faces); c.stand: places
// clear of all of it to stand and wait (transit.js keeps those clear of the
// cabins' way too). At an interchange the same about each of its berths
// (c.berths), the deck its whole plot wide.
function gondolaDeck(c, L, DECK, D, post) {
  const { gb, rng } = c;
  const WAY = 0.14 + 0.08 + 0.03, hub = !!c.berths;
  const berths = c.berths || [{ x: 0, z: 0, cables: c.cables || [] }];
  const inWay = (x, z) => berths.some(B => B.cables.some(k => {
    const ux = Math.sin(k), uz = Math.cos(k), rx = x - B.x, rz = z - B.z;
    return Math.abs(rz * ux - rx * uz) < WAY && rx * ux + rz * uz > -WAY;
  }));
  // where the way up comes on to the deck, at its edge
  const e = c.stair && c.stair[c.stair.length - 1];
  const gate = e && (Math.abs(e.x) > Math.abs(e.z) ? [Math.sign(e.x) * D, e.z] : [e.x, Math.sign(e.z) * D]);
  const atGate = (x, z) => gate && Math.hypot(x - gate[0], z - gate[1]) < 0.1;
  // railings: the deck's edge in short lengths, a post at each end
  const RH = 0.085, n = Math.round(D * 30), len = (2 * D) / n;
  const quiet = [];
  for (const [nx, nz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    for (let i = 0; i < n; i++) {
      const u = -D + len * (i + 0.5), x = nx ? nx * D : u, z = nz ? nz * D : u;
      if (inWay(x, z) || atGate(x, z)) continue;
      const along = nx === 0;
      gb.box(x, DECK + RH - 0.012, z, along ? len : 0.012, 0.012, along ? 0.012 : len, post);
      // (a pane of glass under the rail)
      gb.box(x, DECK + 0.006, z, along ? len - 0.012 : 0.003, RH - 0.02, along ? 0.003 : len - 0.012, '#b9d0d6');
      for (const k of [-1, 1]) gb.box(x + (along ? k * len / 2 : 0), DECK, z + (along ? 0 : k * len / 2), 0.012, RH, 0.012, post);
      quiet.push([x, z, nx, nz, i]);
    }
  }
  // flower boxes on the rails, outside, every few lengths
  for (const [x, z, nx, nz, i] of quiet) {
    if (i % 3 !== 1) continue;
    const ox = x + nx * 0.016, oz = z + nz * 0.016, along = nx === 0;
    gb.box(ox, DECK + RH - 0.03, oz, along ? 0.05 : 0.018, 0.022, along ? 0.018 : 0.05, '#7a5636');
    for (let k = 0; k < 3; k++) gb.sphere(ox + (along ? (k - 1) * 0.016 : 0), DECK + RH - 0.006, oz + (along ? 0 : (k - 1) * 0.016), 0.009, rng.pick(['#d94f5c', '#f2c94c', '#e98ac0', '#f4f1e8']), 0);
    gb.box(ox, DECK + RH - 0.009, oz, along ? 0.046 : 0.014, 0.006, along ? 0.014 : 0.046, '#4f7a3a');
  }
  // benches along the quiet sides, facing in; up to two (three at the
  // terminal), the two places on each where a villager sits
  c.seats = [];
  const spots = [];
  for (const [nx, nz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) for (const u of hub ? [-0.5, 0.5, -0.3, 0.3, -0.68, 0.68, 0] : [0, -0.13, 0.13, -0.18, 0.18]) spots.push([nx, nz, u]);
  const placed = [];
  for (const [nx, nz, u] of spots) {
    if (placed.length >= (hub ? 8 : L ? 3 : 2)) break;
    const bx = nx ? nx * (D - 0.04) : u, bz = nz ? nz * (D - 0.04) : u, ry = Math.atan2(-nx, -nz);
    const ax = nz ? 1 : 0, az = nx ? 1 : 0;   // along the bench
    const ends = [-0.1, 0.1].map(k => [bx + ax * k, bz + az * k]);
    const feet = [bx - nx * 0.04, bz - nz * 0.04];   // (where a sitter's feet reach)
    if ([...ends, feet, [bx, bz]].some(([x, z]) => inWay(x, z) || atGate(x, z) || berths.some(B => Math.hypot(x - B.x, z - B.z) < 0.12))) continue;
    if (placed.some(([px, pz]) => Math.hypot(px - bx, pz - bz) < 0.22)) continue;
    placed.push([bx, bz, ry, nx, nz]);
    bench(c, bx, bz, ry, DECK);
    if (L) {
      // arms at its ends, and a glazed screen behind against the wind
      for (const k of [-0.085, 0.085]) gb.box(bx + ax * k, DECK + 0.036, bz + az * k, ax ? 0.01 : 0.05, 0.03, ax ? 0.05 : 0.01, '#3f342c');
      const sx = bx + nx * 0.035, sz = bz + nz * 0.035;
      gb.box(sx, DECK + 0.01, sz, ax ? 0.2 : 0.008, 0.16, ax ? 0.008 : 0.2, '#3a4248');
      gb.glow(WARM[0], WARM[1], WARM[2], 1.05);
      gb.box(sx - nx * 0.002, DECK + 0.03, sz - nz * 0.002, ax ? 0.18 : 0.006, 0.12, ax ? 0.006 : 0.18, GLASS);
      gb.noGlow();
    }
    for (const k of [-0.045, 0.045]) c.seats.push({ x: bx + ax * k - nx * 0.006, y: DECK + 0.05, z: bz + az * k - nz * 0.006, h: ry });
  }
  // lamps in the two quietest corners
  const corners = [[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([sx, sz]) => [sx * (D - 0.04), sz * (D - 0.04)])
    .filter(([x, z]) => !inWay(x, z) && !atGate(x, z) && !placed.some(([bx, bz]) => Math.hypot(bx - x, bz - z) < 0.12));
  const lamps = corners.slice(0, hub ? 4 : 2);
  for (const [x, z] of lamps) lamp(c, x, z, 0.2, DECK);
  // a clock on each side of the drive (each berth's), over everyone's heads
  for (const B of berths) for (const [fx, fz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const cx = B.x + fx * 0.112, cz = B.z + fz * 0.112, ry = Math.atan2(fx, fz);
    gb.push(cx, DECK + 0.385, cz, ry);
    gb.cyl(0, 0, 0, 0.034, 0.034, 0.006, 12, '#2f2c2a', 0, Math.PI / 2);
    gb.cyl(0, 0, 0.004, 0.028, 0.028, 0.004, 12, '#f1ece0', 0, Math.PI / 2);
    gb.box(0, -0.002, 0.007, 0.003, 0.02, 0.002, '#2a2826');
    gb.boxC(0.006, 0.004, 0.007, 0.013, 0.003, 0.002, '#2a2826');
    gb.pop();
  }
  // at the terminal, a board of the times by the way up
  let board = null;
  if (L && gate) {
    const tx = gate[0] * 0.82, tz = gate[1] * 0.82, ry = Math.atan2(-gate[0], -gate[1]);
    const ox = Math.abs(gate[0]) > Math.abs(gate[1]) ? 0 : 0.11, oz = ox ? 0 : 0.11;
    if (!inWay(tx + ox, tz + oz)) {
      board = [tx + ox, tz + oz];
      gb.push(tx + ox, DECK, tz + oz, ry);
      gb.box(0, 0, 0, 0.01, 0.12, 0.01, '#2f2c2a');
      gb.box(0, 0.12, 0, 0.09, 0.06, 0.008, '#2f4858');
      for (let k = 0; k < 3; k++) gb.box(0, 0.13 + k * 0.015, 0.005, 0.07, 0.004, 0.002, '#e8e0d0');
      gb.pop();
    }
  }
  // where to stand and wait: round the middle of the deck, off the benches
  // (and the feet of those on them), the lamps, the board and the lift's column
  const seg = (x, z, [ax, az], [bx, bz]) => {
    const ex = bx - ax, ez = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez)));
    return Math.hypot(x - ax - ex * t, z - az - ez * t);
  };
  c.stand = [];
  for (const B of berths) for (let k = 0; k < 16; k++) {
    const a = (k * Math.PI) / 8;
    for (const r of [0.22, 0.17, 0.12]) {
      const x = B.x + Math.sin(a) * r, z = B.z + Math.cos(a) * r;
      if (Math.abs(x) > D - 0.06 || Math.abs(z) > D - 0.06 || r < 0.1) continue;
      if (placed.some(([bx, bz, , nx, nz]) => seg(x, z, [bx - (nz ? 0.1 : 0) - nx * 0.05, bz - (nx ? 0.1 : 0) - nz * 0.05], [bx + (nz ? 0.1 : 0) - nx * 0.05, bz + (nx ? 0.1 : 0) - nz * 0.05]) < 0.075)) continue;
      if (lamps.some(([lx, lz]) => Math.hypot(x - lx, z - lz) < 0.06) || (board && Math.hypot(x - board[0], z - board[1]) < 0.08)) continue;
      c.stand.push({ x, y: DECK, z });
      break;
    }
  }
}

// The way up to a gondola station's deck (DECK up, its half-width D), and
// the way a villager walks it (c.stair: points x, y, z from the street to
// the deck). Stairs to scale, steps of about 0.02 (a fifth of a villager)
// on treads of 0.03, up a side strip from the street end and on round the
// deck as far as they need, turning each corner on a landing: the
// terminal's in stone, solid to the ground, the station's in timber on
// stringers. On a tall station a glass lift instead, its car taking those
// waiting at its door up to the deck or down to the street (the way up
// rising there on the spot; see agents.js). Of its ways round, the one whose top (where it meets the deck,
// at the deck's height) is furthest from where the cables leave, as the
// cabins pass through there at the deck's height. A street lamp at its
// foot, a bench under the deck.
function gondolaWayUp(c, L, DECK, D, post, floor) {
  const { gb } = c;
  const S = D + 0.08, W = 0.1, RISE = 0.02, TREAD = 0.03, F = c.Ez;   // (F: the front of the plot)
  // how far a heading in this frame is from the nearest the cables leave on
  // (at an interchange, how far a point is from the cables leaving its berths)
  const rays = c.berths ? c.berths.flatMap(B => B.cables.map(k => [B.x, B.z, Math.sin(k), Math.cos(k)])) : null, by = rays ? 0.05 : 0.2;
  const clear = (x, z) => {
    if (rays) return Math.min(9, ...rays.map(([bx, bz, ux, uz]) => { const t = Math.max(0, (x - bx) * ux + (z - bz) * uz); return Math.hypot(x - bx - ux * t, z - bz - uz * t); }));
    if (!c.cables || !c.cables.length) return Math.PI;
    const a = Math.atan2(x, z);
    return Math.min(...c.cables.map(k => Math.abs(Math.atan2(Math.sin(a - k), Math.cos(a - k)))));
  };
  if (c.lift >= 0.5) {
    // the lift: a long glazed shaft along the strip just off the deck, in
    // the front strip or a side strip, its car room for four in a row (see
    // LIFT); entered at one end from the street and on to the deck from its
    // long side. [its middle x, z; ux, uz: along it, the way in from its
    // street end; ix, iz: on to the deck]. Its glass and its car are drawn
    // apart, as the villagers ride it (see agents.js): here its frame, a
    // steel post at each corner and halfway along, a band round it every
    // quarter tile up, a pit at its foot, the winding gear in a white box on
    // top with a band of the line's colour, and the frames of its doors
    const A = LIFT.across[c.berths ? 'gondolahub' : 'gondola'], LG = LIFT.long, off = F - 0.005 - A / 2;
    const spots = [[0, off, -1, 0, 0, -1], [off, 0, 0, -1, -1, 0], [-off, 0, 0, -1, 1, 0]];
    const [lx, lz, ux, uz, ix, iz] = spots.reduce((a, b) => (clear(b[0], b[1]) > clear(a[0], a[1]) + by ? b : a));
    const hx = Math.abs(ux) * LG / 2 + Math.abs(uz) * A / 2, hz = Math.abs(uz) * LG / 2 + Math.abs(ux) * A / 2, h = DECK + 0.17;
    gb.box(lx, 0, lz, 2 * hx + 0.02, 0.02, 2 * hz + 0.02, CONCRETE_D);
    for (const sx of [-1, 0, 1]) for (const sz of [-1, 0, 1]) {
      if ((!sx && !sz) || (!sx && ux) || (!sz && uz)) continue;   // (the corners, and halfway along its long sides)
      gb.box(lx + sx * hx, 0.02, lz + sz * hz, 0.012, h - 0.02, 0.012, DECK_STEEL);
    }
    for (let y = 0.25; y < h - 0.1; y += 0.25) for (const sd of [-1, 1]) {
      gb.box(lx, y, lz + sd * hz, 2 * hx, 0.008, 0.008, DECK_STEEL);
      gb.box(lx + sd * hx, y, lz, 0.008, 0.008, 2 * hz, DECK_STEEL);
    }
    gb.cbox(lx, h, lz, 2 * hx + 0.02, 0.07, 2 * hz + 0.02, HOOD, 0, 0.01);
    gb.box(lx, h + 0.04, lz, 2 * hx + 0.024, 0.014, 2 * hz + 0.024, c.tint || NO_LINE);
    // (a door: at (px, pz) in a face whose way out is (nx, nz), w wide)
    const doorway = (px, pz, y, nx, nz, w) => {
      for (const s of [-1, 1]) gb.box(px + nz * s * w / 2, y, pz + nx * s * w / 2, nz ? 0.01 : 0.008, 0.16, nz ? 0.008 : 0.01, DECK_STEEL);
      gb.box(px, y + 0.16, pz, nz ? w + 0.01 : 0.008, 0.012, nz ? 0.008 : w + 0.01, DECK_STEEL);
    };
    doorway(lx - ux * (LG / 2 + 0.006), lz - uz * (LG / 2 + 0.006), 0.02, -ux, -uz, 0.08);
    doorway(lx + ix * (A / 2 + 0.006), lz + iz * (A / 2 + 0.006), DECK, ix, iz, LG - 0.08);
    // the way: from the street to its door, into it, up, and out on to the deck
    const dx = lx - ux * (LG / 2 + 0.04), dz = lz - uz * (LG / 2 + 0.04);
    c.stair = [
      { x: dx, y: 0.02, z: F },
      { x: dx, y: 0.02, z: dz },
      { x: lx, y: 0.02, z: lz },
      { x: lx, y: DECK, z: lz },
      { x: lx + ix * (A / 2 + 0.12), y: DECK, z: lz + iz * (A / 2 + 0.12) },
    ];
    lamp(c, ux ? dx + 0.08 : lx - Math.sign(lx) * 0.1, F - 0.05, 0.3);
    return;
  }
  // the stairs: up a side strip from the street end, on round the back (and
  // the other side) as far as they need, up the right side or the left; or
  // first along the front from one corner and on round the far side, so the
  // top can come to the deck on any of its four sides
  const ways = [
    ...[1, -1].map(sx => [[sx * S, F - 0.08], [sx * S, -S], [-sx * S, -S], [-sx * S, S]]),
    ...[1, -1].map(sx => [[-sx * (F - 0.08), S], [sx * S, S], [sx * S, -S], [-sx * S, -S]]),
  ];
  const N = Math.ceil(DECK / RISE), rise = DECK / N;
  // the treads along a way ([x, z, height, heading] each), the corners it
  // turns (landings, [x, z, height]) and its top
  const layout = (P) => {
    const treads = [], lands = [];
    let i = 0, d = 0;
    for (let seg = 0; seg < P.length - 1; seg++) {
      const [ax, az] = P[seg], [bx, bz] = P[seg + 1], len = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / len, uz = (bz - az) / len;
      for (; i < N && d + TREAD <= len - 0.06 + 1e-6; i++, d += TREAD) treads.push([ax + ux * (d + TREAD / 2), az + uz * (d + TREAD / 2), (i + 1) * rise, Math.atan2(ux, uz)]);
      if (i >= N) return { treads, lands, top: [ax + ux * (d + 0.06), az + uz * (d + 0.06)], P };
      lands.push([bx, bz, i * rise]);
      d = 0.06;
    }
    return null;
  };
  const opts = ways.map(layout).filter(Boolean);
  if (!opts.length) return;
  const best = opts.reduce((a, b) => (clear(b.top[0], b.top[1]) > clear(a.top[0], a.top[1]) + by ? b : a));
  const { treads, lands, top } = best;
  for (const [x, z, h, hd] of treads) {
    gb.push(x, 0, z, hd);
    if (L) gb.box(0, 0, 0, W, h, TREAD + 0.002, STONE);
    else gb.box(0, h - 0.012, 0, W, 0.012, TREAD + 0.003, '#9d988e');
    gb.pop();
  }
  for (const [x, z, h] of lands) {
    if (L) gb.box(x, 0, z, W + 0.01, h, W + 0.01, STONE);
    else { gb.box(x, h - 0.014, z, W + 0.01, 0.014, W + 0.01, '#9d988e'); gb.box(x, 0, z, 0.016, h - 0.014, 0.016, post); }
  }
  // the top landing, level with the deck and joined to it
  gb.box(top[0], DECK - 0.04, top[1], W + 0.01, 0.04, W + 0.01, floor);
  if (!L) gb.box(top[0], 0, top[1], 0.016, DECK - 0.04, 0.016, post);
  // each straight flight: stringers under the timber ones, and a handrail
  // along its outer side
  const runs = [];
  for (const t of treads) { const r = runs[runs.length - 1]; if (r && Math.abs(r.hd - t[3]) < 1e-6) r.b = t; else runs.push({ a: t, b: t, hd: t[3] }); }
  for (const r of runs) {
    const [ax, az, ah] = r.a, [bx, bz, bh] = r.b, len = Math.hypot(bx - ax, bz - az) + TREAD;
    const up = bh - ah + rise, mx = (ax + bx) / 2, mz = (az + bz) / 2, my = (ah + bh) / 2 - rise / 2;
    const sl = Math.hypot(len, up), sa = Math.atan2(up, len);
    // (outward, away from the deck: the strip's own side)
    const ox = Math.abs(mx) > Math.abs(mz) ? Math.sign(mx) : 0, oz = ox ? 0 : Math.sign(mz);
    gb.pushEuler(mx, my, mz, -sa, r.hd, 0);
    if (!L) for (const o of [-W / 2, W / 2]) gb.boxC(o, -0.02, 0, 0.012, 0.028, sl, post);
    gb.pop();
    gb.pushEuler(mx + ox * (W / 2 - 0.005), my + 0.13, mz + oz * (W / 2 - 0.005), -sa, r.hd, 0);
    gb.boxC(0, 0, 0, 0.008, 0.008, sl, post);
    gb.pop();
  }
  // the way a villager climbs it: from the street to its foot, up each
  // flight, across each landing, over the top landing and in on to the deck
  const [fx, fz] = best.P[0];
  const way = [{ x: fx, y: 0.02, z: F }, { x: fx, y: 0.02, z: fz + 0.04 }];
  for (const [k, r] of runs.entries()) {
    const [ax, az, ah] = r.a, [bx, bz, bh] = r.b, ux = Math.sin(r.hd), uz = Math.cos(r.hd);
    if (k) { const l = lands[k - 1]; way.push({ x: l[0], y: l[2], z: l[1] }); }
    way.push({ x: ax - ux * TREAD / 2, y: ah - rise, z: az - uz * TREAD / 2 });
    way.push({ x: bx + ux * TREAD / 2, y: bh, z: bz + uz * TREAD / 2 });
  }
  way.push({ x: top[0], y: DECK, z: top[1] });
  // in towards the middle of the deck from the landing
  const inx = Math.abs(top[0]) > Math.abs(top[1]) ? -Math.sign(top[0]) : 0, inz = inx ? 0 : -Math.sign(top[1]);
  way.push({ x: top[0] + inx * 0.15, y: DECK, z: top[1] + inz * 0.15 });
  c.stair = way;
  // (a street lamp by its foot: beside it on the front, or along the side
  // strip when the stairs start along the front)
  if (Math.abs(fz - S) < 1e-6) lamp(c, fx, S - 0.14, 0.3);
  else lamp(c, fx - Math.sign(fx) * 0.1, F - 0.05, 0.3);
  bench(c, -Math.sign(fx) * 0.2, F - 0.26, 0);
}

// A faint per-building colour cast, so neighbours never look copy-pasted.
// ------------------------------------------------- the two home branches

// Villa: a detached house in a proper garden, in one of its plans: with a
// glasshouse at the side; Italianate, a belvedere tower on a front corner;
// Gothic, a steep gable to the street over a bay, a conservatory behind;
// Regency, square under a low roof, a veranda along the front and a bow
// window at the side. The garden in front: clipped hedges, railings and a
// gravel sweep, or a lawn with a fountain.
function villa(c) {
  const { gb, rng, pal } = c;
  const F = c.form, plan = planOf(c, 4), side = F.side;
  const roof = rng.chance(0.5) ? pal.slate : pal.roof;
  const wall = pal.stoneHouse ? pal.stoneWall : plan === 3 && !pal.forced ? STUCCO : pal.wall;
  // a glasshouse gw × gd leaning on the house at its side s (or, s 0, on its back)
  const glass = (gx, gz, gw, gd, s) => {
    footing(c, gx, gz, gw, gd);
    gb.cbox(gx, 0, gz, gw, 0.035, gd, STONE, 0, 0.006);
    gb.glow(WARM[0], WARM[1], WARM[2], 1.3);
    gb.box(gx, 0.035, gz, gw - 0.01, 0.17, gd - 0.01, '#9fbcc0');
    gb.noGlow();
    for (let i = 0; i < 4; i++) {
      if (s) gb.box(gx + s * (gw / 2 - 0.004), 0.035, gz - gd / 2 + 0.015 + (i * (gd - 0.03)) / 3, 0.008, 0.17, 0.008, '#e9e2d4');
      else gb.box(gx - gw / 2 + 0.015 + (i * (gw - 0.03)) / 3, 0.035, gz - gd / 2 + 0.004, 0.008, 0.17, 0.008, '#e9e2d4');
    }
    gb.box(gx, 0.2, gz, gw - 0.005, 0.01, gd - 0.005, '#e9e2d4');
    if (s) gb.wedge(gx, 0.205, gz, gd + 0.01, gw + 0.01, 0.06, '#c8dadc', s > 0 ? Math.PI / 2 : -Math.PI / 2);
    else gb.wedge(gx, 0.205, gz, gw + 0.01, gd + 0.01, 0.06, '#c8dadc', Math.PI);
    for (let i = 0; i < 3; i++) gb.sphere(gx + (s ? 0 : (i - 1) * gw / 4), 0.06, gz + (s ? (i - 1) * gd / 4 : 0), 0.03, rng.pick(LEAF), 0);
  };
  if (plan === 1) {
    // Italianate: a low hipped roof on wide eaves, and a belvedere tower
    // standing up at one corner of the front, open arches round its top
    const x0 = -side * 0.05;
    house(c, { x: x0, z: -0.12, w: 0.66, d: 0.52, h: 0.58, floors: 2, wall, roof, roofType: 'hip', roofLock: true, rh: 0.18, chimney: true, plinth: STONE, doorX: -side * 0.1, doorW: 0.1, nFront: 3, form: { turret: null, bay: null } });
    const tw = 0.18, tx = x0 + side * (0.33 - tw / 2 + 0.02), tz = 0.14 - tw / 2 + 0.04, th = 0.84;
    footing(c, tx, tz, tw, tw);
    gb.cbox(tx, 0, tz, tw, th, tw, wall, 0, 0.012);
    for (let f = 0; f < 2; f++) win(c, tx, f * 0.29 + 0.11, tz + tw / 2, 0.065, 0.11, 'f', 0.8);
    const arched = c.arched; c.arched = true;
    for (const u of [-0.05, 0.05]) { win(c, tx + u, 0.66, tz + tw / 2, 0.035, 0.1, 'f', 0.9); win(c, tx + side * tw / 2, 0.66, tz + u, 0.035, 0.1, side > 0 ? 'r' : 'l', 0.9); }
    c.arched = arched;
    gb.box(tx, th - 0.02, tz, tw + 0.03, 0.025, tw + 0.03, '#ece6da');
    gb.hip(tx, th, tz, tw + 0.02, tw + 0.02, 0.07, roof, 0.05);
    glass(-side * 0.4, -0.2, 0.14, 0.26, -side);
  } else if (plan === 2) {
    // Gothic: a steep gable coming forward to the street with a bay at its
    // foot and a finial; a conservatory on the back
    const x0 = side * 0.06;
    house(c, { x: x0, z: -0.14, w: 0.6, d: 0.48, h: 0.56, floors: 2, wall, roof, roofType: 'gable', roofLock: true, rh: 0.34, chimney: true, plinth: STONE, doorX: side * 0.12, doorW: 0.1, nFront: 3, alongZ: false, form: { turret: null, bay: null, balcony: null } });
    const ww = 0.26, wx = x0 - side * (0.3 - ww / 2 + 0.02), wd = 0.6;
    house(c, { x: wx, z: 0.2 - wd / 2, w: ww, d: wd, h: 0.56, floors: 2, wall, roof, roofType: 'gable', roofLock: true, alongZ: true, rh: 0.42, noDoor: true, chimney: false, nFront: 1, plinth: STONE });
    tallBay(c, wx, 0.2, 0.28, 2, wall, roof, 0.8);
    gb.box(wx, 0.56 + 0.42 * pal.pitch + 0.02, 0.2 + 0.07, 0.01, 0.07, 0.01, IRON_D);
    glass(x0 + side * 0.04, -0.43, 0.3, 0.1, 0);
  } else if (plan === 3) {
    // Regency: square and stuccoed under a low hipped roof, a veranda along
    // the front and a bow window at the side
    house(c, { x: 0, z: -0.12, w: 0.6, d: 0.54, h: 0.6, floors: 2, wall, roof: pal.slate, roofType: 'hip', roofLock: true, rh: 0.16, chimney: true, chimneyPos: 'ends', plinth: STONE, doorX: 0, doorW: 0.1, nFront: 3, form: { porch: 'veranda', turret: null, bay: null, balcony: null } });
    gb.push(side * 0.3, 0, -0.12, side * Math.PI / 2);
    bay(c, 0, 0, 0.17, wall, pal.slate);
    gb.pop();
  } else {
    house(c, {
      x: -side * 0.06, z: -0.12, w: 0.7, d: 0.52, h: 0.58, floors: 2, wall, roof, roofType: rng.chance(0.6) ? 'hip' : 'gable',
      rh: 0.26, chimney: true, plinth: STONE, doorX: 0, doorW: 0.1, nFront: 3,
    });
    glass(side * 0.38, -0.1, 0.16, 0.3, side);
  }
  const dx = plan === 1 ? -side * 0.15 : plan === 2 ? side * 0.18 : plan === 0 ? -side * 0.06 : 0;
  // the front garden
  const garden = plan === 3 ? 1 : Math.floor(F.b * 3);
  if (garden === 1) {
    // railings along the street and a gravel sweep up to the door
    frontage(c, -0.46, 0.46, 0.45, [dx], 'railings');
    gb.cyl(dx, c.gy(dx, 0.3) - 0.008, 0.3, 0.13, 0.13, 0.012, 12, '#cdbf9e');
    gb.cyl(dx, c.gy(dx, 0.3) - 0.004, 0.3, 0.065, 0.065, 0.012, 10, LAWN_G);
    smallTree(c, -side * 0.33, 0.3, rng.float(0.85, 1.05));
    lamp(c, dx + 0.17, 0.42, 0.28);
  } else if (garden === 2) {
    // a lawn with a little fountain, a hedge along the street
    hedge(c, -0.28, 0.44, 0.34, 0.05); hedge(c, 0.28, 0.44, 0.34, 0.05);
    gb.box(dx, c.gy(dx, 0.3) - 0.008, 0.3, 0.08, 0.014, 0.26, '#cdbf9e');
    const fx = dx + side * 0.25;
    gb.cyl(fx, c.gy(fx, 0.29) - 0.01, 0.29, 0.08, 0.09, 0.04, 10, STONE);
    gb.cyl(fx, c.gy(fx, 0.29) + 0.03, 0.29, 0.065, 0.065, 0.004, 10, '#3f7f9f');
    gb.cyl(fx, c.gy(fx, 0.29), 0.29, 0.012, 0.016, 0.1, 6, STONE);
    flowers(c, dx - side * 0.25, 0.3, 6, 0.08);
  } else {
    // front garden: clipped hedges, gravel path, a tree and a bench
    hedge(c, -0.28, 0.43, 0.34, 0.06); hedge(c, 0.28, 0.43, 0.34, 0.06);
    gb.box(dx, c.gy(dx, 0.3) - 0.008, 0.3, 0.1, 0.014, 0.26, '#cdbf9e');
    smallTree(c, -side * 0.36, 0.28, rng.float(0.9, 1.15));
    flowers(c, side * 0.2, 0.3, 6, 0.08);
    bench(c, side * 0.36, 0.3, -side * Math.PI / 2);
    lamp(c, dx + 0.1, 0.42, 0.28);
  }
}

// Tenement: four storeys of flats with two stairs and a back yard, in one of
// its plans: a gable roof and iron balconies; bay windows up all four floors
// under a flat roof behind a parapet; three storeys and a mansard with its
// dormers; open galleries along every floor to a stair tower at one end; two
// gables to the street.
function tenement(c) {
  const { gb, rng, pal } = c;
  const F = c.form, plan = planOf(c, 5), side = F.side;
  const brick = pal.style === 'brick' || (!pal.forced && rng.chance(0.5));
  const wall = brick ? pal.brick : pal.stoneWall, band = shade(wall, 1.15), trim = '#e3dccd';
  const fh = 0.265, floors = plan === 2 ? 3 : 4, h = floors * fh;
  const roofType = ['gable', 'parapet', 'mansard', 'gable', 'gable'][plan];
  const r = house(c, {
    z: -0.1, w: 0.84, d: 0.6, h, floors, wall, roof: pal.slate, roofType, rh: plan === 2 ? 0.3 : 0.22, dormers: plan === 2 ? 4 : 0,
    plinth: STONE_D, doorX: -0.2, nFront: 4, fancy: false, door: pal.door,
  });
  door(c, 0.2, 0.2, 0.085, 0.17, pal.accent);
  const stackY = roofType === 'parapet' ? h + 0.18 : plan === 2 ? r.top + 0.06 : h + 0.32;
  for (const x of [-0.3, 0, 0.3]) chimney(c, x, h - 0.08, stackY, -0.1, 'home', brick ? shade(pal.brick, 0.9) : STONE);
  // string courses between the floors
  for (let f = 1; f < floors; f++) gb.box(0, f * fh - 0.008, -0.1, 0.86, 0.014, 0.62, band);
  if (plan === 1) {
    // bays up all four floors either side of the stairs
    for (const x of [-0.3, 0.3]) tallBay(c, x, 0.2, fh, floors, wall, pal.slate, 0.8, false, floors, 0.18);
  } else if (plan === 3) {
    // galleries along each floor, and the stair tower at one end
    for (let f = 1; f < 4; f++) {
      const y = f * fh;
      gb.box(-side * 0.04, y, 0.235, 0.74, 0.014, 0.07, '#9a9284');
      gb.box(-side * 0.04, y + 0.05, 0.268, 0.74, 0.008, 0.008, IRON_D);
      for (let i = 0; i <= 5; i++) gb.box(-side * 0.04 - 0.37 + i * 0.148, y + 0.014, 0.268, 0.006, 0.04, 0.006, IRON_D);
    }
    const tx = side * 0.33;
    gb.cbox(tx, 0, 0.24, 0.18, h + 0.16, 0.12, wall, 0, 0.01);
    for (let f = 0; f < 4; f++) win(c, tx, f * fh + 0.14, 0.3, 0.05, 0.09, 'f', 0.7);
    gb.hip(tx, h + 0.16, 0.24, 0.18, 0.12, 0.08, pal.slate, 0.02);
  } else if (plan === 4) {
    // two gables to the street, a window in each
    for (const x of [-0.21, 0.21]) wallGable(c, F.gable === 'plain' || !brick ? 'plain' : F.gable, x, 0.2, 0.36, h, 0.2, 0.3, wall, pal.slate, trim, 0.8);
  } else {
    // iron balconies on the upper floors
    for (let f = 1; f < floors; f++) for (const x of [-0.2, 0.2]) {
      const y = f * fh + 0.005;
      gb.box(x, y, 0.235, 0.2, 0.012, 0.07, '#3a3a3e');
      gb.box(x, y + 0.012, 0.268, 0.2, 0.05, 0.006, '#2f2f33');
    }
  }
  sign(c, 0.2, 0.2, 0.207, 0.1, 0.03, '#d8d0c0');
  barrel(c, -0.42, 0.36); crate(c, -0.36, 0.42); handcart(c, 0.38, 0.32);
  washingLine(c, 0, 0.42);
}

// Mansion Block: five storeys (six, for some) in one of its plans: a hipped
// roof with dormers over balconies and a portico; a mansard with its dormers
// over long iron balconies; a flat roof behind a parapet with domed turrets
// on the front corners and oriels between; two shaped gables to the street
// over bays all the way up; a pavilion in the middle of the front rising
// over the roof under its own pyramid and flag; a stair tower over the roof
// with a clock. Stone, red brick banded with stone, or cream stucco.
function mansionBlock(c) {
  const { gb, pal } = c;
  const F = c.form, plan = planOf(c, 6), side = F.side;
  const mat = pal.forced ? 0 : F.a < 0.55 ? 0 : F.a < 0.82 ? 1 : 2;
  const wall = [pal.stoneWall, pal.brick, STUCCO][mat], trim = '#e3dccd';
  const fh = 0.26, floors = 5 + (plan === 1 || plan === 3 ? F.tall : 0), h = floors * fh, W = 0.9, D = 0.66, z0 = -0.08, fz = z0 + D / 2;
  const roofType = ['hip', 'mansard', 'parapet', 'gable', 'hip', 'parapet'][plan];
  house(c, {
    z: z0, w: W, d: D, h, floors, wall, roof: pal.slate, roofType, rh: plan === 1 ? 0.38 : 0.34, dormers: plan === 1 ? 5 : 0,
    plinth: STONE_D, doorX: 0, doorW: 0.13, nFront: 5, fancy: false, door: '#3a2f28', noDoor: plan === 4,
  });
  // (the pavilion's door is the way in, in its front)
  if (plan === 4) door(c, 0, fz + 0.12, 0.12, 0.2, '#3a2f28');
  for (let f = 1; f < floors; f++) gb.box(0, f * fh - 0.008, z0, W + 0.02, 0.016, D + 0.02, trim);
  if (plan === 0 || plan === 3 || plan === 4) gb.box(0, h - 0.02, z0, W + 0.05, 0.03, D + 0.05, trim);
  const rail = (x, y, w, z = fz) => {
    gb.box(x, y, z + 0.02, w, 0.014, 0.06, trim);
    const n = Math.max(3, Math.round(w / 0.035));
    for (let i = 0; i < n; i++) gb.box(x - w / 2 + (i + 0.5) * (w / n), y + 0.014, z + 0.045, 0.008, 0.045, 0.008, '#2f2f33');
  };
  if (plan === 0) {
    for (const x of [-0.27, 0, 0.27]) {
      gb.cbox(x, h + 0.03, 0.13, 0.1, 0.12, 0.1, wall, 0, 0.01);
      gb.gable(x, h + 0.15, 0.13, 0.1, 0.12, 0.06, wall, pal.slate, 0.02, true, 0.02);
      win(c, x, h + 0.055, 0.18, 0.05, 0.065, 'f');
    }
    for (const f of [2, 3]) for (const x of [-0.3, 0.3]) rail(x, f * fh, 0.16);
  } else if (plan === 1) {
    // long iron balconies across the front on the first and top floors
    for (const f of [1, floors - 1]) balcony(c, 'iron', 0, f * fh, fz, W - 0.1);
  } else if (plan === 2) {
    // domed turrets on the front corners, a storey over the parapet, and
    // oriels between them up the middle floors
    for (const s of [-1, 1]) turret(c, 'dome', s * (W / 2 - 0.04), fz - 0.04, 0, h + fh * 0.7, 0.085, fh, wall, pal.slate, 0.8);
    for (const x of [-0.2, 0.2]) tallBay(c, x, fz, fh, floors, wall, pal.slate, 0.8, true, floors - 1, 0.15);
  } else if (plan === 3) {
    // two shaped gables to the street over bays the whole height
    const kind = F.gable !== 'plain' ? F.gable : mat === 1 ? 'dutch' : 'curved';
    for (const x of [-0.24, 0.24]) {
      wallGable(c, kind, x, fz, 0.3, h, 0.26, 0.32, wall, pal.slate, trim, 0.8);
      tallBay(c, x, fz, fh, floors, wall, pal.slate, 0.8, true, floors, 0.17);
    }
  } else if (plan === 4) {
    // a pavilion in the middle of the front, a storey over the roof, under
    // its own pyramid with a flagpole; balconies either side
    const pw = 0.3, pd = 0.12;
    gb.cbox(0, 0, fz + pd / 2 - 0.02, pw, h + fh, pd + 0.04, wall, 0, 0.01);
    for (let f = 1; f <= floors; f++) win(c, 0, f * fh + fh * 0.36, fz + pd + 0.02, 0.08, 0.1, 'f', 0.8);
    gb.box(0, h + fh - 0.02, fz + pd / 2 - 0.02, pw + 0.03, 0.025, pd + 0.07, trim);
    gb.roof(0, h + fh, fz - 0.02, pw + 0.04, pd + 0.2, 0.2, 0, pal.slate);
    gb.box(0, h + fh + 0.2, fz - 0.02, 0.01, 0.2, 0.01, IRON_D);
    gb.box(0.045, h + fh + 0.33, fz - 0.02, 0.08, 0.05, 0.004, ownPick(c, ['#a8473a', '#3f6a8f', '#2f6a4a'], 21));
    for (const f of [1, 2, 3]) for (const x of [-0.32, 0.32]) rail(x, f * fh, 0.15);
  } else {
    // a stair tower rising over the roof at one side, with a clock
    const tx = side * 0.26;
    gb.cbox(tx, h - 0.1, z0 + 0.1, 0.2, fh + 0.2, 0.2, wall, 0, 0.01);
    gb.box(tx, h + fh + 0.08, z0 + 0.1, 0.23, 0.025, 0.23, trim);
    gb.hip(tx, h + fh + 0.1, z0 + 0.1, 0.2, 0.2, 0.1, pal.slate, 0.02);
    wallClock(c, tx, h + fh * 0.55, z0 + 0.201, 0.05);
    for (const f of [1, 2, 3]) for (const x of [-0.3, 0.3]) rail(x, f * fh, 0.16);
  }
  // the door case: a portico, or a canopy on brackets
  if (plan === 1 || plan === 4) {
    const cz = plan === 4 ? fz + 0.12 : fz;
    gb.box(0, 0.24, cz + 0.06, 0.26, 0.016, 0.12, '#2f2f33');
    for (const s of [-1, 1]) gb.boxC(s * 0.11, 0.2, cz + 0.04, 0.008, 0.1, 0.008, IRON_D, 0.7);
  } else {
    for (let i = 0; i < 2; i++) gb.cyl(-0.06 + i * 0.12, 0.02, fz + 0.07, 0.016, 0.019, 0.3, 8, trim);
    gb.gable(0, 0.32, fz + 0.04, 0.24, 0.1, 0.07, trim, pal.slate, 0.02);
  }
  for (const sx of [-1, 1]) for (let i = 0; i < 6; i++) gb.box(sx * (0.12 + i * 0.055), c.gy(sx * (0.12 + i * 0.055), 0.44), 0.44, 0.008, 0.08, 0.008, '#2f2f33');
  for (const sx of [-1, 1]) gb.box(sx * 0.27, c.gy(sx * 0.27, 0.44) + 0.07, 0.44, 0.3, 0.008, 0.008, '#2f2f33');
  lamp(c, -0.14, 0.42, 0.3); lamp(c, 0.14, 0.42, 0.3);
}

// ------------------------------------------------------- builder's yard

function plankStack(c, x, z, n = 4, ry = 0) {
  const { gb, rng } = c;
  gb.push(x, c.gy(x, z), z, ry);
  for (const sx of [-1, 1]) gb.box(sx * 0.08, 0, 0, 0.025, 0.02, 0.14, '#5e432c');
  for (let l = 0; l < n; l++) for (let k = 0; k < 3; k++) gb.box(0, 0.02 + l * 0.018, -0.042 + k * 0.042, 0.25, 0.016, 0.038, rng.pick(['#b8986a', '#a8855a', '#c2a274']));
  gb.pop();
}

function stoneStack(c, x, z, rows = 3) {
  const { gb, rng } = c;
  const y = c.gy(x, z);
  for (let l = 0; l < rows; l++) {
    const count = rows - l;
    for (let k = 0; k < count; k++) {
      gb.cbox(x + (k - (count - 1) / 2) * 0.054, y + l * 0.04, z, 0.05, 0.039, 0.064, rng.pick(['#bdb3a0', '#b3a996', '#a8a294']), rng.float(-0.06, 0.06), 0.006);
    }
  }
}

function sawhorse(c, x, z, ry = 0) {
  const { gb } = c;
  gb.push(x, c.gy(x, z), z, ry);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) gb.boxC(sx * 0.06, 0.04, sz * 0.02, 0.01, 0.085, 0.01, '#6e5034', sz * 0.35, 0, 0);
  gb.box(0, 0.08, 0, 0.16, 0.014, 0.016, '#7a5a3c');
  gb.box(0.02, 0.094, 0, 0.26, 0.012, 0.05, '#c2a274', 0.2);
  gb.pop();
}

function ladder(c, x, z, h, ry = 0, lean = 0.25) {
  const { gb } = c;
  gb.pushEuler(x, c.gy(x, z), z, -lean, ry);
  for (const sx of [-1, 1]) gb.box(sx * 0.022, 0, 0, 0.01, h, 0.01, '#8a6a44');
  for (let y = 0.04; y < h - 0.01; y += 0.045) gb.box(0, y, 0, 0.044, 0.007, 0.007, '#8a6a44');
  gb.pop();
}

// A sheer-legs hoist: a tall pole, a jib and a stone hanging on its rope.
function ginPole(c, x, z, h, ry = 0) {
  const { gb } = c;
  const y = c.gy(x, z);
  gb.push(x, y, z, ry);
  gb.cyl(0, 0, 0, 0.014, 0.018, h, 6, '#7a5a3c');
  for (const a of [0.5, -0.5]) gb.boxC(Math.sin(a) * 0.08, 0.1, Math.cos(a) * -0.05, 0.01, 0.24, 0.01, '#6e5034', 0.35, a, 0);
  const jl = 0.26;
  gb.boxC(0.1, h - 0.06, 0, jl, 0.014, 0.014, '#7a5a3c', 0, 0, 0.35);
  const tx = 0.1 + Math.cos(0.35) * jl / 2, ty = h - 0.06 + Math.sin(0.35) * jl / 2;
  gb.box(tx, ty * 0.45, 0, 0.004, ty * 0.55, 0.004, '#d9cfb4');
  gb.cbox(tx, ty * 0.45 - 0.04, 0, 0.05, 0.04, 0.05, '#bdb3a0', 0, 0.006);
  gb.pop();
}

// A treadwheel crane, the medieval way of lifting stone.
function treadwheel(c, x, z, ry = 0) {
  const { gb } = c;
  const y = c.gy(x, z);
  gb.push(x, y, z, ry);
  gb.cbox(0, 0, 0, 0.28, 0.03, 0.14, '#6e5034', 0, 0.006);
  gb.cyl(0, 0.17, 0, 0.15, 0.15, 0.08, 14, '#9a7a50', 0, 0, Math.PI / 2);
  gb.cyl(0, 0.17, 0, 0.12, 0.12, 0.085, 14, '#5e432c', 0, 0, Math.PI / 2);
  for (const sz of [-1, 1]) gb.box(0, 0.03, sz * 0.055, 0.02, 0.3, 0.02, '#6e5034');
  gb.boxC(0.12, 0.42, 0, 0.5, 0.02, 0.02, '#7a5a3c', 0, 0, 0.8);
  gb.box(0.28, 0.25, 0, 0.004, 0.36, 0.004, '#d9cfb4');
  gb.cbox(0.28, 0.21, 0, 0.06, 0.045, 0.06, '#bdb3a0', 0, 0.006);
  gb.pop();
}

function shed(c, x, z, w, d, h, roof) {
  const { gb } = c;
  gb.push(x, 0, z);
  footing(c, 0, 0, w, d);
  gb.box(0, 0, -d / 2 + 0.01, w, h + 0.06, 0.02, '#7a5a3c');
  for (const sx of [-1, 1]) gb.box(sx * (w / 2 - 0.01), 0, 0, 0.02, h, d, '#86663f');
  for (let i = 0; i <= 3; i++) gb.box(-w / 2 + 0.02 + i * (w - 0.04) / 3, 0, d / 2 - 0.02, 0.022, h - 0.03, 0.022, '#5e432c');
  gb.wedge(0, h - 0.03, 0, w + 0.07, d + 0.08, 0.09, roof, 0);
  for (let i = 0; i < 4; i++) gb.box(-w / 2 + 0.06 + i * 0.05, 0.12, -d / 2 + 0.03, 0.01, 0.12, 0.01, i % 2 ? '#5a5f63' : '#7a5a3c');
  gb.pop();
}

MODELS.builder = (c, L) => {
  const { gb, rng, pal } = c;
  if (L === 0) {
    shed(c, 0.04, -0.24, 0.66, 0.34, 0.28, pal.roof);
    entrance(c, 0.04, -0.07);
    plankStack(c, -0.18, -0.25, 3);
    plankStack(c, -0.24, 0.2, 4, 0.1);
    stoneStack(c, 0.22, 0.18, 3);
    gb.blob(0.3, c.gy(0.3, 0.38), 0.38, 0.08, 0.05, 0.07, '#d4bc88');
    sawhorse(c, -0.02, 0.24, 0.3);
    ladder(c, 0.4, -0.12, 0.34, -Math.PI / 2, 0.3);
    handcart(c, -0.38, -0.02);
    fence(c, -0.46, -0.46, 0.46, 0.46, FENCE, { x: 0, z: 0.46, w: 0.14 });
  } else if (L === 1) {
    house(c, {
      x: -0.2, z: -0.22, w: 0.46, d: 0.38, h: 0.42, floors: 2, wall: pal.wall, roof: pal.roof, roofType: 'gable',
      rh: 0.22, chimney: true, timber: pal.timber, doorX: 0, nFront: 2, fancy: false,
    });
    sign(c, -0.2, 0.3, -0.02, 0.2, 0.05, '#5e432c');
    shed(c, 0.28, -0.22, 0.34, 0.38, 0.26, pal.roof);
    plankStack(c, 0.3, -0.22, 4, Math.PI / 2);
    plankStack(c, -0.25, 0.24, 4);
    stoneStack(c, 0.08, 0.3, 3);
    stoneStack(c, 0.3, 0.36, 2);
    sawhorse(c, 0.02, 0.1, -0.4);
    ginPole(c, 0.4, 0.12, 0.62, Math.PI);
    ladder(c, -0.43, -0.2, 0.36, Math.PI / 2, 0.3);
    boundary(c, 'stone', -0.47, -0.47, 0.47, 0.47, 0);
  } else {
    house(c, {
      x: -0.12, z: -0.24, w: 0.62, d: 0.4, h: 0.5, floors: 2, wall: pal.stoneWall, roof: pal.slate, roofType: 'gable',
      rh: 0.26, chimney: true, plinth: STONE, doorX: 0, nFront: 3, fancy: false,
    });
    sign(c, -0.12, 0.36, -0.03, 0.26, 0.05, '#3b2f2a');
    treadwheel(c, 0.3, 0.12, Math.PI / 2);
    for (const [x, z] of [[-0.3, 0.18], [-0.1, 0.34], [0.06, 0.16]]) stoneStack(c, x, z, rng.int(2, 3));
    plankStack(c, 0.33, -0.3, 4, Math.PI / 2);
    gb.blob(-0.38, c.gy(-0.38, 0.4), 0.4, 0.07, 0.05, 0.06, '#d4bc88');
    sawhorse(c, -0.32, -0.02, 0.5);
    lamp(c, 0.44, 0.44, 0.3);
    boundary(c, 'stone', -0.47, -0.47, 0.47, 0.47, 0);
  }
};

// --------------------------------------------- joined (2×1) buildings

// Merged buildings run along the longer side of their plot. On a deep plot
// (road at the short end) the row is turned so it runs back from the road.
export function rowFrame(c) {
  const turned = c.Ez > c.Ex + 1e-6;
  if (turned) c.gb.push(0, 0, 0, Math.PI / 2);
  return { len: Math.max(c.Ex, c.Ez) * 2, dep: Math.min(c.Ex, c.Ez) * 2, turned };
}

// A low front-garden boundary with gaps at the doors.
export function frontage(c, x0, x1, z, gaps, kind) {
  const { gb } = c;
  const cuts = gaps.slice().sort((a, b) => a - b);
  let a = x0;
  const seg = (s, e) => {
    if (e - s < 0.04) return;
    const m = (s + e) / 2, y = c.gy(m, z);
    if (kind === 'hedge') gb.cbox(m, y - 0.01, z, e - s, 0.07, 0.05, '#4a7036', 0, 0.015);
    else if (kind === 'wall') gb.cbox(m, y - 0.01, z, e - s, 0.055, 0.04, '#9a9284', 0, 0.01);
    else if (kind === 'railings') {
      gb.cbox(m, y - 0.01, z, e - s, 0.03, 0.035, STONE, 0, 0.006);
      for (let px = s + 0.02; px < e - 0.01; px += 0.03) gb.box(px, y + 0.02, z, 0.006, 0.06, 0.006, '#2f2f33');
    } else {
      for (let px = s + 0.015; px < e; px += 0.035) gb.box(px, y - 0.01, z, 0.014, 0.07, 0.01, '#ece6da');
      gb.box(m, y + 0.035, z - 0.006, e - s, 0.01, 0.006, '#ece6da');
    }
  };
  for (const g of cuts) { seg(a, g - 0.055); a = g + 0.055; }
  seg(a, x1);
}

// A row of houses, in one of its plans: one long roof along the row
// (dormers in it from the Terraced Houses up); a gable to the street over
// every house; a mansard with a dormer for each house; Georgian, a flat roof
// behind a parapet, fanlights over the doors and balconies along the first
// floor; or every house its own height under its own roof. The door cases
// are the row's own (hoods, canopies, porches, fanlights).
MODELS.terrace = (c, L) => {
  const { gb, rng, pal } = c;
  const f = rowFrame(c), F = c.form;
  let plan = planOf(c, 5);
  // cottages: a long roof, gables, or each its own
  if (L === 0 && (plan === 2 || plan === 3)) plan = plan === 2 ? 1 : 4;
  const n = L === 0 ? 3 : 4;
  const floors = L + 1;
  const fh = L === 0 ? 0.33 : 0.27;
  const h = L === 0 ? fh : floors * fh;
  const W = f.len - 0.14, D = [0.46, 0.5, 0.56][L];
  const z0 = -f.dep / 2 + D / 2 + 0.06, fz = z0 + D / 2;
  const brick = L === 1 && (pal.style === 'brick' || rng.chance(0.45));
  const thatch = L === 0 && pal.thatched;
  const roof = thatch ? pal.thatch : L === 2 ? pal.slate : pal.roof, trim = '#e3dccd';
  const walls = [];
  for (let i = 0; i < n; i++) {
    walls.push(pal.forced ? shade(pal.wall, rng.float(0.92, 1.06)) : brick ? shade(pal.brick, rng.float(0.92, 1.06)) : L === 2 ? (rng.chance(0.35) ? rng.pick(PAINTED) : '#ebe4d6') : rng.pick(PAINTED));
  }
  const uw = W / n;
  // every house its own height (a little either way) under its own roof
  const lift = (i) => (plan === 4 ? [0, 0.05, -0.025, 0.035][(i + (F.plan >> 3)) % 4] * (L ? 1.4 : 1) : 0);
  footing(c, 0, z0, W, D);
  const doors = [];
  const kind = plan === 3 ? 'fanlight' : !F.porch || F.porch === 'veranda' || F.porch === 'portico' ? (L ? 'hood' : 'canopy') : F.porch;
  for (let i = 0; i < n; i++) {
    const ux = -W / 2 + (i + 0.5) * uw, hi = h + lift(i);
    gb.cbox(ux, 0, z0, uw + 0.003, hi, D, walls[i], 0, 0.008);
    const flip = i % 2 === 1;   // doors mirror in pairs
    const dx = ux + (flip ? 1 : -1) * uw * 0.24, wx = ux + (flip ? -1 : 1) * uw * 0.14;
    doors.push(dx);
    const dh = Math.min(0.17, fh * 0.6);
    door(c, dx, fz, 0.085, dh, L === 2 ? rng.pick(ACCENT) : rng.pick(DOORS));
    if ((L >= 1 || F.a < 0.5) && kind) porchOf(c, kind === 'portico' ? 'pediment' : kind, dx, fz, dh, walls[i], roof, uw, fh * 0.85);
    if (L === 1 && (plan === 1 || plan === 4) && F.b < 0.7) tallBay(c, wx, fz, fh, 2, walls[i], roof, 0.75, false, 2, 0.12);
    else if (L === 1 && rng.chance(0.6)) bay(c, wx, fz, 0.15, walls[i], roof);
    else win(c, wx, fh * 0.34, fz, 0.1, 0.1, 'f');
    for (let k = 1; k < floors; k++) for (const sx of [-1, 1]) win(c, ux + sx * uw * 0.2, k * fh + fh * 0.34, fz, 0.075, 0.1, 'f');
    for (let k = 0; k < floors; k++) win(c, ux, k * fh + fh * 0.36, z0 - D / 2, 0.075, 0.09, 'b');
    if (plan === 3 && L === 2) balcony(c, 'iron', ux, fh, fz, uw * 0.62);
  }
  for (const sx of [-1, 1]) for (let k = 0; k < floors; k++) win(c, sx * W / 2, k * fh + fh * 0.36, z0, 0.07, 0.09, sx > 0 ? 'r' : 'l');
  if (L === 2 && plan !== 3) {
    gb.box(0, h - 0.035, z0, W + 0.02, 0.035, D + 0.02, '#e3dccd');
    gb.box(0, fh - 0.01, fz + 0.004, W, 0.016, 0.012, '#e3dccd');
  }
  const rh = L === 0 ? 0.27 : 0.24;
  const stack = (x, top) => chimney(c, x, top - 0.12, top, z0, 'home', brick ? shade(pal.brick, 0.88) : STONE);
  if (plan === 2) {
    // a mansard along the row, a dormer for each house
    gb.push(0, 0, z0);
    const M = mansardRoof(c, W + 0.02, D, h, 0.3, roof, trim);
    mansardDormers(c, n, W, D, h, M, walls[0], roof, 0.75);
    gb.pop();
    for (let i = 1; i < n; i++) stack(-W / 2 + i * uw, M.top + 0.06);
  } else if (plan === 3) {
    // Georgian: a flat roof behind a parapet
    gb.push(0, 0, z0);
    parapetRoof(c, W + 0.02, D, h, walls[0], roof, trim);
    gb.pop();
    for (let i = 1; i < n; i++) stack(-W / 2 + i * uw, h + 0.17);
  } else if (plan === 4) {
    // each house its own roof, at its own height
    for (let i = 0; i < n; i++) {
      const ux = -W / 2 + (i + 0.5) * uw, hi = h + lift(i), r2 = rh * (1 + lift(i) * 1.5);
      if (thatch) thatchRoof(c, ux, hi, z0, uw + 0.012, D, r2, walls[i], roof, false);
      else gb.gable(ux, hi, z0, uw + 0.012, D, r2, walls[i], roof, 0.04, false, 0.03);
      if (i) stack(-W / 2 + i * uw, Math.max(hi + r2, h + lift(i - 1) + rh * (1 + lift(i - 1) * 1.5)) + 0.06);
    }
  } else {
    if (thatch) thatchRoof(c, 0, h, z0, W + 0.02, D, rh, walls[0], roof, false);
    else gb.gable(0, h, z0, W + 0.02, D, rh, walls[0], roof, 0.05, false, 0.035);
    for (let i = 1; i < n; i++) chimney(c, -W / 2 + i * uw, h - 0.05, h + rh + 0.07, z0, 'home', brick ? shade(pal.brick, 0.88) : STONE);
    if (plan === 1) {
      // a gable to the street over every house
      const g = L === 0 || pal.style === 'timber' ? 'plain' : F.gable;
      for (let i = 0; i < n; i++) wallGable(c, g, -W / 2 + (i + 0.5) * uw, fz, uw * 0.72, h, rh * 0.95, D * 0.48, walls[i], roof, trim, 0.75);
    } else if (L >= 1) {
      for (let i = 0; i < n; i++) {
        if (L === 1 && !rng.chance(0.5)) continue;
        const x = -W / 2 + (i + 0.5) * uw, dz = z0 + (D / 2) * 0.42, dy = h + rh * 0.1;
        gb.cbox(x, dy, dz, 0.1, 0.12, 0.12, walls[i], 0, 0.012);
        gb.gable(x, dy + 0.12, dz, 0.1, 0.13, 0.07, walls[i], roof, 0.025, true, 0.022);
        win(c, x, dy + 0.025, dz + 0.06, 0.05, 0.065, 'f');
      }
    }
  }
  // front gardens, divided between the houses
  const edge = f.dep / 2 - 0.05;
  frontage(c, -W / 2 - 0.03, W / 2 + 0.03, edge, doors, L === 0 ? (rng.chance(0.5) ? 'picket' : 'hedge') : L === 1 ? 'wall' : 'railings');
  for (let i = 1; i < n; i++) {
    const x = -W / 2 + i * uw, mz = (fz + edge) / 2;
    gb.cbox(x, c.gy(x, mz) - 0.01, mz, 0.035, 0.05, edge - fz - 0.02, L === 2 ? STONE : '#4a7036', 0, 0.01);
  }
  for (let i = 0; i < n; i++) {
    const ux = -W / 2 + (i + 0.5) * uw, gx = ux + (doors[i] < ux ? 1 : -1) * uw * 0.2, gz = (fz + edge) / 2 + 0.02;
    const r = rng.next();
    if (r < 0.35) flowers(c, gx, gz, rng.int(4, 7), 0.06);
    else if (r < 0.55) bush(c, gx, gz, rng.float(0.7, 1));
    else if (r < 0.65 && L === 0) barrel(c, gx, gz, 0.9);
  }
  if (L === 2) { lamp(c, -W / 2 + 0.02, edge + 0.01, 0.3); lamp(c, W / 2 - 0.02, edge + 0.01, 0.3); }
  if (f.turned) gb.pop();
};

// A shop with homes over it, joined from a cottage and a shop (b.flavor: the
// trade the shop sold). It keeps that trade's character: its walls and roof,
// its shopfront with the goods in the windows, its sign on a bracket and its
// wares on the pavement, and from the yard its back door, hoist and the
// trade's own things (see shKit). At one end a door leads up to the homes;
// the party walls carry the chimney stacks. A Market Row has two shopfronts,
// a Merchant Block a third storey. On a street corner the end shop carries
// its front round the corner, the stair door going to the other end.
function shKit(c, flavor, L) {
  const { pal, rng } = c;
  const own = !pal.forced;
  const K = {
    wall: pal.wall, roof: L === 2 ? pal.slate : pal.roof, roofType: L === 2 ? 'hip' : 'gable', rh: 0.26, timber: pal.timber && L < 2, siding: false, dormers: 0,
    fascia: '#5e432c', trim: '#e3dccd', riser: null, letter: '#e0c070', door: pal.accent, bow: false, awning: null, facing: null, lit: L >= 1,
    plan: { hoist: true }, load: 'crate',
  };
  const pick = (list) => rng.pick(list);
  if (flavor === 'market') K.awning = pal.awning;
  else if (flavor === 'bakery') Object.assign(K, { wall: own ? '#e2cfa8' : pal.wall, timber: !own && pal.timber && L < 2, roof: L === 2 ? pal.slate : pal.tile, letter: '#e9dfc9', door: '#5e432c', awning: ownPick(c, ['#c8823a', '#b8503a', '#a86a3a'], 22), plan: { yard: true }, load: null });
  else if (flavor === 'tavern') {
    const paint = ownPick(c, ['#2f4a3a', '#5a2a2a', '#2a2f4a', '#3a2a1f'], 13);
    Object.assign(K, { timber: L < 2, roof: L === 2 ? pal.slate : pal.tile, fascia: paint, riser: shade(paint, 0.8), trim: shade(paint, 1.5), facing: paint, door: paint, lit: true, plan: {}, load: null });
  } else if (flavor === 'grocer') Object.assign(K, { fascia: pick(['#2f4a2a', '#3a4a2a', '#2a3a2a']), awning: pick(['#4f7a45', '#3f6a3a', '#6a8a2a']), load: 'sack' });
  else if (flavor === 'butcher') Object.assign(K, {
    wall: own ? pal.brick : pal.wall, roof: L === 2 ? pal.slate : own ? pal.tile : pal.roof, timber: !own && pal.timber && L < 2,
    facing: L ? '#ece8de' : '#6a2a24', fascia: L ? '#1f3a3a' : '#5a2a22', trim: L ? '#ece8de' : '#e3dccd', riser: L ? '#2f5a4a' : '#7a5a3c', door: '#3a2a22', plan: { stack: true }, load: null,
  });
  else if (flavor === 'cobbler') Object.assign(K, { bow: L < 2, fascia: pick(['#3b2f2a', '#2a2420', '#4a2a2a']), plan: { wide: true }, load: null });
  else if (flavor === 'draper') Object.assign(K, {
    wall: own ? (L === 2 ? pal.stoneWall : ownPick(c, PAINTED, 3)) : pal.wall, roof: own ? pal.slate : pal.roof, roofType: L === 1 ? 'hip' : 'gable', timber: !own && pal.timber && L < 2,
    dormers: L === 2 ? 4 : 3, fascia: pick(['#2a2a4a', '#3a1f2a', '#1f3a3a', '#3b2f2a']), awning: L === 1 ? pal.awning : null, load: 'bolt',
  });
  else if (flavor === 'ironmonger') Object.assign(K, { wall: own ? ownPick(c, ['#4f5a52', '#5a5048', '#46525a'], 5) : pal.wall, siding: own, roof: own ? pal.slate : pal.roof, timber: !own && pal.timber && L < 2, fascia: pick(['#2a3a2a', '#2f2f3a', '#3a2a1f']), plan: { hoist: true, yard: true } });
  else if (flavor === 'chemist') Object.assign(K, {
    wall: own ? (L === 2 ? pal.stoneWall : STUCCO) : pal.wall, roof: own ? pal.slate : pal.roof, roofType: 'hip', rh: 0.24, timber: !own && pal.timber && L < 2,
    bow: L === 0, fascia: pick(['#1f3a3a', '#2a2a4a', '#3a1f2a']), letter: L === 2 ? '#ece6d6' : '#e0c070', plan: { wide: true }, load: null,
  });
  else if (flavor === 'stationer') Object.assign(K, { roof: L ? pal.slate : pal.forced ? pal.roof : pal.tile, roofType: 'halfhip', rh: 0.3, dormers: 3, fascia: pick(['#2a3a4a', '#3b2f2a', '#4a2a2a', '#2f3e2a']), plan: {}, load: null });
  else if (flavor === 'coffeehouse') {
    const pastel = ownPick(c, ['#c87a8a', '#7a9ac8', '#8ab08a', '#c8a050'], 9);
    Object.assign(K, { wall: own ? ownPick(c, PAINTED, 8) : pal.wall, roof: L ? pal.slate : pal.roof, timber: !own && !L && pal.timber, bow: L < 2, fascia: L ? shade(pastel, 0.6) : pick(['#3b2f2a', '#2f3e2a', '#4a2a2a']), awning: L ? pastel : null, plan: {}, load: null });
  } else if (flavor === 'postoffice') Object.assign(K, { wall: pal.forced ? pal.wall : L ? pal.stoneWall : '#efe9dc', roof: pal.slate, timber: !L && pal.timber, fascia: '#a8282a', riser: '#6a1a1c', letter: '#ece6d6', door: '#a8282a', lit: true, plan: {}, load: null });
  return K;
}

MODELS.shophouse = (c, L) => {
  const { gb, rng, pal } = c;
  const f = rowFrame(c);
  const flavor = c.flavor || 'market';
  const K = shKit(c, flavor, L);
  const n = L === 0 ? 2 : 3, floors = L === 2 ? 3 : 2, fh = 0.27, h = floors * fh;
  const W = f.len - 0.12, D = [0.54, 0.58, 0.62][L];
  const z0 = -f.dep / 2 + D / 2 + 0.06, fz = z0 + D / 2;
  const jet = K.timber && pal.jetty ? 0.035 : 0, rh = K.rh * pal.pitch;
  // a row that runs back from the street (turned) has no corner of its own
  const corner = f.turned ? 0 : c.corner;
  // the stair door up to the homes at one end (away from a street corner)
  // and the shops along the rest
  const st = corner === 2 ? -1 : 1, sw0 = 0.34, uw = (W - sw0) / (n - 1);
  const shopX = (i) => (st > 0 ? -W / 2 : -W / 2 + sw0) + (i + 0.5) * uw, stairX = st * (W / 2 - sw0 / 2);
  const body = { z: z0, w: W, d: D, h, floors, nFront: n * 2, timber: K.timber };
  const P = backPlan(c, body, K.plan);
  house(c, {
    ...body, wall: K.wall, roof: K.roof, roofType: K.roofType, rh: K.rh, siding: K.siding, dormers: K.dormers, noDoor: true, bareFront: 1, shopWindow: true,
    chimney: false, lit: 0.9, bareSide: corner, backClear: P.clear,
  });
  // the stacks on the party walls
  const wallX = (i) => (st > 0 ? -W / 2 + i * uw : -W / 2 + sw0 + (i - 1) * uw);
  for (let i = 1; i < n; i++) chimney(c, wallX(i), h - 0.05, h + (K.roofType === 'hip' ? 0.3 : rh + 0.08), z0 - 0.06, flavor === 'bakery' && i === 1 ? 'work' : 'home', flavor === 'bakery' && i === 1 ? '#8f4f3a' : STONE);
  // the shops: the trade's shopfront, its goods in the windows, and its awning
  let sf = null;
  for (let i = 0; i < n - 1; i++) {
    const ux = shopX(i);
    if (K.facing) gb.box(ux, 0, fz + 0.003, uw, 0.26, 0.006, K.facing);
    sf = shopfront(c, ux, fz + (K.facing ? 0.006 : 0), uw - 0.04, 0.26, { fascia: K.fascia, trim: K.trim, riser: K.riser, letter: K.letter, lit: K.lit, bow: K.bow, door: K.door });
    if (WARES[flavor]) WARES[flavor](c, sf, L);
    if (K.awning) awning(c, ux, sf.top - 0.004, fz, uw - 0.02, K.awning);
    if (flavor === 'butcher') gb.cyl(ux + uw / 2 - 0.01, sf.top - 0.004, fz + 0.042, 0.011, 0.011, uw - 0.02, 8, ownPick(c, ['#2f5a8a', '#3a4a7a'], 14), 0, 0, Math.PI / 2);
    if (flavor === 'postoffice') wallClock(c, ux, fh + 0.05, fz + jet + 0.002, 0.034);
    if (flavor === 'ironmonger') {
      // pails, lanterns and a kettle hung along a rail over the shop
      const ry = 0.37, rz = fz + jet + 0.05, k = Math.round((uw - 0.1) / 0.07);
      gb.box(ux, ry, rz, uw - 0.06, 0.008, 0.008, IRON_D);
      for (const s of [-1, 1]) gb.box(ux + s * (uw / 2 - 0.04), ry - 0.003, fz + jet + 0.025, 0.008, 0.008, 0.05, IRON_D);
      for (let j = 0; j < k; j++) {
        const x = ux - uw / 2 + 0.05 + (j + 0.5) * ((uw - 0.1) / k);
        gb.box(x, ry - 0.012, rz, 0.003, 0.012, 0.003, IRON_D);
        if (j % 3 === 1) { gb.cyl(x, ry - 0.05, rz, 0.016, 0.02, 0.034, 6, '#3a3a3e'); gb.cone(x, ry - 0.016, rz, 0.016, 0.012, 6, '#3a3a3e'); }
        else pail(c, x, ry - 0.06, rz, 0.85);
      }
    }
  }
  // the stair door up to the homes, with a window beside it
  door(c, stairX - st * 0.07, fz, 0.08, 0.17, pal.door);
  win(c, stairX + st * 0.08, fh * 0.36, fz, 0.075, 0.1, 'f');
  // the trade's sign at the outer end of the shops, and its goods outside
  const sx = (shopX(0) + shopX(n - 2)) / 2, pz = fz + 0.2, ex = -st * (W / 2 - 0.08);
  if (flavor === 'bakery') {
    const bx = -st * (W / 2 - 0.08), by = c.gy(bx, pz);
    gb.box(bx, by, pz, 0.016, 0.3, 0.016, '#3f342c');
    gb.box(bx + st * 0.05, by + 0.28, pz, 0.11, 0.016, 0.016, '#3f342c');
    gb.cyl(bx + st * 0.08, by + 0.2, pz, 0.045, 0.045, 0.014, 12, '#c9944a', 0, Math.PI / 2);
    for (let i = 0; i < 3; i++) gb.sphere(sx - 0.06 + i * 0.06, c.gy(sx, pz) + 0.025, pz, 0.026, '#e2d4b4', 1, 0.8);
  } else if (flavor === 'tavern') {
    const by = fh + 0.06;
    gb.box(ex, by, fz + jet + 0.05, 0.012, 0.012, 0.1, '#2f2c2a');
    sign(c, ex, by - 0.11, fz + jet + 0.09, 0.1, 0.1, rng.pick(['#7a3a2a', '#2f4a6a', '#3f5a3a']), Math.PI / 2);
    barrel(c, sx - 0.12, pz); barrel(c, sx - 0.05, pz + 0.04, 0.9);
    bench(c, sx + 0.12, pz + 0.02, Math.PI);
    lamp(c, -ex, pz + 0.06, 0.28);
  } else if (SHOP_SIGNS[flavor]) {
    const [kind, col] = SHOP_SIGNS[flavor];
    hangSign(c, ex, fh + 0.06, fz + jet, kind, col);
    pavementWares(c, flavor, sx, pz);
  } else {
    const goods = ['#b8402f', '#d98a32', '#7aa34a', '#d9c050', '#6f4a8a'];
    for (let i = 0; i < 3; i++) {
      const x = sx - 0.12 + i * 0.12, y = c.gy(x, pz);
      gb.cbox(x, y, pz, 0.09, 0.06, 0.07, '#86613e', rng.float(-0.2, 0.2), 0.006);
      for (let k = 0; k < 3; k++) gb.sphere(x - 0.025 + k * 0.025, y + 0.075, pz, 0.015, rng.pick(goods), 1);
    }
    crate(c, sx + 0.24, pz + 0.04);
  }
  if (flavor === 'chemist') for (const s of [-1, 1]) { const x = shopX(0) + s * 0.09, z = fz + 0.12; gb.cyl(x, c.gy(x, z), z, 0.02, 0.016, 0.03, 7, '#a8603a'); flowers(c, x, z, 3, 0.012); }
  // on a street corner the end shop carries its front round it
  if (corner) {
    const o = { fascia: K.fascia, trim: K.trim, riser: K.riser, letter: K.letter, lit: K.lit, bow: K.bow, awning: K.awning, facing: K.facing, lim: f.len / 2 };
    if (flavor === 'tavern') cornerFronts(c, { x0: 0, w: W, fz, d: D }, o);
    else cornerShop(c, flavor, L, { x0: 0, w: W, fz, d: D }, o);
  }
  // round the back: the trade's name, its back door and hoist, and what it
  // keeps there (a smoke-house flue, an oven, a workshop window...)
  shopBack(c, P, { fascia: K.fascia, letter: K.letter, door: flavor === 'postoffice' ? '#a8282a' : null, doorW: flavor === 'postoffice' ? 0.12 : 0.08, load: K.load, boltColor: ownPick(c, PAINTED, 12) });
  if (flavor === 'butcher') backFlue(c, P.x0 + P.far, P.zb, h + 0.14, { color: K.wall === pal.brick ? shade(pal.brick, 0.9) : '#8f4f3a' });
  else if (flavor === 'bakery') breadOven(c, P.x0 + P.far, P.zb, '#9a5a42');
  else if (flavor === 'cobbler') backWindow(c, P.x0 + P.next, 0.07, P.zb, P.bw * 0.7, 0.11);
  else if (flavor === 'chemist') { backWindow(c, P.x0 + P.next, 0.07, P.zb, P.bw * 0.66, 0.11, [0.6, 1.9, 1.0]); backFlue(c, P.x0 + (P.next + P.far) / 2, P.zb, h + 0.12, { tin: true, y0: 0.06 }); }
  else if (flavor === 'coffeehouse') backFlue(c, P.x0 + (P.next + P.far) / 2, P.zb, h + 0.1, { tin: true, color: '#2a2a2e', y0: 0.04 });
  else if (flavor === 'ironmonger') leaningBars(c, P.x0 + P.far, P.zb, 6);
  else if (flavor === 'stationer') roofLights(c, 0, h, z0, D + jet * 2, rh, L ? [-0.6, -0.3, 0, 0.3, 0.6] : [-0.45, -0.15, 0.15, 0.45]);
  if (f.turned) gb.pop();
};

// ------------------------------------------------------------- utilities

// Which side of the plot the water is on (the lowest ground), as a local
// direction. Without terrain (thumbnails) it's the back.
function waterSide(c) {
  let best = [0, -1], lo = Infinity;
  for (const [dx, dz] of [[0, -1], [1, 0], [-1, 0], [0, 1]]) {
    const g = c.gy(dx * 0.62, dz * 0.62);
    if (g < lo - 1e-3) { lo = g; best = [dx, dz]; }
  }
  return best;
}

// A wooden utility pole with a cross-arm and insulators.
function pole(c, x, z, h = 0.5) {
  const { gb } = c;
  const y = c.gy(x, z);
  gb.cyl(x, y - 0.02, z, 0.011, 0.015, h + 0.02, 6, '#5e4630');
  gb.box(x, y + h - 0.06, z, 0.16, 0.014, 0.016, '#5e4630');
  for (const s of [-1, 1]) gb.cyl(x + s * 0.06, y + h - 0.046, z, 0.008, 0.008, 0.02, 5, '#d8d0c0');
}

MODELS.watermill = (c, L) => {
  const { gb, rng, pal } = c;
  const [sx, sz] = waterSide(c);
  const w = L ? 0.54 : 0.44, d = L ? 0.44 : 0.38, h = L ? 0.5 : 0.32;
  const hx = -sx * 0.12, hz = -sz * 0.12;
  // the mill under a gable or a hip, or (planOf) a lucam: the hoist's gabled
  // housing standing out from the front over the loading doors
  const kind = planOf(c, 3);
  house(c, {
    x: hx, z: hz, w, d, h, floors: L ? 2 : 1, wall: L ? pal.brick : pal.wall, roof: L ? pal.slate : pal.roof, roofType: kind === 1 ? 'hip' : 'gable',
    rh: kind === 2 ? 0.28 : 0.22, timber: !L && pal.timber, nFront: 2, chimney: false, lit: 0.7, fancy: false, plinth: STONE,
  });
  if (kind === 2) {
    const lz = hz + d / 2 + 0.05, ly = h - 0.04;
    gb.cbox(hx, ly, lz - 0.02, 0.14, 0.18, 0.14, pal.wood, 0, 0.008);
    gb.gable(hx, ly + 0.18, lz - 0.02, 0.15, 0.15, 0.08, pal.wood, L ? pal.slate : pal.roof, 0.015, true, 0.02);
    gb.box(hx, ly + 0.03, lz + 0.052, 0.07, 0.11, 0.006, '#4e3828');
  }
  // the wheel turns in the stream beside the mill
  const R = L ? 0.24 : 0.2;
  const off = (sx ? w : d) / 2 + 0.06;
  const wx = hx + sx * off, wz = hz + sz * off;
  const wy = Math.max(0.1, c.gy(wx, wz) + R * 0.55);
  const wheel = new GeoBuilder();
  wheel.vary = 0.06;
  const n = 10;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    wheel.boxC(Math.cos(a) * R, Math.sin(a) * R, 0, 2 * R * Math.sin(Math.PI / n) + 0.01, 0.022, 0.1, '#6e5034', 0, 0, a + Math.PI / 2);
    wheel.boxC(Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5, 0, R, 0.014, 0.014, '#5e432c', 0, 0, a);
    wheel.boxC(Math.cos(a) * (R + 0.025), Math.sin(a) * (R + 0.025), 0, 0.055, 0.012, 0.1, '#86663f', 0, 0, a);
  }
  wheel.boxC(0, 0, 0, 0.05, 0.05, 0.16, '#3a2f28');
  c.spin = { geo: wheel.build(), x: wx, y: wy, z: wz, speed: 0.7, ry: sx ? Math.PI / 2 : 0 };
  // stone wheel pit and a flume bringing the water in
  gb.cbox(wx - sz * 0.0, Math.min(0, c.gy(wx, wz)) - 0.1, wz, sx ? 0.22 : 0.62, 0.1, sx ? 0.62 : 0.22, STONE_D, 0, 0.01);
  gb.box(wx - sz * 0.0 + (sx ? 0 : -0.1), wy + R + 0.04, wz + (sx ? -0.1 : 0), sx ? 0.08 : 0.3, 0.03, sx ? 0.3 : 0.08, '#6e5034');
  // dynamo shed and the line out to the town
  const dx = hx - sx * 0.02 + (sz ? 0.32 : 0), dz = hz + 0.3;
  gb.cbox(dx, c.gy(dx, dz), dz, 0.14, 0.12, 0.12, '#7a6a58', 0, 0.008);
  gb.wedge(dx, c.gy(dx, dz) + 0.12, dz, 0.16, 0.14, 0.04, pal.slate, 0);
  pole(c, 0.4, 0.42);
  if (L) pole(c, -0.4, 0.42);
  sign(c, hx, 0.24, hz + d / 2 + 0.008, 0.18, 0.04, '#3b2f2a');
  void rng;
};

// A wind generator, its own kind (planOf). The Wind Generator: a smock mill
// with four canvas sails; a round brick tower mill under a white cap; or a
// windpump, a wheel of many blades and a tail vane on a lattice tower. The
// Wind Turbine: three blades on a slim white mast, or two on a lattice one.
MODELS.windgen = (c, L) => {
  const { gb, pal } = c;
  const kind = planOf(c, 3);
  if (L === 0 && kind === 2) {
    // a windpump: a lattice tower, a wheel of blades, a tail vane
    footing(c, 0, -0.05, 0.3, 0.3);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) gb.box(sx * 0.11, 0, -0.05 + sz * 0.11, 0.016, 0.66, 0.016, '#5a5a5e', 0, -sz * 0.12, sx * 0.12);
    for (const y of [0.2, 0.42]) { gb.box(0, y, -0.05 + 0.09 - y * 0.08, 0.2 - y * 0.16, 0.012, 0.012, '#5a5a5e'); gb.box(0, y, -0.05 - 0.09 + y * 0.08, 0.2 - y * 0.16, 0.012, 0.012, '#5a5a5e'); }
    gb.box(0, 0.64, -0.05, 0.08, 0.04, 0.08, '#4a4a4e');
    gb.box(0, 0.66, -0.2, 0.012, 0.012, 0.22, '#4a4a4e');
    gb.box(0, 0.62, -0.32, 0.006, 0.1, 0.12, '#c8423a');
    door(c, 0, 0.13, 0.07, 0.13, '#4a4a4e');
    const fan = new GeoBuilder();
    for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2; fan.boxC(Math.cos(a) * 0.12, Math.sin(a) * 0.12, 0, 0.14, 0.035, 0.006, '#d8d4cc', 0.3, 0, a); }
    fan.cyl(0, 0, -0.01, 0.2, 0.2, 0.008, 16, '#5a5a5e', 0, Math.PI / 2);
    fan.cyl(0, 0, 0, 0.03, 0.03, 0.03, 8, '#3a3a3e', 0, Math.PI / 2);
    c.spin = { geo: fan.build(), x: 0, y: 0.66, z: 0.03, speed: 1.6 };
    gb.cbox(0.3, c.gy(0.3, 0.25), 0.25, 0.16, 0.12, 0.14, '#7a6a58', 0, 0.008);
    gb.wedge(0.3, c.gy(0.3, 0.25) + 0.12, 0.25, 0.18, 0.16, 0.04, pal.slate, 0);
    pole(c, -0.38, 0.38);
  } else if (L === 0) {
    // a smock mill (or a brick tower mill) with four canvas sails driving a dynamo
    footing(c, 0, -0.05, 0.36, 0.36);
    if (kind === 1) {
      gb.cyl(0, 0, -0.05, 0.12, 0.16, 0.6, 12, pal.brick);
      gb.cyl(0, 0.6, -0.05, 0.13, 0.13, 0.03, 12, '#e8e2d4');
      gb.sphere(0, 0.62, -0.05, 0.13, '#e8e2d4', 1, 0.8);
      gb.glow(WARM[0], WARM[1], WARM[2], 1.2); gb.box(0.135, 0.36, -0.05, 0.012, 0.07, 0.04, GLASS); gb.box(-0.135, 0.36, -0.05, 0.012, 0.07, 0.04, GLASS); gb.box(0, 0.36, -0.185, 0.04, 0.07, 0.012, GLASS); gb.noGlow();
    } else {
      gb.cyl(0, 0, -0.05, 0.12, 0.17, 0.6, 8, '#a8885c');
      for (let k = 0; k < 3; k++) gb.cyl(0, 0.15 + k * 0.17, -0.05, 0.172 - k * 0.017, 0.172 - k * 0.017, 0.012, 8, '#5e4630');
      gb.cone(0, 0.6, -0.05, 0.15, 0.14, 8, pal.roof);
    }
    door(c, 0, 0.11, 0.07, 0.14, pal.door);
    const sails = new GeoBuilder();
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      sails.boxC(Math.cos(a) * 0.17, Math.sin(a) * 0.17, 0, 0.34, 0.016, 0.012, '#5e4630', 0, 0, a);
      sails.boxC(Math.cos(a) * 0.2 + Math.cos(a + Math.PI / 2) * 0.035, Math.sin(a) * 0.2 + Math.sin(a + Math.PI / 2) * 0.035, 0.004, 0.24, 0.06, 0.006, '#e8e0cc', 0, 0, a);
    }
    sails.cyl(0, 0, -0.03, 0.025, 0.025, 0.05, 6, '#3a2f28', 0, Math.PI / 2);
    c.spin = { geo: sails.build(), x: 0, y: 0.62, z: 0.1, speed: 1.3 };
    gb.cbox(0.3, c.gy(0.3, 0.25), 0.25, 0.16, 0.12, 0.14, '#7a6a58', 0, 0.008);
    gb.wedge(0.3, c.gy(0.3, 0.25) + 0.12, 0.25, 0.18, 0.16, 0.04, pal.slate, 0);
    pole(c, -0.38, 0.38);
  } else {
    // a tall wind turbine on a slim mast (or two blades on a lattice mast)
    const lattice = kind === 1;
    footing(c, 0, -0.05, 0.16, 0.16);
    gb.cbox(0, -0.02, -0.05, lattice ? 0.24 : 0.16, 0.05, lattice ? 0.24 : 0.16, STONE, 0, 0.01);
    if (lattice) {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) gb.box(sx * 0.07, 0.02, -0.05 + sz * 0.07, 0.014, 1.27, 0.014, '#8a8a90', 0, -sz * 0.05, sx * 0.05);
      for (let y = 0.25; y < 1.2; y += 0.25) { const hw = 0.07 - y * 0.05; for (const sz of [-1, 1]) gb.box(0, y, -0.05 + sz * hw, hw * 2, 0.008, 0.008, '#8a8a90'); }
    } else gb.cyl(0, 0.02, -0.05, 0.022, 0.04, 1.28, 8, '#e6e4de');
    gb.cbox(0, 1.27, -0.09, 0.07, 0.07, 0.19, '#dcdad4', 0, 0.01);
    const blades = new GeoBuilder(), nb = lattice ? 2 : 3;
    for (let k = 0; k < nb; k++) {
      const a = (k / nb) * Math.PI * 2 + Math.PI / 2;
      blades.boxC(Math.cos(a) * 0.24, Math.sin(a) * 0.24, 0, 0.46, 0.035, 0.008, '#f0eee8', 0, 0, a);
    }
    blades.sphere(0, 0, 0.01, 0.03, '#d0cec8', 1);
    c.spin = { geo: blades.build(), x: 0, y: 1.305, z: 0.03, speed: 2.4 };
    gb.cbox(0.3, c.gy(0.3, 0.28), 0.28, 0.18, 0.14, 0.14, '#d8d2c4', 0, 0.008);
    gb.box(0.3, c.gy(0.3, 0.28) + 0.14, 0.28, 0.2, 0.02, 0.16, '#5a5f63');
    pole(c, -0.38, 0.38);
  }
};

MODELS.pump = (c, L) => {
  const { gb, pal } = c;
  const [sx, sz] = waterSide(c);
  const hx = -sx * 0.1, hz = -sz * 0.1;
  const w = L ? 0.56 : 0.42, d = L ? 0.44 : 0.36;
  const kind = planOf(c, 3);
  house(c, {
    x: hx, z: hz, w, d, h: L ? 0.44 : 0.32, wall: kind === 2 ? pal.stoneWall : pal.brick, roof: pal.slate, roofType: kind === 1 ? 'hip' : 'gable', rh: 0.18,
    nFront: 2, chimney: false, lit: 0.8, fancy: false, plinth: STONE,
  });
  const cx = hx - (sx ? 0 : w * 0.3) , cz = hz - (sz ? 0 : d * 0.3);
  chimney(c, cx, 0.2, L ? 1.05 : 0.8, cz, 'heavy', '#7f3f2e');
  // intake pipe down to the water
  const ex = hx + sx * ((sx ? w : d) / 2 + 0.2), ez = hz + sz * ((sx ? w : d) / 2 + 0.2);
  const mx = (hx + ex) / 2 + (sx ? 0 : 0.1), mz = (hz + ez) / 2 + (sz ? 0 : 0.1);
  gb.boxC(mx, Math.max(c.gy(mx, mz), -0.1) + 0.04, mz, sx ? 0.36 : 0.04, 0.04, sx ? 0.04 : 0.36, '#4a4a4e');
  gb.cyl(ex + (sx ? 0 : 0.1), Math.min(c.gy(ex, ez), 0) - 0.12, ez + (sz ? 0 : 0.1), 0.035, 0.035, 0.2, 8, '#4a4a4e');
  if (L && kind === 2) {
    // a standpipe tower, tall and round under a little dome
    const tx = (sx ? 0 : 0.3) - sx * 0.3, tz = 0.28, ty = c.gy(tx, tz);
    gb.cyl(tx, ty - 0.02, tz, 0.07, 0.085, 0.78, 10, pal.stoneWall);
    gb.cyl(tx, ty + 0.76, tz, 0.09, 0.09, 0.03, 10, STONE_D);
    gb.sphere(tx, ty + 0.79, tz, 0.08, '#4a5560', 1, 0.9);
  } else if (L) {
    // a raised tank on iron legs
    const tx = -hx * 0 + (sx ? 0 : 0.3) - sx * 0.3, tz = 0.28;
    for (const ax of [-1, 1]) for (const az of [-1, 1]) gb.box(tx + ax * 0.08, c.gy(tx, tz), tz + az * 0.08, 0.02, 0.5, 0.02, '#3a3a3e');
    gb.cyl(tx, c.gy(tx, tz) + 0.5, tz, 0.13, 0.13, 0.16, 12, '#6f7f86');
    gb.cone(tx, c.gy(tx, tz) + 0.66, tz, 0.14, 0.06, 12, '#4a5560');
  } else {
    gb.cyl(0.32, c.gy(0.32, 0.3), 0.3, 0.09, 0.1, 0.16, 12, '#6f7f86');
  }
};

MODELS.powerplant = (c, L) => {
  const { gb, pal } = c;
  const brick = pal.style === 'stone' ? pal.stoneWall : pal.brick;
  // turbine hall with tall windows: under a gable, a hip, or a gable with a
  // monitor of lit windows along its ridge (planOf)
  const plan = planOf(c, 3), hh = L ? 0.72 : 0.6;
  house(c, {
    x: -0.22, z: -0.18, w: 1.1, d: 0.66, h: hh, floors: 2, wall: brick, roof: pal.slate, roofType: plan === 1 ? 'hip' : 'gable', rh: plan === 2 ? 0.16 : 0.22,
    fancy: false, nFront: 6, doorX: 0, doorW: 0.14, lit: 0.85, plinth: STONE_D, chimney: false,
  });
  if (plan === 2) {
    gb.cbox(-0.22, hh + 0.1, -0.18, 0.9, 0.1, 0.24, shade(brick, 0.9), 0, 0.006);
    gb.glow(WARM[0], WARM[1], WARM[2], 1.3); for (const s2 of [-1, 1]) gb.box(-0.22, hh + 0.12, -0.18 + s2 * 0.122, 0.84, 0.05, 0.008, GLASS); gb.noGlow();
    gb.gable(-0.22, hh + 0.2, -0.18, 0.94, 0.28, 0.06, brick, pal.slate, 0.02, false, 0.02);
  }
  // boiler house and chimneys
  const bx = 0.62, bz = -0.36;
  footing(c, bx, bz, 0.5, 0.52);
  gb.cbox(bx, 0, bz, 0.5, 0.52, 0.52, shade(brick, 0.88), 0, 0.016);
  gb.hip(bx, 0.52, bz, 0.5, 0.52, 0.12, pal.slate, 0.04);
  const stacks = plan === 1 ? (L ? [[0.48, -0.68], [0.76, -0.68]] : [[0.48, -0.68], [0.76, -0.68]]) : L ? [[0.5, -0.66], [0.78, -0.66], [0.64, -0.12]] : [[0.62, -0.68]];
  for (const [x, z] of stacks) {
    const top = L ? 1.75 : 1.5;
    gb.cyl(x, 0.3, z, 0.06, 0.085, top - 0.3, 10, '#7f3f2e');
    gb.cyl(x, top, z, 0.07, 0.07, 0.04, 10, '#5e2e22');
    c.addSmoke(x, top + 0.05, z, 'heavy');
  }
  // coal heaps and a little rail of tubs
  gb.blob(-0.55, c.gy(-0.55, 0.55) - 0.02, 0.55, 0.3, 0.13, 0.22, '#2a2826');
  gb.blob(-0.2, c.gy(-0.2, 0.62) - 0.02, 0.62, 0.18, 0.08, 0.14, '#33302d');
  for (let i = 0; i < 3; i++) gb.cbox(0.1 + i * 0.12, c.gy(0.1 + i * 0.12, 0.6), 0.6, 0.09, 0.06, 0.07, '#4a4a4e', 0, 0.006);
  // transformer yard
  for (const [x, z] of [[0.55, 0.3], [0.8, 0.3], [0.55, 0.6], [0.8, 0.6]]) pole(c, x, z, 0.46);
  gb.cbox(0.68, c.gy(0.68, 0.45), 0.45, 0.14, 0.12, 0.12, '#5a5f63', 0, 0.008);
  fence(c, 0.42, 0.18, 0.94, 0.9, '#5a5a5e', { x: 0.68, z: 0.9, w: 0.08 });
};

// ------------------------------------------------- combination buildings
// All sit on a double plot laid out along its long side (see rowFrame).

MODELS.arcade = (c, L) => {
  const { gb, rng, pal } = c;
  const f = rowFrame(c);
  const W = f.len - 0.12, D = 0.6, z0 = -f.dep / 2 + D / 2 + 0.05, fz = z0 + D / 2;
  const h = [0.42, 0.6, 0.78][L];
  const wall = L ? pal.stoneWall : pal.wall, trim = '#e3dccd';
  footing(c, 0, z0, W, D);
  gb.cbox(0, 0, z0 - 0.07, W, h, D - 0.14, wall, 0, 0.02);
  // an arcade of piers along the front, shops behind
  const n = Math.max(4, Math.round(W / 0.24));
  gb.box(0, -0.01, fz - 0.04, W, 0.02, 0.15, '#cfc6b4');
  for (let i = 0; i <= n; i++) gb.cbox(-W / 2 + (i * W) / n, 0, fz - 0.02, 0.05, h * 0.6, 0.05, trim, 0, 0.008);
  gb.box(0, h * 0.6, fz - 0.04, W + 0.04, 0.05, 0.1, trim);
  for (let i = 0; i < n; i++) {
    const x = -W / 2 + ((i + 0.5) * W) / n;
    if (i === n >> 1) door(c, x, fz - 0.11, 0.1, 0.18, '#3f4f5a');
    else win(c, x, 0.05, fz - 0.11, (W / n) * 0.55, 0.15, 'f', 0.95);
    gb.boxC(x, h * 0.5, fz + 0.06, W / n, 0.012, 0.12, i % 2 ? '#e9dfc9' : pal.awning, 0.45);
  }
  for (let k = 1; k < (L ? 3 : 2); k++) for (let i = 0; i < n; i++) win(c, -W / 2 + ((i + 0.5) * W) / n, h * 0.6 + 0.06 + (k - 1) * 0.18, fz - 0.06, 0.07, 0.1, 'f');
  // the roof, its own way (planOf): a long gable (with gables to the street
  // over the arcade, or not), a hip with a clock lantern, or a mansard with
  // a pedimented middle
  const plan = planOf(c, 3);
  if (L === 0 || plan === 1) {
    gb.gable(0, h, z0 - 0.07, W + 0.02, D - 0.1, 0.22, wall, L ? pal.slate : pal.roof, 0.05, false, 0.035);
    if (plan === 1) for (const x of [-W * 0.3, 0, W * 0.3]) wallGable(c, 'plain', x, fz - 0.07, 0.3, h, 0.2, 0.25, wall, L ? pal.slate : pal.roof, trim, 0.8);
  } else if (plan === 2) {
    gb.push(0, 0, z0 - 0.07);
    const M = mansardRoof(c, W + 0.02, D - 0.1, h, 0.3, pal.slate, trim);
    mansardDormers(c, 5, W * 0.9, D - 0.1, h, M, wall, pal.slate, 0.7);
    gb.pop();
    gb.gable(0, h + 0.01, fz - 0.06, 0.5, 0.04, 0.12, trim, trim, 0.01, true);
  } else {
    gb.hip(0, h, z0 - 0.07, W + 0.02, D - 0.1, 0.26, pal.slate, 0.05);
    // a clock lantern on the ridge
    gb.cbox(0, h + 0.2, z0 - 0.07, 0.15, 0.16, 0.15, trim, 0, 0.01);
    gb.glow(1.2, 1.1, 0.8, 1.02); gb.cyl(0, h + 0.28, z0 + 0.006, 0.045, 0.045, 0.01, 12, '#efe8da', 0, Math.PI / 2); gb.noGlow();
    gb.roof(0, h + 0.36, z0 - 0.07, 0.18, 0.18, 0.14, 0, pal.slate);
  }
  // round arches over the arcade, on some
  if (c.form.b < 0.5) for (let i = 0; i < n; i++) gb.arch(-W / 2 + ((i + 0.5) * W) / n, h * 0.6 - (W / n) * 0.42, fz - 0.015, (W / n) * 0.42, 0.03, 8, trim);
  if (L >= 2) { gb.glow(1.6, 1.4, 1.0, 1.5); gb.box(0, h + 0.005, z0 - 0.07, W * 0.5, 0.03, 0.18, '#a9c4c8'); gb.noGlow(); }
  sign(c, 0, h * 0.6 + 0.03, fz + 0.012, 0.36, 0.06, '#3b2f2a');
  const goods = ['#b8402f', '#d98a32', '#7aa34a', '#d9c050', '#6f4a8a'];
  for (let i = 0; i < 4; i++) {
    const x = -W / 2 + 0.2 + i * (W - 0.4) / 3, pz = fz + 0.17, y = c.gy(x, pz);
    gb.cbox(x, y, pz, 0.1, 0.06, 0.07, '#86613e', rng.float(-0.2, 0.2), 0.006);
    for (let k = 0; k < 3; k++) gb.sphere(x - 0.025 + k * 0.025, y + 0.075, pz, 0.015, rng.pick(goods), 1);
  }
  lamp(c, -W / 2 + 0.02, fz + 0.24, 0.3); lamp(c, W / 2 - 0.02, fz + 0.24, 0.3);
  if (f.turned) gb.pop();
};

MODELS.inn = (c, L) => {
  const { gb, rng, pal } = c;
  const f = rowFrame(c);
  const W = f.len - 0.14, D = [0.52, 0.56, 0.62][L], z0 = -f.dep / 2 + D / 2 + 0.06, fz = z0 + D / 2;
  const floors = L + 2, h = floors * 0.26;
  const wall = L === 2 ? '#ebe4d6' : pal.wall;
  // main house, with a carriage arch through to the yard behind
  // under one long roof, with gables to the street, or (the Grand Hotel) a
  // mansard and a corner dome (planOf)
  const plan = planOf(c, 3);
  house(c, {
    x: 0, z: z0, w: W, d: D, h, floors, wall, roof: L === 2 ? pal.slate : pal.roof, roofType: L === 2 ? (plan === 2 ? 'mansard' : 'hip') : 'gable', rh: L === 2 && plan === 2 ? 0.32 : 0.26,
    dormers: L === 2 && plan === 2 ? 6 : undefined, timber: L < 2 && pal.timber, nFront: Math.round(W / 0.2), doorX: -W * 0.3, chimney: true, lit: 0.95, fancy: false, plinth: STONE,
  });
  if (plan === 1) for (const x of [-W * 0.3, W * 0.05, W * 0.38]) wallGable(c, L < 2 && pal.timber ? 'plain' : c.form.gable, x, fz, 0.26, h, 0.22, D * 0.42, wall, L === 2 ? pal.slate : pal.roof, '#e3dccd', 0.9);
  if (L === 2 && plan === 2) turret(c, 'dome', W / 2 - 0.08, fz - 0.06, 0, h + 0.2, 0.1, 0.26, wall, '#5f8f7e', 0.9);
  const ax = W * 0.18;
  gb.box(ax, 0, fz + 0.004, 0.2, 0.22, 0.012, '#3a2f28');
  gb.cyl(ax, 0.22, fz + 0.006, 0.1, 0.1, 0.012, 10, '#3a2f28', 0, Math.PI / 2);
  gb.box(ax, 0.24, fz + 0.012, 0.26, 0.03, 0.02, STONE);
  // hanging sign, lanterns, benches and barrels
  gb.box(-W / 2 + 0.06, h * 0.55, fz + 0.06, 0.012, 0.012, 0.12, '#2f2c2a');
  sign(c, -W / 2 + 0.06, h * 0.55 - 0.12, fz + 0.11, 0.11, 0.11, rng.pick(['#7a3a2a', '#2f4a6a', '#3f5a3a']), Math.PI / 2);
  for (const x of [-W * 0.1, W * 0.42]) { gb.glow(2.2, 1.6, 0.8, 3.0); gb.box(x, 0.26, fz + 0.03, 0.04, 0.05, 0.04, '#ffe2a0'); gb.noGlow(); }
  bench(c, -W * 0.1, fz + 0.12, Math.PI); barrel(c, W * 0.34, fz + 0.12); barrel(c, W * 0.4, fz + 0.16, 0.9);
  if (L === 2) {
    // a veranda and flags for the grand hotel
    for (let i = 0; i < 6; i++) gb.cyl(-W / 2 + 0.1 + i * (W - 0.2) / 5, 0, fz + 0.1, 0.012, 0.014, 0.26, 6, '#ece6da');
    gb.box(0, 0.26, fz + 0.06, W - 0.1, 0.02, 0.14, '#ece6da');
    for (const x of [-W * 0.3, W * 0.3]) { gb.box(x, h + 0.1, z0, 0.01, 0.3, 0.01, '#3a3a3e'); gb.box(x + 0.05, h + 0.32, z0, 0.1, 0.06, 0.004, rng.pick(['#a8473a', '#3f6a8f'])); }
  } else {
    // stable block at the back
    gb.cbox(-W * 0.25, 0, z0 - D / 2 - 0.0, 0.4, 0.2, 0.08, pal.wood, 0, 0.008);
  }
  if (f.turned) gb.pop();
};

// A parish school: the chapel's nave at one end (either end), the schoolroom
// at the other, a bell tower between them crowned its own way (a broach
// spire, a pyramid, a saddleback or an open belfry), the schoolroom's roof
// hipped or gabled, a playground in front.
MODELS.parishschool = (c, L) => {
  const { gb, pal } = c;
  const f = rowFrame(c), F = c.form, side = F.side;
  const W = f.len - 0.12;
  const stone = L ? pal.stoneWall : (pal.style === 'brick' ? pal.brick : pal.stoneWall);
  // chapel nave on one side, schoolroom wing on the other, a bell tower between
  const nx = side * (-W / 2 + 0.32), z0 = -f.dep / 2 + 0.36;
  footing(c, nx, z0, 0.56, 0.5);
  gb.cbox(nx, 0, z0, 0.56, 0.42, 0.5, stone, 0, 0.02);
  gb.gable(nx, 0.42, z0, 0.56, 0.5, 0.3, stone, pal.slate, 0.05, true, 0.035);
  for (let i = 0; i < 3; i++) { win(c, nx + 0.28, 0.12, z0 - 0.15 + i * 0.15, 0.06, 0.18, 'r', 0.9); win(c, nx - 0.28, 0.12, z0 - 0.15 + i * 0.15, 0.06, 0.18, 'l', 0.9); }
  gb.cyl(nx, 0.5, z0 + 0.255, 0.07, 0.07, 0.012, 12, '#9fbcc0', 0, Math.PI / 2);
  door(c, nx, z0 + 0.25, 0.09, 0.18, '#4e3424');
  const tx = nx + side * 0.4, tz = z0 + 0.12, th = L ? 1.1 : 0.85;
  tower(c, ['spire', 'pyramid', 'saddle', 'belfry'][planOf(c, 4)], tx, tz, 0.18, th - 0.1, stone, pal.slate, { cross: true, clock: L > 0 });
  const sx = side * (W / 2 - 0.36), sw = 0.66, sd = 0.46;
  house(c, { x: sx, z: z0 - 0.02, w: sw, d: sd, h: L ? 0.52 : 0.34, floors: L ? 2 : 1, wall: L ? stone : pal.wall, roof: pal.slate, roofType: F.b < 0.5 ? 'gable' : 'hip', rh: 0.22, nFront: 3, doorX: 0, chimney: true, fancy: false, lit: 0.9 });
  // a playground with a fence at the front
  const pz = f.dep / 2 - 0.16;
  fence(c, sx - sw / 2, pz - 0.18, sx + sw / 2, pz + 0.08, FENCE, { x: sx, z: pz + 0.08, w: 0.1 });
  for (let i = 0; i < 2; i++) { const x = sx - 0.12 + i * 0.24; gb.box(x, c.gy(x, pz - 0.04), pz - 0.04, 0.012, 0.16, 0.012, '#5e432c'); }
  gb.box(sx, c.gy(sx, pz - 0.04) + 0.15, pz - 0.04, 0.26, 0.012, 0.012, '#5e432c');
  bush(c, nx - 0.18, f.dep / 2 - 0.1); bush(c, nx + 0.16, f.dep / 2 - 0.1);
  if (f.turned) gb.pop();
};

// Almshouses, in one of their plans: a long low row of rooms with a gabled
// infirmary in the middle; a court, wings coming forward with their gables
// to the street and the chapel's bell-cote across the back; or two storeys
// with a timber gallery along the upper rooms and a clock turret.
MODELS.almshouse = (c, L) => {
  const { gb, rng, pal } = c;
  const f = rowFrame(c), F = c.form, plan = planOf(c, 3);
  const W = f.len - 0.12, z0 = -f.dep / 2 + 0.28;
  const wall = L ? pal.stoneWall : pal.wall;
  if (plan === 1) {
    // a court: the back range with its chapel, wings coming forward
    const D = 0.32, zb = -f.dep / 2 + 0.22;
    house(c, { x: 0, z: zb, w: W - 0.5, d: D, h: 0.3, floors: 1, wall, roof: pal.roof, roofType: 'gable', rh: 0.2, nFront: 5, doorX: 0, chimney: true, chimneyPos: 'ends', fancy: false, lit: 0.85 });
    bellcote(c, 0, 0.3 + 0.2, zb + D / 2 - 0.02, wall, pal.roof);
    for (const s of [-1, 1]) {
      house(c, { x: s * (W / 2 - 0.2), z: -0.02, w: 0.36, d: f.dep - 0.18, h: 0.3, floors: 1, wall, roof: pal.roof, roofType: 'gable', alongZ: true, rh: 0.2, noDoor: true, nFront: 1, chimney: true, fancy: false, lit: 0.85 });
      for (let i = 0; i < 3; i++) { const z = -0.24 + i * 0.18; door(c, s * (W / 2 - 0.38), z, 0.06, 0.14, rng.pick(DOORS)); }
    }
    for (const x of [-0.18, 0.18]) bench(c, x, 0.1, Math.PI);
    const cz = 0.12;
    gb.box(0, c.gy(0, cz) - 0.006, cz, 0.08, 0.012, 0.42, '#cdbf9e');
    flowers(c, -0.3, cz, 6, 0.07); flowers(c, 0.3, cz, 6, 0.07);
    gatePiers(c, 0, f.dep / 2 - 0.06, 0.14, STONE);
    if (f.turned) gb.pop();
    return;
  }
  if (plan === 2) {
    // two storeys, a gallery along the upper rooms, a clock turret
    const D = 0.36;
    const r = house(c, { x: 0, z: z0, w: W, d: D, h: 0.52, floors: 2, wall, roof: pal.roof, roofType: 'gable', rh: 0.2, nFront: 6, doorX: 0, chimney: true, chimneyPos: 'ends', fancy: false, lit: 0.85 });
    balcony(c, 'gallery', 0, 0.26, z0 + D / 2, W - 0.1);
    for (const s of [-1, 1]) gb.boxC(s * (W / 2 - 0.12), 0.13, z0 + D / 2 + 0.08, 0.06, 0.012, 0.3, shade(pal.wood, 0.9), 0.9);
    gb.cbox(0, r.top - 0.06, z0, 0.12, 0.16, 0.12, '#ebe4d6', 0, 0.01);
    wallClock(c, 0, r.top + 0.03, z0 + 0.062, 0.035);
    gb.roof(0, r.top + 0.1, z0, 0.16, 0.16, 0.14, 0, pal.slate);
    const gz = f.dep / 2 - 0.16;
    hedge(c, 0, gz + 0.1, W - 0.2, 0.05);
    bench(c, -0.35, gz, Math.PI); bench(c, 0.35, gz, Math.PI);
    if (f.turned) gb.pop();
    return;
  }
  // a long low row of almshouse rooms with a central gabled infirmary
  const D = 0.36, n = 5;
  footing(c, 0, z0, W, D);
  gb.cbox(0, 0, z0, W, 0.3, D, wall, 0, 0.016);
  gb.gable(0, 0.3, z0, W + 0.02, D, 0.2, wall, pal.roof, 0.05, false, 0.03);
  for (let i = 0; i < n; i++) {
    const x = -W / 2 + (i + 0.5) * (W / n);
    if (i === 2) continue;
    door(c, x - 0.06, z0 + D / 2, 0.07, 0.15, rng.pick(DOORS));
    win(c, x + 0.07, 0.1, z0 + D / 2, 0.07, 0.09, 'f');
    chimney(c, x, 0.25, 0.62, z0 - 0.06, 'home', STONE);
  }
  gb.cbox(0, 0, z0 + 0.08, 0.32, L ? 0.58 : 0.46, 0.4, '#ebe4d6', 0, 0.016);
  gb.gable(0, L ? 0.58 : 0.46, z0 + 0.08, 0.32, 0.4, 0.2, '#ebe4d6', pal.roof, 0.04, true, 0.03);
  door(c, 0, z0 + 0.28, 0.1, 0.18, '#3f4f5a');
  gb.box(0, 0.3, z0 + 0.282, 0.09, 0.09, 0.008, '#c8423a');
  gb.box(0, 0.33, z0 + 0.286, 0.03, 0.03, 0.006, '#f2ede0'); gb.box(0, 0.33, z0 + 0.286, 0.006, 0.07, 0.006, '#f2ede0'); gb.box(0, 0.33, z0 + 0.286, 0.07, 0.006, 0.006, '#f2ede0');
  // a garden court with benches
  const gz = f.dep / 2 - 0.2;
  hedge(c, -W / 2 + 0.3, gz + 0.12, 0.5, 0.05); hedge(c, W / 2 - 0.3, gz + 0.12, 0.5, 0.05);
  bench(c, -0.35, gz, Math.PI); bench(c, 0.35, gz, Math.PI);
  flowers(c, -0.6, gz - 0.02, 6, 0.07); flowers(c, 0.6, gz - 0.02, 6, 0.07);
  if (f.turned) gb.pop();
};


MODELS.joinery = (c, L) => {
  const { gb, pal } = c;
  const f = rowFrame(c);
  const W = f.len - 0.12, z0 = -f.dep / 2 + 0.3;
  house(c, { x: -W / 2 + 0.36, z: z0, w: 0.62, d: 0.48, h: L ? 0.5 : 0.36, floors: L ? 2 : 1, wall: L ? pal.brick : pal.wood, roof: pal.slate, roofType: 'gable', rh: 0.2, nFront: 3, doorX: 0, chimney: false, fancy: false, lit: 0.8 });
  chimney(c, -W / 2 + 0.16, 0.2, L ? 0.95 : 0.75, z0 - 0.15, 'work', '#7f3f2e');
  // an open timber shed with racks of planks
  shed(c, W / 2 - 0.36, z0, 0.6, 0.42, 0.3, pal.roof);
  plankStack(c, W / 2 - 0.36, z0, 4, 0);
  plankStack(c, 0.1, f.dep / 2 - 0.18, 3, 0);
  logs(c, W / 2 - 0.5, f.dep / 2 - 0.16, 3, 0);
  sawhorse(c, -0.1, f.dep / 2 - 0.16, 0.3);
  if (L) { for (let i = 0; i < 3; i++) gb.cbox(-0.05 + i * 0.12, c.gy(0, -0.05), -0.05, 0.09, 0.08, 0.06, '#a8804e', 0.2 * i, 0.006); }
  sign(c, -W / 2 + 0.36, 0.26, z0 + 0.25, 0.26, 0.05, '#3b2f2a');
  if (f.turned) gb.pop();
};

// A brewhouse: the brewing tower with a louvred ventilator on its ridge (the
// steam off the coppers escapes there), the copper house across the back of
// the yard, and the taproom on the street with its sign, benches and casks.
// The Brewery is brick and a storey taller, with a square works stack and a
// horse dray loading in the yard.
MODELS.brewhouse = (c, L) => {
  const { gb, rng, pal } = c;
  const f = rowFrame(c);
  const W = f.len - 0.12, back = -f.dep / 2, front = f.dep / 2;
  const wall = L ? pal.brick : pal.stoneWall;
  // the taproom first: its door is the one customers use
  const pw = 0.7, px = W / 2 - pw / 2 - 0.02, pd = 0.5, pz = back + 0.36, ph = L ? 0.58 : 0.52;
  house(c, {
    x: px, z: pz, w: pw, d: pd, h: ph, floors: 2, wall: pal.wall, roof: L ? pal.slate : pal.roof, roofType: 'gable', rh: 0.26,
    timber: L ? false : pal.timber, chimney: true, lit: 0.95, plinth: STONE, doorX: -pw * 0.2,
  });
  // the brewing tower at the other end, with a loading door and hoist beam
  const tw = 0.46, td = 0.44, tx = -W / 2 + tw / 2 + 0.04, tz = back + 0.3, th = L ? 0.86 : 0.62, trh = 0.22;
  house(c, { x: tx, z: tz, w: tw, d: td, h: th, floors: L ? 3 : 2, wall, roof: pal.slate, roofType: 'gable', rh: trh, nFront: 2, noDoor: true, chimney: false, fancy: false, lit: 0.7 });
  gb.box(tx, th - 0.21, tz + td / 2 + 0.006, 0.09, 0.14, 0.012, '#4e3828');
  gb.box(tx, th - 0.04, tz + td / 2 + 0.06, 0.016, 0.016, 0.12, '#3a2f28');
  gb.box(tx, th - 0.17, tz + td / 2 + 0.11, 0.004, 0.13, 0.004, '#2a2620');
  // louvred ventilator on the ridge
  const vy = th + trh - 0.03;
  gb.cbox(tx, vy, tz, 0.14, 0.1, 0.12, pal.wood, 0, 0.006);
  for (const s of [-1, 1]) for (let i = 0; i < 3; i++) gb.box(tx, vy + 0.02 + i * 0.026, tz + s * 0.062, 0.12, 0.008, 0.008, '#3a2f28');
  gb.gable(tx, vy + 0.1, tz, 0.18, 0.16, 0.06, pal.wood, pal.slate, 0.02);
  if (!L) c.addSmoke(tx, vy + 0.18, tz, 'home');
  // the copper house between them, across the back of the yard
  const cx = (tx + tw / 2 + px - pw / 2) / 2, cw = px - pw / 2 - (tx + tw / 2) - 0.04, cz = back + 0.2;
  worksShed(c, cx, cz, cw, 0.32, 0.34, 1, wall, pal.slate, 0.16, (u) => Math.abs(u - cx) < 0.1);
  plainDoor(c, cx, cz + 0.16, 0.13, 0.2, '#4e3828');
  if (L) {
    // a square works stack through the copper house roof, and a sign on the tower
    const sx = cx + cw / 2 - 0.08, sz = cz - 0.04;
    gb.cbox(sx, 0, sz, 0.1, 1.15, 0.1, '#7f3f2e', 0, 0.01);
    gb.cbox(sx, 1.15, sz, 0.125, 0.04, 0.125, '#5f3022', 0, 0.008);
    c.addSmoke(sx, 1.22, sz, 'work');
    sign(c, tx, th * 0.5, tz + td / 2 + 0.012, 0.36, 0.07, '#2f3a2a');
  }
  // the yard: casks stacked by the copper house, sacks of malt, a dray
  const yz = cz + 0.24;
  for (let i = 0; i < 4; i++) barrel(c, cx - cw / 2 + 0.07 + i * 0.07, yz);
  for (let i = 0; i < 3; i++) barrel(c, cx - cw / 2 + 0.1 + i * 0.07, yz + 0.07, 0.95);
  for (let i = 0; i < 2; i++) gb.blob(cx + cw / 2 - 0.08 + i * 0.05, c.gy(cx + cw / 2 - 0.08, yz) + 0.02, yz + 0.02, 0.03, 0.035, 0.025, '#d4bc88');
  const dx = cx - 0.02, dz = front - 0.2;
  if (L) {
    // a horse dray with casks aboard, the horse towards the tower end
    gb.push(dx, c.gy(dx, dz), dz, -Math.PI / 2);
    gb.cbox(0, 0.06, 0, 0.18, 0.025, 0.3, '#6e5034', 0, 0.006);
    for (const sx of [-1, 1]) for (const wz of [-0.09, 0.09]) gb.cyl(sx * 0.1, 0.05, wz, 0.05, 0.05, 0.012, 8, '#3a2a1f', 0, 0, Math.PI / 2);
    for (let i = 0; i < 3; i++) gb.cyl(0, 0.1, -0.09 + i * 0.09, 0.034, 0.034, 0.075, 9, '#6e4a2c', 0, 0, Math.PI / 2);
    gb.pop();
    horse(c, dx - 0.27, dz, -Math.PI / 2);
  } else handcart(c, dx, dz);
  // out front of the taproom: a hanging sign, benches and a cask table
  const fz = pz + pd / 2;
  const sx2 = px + pw * 0.38, sz2 = front - 0.08, sy = c.gy(sx2, sz2);
  gb.box(sx2, sy, sz2, 0.018, 0.4, 0.018, '#3a2f28');
  gb.box(sx2 - 0.06, sy + 0.38, sz2, 0.14, 0.018, 0.018, '#3a2f28');
  sign(c, sx2 - 0.08, sy + 0.27, sz2, 0.11, 0.09, rng.pick(['#5a3a1e', '#2f4a3a', '#6a2a2a']));
  gb.cyl(sx2 - 0.08, sy + 0.31, sz2 + 0.01, 0.022, 0.022, 0.012, 8, '#d9b04a', 0, Math.PI / 2);
  bench(c, px - pw * 0.25, fz + 0.12, Math.PI); bench(c, px + pw * 0.1, fz + 0.12, Math.PI);
  barrel(c, px - pw * 0.08, fz + 0.24); barrel(c, px + pw * 0.26, fz + 0.22, 0.9);
  lamp(c, px - pw / 2 - 0.02, front - 0.06, 0.28);
  if (f.turned) gb.pop();
};

// A fish market: an open-sided market roof over slabs of the catch, an ice
// house behind, nets drying and a boat drawn up on trestles. The Fish Hall
// walls the market in with tall arched openings under a glazed roof, and the
// ice house becomes a smokehouse with its stack.
MODELS.fishmarket = (c, L) => {
  const { gb, rng, pal } = c;
  const f = rowFrame(c);
  const W = f.len - 0.12, back = -f.dep / 2, front = f.dep / 2;
  const FISH = ['#b8c4cc', '#9fb0b8', '#c9d2d6', '#d98a7a', '#8a9aa6', '#a9b8a0'];
  const slab = (x, z) => {
    const y = c.gy(x, z);
    for (const sx of [-1, 1]) gb.box(x + sx * 0.1, y, z, 0.02, 0.1, 0.1, STONE_D);
    gb.cbox(x, y + 0.1, z, 0.26, 0.02, 0.13, '#d8d2c6', 0, 0.004);
    for (let i = 0; i < 6; i++) gb.box(x - 0.09 + (i % 3) * 0.09, y + 0.12, z - 0.03 + Math.floor(i / 3) * 0.06, 0.07, 0.014, 0.024, rng.pick(FISH), rng.float(-0.4, 0.4));
  };
  // the market: open at L0, a hall with a glazed roof at L1
  const mx = 0.24, mw = 1.32, md = 0.66, mz = 0;
  if (L) {
    const h = 0.44, hw = pal.brick;
    door(c, mx, md / 2, 0.16, 0.24, '#3f4f5a');
    footing(c, mx, mz, mw, md);
    gb.cbox(mx, 0, mz, mw, h, md, hw, 0, 0.02);
    for (let i = 0; i < 4; i++) {
      const x = mx - mw / 2 + (i + 0.5) * (mw / 4);
      if (Math.abs(x - mx) < 0.12) continue;
      win(c, x, 0.07, md / 2, 0.15, 0.22, 'f', 0.95);
      gb.cyl(x, 0.07 + 0.22 * (c.winH || 1) + 0.012, md / 2 + 0.004, 0.087, 0.087, 0.016, 10, '#e3dccd', 0, Math.PI / 2);
    }
    // a fanlight over the doors (its lower half sits behind the door frame)
    gb.glow(WARM[0], WARM[1], WARM[2], 1.3); gb.cyl(mx, 0.26, md / 2 + 0.001, 0.09, 0.09, 0.008, 10, '#e3dccd', 0, Math.PI / 2); gb.noGlow();
    for (const s of [-1, 1]) for (let i = 0; i < 2; i++) win(c, mx + s * mw / 2, 0.12, -0.14 + i * 0.28, 0.12, 0.18, s > 0 ? 'r' : 'l', 0.8);
    gb.gable(mx, h, mz, mw + 0.02, md, 0.24, hw, pal.slate, 0.05, false, 0.035);
    glassRoof(c, mx, h, mz, mw * 0.55, md, 0.24, false, 5, 0.048);
    sign(c, mx, h - 0.09, md / 2 + 0.012, 0.42, 0.06, '#2f4a5a');
    // a louvred lantern on the ridge with a fish for a vane
    gb.cbox(mx, h + 0.21, mz, 0.12, 0.11, 0.12, '#e3dccd', 0, 0.006);
    gb.hip(mx, h + 0.32, mz, 0.16, 0.16, 0.07, pal.slate, 0.02);
    gb.box(mx, h + 0.39, mz, 0.008, 0.08, 0.008, '#2f2c2a');
    gb.box(mx, h + 0.46, mz, 0.1, 0.03, 0.006, '#c9a640');
  } else {
    // posts carrying a long roof, open all round (shoppers wander under it)
    c.openAir = true;
    const eave = 0.3;
    for (let i = 0; i <= 4; i++) for (const s of [-1, 1]) {
      const x = mx - mw / 2 + 0.03 + (i * (mw - 0.06)) / 4, z = mz + s * (md / 2 - 0.03);
      gb.box(x, c.gy(x, z) - 0.01, z, 0.026, eave + 0.01 - c.gy(x, z), 0.026, '#5e432c');
    }
    gb.box(mx, eave - 0.02, mz + md / 2 - 0.03, mw, 0.03, 0.03, '#5e432c');
    gb.box(mx, eave - 0.02, mz - md / 2 + 0.03, mw, 0.03, 0.03, '#5e432c');
    gb.gable(mx, eave, mz, mw + 0.04, md + 0.06, 0.18, pal.wood, pal.roof, 0.04, false, 0.03);
    for (const x of [mx - 0.42, mx, mx + 0.42]) for (const z of [mz - 0.13, mz + 0.13]) slab(x, z);
    sign(c, mx, eave - 0.07, mz + md / 2 + 0.012, 0.4, 0.06, '#2f4a5a');
  }
  // ice by the front, and baskets of the catch
  for (let i = 0; i < 3; i++) crate(c, mx - 0.5 + i * 0.09, front - 0.1, 0.9, '#dfeaf0');
  for (let i = 0; i < 2; i++) { const x = mx + 0.4 + i * 0.1, z = front - 0.09; gb.cyl(x, c.gy(x, z), z, 0.035, 0.03, 0.05, 8, '#a8804e'); gb.box(x, c.gy(x, z) + 0.05, z, 0.04, 0.008, 0.03, rng.pick(FISH)); }
  // the ice house (a smokehouse at the Fish Hall) at the back of one end
  const ix = -W / 2 + 0.22, iz = back + 0.24, iw = 0.38, id = 0.36, ih = L ? 0.46 : 0.3;
  house(c, { x: ix, z: iz, w: iw, d: id, h: ih, floors: L ? 2 : 1, wall: L ? pal.brick : pal.stoneWall, roof: pal.slate, roofType: 'hip', rh: 0.14, nFront: 1, noDoor: true, chimney: false, fancy: false, lit: 0.4 });
  plainDoor(c, ix, iz + id / 2, 0.08, 0.16, '#3f4f5a');
  if (L) chimney(c, ix, ih + 0.02, ih + 0.3, iz - 0.06, 'work', STONE_D);
  // nets drying on a frame, and a boat on trestles
  const nz = iz + id / 2 + 0.16, ny = c.gy(ix, nz);
  for (const s of [-1, 1]) gb.box(ix + s * 0.15, ny, nz, 0.016, 0.2, 0.016, '#4e3a2a');
  gb.box(ix, ny + 0.19, nz, 0.33, 0.012, 0.012, '#4e3a2a');
  for (let i = 0; i < 5; i++) gb.box(ix - 0.12 + i * 0.06, ny + 0.11, nz, 0.045, 0.075, 0.006, '#93a6b0');
  const bx = ix, bz = front - 0.13;
  gb.push(bx, c.gy(bx, bz), bz, Math.PI / 2);
  for (const s of [-1, 1]) gb.box(0, 0, s * 0.09, 0.1, 0.05, 0.014, '#5e432c');
  gb.roof(0, 0.05, 0, 0.13, 0.32, 0.065, 0, '#6e4a2c', 0);
  gb.box(0, 0.05, 0, 0.11, 0.035, 0.24, '#7d5b3b');
  gb.pop();
  lamp(c, mx + mw / 2 - 0.02, front - 0.05, 0.28);
  if (f.turned) gb.pop();
};

// A department store: three storeys the length of the double plot, plate
// glass in every bay of the shop floor under striped awnings, showroom
// windows on the first floor, its name lit on the parapet and a corner
// tower with a copper cupola and a flag. The Grand Department Store is a
// storey taller under a mansard with dormers, with a domed entrance bay and
// a clock, a glazed canopy the length of the front and its van at the kerb.
MODELS.deptstore = (c, L) => {
  const { gb, rng, pal } = c;
  const f = rowFrame(c);
  const W = f.len - 0.12, D = L ? 0.64 : 0.6, floors = L ? 4 : 3, fh = 0.27, H = floors * fh;
  const z0 = -f.dep / 2 + D / 2 + 0.04, fz = z0 + D / 2;
  const wall = pal.forced ? pal.wall : L ? '#e6dccb' : pal.style === 'brick' ? pal.brick : pal.stoneWall;
  const trim = '#ece6da', fascia = rng.pick(['#2a2a4a', '#3a1f2a', '#1f3a3a']), copper = '#5f8a7a';
  footing(c, 0, z0, W, D);
  gb.cbox(0, 0, z0, W, H, D, wall, 0, 0.02);
  const n = 5, bw = W / n, mid = 2;
  // the shop floor: plate glass in every bay, the doors in the middle one,
  // and the goods set out in the windows
  for (let i = 0; i < n; i++) {
    const x = -W / 2 + (i + 0.5) * bw;
    const sf = shopfront(c, x, fz, bw - 0.006, 0.27, { fascia, trim, lit: true, noDoor: i !== mid, doorW: 0.13 });
    for (const p of sf.panes) {
      if (i % 2) for (let k = 0; k < 2; k++) dummyAt(c, p.m + (k - 0.5) * p.w * 0.5, p.z + 0.02, rng.pick(PAINTED));
      else for (let k = 0; k < 5; k++) gb.cyl(p.m - p.w * 0.36 + k * p.w * 0.18, 0.05, p.z + 0.014, 0.011, 0.011, 0.07, 6, rng.pick(PAINTED.concat(ACCENT)));
    }
    if (!L && i !== mid) awning(c, x, sf.top - 0.004, fz, bw - 0.012, i % 2 ? pal.awning : '#3f5a3a');
  }
  // showroom windows on the first floor, pairs of sashes above, piers between the bays
  for (let i = 0; i < n; i++) {
    const x = -W / 2 + (i + 0.5) * bw;
    gb.glow(WARM[0], WARM[1], WARM[2], 1 + rng.float(0.02, 0.3));
    gb.box(x, fh + 0.03, fz + 0.006, bw - 0.08, fh - 0.08, 0.012, GLASS);
    gb.noGlow();
    gb.box(x, fh + 0.03 + (fh - 0.08) * 0.7, fz + 0.013, bw - 0.08, 0.007, 0.006, trim);
    gb.box(x, fh + 0.03, fz + 0.013, 0.007, fh - 0.08, 0.006, trim);
    for (let k = 2; k < floors; k++) for (const s of [-1, 1]) win(c, x + s * bw * 0.2, k * fh + fh * 0.32, fz, 0.075, 0.11, 'f', 0.85);
    for (let k = 1; k < floors; k++) win(c, x, k * fh + fh * 0.34, z0 - D / 2, 0.08, 0.1, 'b', 0.6);
  }
  for (let i = 0; i <= n; i++) gb.box(-W / 2 + i * bw, fh, fz + 0.008, 0.03, H - fh, 0.02, trim);
  for (let k = 1; k < floors; k++) for (const s of [-1, 1]) for (const v of [-0.25, 0.25]) win(c, (s * W) / 2, k * fh + fh * 0.32, z0 + v * D, 0.075, 0.1, s > 0 ? 'r' : 'l', 0.7);
  gb.box(0, fh - 0.004, fz + 0.012, W, 0.014, 0.03, trim);
  gb.box(0, H - 0.03, z0, W + 0.035, 0.035, D + 0.035, trim);
  if (L) {
    // a mansard storey of slate with dormers, a low hip over it
    gb.cbox(0, H, z0, W - 0.04, 0.2, D - 0.04, pal.slate, 0, 0.03);
    gb.hip(0, H + 0.2, z0, W - 0.04, D - 0.04, 0.1, pal.slate, 0.02);
    for (let i = 0; i < n; i++) {
      if (i === mid) continue;
      const x = -W / 2 + (i + 0.5) * bw, dz = fz - 0.02;
      for (const s of [-1, 1]) {
        win(c, x + s * bw * 0.2, H + 0.05, dz, 0.06, 0.08, 'f', 0.7);
        gb.gable(x + s * bw * 0.2, H + 0.05 + 0.08 * (c.winH || 1) + 0.01, dz + 0.01, 0.09, 0.03, 0.035, trim, trim, 0.008);
      }
    }
    // the domed entrance bay with a clock, and the name over the doors
    const bx = 0, bz = fz - 0.06;
    gb.cbox(bx, H - 0.03, bz, bw - 0.02, 0.3, 0.13, wall, 0, 0.012);
    gb.box(bx, H + 0.27, bz, bw, 0.03, 0.15, trim);
    gb.cyl(bx, H + 0.3, bz - 0.04, 0.12, 0.13, 0.06, 12, trim);
    gb.sphere(bx, H + 0.36, bz - 0.04, 0.12, copper, 1, 0.8);
    gb.cyl(bx, H + 0.45, bz - 0.04, 0.008, 0.012, 0.12, 5, GOLD);
    gb.cyl(bx, H + 0.14, bz + 0.066, 0.06, 0.06, 0.008, 14, '#3a3a3e', 0, Math.PI / 2);
    gb.glow(1.2, 1.1, 0.8, 1.02); gb.cyl(bx, H + 0.14, bz + 0.07, 0.048, 0.048, 0.008, 14, '#efe8da', 0, Math.PI / 2); gb.noGlow();
    gb.box(bx, H + 0.03, bz + 0.067, bw * 0.8, 0.05, 0.012, fascia);
    gb.glow(1.8, 1.4, 0.6, 3.1); gb.box(bx, H + 0.043, bz + 0.075, bw * 0.66, 0.024, 0.006, '#e0c070'); gb.noGlow();
    // a glazed canopy on iron brackets the length of the front
    gb.box(0, 0.3, fz + 0.075, W - 0.04, 0.012, 0.15, IRON_D);
    gb.glow(1.6, 1.4, 1.0, 1.5); gb.box(0, 0.312, fz + 0.075, W - 0.06, 0.008, 0.13, GLASS_ROOF); gb.noGlow();
    for (let i = 0; i <= n; i++) gb.boxC(-W / 2 + 0.02 + i * ((W - 0.04) / n), 0.27, fz + 0.06, 0.008, 0.008, 0.12, IRON_D, 0.45);
    // a carriage drawn up at the doors (not on a deep plot, where the front
    // is the side path in from the street, and it would stand across it)
    if (!f.turned) coach(c, -W / 2 + 0.4, fz + 0.2, Math.PI / 2, rng.pick(['#5a2a4a', '#2a3a5a', '#2f4a3a']), true);
  } else {
    gb.hip(0, H, z0, W + 0.02, D + 0.02, 0.24, pal.slate, 0.04);
    // the name on the parapet over the doors
    gb.box(0, H, fz - 0.01, bw * 1.2, 0.09, 0.03, wall);
    gb.box(0, H + 0.09, fz - 0.01, bw * 1.2 + 0.02, 0.014, 0.04, trim);
    gb.box(0, H + 0.02, fz + 0.007, bw * 1.0, 0.05, 0.008, fascia);
    gb.glow(1.8, 1.4, 0.6, 3.1); gb.box(0, H + 0.033, fz + 0.012, bw * 0.86, 0.024, 0.006, '#e0c070'); gb.noGlow();
  }
  // the corner tower (at one end, or one at each), with a copper cupola, a
  // spire or a clock stage, and a flag (planOf)
  const crown = planOf(c, 3);
  for (const ts of c.form.b < 0.3 ? [-1, 1] : [1]) {
    const tx = ts * (W / 2 - 0.15), tz = z0 + 0.04, th = H + (L ? 0.3 : 0.22);
    gb.cbox(tx, H - 0.03, tz, 0.26, th - H + 0.03, 0.26, wall, 0, 0.012);
    for (const [dx, dz, face] of [[0, 0.13, 'f'], [0.13, 0, 'r'], [-0.13, 0, 'l']]) win(c, tx + dx, th - 0.16, tz + dz, 0.06, 0.1, face, 0.8);
    gb.box(tx, th, tz, 0.29, 0.025, 0.29, trim);
    let top = th + 0.16;
    if (crown === 1) { gb.roof(tx, th + 0.025, tz, 0.27, 0.27, 0.34, 0, pal.slate); top = th + 0.36; }
    else if (crown === 2) {
      gb.cbox(tx, th + 0.025, tz, 0.2, 0.12, 0.2, wall, 0, 0.008);
      wallClock(c, tx, th + 0.085, tz + 0.102, 0.045);
      gb.hip(tx, th + 0.145, tz, 0.22, 0.22, 0.1, copper, 0.01);
      top = th + 0.24;
    } else {
      gb.cyl(tx, th + 0.025, tz, 0.09, 0.1, 0.06, 10, trim);
      gb.sphere(tx, th + 0.085, tz, 0.09, copper, 1, 0.85);
    }
    gb.box(tx, top, tz, 0.01, 0.22, 0.01, IRON_D);
    gb.box(tx + 0.05, top + 0.16, tz, 0.09, 0.055, 0.004, rng.pick(['#a8473a', '#3f6a8f', '#7a3a5a']));
  }
  lamp(c, -W / 2 + 0.04, f.dep / 2 - 0.06, 0.3); lamp(c, W / 2 - 0.04, f.dep / 2 - 0.06, 0.3);
  if (f.turned) gb.pop();
};

// Exchange Buildings: a long classical front of stone, rusticated below, a
// portico of six columns up a flight of steps with a clock in its
// pediment, and rows of office windows either side. The Stock Exchange is
// a storey taller, its trading floor under a great copper dome on a drum of
// windows, with statues along the parapet and flags at the ends.
MODELS.exchange = (c, L) => {
  const { gb, rng, pal } = c;
  const f = rowFrame(c);
  const W = f.len - 0.12, D = L ? 0.62 : 0.58, floors = L ? 3 : 2, fh = L ? 0.28 : 0.3, H = floors * fh;
  const z0 = -f.dep / 2 + D / 2 + 0.04, fz = z0 + D / 2;
  const wall = pal.forced ? pal.wall : pal.stoneWall, trim = '#ece6da', copper = '#5f8a7a';
  footing(c, 0, z0, W, D);
  gb.cbox(0, 0, z0, W, H, D, wall, 0, 0.02);
  gb.cbox(0, -0.02, z0, W + 0.03, 0.06, D + 0.03, STONE, 0, 0.01);
  for (let y = 0.06; y < fh - 0.02; y += 0.045) gb.box(0, y, fz + 0.002, W, 0.006, 0.006, shade(wall, 0.84));
  const pw = 0.56;
  // windows along the front either side of the portico, and round the back and ends
  const n = 8;
  for (let i = 0; i < n; i++) {
    const x = -W / 2 + (i + 0.5) * (W / n);
    for (let k = 0; k < floors; k++) {
      if (Math.abs(x) > pw / 2 + 0.04) win(c, x, k * fh + fh * 0.3, fz, 0.08, k ? 0.13 : 0.14, 'f', 0.85);
      win(c, x, k * fh + fh * 0.3, z0 - D / 2, 0.075, 0.12, 'b', 0.6);
    }
  }
  for (let k = 0; k < floors; k++) for (const s of [-1, 1]) for (const v of [-0.22, 0.22]) win(c, (s * W) / 2, k * fh + fh * 0.3, z0 + v * D, 0.075, 0.12, s > 0 ? 'r' : 'l', 0.7);
  for (let k = 1; k < floors; k++) gb.box(0, k * fh - 0.01, fz + 0.003, W + 0.006, 0.016, 0.01, trim);
  gb.box(0, H - 0.035, z0, W + 0.04, 0.035, D + 0.04, trim);
  // the portico: steps up to six columns, an entablature and a pediment with a clock
  const ch = L ? fh * 2 : fh * 1.4;
  for (let s = 0; s < 3; s++) gb.box(0, -0.03 + s * 0.02, fz + 0.2 - s * 0.03, pw + 0.12 - s * 0.03, 0.02 + 0.001, 0.08, STONE);
  portico(c, 0, fz, pw, ch, 6, pal.slate, trim);
  wallClock(c, 0, 0.055 + ch + 0.045, fz + 0.15, 0.032);
  door(c, 0, fz, 0.13, 0.22, '#3a2f28');
  for (const s of [-1, 1]) win(c, s * 0.15, 0.08, fz, 0.07, 0.15, 'f', 0.8);
  gb.box(0, fh + 0.02, fz + 0.004, 0.36, 0.035, 0.012, '#2a2a30');
  gb.glow(1.8, 1.4, 0.6, 3.1); gb.box(0, fh + 0.03, fz + 0.012, 0.3, 0.018, 0.006, GOLD); gb.noGlow();
  if (L) {
    // a balustrade with statues, the roof low behind it, and the dome
    gb.hip(0, H, z0, W - 0.1, D - 0.1, 0.12, pal.slate, 0);
    gb.box(0, H, fz - 0.015, W, 0.05, 0.03, trim);
    for (let i = 0; i < 7; i++) {
      const x = -W / 2 + 0.1 + i * ((W - 0.2) / 6);
      if (Math.abs(x) < 0.2) continue;
      gb.cbox(x, H + 0.05, fz - 0.015, 0.04, 0.03, 0.04, trim, 0, 0.004);
      gb.cyl(x, H + 0.08, fz - 0.015, 0.011, 0.014, 0.06, 6, STONE);
      gb.sphere(x, H + 0.15, fz - 0.015, 0.012, STONE, 0);
    }
    const dz = z0 - 0.02, crown = planOf(c, 3);
    if (crown === 1) {
      // a clock tower over the trading floor
      tower(c, 'lantern', 0, dz, 0.26, H + 0.42, wall, copper, { clock: true });
    } else if (crown === 2) {
      // a cupola at either end of the front
      for (const s2 of [-1, 1]) { gb.cbox(s2 * 0.5, H, z0 + 0.1, 0.18, 0.12, 0.18, wall, 0, 0.008); gb.cyl(s2 * 0.5, H + 0.12, z0 + 0.1, 0.07, 0.08, 0.05, 8, trim); gb.sphere(s2 * 0.5, H + 0.17, z0 + 0.1, 0.075, copper, 1, 0.9); }
    } else {
      gb.cyl(0, H, dz, 0.2, 0.2, 0.14, 14, wall);
      for (let i = 0; i < 6; i++) { const a = -Math.PI / 2 + (i - 2.5) * 0.42; stainedGlass(c, Math.cos(a) * 0.2, H + 0.03, dz - Math.sin(a) * 0.2, 0.05, 0.08, 2, 'f', a + Math.PI / 2); }
      gb.box(0, H + 0.14, dz, 0.44, 0.02, 0.44, trim);
      gb.sphere(0, H + 0.16, dz, 0.2, copper, 1, 0.75);
      gb.cyl(0, H + 0.3, dz, 0.04, 0.05, 0.07, 8, trim);
      gb.cone(0, H + 0.37, dz, 0.045, 0.06, 8, copper);
    }
    for (const s of [-1, 1]) {
      gb.box(s * (W / 2 - 0.08), H, z0, 0.01, 0.3, 0.01, IRON_D);
      gb.box(s * (W / 2 - 0.08) + 0.05, H + 0.24, z0, 0.09, 0.055, 0.004, rng.pick(['#a8473a', '#3f6a8f', '#2f6a4a']));
    }
  } else if (planOf(c, 2)) {
    // a mansard over the offices, its dormers along the front
    gb.push(0, 0, z0);
    const M = mansardRoof(c, W + 0.02, D + 0.02, H, 0.28, pal.slate, trim);
    mansardDormers(c, 6, W * 0.92, D + 0.02, H, M, wall, pal.slate, 0.7);
    gb.pop();
    for (const s of [-1, 1]) chimney(c, s * (W / 2 - 0.2), H - 0.05, M.top + 0.06, z0, 'home', STONE);
  } else {
    gb.hip(0, H, z0, W + 0.02, D + 0.02, 0.2, pal.slate, 0.04);
    for (const s of [-1, 1]) chimney(c, s * (W / 2 - 0.2), H - 0.05, H + 0.24, z0, 'home', STONE);
  }
  frontage(c, -W / 2, -pw / 2 - 0.08, f.dep / 2 - 0.06, [], 'railings');
  frontage(c, pw / 2 + 0.08, W / 2, f.dep / 2 - 0.06, [], 'railings');
  lamp(c, -pw / 2 - 0.04, f.dep / 2 - 0.08, 0.32); lamp(c, pw / 2 + 0.04, f.dep / 2 - 0.08, 0.32);
  if (f.turned) gb.pop();
};

// A watch house: the station on the street with a blue lamp over the door, a
// watch tower at its end (crowned with a pyramid, battlements or an open
// belfry), and a walled yard with the cells along the back. The Police
// Station is brick, three storeys, with a porch, a clock in the tower and
// the police wagon in the yard.
MODELS.watchhouse = (c, L) => {
  const { gb, rng, pal } = c;
  const f = rowFrame(c), crown = planOf(c, 3);
  const W = f.len - 0.12, back = -f.dep / 2, front = f.dep / 2;
  const wall = L ? pal.brick : pal.stoneWall;
  // the station
  const hw = 0.84, hd = 0.48, hx = -W / 2 + hw / 2 + 0.02, hz = back + 0.3, floors = L ? 3 : 2, h = L ? 0.78 : 0.52;
  house(c, { x: hx, z: hz, w: hw, d: hd, h, floors, wall, roof: pal.slate, roofType: ['hip', 'gable', 'parapet'][crown], rh: 0.2, nFront: L ? 5 : 4, doorX: 0, chimney: true, fancy: false, lit: 0.9, plinth: STONE });
  const hf = hz + hd / 2;
  gb.glow(1.0, 1.4, 2.2, 3.0); gb.box(hx, 0.21, hf + 0.03, 0.04, 0.05, 0.03, '#b8d0ff'); gb.noGlow();
  gb.box(hx, 0.2, hf + 0.012, 0.012, 0.012, 0.04, '#2f2c2a');
  sign(c, hx, h / floors + 0.01, hf + 0.012, 0.34, 0.05, '#2f3e5a');
  if (L) portico(c, hx, hf, 0.24, 0.2, 2, pal.slate);
  // the watch tower beside it (a clock in it at the Police Station)
  const s = L ? 1 : 0.9, tx = hx + hw / 2 + 0.13, tz = back + 0.2, H = L ? 1.25 : 0.95;
  footing(c, tx, tz, 0.26 * s, 0.26 * s);
  gb.cbox(tx, 0, tz, 0.26 * s, H, 0.26 * s, wall, 0, 0.02);
  gb.cbox(tx, H, tz, 0.32 * s, 0.045, 0.32 * s, STONE_D, 0, 0.012);
  const flag = rng.pick(['#2f3e5a', '#a8473a', '#3f6a8f']);
  if (crown === 1) {
    // battlements and a flag
    for (const a of [-1, 0, 1]) for (const b2 of [-1, 1]) { gb.box(tx + a * 0.11 * s, H + 0.045, tz + b2 * 0.14 * s, 0.05 * s, 0.06, 0.035 * s, wall); gb.box(tx + b2 * 0.14 * s, H + 0.045, tz + a * 0.11 * s, 0.035 * s, 0.06, 0.05 * s, wall); }
    gb.box(tx, H + 0.045, tz, 0.011, 0.34, 0.011, '#2f2c2a');
    gb.box(tx + 0.055, H + 0.3, tz, 0.11, 0.065, 0.004, flag);
  } else if (crown === 2) {
    // an open belfry under a lead cap
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) gb.box(tx + sx * 0.1 * s, H + 0.045, tz + sz * 0.1 * s, 0.035, 0.15, 0.035, wall);
    gb.cyl(tx, H + 0.08, tz, 0.025, 0.035, 0.05, 7, '#c08a3a');
    gb.box(tx, H + 0.195, tz, 0.3 * s, 0.025, 0.3 * s, STONE_D);
    gb.roof(tx, H + 0.22, tz, 0.26 * s, 0.26 * s, 0.12, 0, pal.slate);
    gb.box(tx, H + 0.34, tz, 0.011, 0.16, 0.011, '#2f2c2a');
    gb.box(tx + 0.055, H + 0.44, tz, 0.11, 0.065, 0.004, flag);
  } else {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) gb.cbox(tx + sx * 0.125 * s, H + 0.045, tz + sz * 0.125 * s, 0.07 * s, 0.07, 0.07 * s, wall, 0, 0.01);
    gb.roof(tx, H + 0.11, tz, 0.3 * s, 0.3 * s, 0.24, 0, pal.slate);
    gb.box(tx, H + 0.33, tz, 0.011, 0.22, 0.011, '#2f2c2a');
    gb.box(tx + 0.055, H + 0.47, tz, 0.11, 0.065, 0.004, flag);
  }
  for (let k = 0; k < 2; k++) win(c, tx, H * (0.3 + k * 0.3), tz + 0.13 * s, 0.05, 0.08, 'f', 0.9);
  if (L) {
    gb.cyl(tx, H * 0.84, tz + 0.132, 0.065, 0.065, 0.012, 14, STONE_D, 0, Math.PI / 2);
    gb.glow(1.2, 1.1, 0.8, 1.02); gb.cyl(tx, H * 0.84, tz + 0.138, 0.055, 0.055, 0.01, 14, '#efe8da', 0, Math.PI / 2); gb.noGlow();
  }
  c.addGlow(tx, H * 0.6 + 0.04, tz + 0.15 * s);
  // the cells along the back of the yard, barred windows facing in
  const yx0 = tx + 0.15, yx1 = W / 2, cx = (yx0 + yx1) / 2, cl = yx1 - yx0 - 0.02, cz = back + 0.16;
  footing(c, cx, cz, cl, 0.26);
  gb.cbox(cx, 0, cz, cl, 0.26, 0.26, wall, 0, 0.014);
  gb.gable(cx, 0.26, cz, cl + 0.02, 0.26, 0.12, wall, pal.slate, 0.04, false, 0.03);
  const n = Math.max(3, Math.round(cl / 0.16));
  for (let i = 0; i < n; i++) {
    const x = cx - cl / 2 + (i + 0.5) * (cl / n);
    gb.box(x, 0.13, cz + 0.132, 0.05, 0.05, 0.008, '#2a2a2e');
    for (let k = -1; k <= 1; k++) gb.box(x + k * 0.016, 0.13, cz + 0.137, 0.005, 0.05, 0.005, '#6a6a6e');
  }
  plainDoor(c, cx - cl / 2 + 0.08, cz + 0.13, 0.07, 0.16, '#3a3a3e');
  // a high yard wall round the front, with gate piers
  const wz = front - 0.06, wy = 0.12, wc = '#9a9284';
  const seg = (ax, az, bx, bz) => { const mx = (ax + bx) / 2, mz = (az + bz) / 2; gb.cbox(mx, c.gy(mx, mz) - 0.01, mz, Math.abs(bx - ax) + 0.04, wy, Math.abs(bz - az) + 0.04, wc, 0, 0.012); };
  const gx = cx + 0.08;
  seg(yx0, wz, gx - 0.11, wz); seg(gx + 0.11, wz, yx1 - 0.02, wz);
  seg(yx1 - 0.02, cz + 0.13, yx1 - 0.02, wz);
  seg(yx0, tz + 0.13 * s + 0.02, yx0, wz);
  gatePiers(c, gx, wz, 0.22);
  if (L) coach(c, cx, cz + 0.36, Math.PI / 2, '#22304a', false);
  else { handcart(c, cx + 0.1, cz + 0.32); barrel(c, yx1 - 0.1, cz + 0.24); }
  lamp(c, hx + hw / 2 - 0.06, front - 0.06, 0.3); lamp(c, hx - hw / 2 + 0.06, front - 0.06, 0.3);
  if (f.turned) gb.pop();
};

// A craftsman's house: the family's cottage at one end and the workshop at
// the other, its wide doors open onto a yard of planks, a sawhorse and a cart
// wheel being mended, with a small forge stack. Artisans' Row: three narrow
// houses under one roof, a wide workshop window below each and its trade
// sign hung out over the street.
MODELS.craftshouse = (c, L) => {
  const { gb, rng, pal } = c;
  const f = rowFrame(c);
  const W = f.len - 0.12, back = -f.dep / 2, front = f.dep / 2;
  const SIGNS = ['#5a3a1e', '#2f4a5a', '#6a2a2a', '#3f5a3a', '#5a4a6a'];
  // a trade sign hung out from the wall on a bracket
  const tradeSign = (x, y, z) => {
    gb.box(x, y + 0.08, z + 0.05, 0.012, 0.012, 0.1, '#3a2f28');
    sign(c, x, y, z + 0.08, 0.08, 0.07, rng.pick(SIGNS), Math.PI / 2);
  };
  const wheel = (x, z) => {
    const y = c.gy(x, z);
    gb.cyl(x, y + 0.062, z, 0.06, 0.06, 0.012, 10, '#5e432c', 0, Math.PI / 2);
    gb.cyl(x, y + 0.062, z + 0.004, 0.014, 0.014, 0.02, 6, '#3a2f28', 0, Math.PI / 2);
  };
  if (L === 0) {
    const hx = -W / 2 + 0.32, hz = back + 0.32, hw = 0.58, hd = 0.46;
    const { doorX } = house(c, { x: hx, z: hz, w: hw, d: hd, h: 0.5, floors: 2, wall: pal.wall, roof: pal.roof, roofType: 'gable', rh: 0.26, timber: pal.timber, chimney: true, lit: 0.85 });
    // the workshop: wide doors standing open, the forge glowing inside
    const ww = 0.7, wd = 0.42, wx = W / 2 - ww / 2 - 0.05, wz = back + 0.3, wf = wz + wd / 2, dx = wx - 0.12;
    worksShed(c, wx, wz, ww, wd, 0.32, 1, pal.wood, pal.slate, 0.18, (u) => Math.abs(u - dx) < 0.22);
    gb.box(dx, 0, wf + 0.006, 0.2, 0.22, 0.012, '#2a2018');
    for (const s of [-1, 1]) gb.box(dx + s * 0.15, 0, wf + 0.012, 0.08, 0.21, 0.01, '#6e5034');
    c.addGlow(dx, 0.1, wf - 0.04, 'forge');
    chimney(c, wx + ww / 2 - 0.1, 0.26, 0.66, wz, 'work', STONE_D);
    tradeSign(wx + ww / 2 - 0.05, 0.2, wf);
    // the yard in front of it
    plankStack(c, wx + 0.2, front - 0.15, 3, 0);
    sawhorse(c, dx, front - 0.17, 0.3);
    wheel(wx + 0.03, front - 0.09);
    crate(c, wx + 0.31, front - 0.07, 0.9);
    // and the cottage's front garden
    frontage(c, hx - hw / 2, hx + hw / 2, front - 0.05, [hx + doorX], pal.fence === 'stone' ? 'wall' : pal.fence === 'hedge' ? 'hedge' : 'picket');
    flowers(c, hx - hw * 0.3, front - 0.15, 6, 0.06); bush(c, hx + hw * 0.3, front - 0.14, 0.8);
  } else {
    const n = 3, D = 0.5, z0 = back + D / 2 + 0.06, fz = z0 + D / 2, fh = 0.3, h = 2 * fh, rh = 0.24, uw = W / n;
    footing(c, 0, z0, W, D);
    for (let i = 0; i < n; i++) {
      const ux = -W / 2 + (i + 0.5) * uw, wall = shade(pal.style === 'brick' ? pal.brick : pal.wall, rng.float(0.93, 1.05));
      gb.cbox(ux, 0, z0, uw + 0.003, h, D, wall, 0, 0.008);
      const flip = i % 2 === 1, dx = ux + (flip ? 1 : -1) * uw * 0.3, wx = ux + (flip ? -1 : 1) * uw * 0.08;
      door(c, dx, fz, 0.085, 0.17, rng.pick(DOORS));
      // a wide workshop window below, two windows above
      win(c, wx, fh * 0.28, fz, 0.22, 0.13, 'f', 0.9);
      for (const sx of [-1, 1]) win(c, ux + sx * uw * 0.2, fh + fh * 0.34, fz, 0.075, 0.1, 'f');
      for (let k = 0; k < 2; k++) win(c, ux, k * fh + fh * 0.36, z0 - D / 2, 0.075, 0.09, 'b');
      tradeSign(ux + (flip ? -1 : 1) * uw * 0.42, fh + 0.04, fz);
    }
    for (const sx of [-1, 1]) for (let k = 0; k < 2; k++) win(c, sx * W / 2, k * fh + fh * 0.36, z0, 0.07, 0.09, sx > 0 ? 'r' : 'l');
    // its roofs: one long one, a gable to the street over each house, or
    // each house its own (planOf)
    const plan = planOf(c, 3);
    if (plan === 2) for (let i = 0; i < n; i++) gb.gable(-W / 2 + (i + 0.5) * uw, h, z0, uw + 0.012, D, rh * [1, 1.3, 0.85][i], pal.wall, pal.slate, 0.04, false, 0.03);
    else gb.gable(0, h, z0, W + 0.02, D, rh, pal.wall, pal.slate, 0.05, false, 0.035);
    if (plan === 1) for (let i = 0; i < n; i++) wallGable(c, 'plain', -W / 2 + (i + 0.5) * uw, fz, uw * 0.7, h, rh, D * 0.45, pal.wall, pal.slate, '#e3dccd', 0.8);
    // a stack on each party wall
    for (let i = 1; i < n; i++) chimney(c, -W / 2 + i * uw, h - 0.05, h + rh * (plan === 2 ? 1.3 : 1) + 0.07, z0, 'home', stackColor(c));
    // work set out on the pavement
    wheel(-W / 2 + 0.22, front - 0.08);
    crate(c, -0.12, front - 0.1); crate(c, -0.05, front - 0.08, 0.8);
    plankStack(c, 0.3, front - 0.14, 2, 0);
    barrel(c, W / 2 - 0.12, front - 0.1); bench(c, W / 2 - 0.34, front - 0.12, Math.PI);
  }
  if (f.turned) gb.pop();
};

// A building yard: the builder's office with its sign, an open timber shed
// stacked with planks, logs, stone, a sawhorse, a ladder and a handcart,
// fenced round. Building Contractors: a brick office, two timber sheds, a
// treadwheel crane and a stone yard behind a wall.
MODELS.contractor = (c, L) => {
  const { gb, rng, pal } = c;
  const f = rowFrame(c);
  const W = f.len - 0.12, back = -f.dep / 2, front = f.dep / 2;
  const ow = 0.5, ox = -W / 2 + ow / 2 + 0.05, oz = back + 0.3;
  house(c, { x: ox, z: oz, w: ow, d: 0.42, h: L ? 0.56 : 0.44, floors: 2, wall: L ? pal.brick : pal.wall, roof: L ? pal.slate : pal.roof, roofType: 'gable', rh: 0.22, chimney: true, timber: L ? false : pal.timber, nFront: 2, doorX: 0, fancy: false, lit: 0.8 });
  sign(c, ox, L ? 0.34 : 0.28, oz + 0.222, 0.3, 0.06, '#3b2f2a');
  // timber sheds with planks stacked inside
  const sheds = L ? [0.06, 0.62] : [0.32];
  for (const sx of sheds) {
    shed(c, sx, back + 0.27, L ? 0.5 : 0.62, 0.4, 0.3, pal.roof);
    plankStack(c, sx, back + 0.27, 4, 0);
  }
  // the yard
  const yz = front - 0.2;
  logs(c, -0.32, yz, 3, 0);
  plankStack(c, 0.06, yz + 0.04, 3, 0.1);
  stoneStack(c, 0.3, yz + 0.06, L ? 3 : 2);
  sawhorse(c, -0.1, yz - 0.08, 0.4);
  ladder(c, W / 2 - 0.05, back + 0.3, 0.32, -Math.PI / 2, 0.3);
  if (L) {
    treadwheel(c, 0.66, yz, 0);
    for (const [x, z] of [[0.45, yz + 0.1], [0.82, yz + 0.12]]) stoneStack(c, x, z, rng.int(2, 3));
    boundary(c, 'stone', -W / 2 + ow + 0.08, back + 0.04, W / 2 - 0.02, front - 0.04, 0.1);
    lamp(c, ox + ow / 2 - 0.04, front - 0.06, 0.3);
  } else {
    handcart(c, 0.62, yz);
    fence(c, -W / 2 + ow + 0.08, back + 0.04, W / 2 - 0.02, front - 0.04, FENCE, { x: 0.1, z: front - 0.04, w: 0.12 });
  }
  if (f.turned) gb.pop();
};

// A cottage hospital: a two-storey entrance block with the red cross over
// the door, a long single-storey ward with a verandah where patients sit
// out, and a garden. The General Hospital: three storeys between two-storey
// wings, a canopied entrance, and a horse ambulance at the door.
MODELS.cottagehospital = (c, L) => {
  const { gb, rng, pal } = c;
  const f = rowFrame(c);
  const W = f.len - 0.12, back = -f.dep / 2, front = f.dep / 2;
  const white = '#ece4d4';
  const redCross = (x, y, z) => {
    sign(c, x, y, z, 0.13, 0.13, '#f5f0e6');
    gb.glow(1.6, 0.3, 0.3, 3.0);
    gb.box(x, y + 0.055, z + 0.008, 0.085, 0.026, 0.008, '#b83a32');
    gb.box(x, y + 0.025, z + 0.008, 0.026, 0.085, 0.008, '#b83a32');
    gb.noGlow();
  };
  if (L === 0) {
    // the house at either end of the ward, its gable or its eaves to the street
    const side = c.form.side, gableEnd = c.form.b < 0.6;
    const ew = 0.44, ed = 0.48, ex = side * (-W / 2 + 0.5), ez = back + 0.3;
    house(c, { x: ex, z: ez, w: ew, d: ed, h: 0.5, floors: 2, wall: white, roof: pal.tile, roofType: gableEnd ? 'gable' : 'hip', alongZ: gableEnd, rh: 0.22, chimney: true, doorX: 0, doorW: 0.11, fancy: false, plinth: STONE, lit: 0.9, nFront: 2 });
    redCross(ex, 0.3, ez + ed / 2 + 0.004);
    // the ward, its tall windows on both sides, and a verandah along it
    const wx0 = side > 0 ? ex + ew / 2 : -W / 2, wx1 = side > 0 ? W / 2 : ex - ew / 2, wx = (wx0 + wx1) / 2, ww = wx1 - wx0, wz = back + 0.26, wd = 0.38, wh = 0.3;
    footing(c, wx, wz, ww, wd);
    gb.cbox(wx, 0, wz, ww, wh, wd, white, 0, 0.014);
    gb.gable(wx, wh, wz, ww + 0.02, wd, 0.16, white, pal.slate, 0.05, false, 0.03);
    const n = Math.round(ww / 0.13);
    for (let i = 0; i < n; i++) {
      const x = wx - ww / 2 + (i + 0.5) * (ww / n);
      win(c, x, 0.07, wz + wd / 2, 0.06, 0.17, 'f', 0.85);
      win(c, x, 0.07, wz - wd / 2, 0.06, 0.17, 'b', 0.85);
    }
    const vz = wz + wd / 2 + 0.09;
    for (let i = 0; i <= 4; i++) {
      const x = wx - ww / 2 + 0.03 + (i * (ww - 0.06)) / 4, y = c.gy(x, vz + 0.07);
      gb.box(x, y - 0.01, vz + 0.07, 0.016, 0.25 - y, 0.016, '#e9e2d4');
    }
    gb.boxC(wx, 0.24, vz, ww, 0.014, 0.19, pal.slate, 0.3);
    bench(c, wx - 0.18, vz + 0.02, Math.PI); bench(c, wx + 0.16, vz + 0.02, Math.PI);
    // a garden at the other end, and the path to the door
    smallTree(c, side * (-W / 2 + 0.14), front - 0.26, 0.8);
    flowers(c, side * (-W / 2 + 0.16), back + 0.2, 6, 0.06); bush(c, side * (-W / 2 + 0.12), 0.02, 0.8);
    gravel(c, ex, (ez + ed / 2 + front) / 2, 0.1, front - ez - ed / 2 - 0.02);
    hedge(c, wx, front - 0.05, ww - 0.08, 0.05);
    lamp(c, ex + side * 0.16, front - 0.06, 0.28);
  } else {
    // the General Hospital: a tall centre between wings (hipped, or with
    // gables to the street), or a clock turret over a mansard centre
    const plan = planOf(c, 3), cw = 0.6, cd = 0.56, cx = -0.1, cz = back + 0.32;
    const r = house(c, { x: cx, z: cz, w: cw, d: cd, h: 0.84, floors: 3, wall: white, roof: pal.slate, roofType: plan === 2 ? 'mansard' : 'hip', rh: plan === 2 ? 0.3 : 0.24, dormers: plan === 2 ? 3 : 0, chimney: true, plinth: STONE, doorX: 0, doorW: 0.13, fancy: false, lit: 0.95, nFront: 3 });
    for (const s of [-1, 1]) house(c, { x: cx + s * (cw / 2 + 0.27), z: cz - 0.02, w: 0.54, d: 0.5, h: 0.56, floors: 2, wall: white, roof: pal.slate, roofType: plan === 1 ? 'gable' : 'hip', rh: 0.18, noDoor: true, fancy: false, plinth: STONE, nFront: 3, lit: 0.95 });
    if (plan === 1) for (const s of [-1, 1]) wallGable(c, 'plain', cx + s * (cw / 2 + 0.27), cz - 0.02 + 0.25, 0.3, 0.56, 0.18, 0.25, white, pal.slate, '#e3dccd', 0.95);
    if (plan === 2) { gb.cbox(cx, r.top - 0.04, cz, 0.13, 0.16, 0.13, white, 0, 0.01); wallClock(c, cx, r.top + 0.05, cz + 0.067, 0.04); gb.roof(cx, r.top + 0.12, cz, 0.17, 0.17, 0.14, 0, pal.slate); }
    const fz = cz + cd / 2;
    gb.box(cx, 0.24, fz + 0.06, 0.26, 0.02, 0.12, pal.slate);
    for (const s of [-1, 1]) gb.cyl(cx + s * 0.11, 0, fz + 0.11, 0.012, 0.012, 0.24, 6, '#e9e2d4');
    redCross(cx, 0.6, fz + 0.004);
    coach(c, 0.42, front - 0.2, Math.PI / 2, '#e8e2d4', true);
    bench(c, cx - 0.5, front - 0.1, Math.PI); bench(c, -W / 2 + 0.16, front - 0.1, Math.PI);
    lamp(c, cx - 0.22, front - 0.06, 0.3); lamp(c, cx + 0.22, front - 0.06, 0.3);
  }
  void rng;
  if (f.turned) gb.pop();
};

// A board school: a tall brick schoolroom range with big windows, two gabled
// porches (one for the girls, one for the boys), a bell turret on the ridge,
// stacks at both ends and a walled playground with a flagpole. The Large
// Board School is three storeys with a taller turret.
MODELS.boardschool = (c, L) => {
  const { gb, rng, pal } = c;
  const f = rowFrame(c);
  const W = f.len - 0.12, back = -f.dep / 2, front = f.dep / 2;
  const brick = pal.style === 'stone' ? pal.stoneWall : pal.style === 'brick' ? pal.brick : rng.pick(['#a8573a', '#9a5640', '#b8704a', '#8c4c38']);
  const floors = L ? 3 : 1, fh = L ? 0.26 : 0.44, h = floors * fh, D = 0.5, z0 = back + D / 2 + 0.05, fz = z0 + D / 2, len = W - 0.06, rh = 0.24;
  const plan = planOf(c, 3);
  footing(c, 0, z0, len, D);
  gb.cbox(0, 0, z0, len, h, D, brick, 0, 0.02);
  if (plan === 1) gb.hip(0, h, z0, len + 0.02, D, rh, pal.slate, 0.05);
  else gb.gable(0, h, z0, len + 0.02, D, rh, brick, pal.slate, 0.05, false, 0.035);
  // the big classroom gables to the street (on the second plan)
  if (plan === 2) for (const x of [-len * 0.12, len * 0.12]) wallGable(c, 'plain', x, fz, 0.3, h, 0.22, D / 2, brick, pal.slate, '#e3dccd', 0.75);
  // tall classroom windows down both sides, stone bands between storeys
  const n = Math.round(len / 0.17), porch = (x) => Math.abs(Math.abs(x) - len * 0.3) < 0.12;
  for (let k = 0; k < floors; k++) for (let i = 0; i < n; i++) {
    const x = -len / 2 + (i + 0.5) * (len / n), y = k * fh + (L ? 0.07 : 0.1), wh = L ? 0.13 : 0.24;
    if (!(k === 0 && porch(x))) win(c, x, y, fz, 0.075, wh, 'f', 0.75);
    win(c, x, y, z0 - D / 2, 0.075, wh, 'b', 0.75);
  }
  for (let k = 1; k < floors; k++) gb.box(0, k * fh - 0.008, fz + 0.004, len, 0.016, 0.012, '#d8ccb4');
  // the two porches, girls' and boys'
  for (const s of [-1, 1]) {
    const px = s * len * 0.3, pz = fz + 0.07;
    gb.cbox(px, 0, pz, 0.18, 0.26, 0.14, brick, 0, 0.012);
    gb.gable(px, 0.26, pz, 0.18, 0.14, 0.1, brick, pal.slate, 0.03, true, 0.025);
    door(c, px, pz + 0.07, 0.08, 0.16, s < 0 ? '#3f4f5a' : '#5c3d26');
    sign(c, px, 0.19, pz + 0.072, 0.12, 0.03, '#e3dccd');
  }
  // the bell turret (a spirelet, or a cupola), and a stack at each end
  const ty = h + rh - 0.04, th = L ? 0.2 : 0.15;
  gb.cbox(0, ty, z0, 0.12, th, 0.12, '#e9e0cc', 0, 0.01);
  gb.cyl(0, ty + th * 0.35, z0, 0.022, 0.03, 0.04, 7, '#c08a3a');
  if (plan === 1) { gb.box(0, ty + th, z0, 0.15, 0.015, 0.15, '#e9e0cc'); gb.sphere(0, ty + th + 0.015, z0, 0.07, pal.slate, 1, 0.9); }
  else gb.roof(0, ty + th, z0, 0.16, 0.16, L ? 0.2 : 0.14, 0, pal.slate);
  for (const s of [-1, 1]) chimney(c, s * (len / 2 - 0.1), h - 0.05, h + rh * 0.55 + 0.08, z0, 'home', stackColor(c));
  // the playground: a wall along the street, hopscotch and a flagpole
  frontage(c, -len / 2, len / 2, front - 0.05, [-len * 0.3, len * 0.3], 'wall');
  for (let i = 0; i < 4; i++) gravel(c, -0.06 + (i % 2) * 0.06, front - 0.32 + Math.floor(i / 2) * 0.06, 0.05, 0.05, '#d8d0bc');
  const fx = len / 2 - 0.06, fz2 = front - 0.14, fy = c.gy(fx, fz2);
  gb.box(fx, fy, fz2, 0.011, 0.44, 0.011, '#cfcfcf');
  gb.box(fx + 0.045, fy + 0.36, fz2, 0.085, 0.055, 0.004, rng.pick(AWNING));
  if (f.turned) gb.pop();
};

// A chapel and its vicarage: the chapel with its tower to the street at one
// end, the minister's house at the other, gravestones and a yew in the
// churchyard between, a lych-gate on the path and a low wall along the
// street. Church & Rectory: a stone church with a clock and a spire, and a
// bigger rectory.
MODELS.vicarage = (c, L) => {
  const { gb, rng, pal } = c;
  const f = rowFrame(c), F = c.form, side = F.side;
  const W = f.len - 0.12, back = -f.dep / 2, front = f.dep / 2;
  const wall = L ? pal.stoneWall : '#ece4d4';
  const w = L ? 0.48 : 0.4, d = L ? 0.72 : 0.6, h = L ? 0.5 : 0.4, nx = side * (-W / 2 + w / 2 + 0.06), z0 = back + d / 2 + 0.04;
  footing(c, nx, z0, w, d);
  gb.cbox(nx, 0, z0, w, h, d, wall, 0, 0.022);
  gb.gable(nx, h, z0, w, d, L ? 0.32 : 0.26, wall, L ? pal.slate : pal.roof, 0.05, true, 0.035);
  for (let i = 0; i < 3; i++) {
    const zz = z0 - d / 2 + (i + 0.5) * (d / 3);
    for (const side of [1, -1]) stainedGlass(c, nx + side * (w / 2 + 0.007), h * 0.3, zz, 0.065, h * 0.45, i + (side > 0 ? 0 : 1), side > 0 ? 'r' : 'l');
  }
  // the tower at the street end, standing clear above the ridge, its door
  // the way in
  const tw = L ? 0.2 : 0.17, th = L ? 1.08 : 0.86, tz = z0 + d / 2 - tw / 2 + 0.03;
  const kind = (L ? ['spire', 'battlement', 'pyramid', 'lantern'] : ['spire', 'pyramid', 'saddle', 'belfry'])[planOf(c, 4)];
  tower(c, kind, nx, tz, tw, th - (kind === 'spire' ? 0.06 : 0), wall, L ? pal.slate : pal.roof, { cross: kind === 'spire', clock: L > 0, lit: 0.8 });
  door(c, nx, tz + tw / 2, 0.07, 0.15, '#4e3424');
  // the vicarage (the rectory at the church)
  const vw = L ? 0.62 : 0.56, vx = side * (W / 2 - vw / 2 - 0.04), vz = back + 0.34;
  const { doorX } = house(c, { x: vx, z: vz, w: vw, d: 0.44, h: L ? 0.6 : 0.5, floors: 2, wall: pal.wall, roof: L ? pal.slate : pal.roof, roofType: L ? 'hip' : 'gable', rh: 0.24, chimney: true, lit: 0.85 });
  // the churchyard between them: gravestones and a yew
  const gx0 = Math.min(nx, vx) + (side > 0 ? w : vw) / 2 + 0.1 - (side > 0 ? 0 : 0.04), gx1 = Math.max(nx, vx) - (side > 0 ? vw : w) / 2 - 0.06 + (side > 0 ? 0 : 0.04);
  for (let i = 0; i < (L ? 8 : 6); i++) {
    const cols = L ? 4 : 3, gx = gx0 + (i % cols + 0.5) * ((gx1 - gx0) / cols), gz = back + 0.18 + Math.floor(i / cols) * 0.2;
    gb.cbox(gx, c.gy(gx, gz) - 0.01, gz, 0.05, 0.075, 0.016, '#a39e94', 0, 0.006);
  }
  for (const [yx, yz, s] of L ? [[gx1 - 0.05, front - 0.2, 1], [gx0 + 0.04, front - 0.24, 0.8]] : [[gx1 - 0.05, front - 0.2, 0.9]]) {
    const y = c.gy(yx, yz);
    gb.cyl(yx, y - 0.01, yz, 0.014, 0.018, 0.05, 6, '#5e432c');
    gb.cone(yx, y + 0.03, yz, 0.09 * s, 0.26 * s, 7, '#2f4a2a');
  }
  // the path to the church door, a lych-gate, and a low wall along the street
  const pz0 = tz + tw / 2, gz = front - 0.07;
  gravel(c, nx, (pz0 + gz) / 2, 0.08, gz - pz0);
  for (const s of [-1, 1]) gb.box(nx + s * 0.065, c.gy(nx + s * 0.065, gz), gz, 0.018, 0.16, 0.018, '#5e432c');
  gb.gable(nx, c.gy(nx, gz) + 0.16, gz, 0.18, 0.1, 0.07, pal.wood, L ? pal.slate : pal.roof, 0.02);
  frontage(c, -W / 2, W / 2, front - 0.05, [nx, vx + doorX], 'wall');
  flowers(c, vx - vw * 0.3, front - 0.15, 6, 0.06); bush(c, vx + vw * 0.32, front - 0.14, 0.8);
  if (L) lamp(c, nx + 0.16, front - 0.08, 0.3);
  if (f.turned) gb.pop();
};

// A tea garden: the coffee house at one end (a bow-windowed shopfront, tea
// rooms under an awning later), and beside it a lawn of tables under
// parasols, flower beds, low lanterns, and a hedge along the street with a
// gate. The Tea Pavilion adds an open pavilion with a domed roof at the far
// end of the lawn.
MODELS.teagarden = (c, L) => {
  const { gb, rng, pal } = c;
  const f = rowFrame(c);
  const W = f.len - 0.12, back = -f.dep / 2, front = f.dep / 2;
  const pastel = ownPick(c, ['#c87a8a', '#7a9ac8', '#8ab08a', '#c8a050'], 9);
  // the coffee house, its shopfront to the street (the shop door is the way in)
  const hw = 0.62, hd = 0.5, hx = -W / 2 + hw / 2 + 0.04, fz = back + hd + 0.06, H = L ? 0.6 : 0.54;
  shopBody(c, { x: hx, z: fz - hd / 2, w: hw, d: hd, h: H, floors: 2, wall: pal.forced ? pal.wall : ownPick(c, PAINTED, 8), roof: L ? pal.slate : pal.roof, roofType: 'gable', rh: 0.26, chimney: true, timber: !L && pal.timber });
  const sf = shopfront(c, hx, fz, hw - 0.04, 0.26, { bow: !L, fascia: L ? shade(pastel, 0.6) : rng.pick(['#3b2f2a', '#2f3e2a', '#4a2a2a']), lit: true });
  for (const p of sf.panes) for (let i = 0; i < 2; i++) gb.cyl(p.m + (i - 0.5) * p.w * 0.45, 0.05, p.z + 0.02, 0.018, 0.012, 0.03, 8, i ? '#e8d8c0' : '#8a5a3a');
  if (L) awning(c, hx, sf.top - 0.004, fz, hw - 0.02, pastel);
  else hangSign(c, hx + hw / 2 - 0.05, 0.31, fz, 'pot', GOLD);
  tubPlant(c, hx - hw / 2 + 0.03, fz + 0.08, L > 0); tubPlant(c, hx + hw / 2 - 0.03, fz + 0.08, L > 0);
  cafeTable(c, hx - 0.14, fz + 0.26); cafeTable(c, hx + 0.14, fz + 0.26);
  // the garden: hedged round, a gate from the street and a gravel walk
  const gx0 = hx + hw / 2 + 0.05, gx1 = W / 2, gw = gx1 - gx0, gx = gx0 + gw * 0.3, hz = front - 0.05;
  hedge(c, (gx0 + gx1) / 2, back + 0.04, gw, 0.05);
  hedge(c, gx1 - 0.03, 0, 0.05, f.dep - 0.12);
  hedge(c, (gx0 + gx - 0.08) / 2, hz, gx - 0.08 - gx0, 0.05);
  hedge(c, (gx + 0.08 + gx1) / 2, hz, gx1 - gx - 0.08, 0.05);
  gatePiers(c, gx, hz, 0.16, '#e3dccd');
  gravel(c, gx, hz - 0.13, 0.1, 0.22, '#d8ccb0');
  // tables under parasols on the lawn, a pavilion at the end of it later
  const spots = L ? [[0.12, -0.26], [0.12, 0.04], [0.44, 0.04], [0.44, -0.26]] : [[0.2, -0.25], [0.6, -0.25], [0.22, 0.05], [0.62, 0.05]];
  spots.forEach(([u, z], i) => cafeTable(c, gx0 + u * gw, z, i % 2 ? '#e9dfc9' : pastel));
  if (L) {
    const px = gx0 + gw * 0.8, pz = back + 0.27, py = c.gy(px, pz), r = 0.15;
    gb.cyl(px, py - 0.01, pz, r + 0.03, r + 0.03, 0.03, 12, STONE);
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; gb.cyl(px + Math.cos(a) * r, py + 0.02, pz + Math.sin(a) * r, 0.01, 0.012, 0.22, 6, '#ece6da'); }
    gb.cyl(px, py + 0.24, pz, r + 0.04, r + 0.04, 0.025, 12, '#ece6da');
    gb.sphere(px, py + 0.26, pz, r + 0.03, pastel, 1, 0.7);
    gb.cyl(px, py + 0.37, pz, 0.006, 0.006, 0.06, 4, GOLD);
    cafeTable(c, px, pz, null);
  } else flowers(c, gx0 + gw * 0.82, back + 0.2, 7, 0.07);
  flowers(c, gx0 + 0.1, back + 0.14, 6, 0.06); flowers(c, gx1 - 0.14, hz - 0.12, 5, 0.06);
  smallTree(c, gx0 + 0.07, hz - 0.14, 0.75); smallTree(c, gx1 - 0.1, 0.06, 0.8);
  for (const u of [0.38, 0.75]) lamp(c, gx0 + u * gw, -0.11, 0.22);
  if (f.turned) gb.pop();
};

// A free library: a classical front with a portico, tall arched windows and
// a cornice, and beside it the reading room (the stationer's old shop
// rebuilt) under a glazed roof, behind railings. The Public Library is
// taller, with a dome on a drum over the middle and a lantern on top.
MODELS.library = (c, L) => {
  const { gb, pal } = c;
  const f = rowFrame(c);
  const W = f.len - 0.12, back = -f.dep / 2, front = f.dep / 2;
  const stone = pal.style === 'brick' ? pal.brick : '#d8d0bf', trim = '#ece6da';
  const mw = 0.9, md = 0.56, mx = -W / 2 + mw / 2 + 0.04, mz = back + md / 2 + 0.06, mf = mz + md / 2, H = L ? 0.66 : 0.5, wh = L ? 0.3 : 0.24;
  door(c, mx, mf, 0.1, 0.2, '#3f4f5a');
  footing(c, mx, mz, mw, md);
  gb.cbox(mx, 0, mz, mw, H, md, stone, 0, 0.02);
  gb.box(mx, H - 0.04, mz, mw + 0.03, 0.045, md + 0.03, trim);
  gb.hip(mx, H, mz, mw + 0.02, md + 0.02, 0.2, pal.slate, 0.04);
  for (const s of [-1, 1]) for (let i = 0; i < 2; i++) {
    const x = mx + s * (0.23 + i * 0.15);
    win(c, x, 0.08, mf, 0.08, wh, 'f', 0.9);
    gb.cyl(x, 0.08 + wh * (c.winH || 1) + 0.012, mf + 0.004, 0.052, 0.052, 0.014, 10, trim, 0, Math.PI / 2);
  }
  for (const s of [-1, 1]) for (let i = 0; i < 2; i++) win(c, mx + s * mw / 2, 0.1, mz - 0.12 + i * 0.24, 0.08, wh, s > 0 ? 'r' : 'l', 0.8);
  portico(c, mx, mf, 0.3, L ? 0.36 : 0.28, 4, pal.slate, trim);
  const crown = planOf(c, 3);
  if (L && crown === 1) {
    // a clock tower over the roof, a lantern on it
    tower(c, 'lantern', mx, mz - 0.06, 0.22, H + 0.36, stone, '#5f8f7e', { clock: true });
  } else if (!L && crown === 1) {
    // a pediment over the portico's bay, carried up over the cornice
    gb.gable(mx, H, mf - 0.01, 0.4, 0.03, 0.1, trim, trim, 0.01, true);
  } else if (!L && crown === 2) {
    // a cupola on the roof
    gb.push(mx, 0, mz); crest(c, 'cupola', H + 0.2, 0, 0, stone, pal.slate); gb.pop();
  } else if (L) {
    // a dome on a windowed drum, and a lantern
    const dy = H + 0.06;
    gb.cyl(mx, dy, mz, 0.17, 0.17, 0.2, 14, stone);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      gb.glow(WARM[0], WARM[1], WARM[2], 1.1);
      gb.box(mx + Math.sin(a) * 0.172, dy + 0.06, mz + Math.cos(a) * 0.172, 0.04, 0.09, 0.012, GLASS, a);
      gb.noGlow();
    }
    gb.cyl(mx, dy + 0.2, mz, 0.19, 0.19, 0.025, 14, trim);
    gb.sphere(mx, dy + 0.22, mz, 0.17, '#5f8f7e', 1, 0.8);
    gb.cyl(mx, dy + 0.35, mz, 0.03, 0.03, 0.06, 8, trim);
    gb.cone(mx, dy + 0.41, mz, 0.04, 0.05, 8, '#5f8f7e');
  }
  // the reading room, lit from above
  const rw = W / 2 - (mx + mw / 2) - 0.04, rx = mx + mw / 2 + rw / 2 + 0.02, rd = 0.44, rz = back + rd / 2 + 0.06, rh = L ? 0.42 : 0.36;
  footing(c, rx, rz, rw, rd);
  gb.cbox(rx, 0, rz, rw, rh, rd, stone, 0, 0.016);
  gb.gable(rx, rh, rz, rw + 0.02, rd, 0.16, stone, pal.slate, 0.04, false, 0.03);
  glassRoof(c, rx, rh, rz, rw * 0.6, rd, 0.16, false, 4, 0.043);
  for (let i = 0; i < 3; i++) {
    const x = rx - rw / 2 + (i + 0.5) * (rw / 3);
    win(c, x, 0.08, rz + rd / 2, 0.09, 0.2, 'f', 0.9);
    win(c, x, 0.08, rz - rd / 2, 0.09, 0.2, 'b', 0.8);
  }
  sign(c, rx, rh - 0.08, rz + rd / 2 + 0.01, rw * 0.6, 0.05, '#2a3a4a');
  // railings along the street, lamps by the steps, a bench and a book barrow
  frontage(c, -W / 2, W / 2, front - 0.05, [mx], 'railings');
  lamp(c, mx - 0.24, front - 0.12, 0.3); lamp(c, mx + 0.24, front - 0.12, 0.3);
  bench(c, rx - rw * 0.2, front - 0.16, Math.PI);
  bookBarrow(c, rx + rw * 0.25, front - 0.17);
  if (f.turned) gb.pop();
};


// A country mansion on a double plot, in one of its plans: a centre block
// and wings with a portico; a forecourt, the wings coming forward with
// pediments on their ends and a cupola on the centre; Tudor, a long range
// with gables to the drive and a porch tower; a château, mansards with round
// towers at the ends of the centre. A formal garden in front.
MODELS.mansion = (c, L) => {
  const { gb, pal } = c;
  const f = rowFrame(c), F = c.form, plan = planOf(c, 4);
  const W = f.len - 0.14;
  const wall = pal.stoneHouse || L ? pal.stoneWall : pal.wall, roof = pal.slate, trim = '#ece6da';
  const z0 = -f.dep / 2 + 0.32;
  const H = L ? 0.9 : 0.62, floors = L ? 3 : 2;
  if (plan === 1) {
    // a forecourt between wings that come forward, pediments on their ends
    const r = house(c, { x: 0, z: z0 - 0.02, w: 0.74, d: 0.44, h: H, floors, wall, roof, roofType: 'hip', roofLock: true, rh: 0.26, plinth: STONE, doorX: 0, doorW: 0.12, nFront: 3, chimney: true, chimneyPos: 'ends', form: { turret: null, crest: null, front: 'eaves', bay: null } });
    gb.push(0, 0, z0 - 0.02); crest(c, 'cupola', r.top, 0, 0, wall, roof); gb.pop();
    for (const s of [-1, 1]) {
      const wx = s * (W / 2 - 0.2), wd = 0.56;
      house(c, { x: wx, z: z0 + 0.38 - wd / 2, w: 0.36, d: wd, h: L ? 0.66 : 0.5, floors: 2, wall, roof, roofType: 'hip', alongZ: true, rh: 0.2, noDoor: true, plinth: STONE, nFront: 2, chimney: true, form: false });
      gb.gable(wx, (L ? 0.66 : 0.5) + 0.01, z0 + 0.37, 0.38, 0.04, 0.1, trim, trim, 0.012, true);
    }
    gravel(c, 0, z0 + 0.28, 0.6, 0.18);
  } else if (plan === 2) {
    // Tudor: a long range with gables to the drive, a porch tower in the middle
    house(c, { x: 0, z: z0, w: W - 0.1, d: 0.42, h: H, floors, wall, roof, roofType: 'gable', roofLock: true, rh: 0.3, plinth: STONE, noDoor: true, nFront: 8, chimney: true, chimneyPos: 'ends', timber: !L && pal.timber, form: { turret: null, front: 'eaves', dormer: null, bay: null, balcony: null } });
    const g = pal.style === 'timber' || (!L && pal.timber) ? 'plain' : F.gable === 'plain' ? 'stepped' : F.gable;
    for (const x of [-0.62, -0.32, 0.32, 0.62]) wallGable(c, g, x, z0 + 0.21, 0.24, H, 0.24, 0.24, wall, roof, trim, 0.85);
    house(c, { x: 0, z: z0 + 0.24, w: 0.2, d: 0.2, h: H + 0.26, floors: floors + 1, wall, roof, roofType: 'gable', alongZ: true, rh: 0.2, doorX: 0, doorW: 0.1, nFront: 1, chimney: false, plinth: STONE, form: false });
    for (const s of [-1, 1]) tallBay(c, s * 0.15, z0 + 0.21, H / floors, floors, wall, roof, 0.85, false, floors, 0.12);
  } else if (plan === 3) {
    // a château: mansards, round towers at the ends of the centre block
    house(c, { x: 0, z: z0, w: 0.72, d: 0.5, h: H, floors, wall, roof, roofType: 'mansard', rh: 0.34, dormers: 4, plinth: STONE, doorX: 0, doorW: 0.12, nFront: 3, chimney: true, chimneyPos: 'ends', form: false });
    for (const s of [-1, 1]) turret(c, 'round', s * 0.36, z0 + 0.2, 0, H + 0.2, 0.09, H / floors, wall, roof, 0.85);
    for (const s of [-1, 1]) house(c, { x: s * (W / 2 - 0.24), z: z0 + 0.04, w: 0.4, d: 0.42, h: L ? 0.62 : 0.46, floors: 2, wall, roof, roofType: 'mansard', rh: 0.24, dormers: 2, noDoor: true, plinth: STONE, nFront: 2, chimney: true, form: false });
    porchOf(c, 'portico', 0, z0 + 0.25, 0.2, wall, roof, 0.72, 0.3);
  } else {
    // centre block with two wings and a portico
    house(c, { x: 0, z: z0, w: 0.7, d: 0.5, h: H, floors, wall, roof, roofType: 'hip', rh: 0.3, plinth: STONE, doorX: 0, doorW: 0.12, nFront: 3, chimney: true, form: { porch: null, turret: null } });
    for (const s of [-1, 1]) house(c, { x: s * (W / 2 - 0.26), z: z0 + 0.04, w: 0.44, d: 0.42, h: L ? 0.62 : 0.46, floors: 2, wall, roof, roofType: 'hip', rh: 0.22, noDoor: true, plinth: STONE, nFront: 2, chimney: true });
    for (let i = 0; i < 4; i++) gb.cyl(-0.15 + i * 0.1, 0.02, z0 + 0.32, 0.016, 0.019, 0.36, 8, trim);
    gb.gable(0, 0.38, z0 + 0.3, 0.4, 0.14, 0.09, trim, roof, 0.02);
  }
  const gz = f.dep / 2 - 0.2;
  gb.box(0, c.gy(0, gz) - 0.006, gz, 0.12, 0.012, 0.3, '#cdbf9e');
  for (const s of [-1, 1]) { hedge(c, s * 0.42, gz, 0.5, 0.05); flowers(c, s * 0.25, gz - 0.06, 6, 0.06); smallTree(c, s * (W / 2 - 0.08), gz, 0.9); }
  if (L) { gb.cyl(0, c.gy(0, gz + 0.04), gz + 0.04, 0.09, 0.1, 0.05, 12, STONE); c.fountain = [0, c.gy(0, gz + 0.04) + 0.08, gz + 0.04]; }
  lamp(c, -0.12, f.dep / 2 - 0.06, 0.3); lamp(c, 0.12, f.dep / 2 - 0.06, 0.3);
  if (f.turned) gb.pop();
};

// Apartments on a double plot, in one of their plans: stacked balconies
// either side of the doors; bays up every floor under a parapet; a mansard
// over a pedimented middle; domed turrets on the front corners with long
// balconies between; or the middle set back between two end blocks, round a
// court with its own doors.
MODELS.apartments = (c, L) => {
  const { gb, rng, pal } = c;
  const f = rowFrame(c), F = c.form, plan = planOf(c, 5);
  const W = f.len - 0.12, D = 0.62, z0 = -f.dep / 2 + D / 2 + 0.06, fz = z0 + D / 2, fh = 0.25;
  const floors = L ? 6 : 4, h = floors * fh;
  const wall = pal.style === 'brick' || (!pal.forced && rng.chance(0.5)) ? pal.brick : pal.stoneWall, trim = '#e3dccd';
  const roofType = [L ? 'flat' : 'hip', 'parapet', 'mansard', 'parapet', L ? 'parapet' : 'hip'][plan];
  const nF = Math.round(W / 0.16);
  if (plan === 4) {
    // the middle set back between the end blocks: a court with a fountain
    const ew = 0.5, mw = W - 2 * ew + 0.04;
    house(c, { x: 0, z: z0 - 0.12, w: mw, d: D - 0.24, h, floors, wall, roof: pal.slate, roofType, rh: 0.24, plinth: STONE_D, doorX: 0, doorW: 0.14, nFront: Math.round(mw / 0.16), fancy: false, door: '#3a2f28' });
    for (const s of [-1, 1]) house(c, { x: s * (W / 2 - ew / 2), z: z0, w: ew, d: D, h, floors, wall, roof: pal.slate, roofType, rh: 0.26, plinth: STONE_D, noDoor: true, nFront: 3, fancy: false });
    for (let k = 1; k < floors; k++) gb.box(0, k * fh - 0.008, z0, W + 0.02, 0.014, D + 0.02, trim);
    const cz = fz - 0.12;
    gravel(c, 0, cz, mw - 0.06, 0.2);
    gb.cyl(0, c.gy(0, cz) - 0.01, cz, 0.07, 0.08, 0.04, 10, STONE);
    gb.cyl(0, c.gy(0, cz) + 0.025, cz, 0.06, 0.06, 0.004, 10, '#3f7f9f');
    c.fountain = [0, c.gy(0, cz) + 0.06, cz];
  } else {
    house(c, { x: 0, z: z0, w: W, d: D, h, floors, wall, roof: pal.slate, roofType, rh: 0.26, dormers: plan === 2 ? Math.round(W / 0.2) : 0, plinth: STONE_D, doorX: 0, doorW: 0.14, nFront: nF, fancy: false, door: '#3a2f28' });
    for (let k = 1; k < floors; k++) gb.box(0, k * fh - 0.008, z0, W + 0.02, 0.014, D + 0.02, trim);
  }
  if (plan === 1) {
    for (const x of [-0.66, -0.3, 0.3, 0.66]) tallBay(c, x * (W / 1.88), fz, fh, floors, wall, pal.slate, 0.8, false, floors, 0.16);
  } else if (plan === 2) {
    // a pedimented middle, brought forward over the ground floor and carried
    // up over the cornice
    const pw = 0.5;
    gb.cbox(0, fh - 0.01, fz + 0.02, pw, h + 0.05 - fh, 0.05, wall, 0, 0.006);
    for (let k = 1; k < floors; k++) for (const u of [-0.16, 0, 0.16]) win(c, u, k * fh + fh * 0.36, fz + 0.046, 0.06, 0.1, 'f', 0.8);
    gb.box(0, h + 0.04, fz + 0.02, pw + 0.03, 0.02, 0.07, trim);
    gb.gable(0, h + 0.06, fz + 0.02, pw + 0.03, 0.06, 0.12, trim, trim, 0.01, true);
  } else if (plan === 3) {
    for (const s of [-1, 1]) turret(c, 'dome', s * (W / 2 - 0.05), fz - 0.04, 0, h + fh * 0.8, 0.09, fh, wall, pal.slate, 0.8);
    for (const k of [1, floors - 1]) balcony(c, 'iron', 0, k * fh, fz, W - 0.4);
  } else if (plan === 0) {
    // stacked balconies either side of the entrance
    for (let k = 1; k < floors; k++) for (const s of [-1, 1]) {
      const x = s * W * 0.28, y = k * fh;
      gb.box(x, y, fz + 0.035, 0.24, 0.012, 0.07, trim);
      gb.box(x, y + 0.012, fz + 0.068, 0.24, 0.045, 0.006, '#2f2f33');
    }
  }
  if (plan !== 4) gb.gable(0, 0.3, fz + 0.04, 0.26, 0.1, 0.08, trim, pal.slate, 0.02);
  if (L && roofType === 'flat') { for (const x of [-W * 0.3, 0, W * 0.3]) { gb.cbox(x, h + 0.04, z0, 0.16, 0.12, 0.14, wall, 0, 0.01); } gb.box(0, h + 0.045, z0, W + 0.03, 0.03, D + 0.03, trim); }
  const st = roofType === 'mansard' ? h + 0.36 : roofType === 'parapet' ? h + 0.18 : h + (L ? 0.3 : 0.38);
  for (const x of [-W * 0.42, W * 0.42]) chimney(c, x, h - 0.1, st, z0 - 0.12, 'home', STONE);
  lamp(c, -0.2, fz + 0.18, 0.3); lamp(c, 0.2, fz + 0.18, 0.3);
  if (f.turned) gb.pop();
};

// --------------------------------------------------- schools by stage

// A middle school, its clock on the front and a bell on the roof, in one of
// its plans: a hipped block with a bell-cote; gables to the street at each
// end with the bell in a cupola; or an L, a wing coming forward with its
// gable to the street, a little spire on the ridge. A playground in front.
MODELS.middleschool = (c, L) => {
  const { gb, rng, pal } = c;
  const F = c.form, plan = planOf(c, 3), side = F.side;
  const wall = L ? pal.brick : rng.pick(['#b8704a', '#cfae86', '#a8573a']);
  const H = L ? 0.62 : 0.48, W = L ? 0.88 : 0.8;
  const r = house(c, { z: -0.14, w: W, d: 0.5, h: H, floors: 2, wall, roof: pal.slate, roofType: plan === 0 ? 'hip' : 'gable', rh: 0.22, doorX: 0, doorW: 0.12, nFront: 4, lit: 0.6, plinth: STONE, fancy: false, chimney: true });
  gb.glow(1.2, 1.1, 0.8, 1.02); gb.cyl(0, H - 0.1, 0.115, 0.045, 0.045, 0.01, 12, '#efe8da', 0, Math.PI / 2); gb.noGlow();
  if (plan === 1) {
    for (const s of [-1, 1]) wallGable(c, 'plain', s * (W / 2 - 0.14), 0.11, 0.24, H, 0.16, 0.24, wall, pal.slate, '#e3dccd', 0.6);
    gb.push(0, 0, -0.14); crest(c, 'cupola', r.top, 0, 0, '#e9e0cc', pal.slate); gb.pop();
  } else if (plan === 2) {
    house(c, { x: side * (W / 2 - 0.13), z: 0.02, w: 0.24, d: 0.42, h: H, floors: 2, wall, roof: pal.slate, roofType: 'gable', alongZ: true, rh: 0.2, noDoor: true, nFront: 1, lit: 0.6, plinth: STONE, fancy: false });
    gb.cbox(0, r.top - 0.06, -0.14, 0.09, 0.1, 0.09, '#e9e0cc', 0, 0.01);
    gb.cone(0, r.top + 0.04, -0.14, 0.07, 0.22, 8, pal.slate, Math.PI / 8);
  } else {
    // bell cote
    gb.cbox(0, H + 0.12, -0.14, 0.14, 0.16, 0.14, '#e9e0cc', 0, 0.01);
    gb.roof(0, H + 0.28, -0.14, 0.18, 0.18, 0.12, 0, pal.slate);
  }
  // playground: hopscotch, a climbing frame, a fence
  const py = c.gy(-0.3, 0.32);
  gb.box(-0.3, py - 0.004, 0.32, 0.22, 0.01, 0.14, '#9a9284');
  for (const x of [0.18, 0.36]) gb.box(x, c.gy(x, 0.32), 0.32, 0.014, 0.16, 0.014, '#5e432c');
  gb.box(0.27, c.gy(0.27, 0.32) + 0.15, 0.32, 0.2, 0.014, 0.014, '#5e432c');
  fence(c, -0.47, 0.18, 0.47, 0.47, FENCE, { x: 0, z: 0.47, w: 0.12 });
};

// A high school on a double plot: a long range with a tower, a clock in it
// and a flag on it, and a sports field in front. The tower over the doors in
// the middle (a pyramid, a lantern, battlements), or at one end beside
// gables to the street; the roof hipped, or a parapet with gables.
MODELS.highschool = (c, L) => {
  const { gb, pal } = c;
  const f = rowFrame(c), F = c.form, plan = planOf(c, 4), side = F.side;
  const W = f.len - 0.14, D = 0.56, z0 = -f.dep / 2 + D / 2 + 0.06, fz = z0 + D / 2;
  const floors = L ? 3 : 2, h = floors * 0.26;
  // (a tower in the middle of the front has the way in in its foot)
  house(c, { x: 0, z: z0, w: W, d: D, h, floors, wall: pal.brick, roof: pal.slate, roofType: plan >= 2 ? 'gable' : 'hip', rh: 0.26, plinth: STONE, doorX: 0, doorW: 0.14, noDoor: plan < 2, nFront: Math.round(W / 0.17), fancy: false, chimney: true, lit: 0.7 });
  const kind = ['pyramid', 'lantern', 'battlement', 'spire'][plan];
  const tx = plan >= 2 ? side * (W / 2 - 0.16) : 0;
  tower(c, kind, tx, fz - 0.05, 0.22, h + 0.32, plan === 2 ? pal.brick : pal.stoneWall, pal.slate, { clock: true, flag: '#3f6a8f', door: 0.18 });
  if (plan >= 2) for (const x of [-0.1, 0.32].map(u => -side * u)) wallGable(c, 'plain', x, fz, 0.28, h, 0.2, 0.28, pal.brick, pal.slate, '#e3dccd', 0.7);
  door(c, tx, fz + 0.06, 0.1, 0.18, '#3f2f28');
  // a sports field in front
  const sz = f.dep / 2 - 0.18;
  gb.box(0, c.gy(0, sz) - 0.006, sz, W * 0.7, 0.012, 0.24, '#7fae4f');
  for (const s of [-1, 1]) { gb.box(s * W * 0.33, c.gy(s * W * 0.33, sz), sz, 0.01, 0.12, 0.01, '#f2ede0'); gb.box(s * W * 0.33, c.gy(s * W * 0.33, sz) + 0.11, sz, 0.01, 0.01, 0.12, '#f2ede0'); }
  if (f.turned) gb.pop();
};

// A college: a Gothic hall in stone and a quad in front, in one of its
// plans: towers at both ends with pinnacles; a gate tower in the middle,
// battlemented, the hall's gables either side; or the hall and its chapel,
// a flèche on the chapel's ridge, a cloister walk along the front.
MODELS.college = (c, L) => {
  const { gb, pal } = c;
  const f = rowFrame(c), F = c.form, plan = planOf(c, 3), side = F.side;
  const W = f.len - 0.12, z0 = -f.dep / 2 + 0.34;
  const stone = pal.stoneWall, h = L ? 0.84 : 0.66, floors = L ? 3 : 2;
  if (plan === 1) {
    // a gate tower in the middle, the ranges either side with gables
    house(c, { x: 0, z: z0, w: W - 0.1, d: 0.5, h, floors, wall: stone, roof: pal.slate, roofType: 'gable', rh: 0.32, plinth: STONE_D, noDoor: true, nFront: 8, fancy: false, lit: 0.85 });
    for (const x of [-0.62, -0.32, 0.32, 0.62]) wallGable(c, 'plain', x, z0 + 0.25, 0.2, h, 0.22, 0.24, stone, pal.slate, '#e3dccd', 0.8);
    tower(c, 'battlement', 0, z0 + 0.22, 0.3, h + 0.34, stone, pal.slate, { clock: L > 0, flag: '#7a2a3a', lit: 0.8 });
    gb.arch(0, 0.16, z0 + 0.37, 0.08, 0.012, 8, shade(stone, 0.7));
    door(c, 0, z0 + 0.37, 0.12, 0.16, '#4e3424');
  } else if (plan === 2) {
    // the hall and its chapel, a cloister walk along the front
    const cw = 0.56, hx = -side * (W / 2 - 0.5);
    house(c, { x: hx, z: z0, w: 0.9, d: 0.5, h, floors, wall: stone, roof: pal.slate, roofType: 'gable', rh: 0.34, plinth: STONE_D, doorX: 0, doorW: 0.12, nFront: 5, fancy: false, lit: 0.85 });
    const cx = side * (W / 2 - cw / 2 - 0.04);
    gb.cbox(cx, 0, z0 - 0.02, cw, h * 0.9, 0.42, stone, 0, 0.016);
    gb.gable(cx, h * 0.9, z0 - 0.02, cw + 0.02, 0.42, 0.34, stone, pal.slate, 0.04, false, 0.03);
    for (let i = 0; i < 4; i++) for (const s of [-1, 1]) stainedGlass(c, cx - cw / 2 + 0.08 + i * ((cw - 0.16) / 3), h * 0.3, z0 - 0.02 + s * 0.212, 0.06, h * 0.45, i, s > 0 ? 'f' : 'b');
    for (const s of [-1, 1]) win(c, cx + s * (cw / 2 + 0.002), h * 0.35, z0 - 0.02, 0.06, 0.14, s > 0 ? 'r' : 'l', 0.8);
    gb.cyl(cx, h * 0.9 + 0.32, z0 - 0.02, 0.03, 0.04, 0.06, 6, pal.slate); gb.cone(cx, h * 0.9 + 0.38, z0 - 0.02, 0.035, 0.2, 6, pal.slate);
    const cz = z0 + 0.32;
    for (let i = 0; i <= 8; i++) { const px = -W / 2 + 0.1 + (i * (W - 0.2)) / 8; if (Math.abs(px - hx) > 0.1) gb.box(px, 0, cz, 0.025, 0.18, 0.025, shade(stone, 1.1)); }
    gb.box(0, 0.18, cz - 0.03, W - 0.16, 0.025, 0.1, shade(stone, 1.1));
    gb.wedge(0, 0.205, cz - 0.04, W - 0.14, 0.12, 0.05, pal.slate, 0);
  } else {
    // a gothic hall with corner towers, pointed windows and a quad
    house(c, { x: 0, z: z0, w: W * 0.62, d: 0.52, h, floors, wall: stone, roof: pal.slate, roofType: 'gable', rh: 0.34, plinth: STONE_D, doorX: 0, doorW: 0.12, nFront: 5, fancy: false, lit: 0.85 });
    for (const s of [-1, 1]) {
      const tx = s * (W / 2 - 0.16);
      footing(c, tx, z0, 0.26, 0.26);
      gb.cbox(tx, 0, z0, 0.26, h + 0.2, 0.26, stone, 0, 0.014);
      for (const a of [-1, 1]) for (const b2 of [-1, 1]) gb.cone(tx + a * 0.1, h + 0.2, z0 + b2 * 0.1, 0.035, 0.16, 6, pal.slate);
      for (let k = 0; k < 3; k++) win(c, tx, 0.12 + k * 0.22, z0 + 0.131, 0.06, 0.12, 'f', 0.8);
    }
  }
  // the quad: lawn and paths
  const qz = f.dep / 2 - 0.22;
  gb.box(0, c.gy(0, qz) - 0.006, qz, W * 0.7, 0.012, 0.3, '#7fae4f');
  gb.box(0, c.gy(0, qz) - 0.002, qz, 0.08, 0.012, 0.3, '#cdbf9e');
  gb.box(0, c.gy(0, qz) - 0.002, qz, W * 0.7, 0.012, 0.06, '#cdbf9e');
  // (two trees in the quad, not before the hall's door on the second plan)
  for (const s of [-1, 1]) smallTree(c, plan === 2 && s === -side ? s * W * 0.12 : s * W * 0.25, qz + (plan === 2 && s === -side ? 0.06 : 0), 0.9);
  lamp(c, -0.1, f.dep / 2 - 0.06, 0.3); lamp(c, 0.1, f.dep / 2 - 0.06, 0.3);
  if (f.turned) gb.pop();
};

// A research university: a main hall with a portico between wings, an
// observatory dome on one wing; the hall under a dome on a drum, under a
// clock tower, or Gothic with a great window and pinnacles.
MODELS.university = (c, L) => {
  const { gb, pal } = c;
  const f = rowFrame(c), F = c.form, plan = planOf(c, 3), side = F.side;
  const W = f.len - 0.12, z0 = -f.dep / 2 + 0.34, trim = '#ece6da';
  const stone = plan === 2 ? pal.stoneWall : trim;
  house(c, { x: 0, z: z0, w: 0.62, d: 0.52, h: 0.74, floors: 3, wall: stone, roof: pal.slate, roofType: plan === 2 ? 'gable' : 'flat', alongZ: plan === 2, rh: 0.36, plinth: STONE_D, doorX: 0, doorW: 0.14, nFront: 3, fancy: false, lit: 0.9 });
  if (plan === 1) {
    tower(c, 'lantern', 0, z0 - 0.04, 0.24, 1.2, trim, '#5f7f86', { clock: true });
  } else if (plan === 2) {
    gb.glow(1.4, 1.1, 0.7, 1.1); gb.arch(0, 0.84, z0 + 0.262, 0.12, 0.012, 10, GLASS); gb.box(0, 0.5, z0 + 0.268, 0.24, 0.34, 0.012, GLASS); gb.noGlow();
    for (const s of [-1, 1]) { gb.cbox(s * 0.3, 0, z0 + 0.24, 0.06, 0.96, 0.06, stone, 0, 0.006); gb.cone(s * 0.3, 0.96, z0 + 0.24, 0.04, 0.2, 4, pal.slate, Math.PI / 4); }
  } else {
    gb.cyl(0, 0.76, z0, 0.2, 0.22, 0.12, 14, trim);
    gb.sphere(0, 0.88, z0, 0.2, '#5f7f86', 1, 0.8);
    gb.cyl(0, 1.04, z0, 0.03, 0.04, 0.1, 8, trim);
  }
  if (plan !== 2) {
    for (let i = 0; i < 6; i++) gb.cyl(-0.2 + i * 0.08, 0.02, z0 + 0.32, 0.016, 0.018, 0.44, 8, trim);
    gb.gable(0, 0.46, z0 + 0.3, 0.52, 0.14, 0.1, trim, pal.slate, 0.02);
  }
  for (const s of [-1, 1]) house(c, { x: s * (W / 2 - 0.25), z: z0 + 0.04, w: 0.42, d: 0.42, h: 0.54, floors: 2, wall: pal.stoneWall, roof: pal.slate, roofType: plan === 2 ? 'gable' : 'hip', rh: 0.2, noDoor: true, nFront: 2, fancy: false, lit: 0.85 });
  // observatory dome on one wing
  const ox = side * (W / 2 - 0.25), oy = plan === 2 ? 0.74 : 0.74;
  gb.cyl(ox, oy, z0 + 0.04, 0.12, 0.12, 0.06, 12, trim);
  gb.sphere(ox, oy + 0.06, z0 + 0.04, 0.12, '#c8cfd2', 1, 0.9);
  gb.box(ox + 0.03, oy + 0.06, z0 + 0.04, 0.03, 0.14, 0.03, '#3a3a3e', 0, 0, -0.5);
  const qz = f.dep / 2 - 0.2;
  gb.box(0, c.gy(0, qz) - 0.006, qz, W * 0.75, 0.012, 0.28, '#7fae4f');
  gb.box(0, c.gy(0, qz) - 0.002, qz, 0.1, 0.012, 0.28, '#cdbf9e');
  for (const s of [-1, 1]) { smallTree(c, s * W * 0.3, qz, 1); bench(c, s * 0.14, qz, Math.PI); }
  if (f.turned) gb.pop();
};

// ----------------------------------------------------------- 2×2 estates
// A double-plot building grown onto the two plots beside it can be rebuilt
// as one of these. Each lays itself out over the whole 2×2 plot (rowFrame:
// the street at +z, the plot ±1 round the centre), in the building's
// palette and style.

const GRAVEL = '#cdbf9e', LAWN_G = '#7fae4f', IRON = '#2f2f33', GLASS_ROOF = '#a9c4c8', POOL = '#3f7f9f';

export function gravel(c, x, z, w, d, color = GRAVEL) {
  c.gb.box(x, c.gy(x, z) - 0.008, z, w, 0.012, d, color);
}

// A door frame and leaf on any face of a wall (door() registers the one
// villagers use, and only faces the street).
function plainDoor(c, x, z, w, h, color, face = 'f') {
  const { gb } = c;
  const oz = face === 'f' ? 1 : face === 'b' ? -1 : 0, ox = face === 'r' ? 1 : face === 'l' ? -1 : 0, side = ox !== 0;
  gb.box(x + ox * 0.004, 0, z + oz * 0.004, side ? 0.014 : w + 0.024, h + 0.016, side ? w + 0.024 : 0.014, '#5a4330');
  gb.box(x + ox * 0.01, 0, z + oz * 0.01, side ? 0.014 : w, h, side ? w : 0.014, color);
}

// A tall window of coloured glass, glowing at night (ry turns one on a
// front or back face, to follow a curved wall).
export function stainedGlass(c, x, y, z, w, h, k, face, ry = 0) {
  const s = [[1.4, 0.5, 0.5], [0.5, 0.7, 1.6], [1.4, 1.1, 0.4]][k % 3];
  c.gb.glow(s[0], s[1], s[2], 1.05 + c.rng.float(0, 0.2));
  if (face === 'r' || face === 'l') c.gb.box(x, y, z, 0.016, h, w, '#3f4a6e');
  else c.gb.box(x, y, z, w, h, 0.016, '#3f4a6e', ry);
  c.gb.noGlow();
}

// A round window (rose or wheel) in a wall facing +z (dir 0) or ±x (dir ±1).
export function roseWindow(c, x, y, z, r, dir = 0) {
  const { gb } = c;
  const rx = dir ? 0 : Math.PI / 2, rz = dir > 0 ? -Math.PI / 2 : dir < 0 ? Math.PI / 2 : 0;
  gb.cyl(x, y, z, r + 0.018, r + 0.018, 0.01, 14, STONE_D, 0, rx, rz);
  gb.glow(1.6, 0.8, 1.6, 1.04);
  gb.cyl(x + dir * 0.004, y, z + (dir ? 0 : 0.004), r, r, 0.012, 14, '#5a4a8a', 0, rx, rz);
  gb.noGlow();
}

// Classical columns carrying an entablature and a pediment, in front of a
// wall face at z: w wide, columns h tall.
function portico(c, x, z, w, h, n, roof, trim = '#ece6da') {
  const { gb } = c;
  footing(c, x, z + 0.07, w + 0.06, 0.16);
  gb.cbox(x, -0.03, z + 0.07, w + 0.06, 0.05, 0.16, STONE, 0, 0.008);
  for (let i = 0; i < n; i++) gb.cyl(x - w / 2 + 0.025 + (i * (w - 0.05)) / (n - 1), 0.02, z + 0.11, 0.015, 0.018, h, 8, trim);
  gb.cbox(x, 0.02 + h, z + 0.07, w + 0.02, 0.035, 0.15, trim, 0, 0.006);
  gb.gable(x, 0.055 + h, z + 0.07, w + 0.02, 0.15, Math.min(0.1, w * 0.2), trim, roof, 0.02);
}

// A crenellated parapet along a wall top: len long, centred on (x, y, z),
// running along x (or z).
function battlements(c, x, y, z, len, alongZ, color) {
  const { gb } = c;
  const n = Math.max(3, 2 * Math.round(len / 0.12) + 1), s = len / n;
  gb.box(x, y, z, alongZ ? 0.04 : len, 0.022, alongZ ? len : 0.04, color);
  for (let i = 0; i < n; i += 2) {
    const u = -len / 2 + (i + 0.5) * s;
    gb.box(alongZ ? x : x + u, y + 0.022, alongZ ? z + u : z, alongZ ? 0.04 : s, 0.026, alongZ ? s : 0.04, color);
  }
}
function parapet(c, x, y, z, w, d, color) {
  battlements(c, x, y, z + d / 2 - 0.02, w, false, color);
  battlements(c, x, y, z - d / 2 + 0.02, w, false, color);
  battlements(c, x + w / 2 - 0.02, y, z, d - 0.08, true, color);
  battlements(c, x - w / 2 + 0.02, y, z, d - 0.08, true, color);
}

// Gate piers with ball finials either side of a gap at (x, z).
export function gatePiers(c, x, z, gap, color = STONE) {
  for (const s of [-1, 1]) {
    const px = x + (s * gap) / 2, y = c.gy(px, z);
    c.gb.cbox(px, y - 0.01, z, 0.06, 0.17, 0.06, color, 0, 0.008);
    c.gb.sphere(px, y + 0.19, z, 0.025, shade(color, 1.1), 0);
  }
}

function topiary(c, x, z, s = 1) {
  const y = c.gy(x, z);
  c.gb.cyl(x, y - 0.01, z, 0.014, 0.014, 0.03, 5, '#5e432c');
  c.gb.cone(x, y + 0.02, z, 0.04 * s, 0.13 * s, 7, '#3f6a32');
}

// A formal bed: low clipped hedges round a rectangle with a cross through
// it, flowers in its quarters and a clipped cone at each corner.
function parterre(c, x, z, w, d) {
  const h = 0.035;
  hedge(c, x, z - d / 2, w, 0.03, h); hedge(c, x, z + d / 2, w, 0.03, h);
  hedge(c, x - w / 2, z, 0.03, d, h); hedge(c, x + w / 2, z, 0.03, d, h);
  hedge(c, x, z, w - 0.06, 0.025, h * 0.8); hedge(c, x, z, 0.025, d - 0.06, h * 0.8);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    flowers(c, x + (sx * w) / 4, z + (sz * d) / 4, 4, Math.min(w, d) * 0.12);
    topiary(c, x + (sx * w) / 2, z + (sz * d) / 2, 0.8);
  }
}

// A round stone basin with a jet in the middle (fountain particles at it).
function basin(c, x, z, r, jet = 0.12) {
  const { gb } = c;
  const y = c.gy(x, z);
  gb.cyl(x, y - 0.02, z, r, r + 0.01, 0.07, 14, STONE);
  gb.cyl(x, y + 0.045, z, r - 0.015, r - 0.015, 0.008, 14, POOL);
  gb.cyl(x, y + 0.04, z, 0.018, 0.024, jet, 8, STONE);
  c.fountain = [x, y + jet + 0.06, z];
}

// Glazed panes over a gable roof's slopes (iron ribs show between them),
// lit from within at night. Same frame as GeoBuilder.gable.
// lift: how far the panes stand off the slope (more than the slates' thickness
// when they're laid over a roof).
export function glassRoof(c, x, y, z, w, d, h, alongZ, n = 6, lift = 0.03) {
  const { gb } = c;
  gb.push(x, y, z, alongZ ? Math.PI / 2 : 0);
  if (alongZ) [w, d] = [d, w];
  const hd = d / 2, a = Math.atan2(h, hd), L = Math.hypot(hd, h);
  const cz = hd / 2 + Math.sin(a) * lift, cy = h / 2 + Math.cos(a) * lift, pw = w / n;
  gb.glow(1.6, 1.4, 1.0, 1.5);
  for (let i = 0; i < n; i++) for (const s of [-1, 1]) gb.boxC(-w / 2 + (i + 0.5) * pw, cy, s * cz, pw - 0.022, 0.01, L - 0.03, GLASS_ROOF, s * a);
  gb.noGlow();
  gb.pop();
}

// A plain works building: walls, a gable roof and windows on every face,
// leaving out the ground-floor front windows where skip(x) says.
function worksShed(c, x, z, w, d, h, floors, wall, roof, rh, skip = () => false) {
  const { gb, rng } = c;
  footing(c, x, z, w, d);
  gb.cbox(x, 0, z, w, h, d, wall, 0, 0.02);
  gb.gable(x, h, z, w, d, rh, wall, roof, 0.05, false, 0.035);
  const fh = h / floors, nF = Math.max(1, Math.round(w / 0.2)), nS = Math.max(1, Math.round(d / 0.24)), wh = Math.min(0.11, fh * 0.4);
  for (let k = 0; k < floors; k++) {
    const y = k * fh + fh * 0.36;
    for (let i = 0; i < nF; i++) {
      const u = x - w / 2 + (i + 0.5) * (w / nF);
      if (k || !skip(u)) win(c, u, y, z + d / 2, 0.075, wh, 'f', 0.8);
      if (rng.chance(0.7) || facesStreet(c, 0, -1, u, z - d / 2)) win(c, u, y, z - d / 2, 0.075, wh, 'b', 0.8);
    }
    for (let i = 0; i < nS; i++) {
      const v = z - d / 2 + (i + 0.5) * (d / nS);
      win(c, x + w / 2, y, v, 0.075, wh, 'r', 0.8);
      win(c, x - w / 2, y, v, 0.075, wh, 'l', 0.8);
    }
  }
}

// One range of rooms round a court: walls and a gable roof along its length
// (alongZ: it runs along z), windows down both long sides and, on the side
// facing the court (dir: ±1 across the range, 0 for none), a door to each
// ground-floor room. A stack in the middle of the ridge if asked for.
function courtRange(c, x, z, len, dep, h, floors, wall, roof, alongZ, dir, rooms, stack = false, rh = 0.2) {
  const { gb, rng } = c;
  const w = alongZ ? dep : len, d = alongZ ? len : dep;
  footing(c, x, z, w, d);
  gb.cbox(x, 0, z, w, h, d, wall, 0, 0.016);
  if (rh > 0) gb.gable(x, h, z, w, d, rh, wall, roof, 0.05, alongZ, 0.03);
  const at = (u, s) => (alongZ ? [x + (s * dep) / 2, z + u] : [x + u, z + (s * dep) / 2]);
  const face = (s) => (alongZ ? (s > 0 ? 'r' : 'l') : s > 0 ? 'f' : 'b');
  const fh = h / floors, wh = Math.min(0.1, fh * 0.36);
  for (let i = 0; i < rooms; i++) {
    const u = -len / 2 + (i + 0.5) * (len / rooms);
    for (let k = 0; k < floors; k++) for (const s of [-1, 1]) {
      const y = k * fh + fh * 0.34;
      if (k === 0 && s === dir) {
        const [dx, dz] = at(u - 0.05, s), [wx, wz] = at(u + 0.06, s);
        plainDoor(c, dx, dz, 0.065, Math.min(0.16, fh * 0.6), rng.pick(DOORS), face(s));
        win(c, wx, y, wz, 0.065, wh, face(s));
      } else if (s === dir || rng.chance(0.8)) {
        const [wx, wz] = at(u, s);
        win(c, wx, y, wz, 0.07, wh, face(s));
      }
    }
  }
  if (stack) chimney(c, x, h - 0.05, h + rh + 0.08, z, 'home', stackColor(c));
}
const stackColor = (c) => (c.pal.style === 'brick' ? c.pal.brick : STONE);

// A standing horse, the size of the ones that pull the coaches (Transit):
// facing +z, its head at z ≈ 0.17.
export function horse(c, x, z, ry, color = '#7a5232') {
  const { gb } = c;
  gb.push(x, c.gy(x, z), z, ry);
  gb.box(0, 0.075, 0, 0.07, 0.07, 0.17, color);
  gb.box(0, 0.12, 0.1, 0.045, 0.07, 0.05, color, 0, -0.5);
  gb.box(0, 0.15, 0.14, 0.04, 0.035, 0.07, color);
  gb.box(0, 0.12, 0.07, 0.012, 0.06, 0.05, '#3a2a1f', 0, -0.4);
  gb.box(0, 0.09, -0.09, 0.012, 0.05, 0.012, '#3a2a1f', 0, 0.6);
  for (const [lx, lz] of [[-0.025, 0.06], [0.025, 0.06], [-0.025, -0.06], [0.025, -0.06]]) gb.box(lx, 0, lz, 0.018, 0.08, 0.018, shade(color, 0.85));
  gb.pop();
}

// A stage coach the size of the ones on the coach lines, facing +z; with its
// horse in the shafts if asked for.
export function coach(c, x, z, ry, body = '#3f5466', withHorse = false) {
  const { gb } = c;
  gb.push(x, c.gy(x, z), z, ry);
  gb.box(0, 0.06, -0.02, 0.2, 0.17, 0.34, body);
  gb.box(0, 0.23, -0.02, 0.22, 0.025, 0.37, '#3a3a3e');
  gb.box(0, 0.06, -0.02, 0.21, 0.025, 0.35, '#3a2a1f');
  for (const sx of [-1, 1]) for (const wz of [-0.1, 0.05]) gb.box(sx * 0.101, 0.13, wz, 0.006, 0.06, 0.09, '#34475b');
  gb.box(0, 0.2, 0.15, 0.12, 0.012, 0.06, '#3a2a1f');
  for (const [wz, r] of [[0.08, 0.04], [-0.12, 0.05]]) for (const sx of [-1, 1]) gb.cyl(sx * 0.118, r, wz, r, r, 0.015, 8, '#3a2a1f', 0, 0, Math.PI / 2);
  gb.box(0, 0.09, 0.2, 0.014, 0.014, 0.12, '#5b4231');
  gb.pop();
  if (withHorse) horse(c, x + Math.sin(ry) * 0.26, z + Math.cos(ry) * 0.26, ry);
}

function hayBale(c, x, z, ry = 0) {
  c.gb.cyl(x, c.gy(x, z) + 0.03, z, 0.03, 0.03, 0.07, 8, '#d9be6a', ry, 0, Math.PI / 2);
}

// The market's trestle stall under a striped awning.
function marketStall(c, x, z, ry, s, awnA) {
  const { gb, rng } = c;
  const awnB = '#e9dfc9';
  gb.push(x, c.gy(x, z), z, ry, s);
  gb.cbox(0, 0, 0, 0.4, 0.13, 0.2, '#86613e', 0, 0.01);
  gb.box(0, 0.13, 0, 0.42, 0.016, 0.22, '#a07a50');
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) gb.box(sx * 0.2, 0, sz * 0.1, 0.022, sz < 0 ? 0.38 : 0.33, 0.022, '#5e432c');
  for (let i = 0; i < 5; i++) gb.boxC(-0.176 + i * 0.088, 0.36, 0.0, 0.088, 0.014, 0.31, i % 2 ? awnB : awnA, -0.2);
  const goods = ['#b8402f', '#d98a32', '#7aa34a', '#d9c050', '#6f4a8a'];
  for (let i = 0; i < 7; i++) gb.sphere(-0.16 + i * 0.054, 0.165, rng.float(-0.05, 0.05), 0.022, rng.pick(goods), 1);
  gb.pop();
}

// Manor Estate: the great house across the back of a forecourt, wings
// reaching forward either side, a drive between formal gardens, and the
// stables and kitchen garden (an orangery at the Ducal Seat) behind.
MODELS.manor = (c, L) => {
  const { gb, rng, pal } = c;
  const f = rowFrame(c);
  const wall = !pal.forced && (L > 0 || pal.stoneHouse || rng.chance(0.5)) ? pal.stoneWall : pal.wall;
  const roof = pal.forced ? pal.roof : pal.slate, trim = '#ece6da';
  // classical and hipped, unless the style calls for gables
  const hipped = !pal.forced || pal.hip || pal.style === 'brick' || pal.style === 'stone';
  const H = L ? 0.88 : 0.62, D = 0.46, z0 = -0.39, front = z0 + D / 2;
  house(c, {
    x: 0, z: z0, w: 0.96, d: D, h: H, floors: L ? 3 : 2, wall, roof, roofType: hipped ? 'hip' : 'gable', rh: 0.3,
    plinth: STONE, doorX: 0, doorW: 0.12, nFront: L ? 7 : 5, chimney: true, chimneyPos: 'ends',
  });
  portico(c, 0, front, L ? 0.42 : 0.34, L ? 0.5 : 0.36, L ? 6 : 4, roof, trim);
  const wh = L ? 0.62 : 0.46;
  for (const s of [-1, 1]) {
    house(c, {
      x: s * 0.64, z: -0.13, ry: (-s * Math.PI) / 2, w: 0.74, d: 0.32, h: wh, floors: 2, wall, roof, roofType: hipped ? 'hip' : 'gable', rh: 0.2,
      noDoor: true, plinth: STONE, nFront: 3, chimney: false,
    });
  }
  const crown = planOf(c, 3);
  if (crown === 2) {
    // pavilions at the wings' ends, a storey taller under pyramids
    for (const s of [-1, 1]) {
      const px = s * 0.64, pz = 0.22;
      gb.cbox(px, 0, pz, 0.26, wh + 0.2, 0.22, wall, 0, 0.01);
      for (let k = 0; k < 3; k++) win(c, px, 0.08 + k * 0.22, pz + 0.11, 0.06, 0.1, 'f', 0.8);
      gb.roof(px, wh + 0.2, pz, 0.3, 0.26, 0.16, 0.04, roof);
    }
  }
  if (L && crown === 1) {
    // a clock tower rising out of the middle of the house
    tower(c, 'lantern', 0, z0, 0.2, H + 0.42, wall, '#5f7f86', { clock: true });
  } else if (L) {
    // a cupola with a flag over the middle of the house
    const top = H + 0.3 * pal.pitch;
    gb.cbox(0, top - 0.05, z0, 0.13, 0.12, 0.13, trim, 0, 0.01);
    gb.glow(WARM[0], WARM[1], WARM[2], 1.2); gb.box(0, top + 0.0, z0 + 0.066, 0.05, 0.05, 0.006, GLASS); gb.noGlow();
    gb.sphere(0, top + 0.08, z0, 0.075, '#5f7f86', 1, 0.8);
    gb.box(0, top + 0.13, z0, 0.01, 0.2, 0.01, '#3a3a3e');
    gb.box(0.045, top + 0.27, z0, 0.09, 0.055, 0.004, rng.pick(['#a8473a', '#3f6a8f', '#4f7a45']));
  }
  // the forecourt: gravel round a lawn with a statue (a fountain later)
  gravel(c, 0, 0.12, 0.92, 0.26);
  const cy = c.gy(0, 0.13);
  gb.cyl(0, cy - 0.004, 0.13, 0.1, 0.1, 0.012, 16, LAWN_G);
  if (L) basin(c, 0, 0.13, 0.08, 0.1);
  else {
    gb.cbox(0, cy, 0.13, 0.05, 0.08, 0.05, STONE, 0, 0.008);
    gb.cyl(0, cy + 0.08, 0.13, 0.014, 0.02, 0.09, 6, '#8a8478');
    gb.sphere(0, cy + 0.185, 0.13, 0.02, '#8a8478', 0);
  }
  // the drive in from the gates, between formal gardens
  gravel(c, 0, 0.61, 0.14, 0.7);
  for (const s of [-1, 1]) parterre(c, s * 0.53, 0.6, 0.56, 0.46);
  frontage(c, -0.97, 0.97, 0.95, [0], L ? 'railings' : 'wall');
  gatePiers(c, 0, 0.95, 0.15);
  for (const s of [-1, 1]) {
    hedge(c, s * 0.94, 0.62, 0.04, 0.6);
    smallTree(c, s * 0.89, -0.32, 0.7); smallTree(c, s * 0.89, 0.02, 0.65);
    if (L) { lamp(c, s * 0.11, 0.42, 0.3); lamp(c, s * 0.11, 0.8, 0.3); }
  }
  // behind the house: a stable range with a clock, and the kitchen garden
  const side = rng.chance(0.5) ? 1 : -1, sx = side * 0.68, sz = -0.8;
  footing(c, sx, sz, 0.52, 0.26);
  gb.cbox(sx, 0, sz, 0.52, 0.26, 0.26, wall, 0, 0.014);
  gb.gable(sx, 0.26, sz, 0.52, 0.26, 0.13, wall, roof, 0.04, false, 0.03);
  for (let i = 0; i < 3; i++) {
    const x = sx - 0.16 + i * 0.16;
    plainDoor(c, x, sz + 0.13, 0.06, 0.13, '#5e432c');
    gb.box(x, 0.065, sz + 0.142, 0.064, 0.008, 0.006, '#3f342c');
  }
  gb.cbox(sx, 0.33, sz, 0.08, 0.08, 0.08, trim, 0, 0.006);
  gb.roof(sx, 0.41, sz, 0.1, 0.1, 0.07, 0, roof);
  gb.glow(1.2, 1.1, 0.8, 1.02); gb.cyl(sx, 0.355, sz + 0.04, 0.026, 0.026, 0.006, 10, '#efe8da', 0, Math.PI / 2); gb.noGlow();
  if (L) {
    // the orangery: a long glasshouse on a stone base
    const ox = -side * 0.66, oz = -0.8;
    footing(c, ox, oz, 0.5, 0.22);
    gb.cbox(ox, 0, oz, 0.5, 0.05, 0.22, STONE, 0, 0.008);
    gb.glow(WARM[0], WARM[1], WARM[2], 1.3);
    gb.box(ox, 0.05, oz, 0.48, 0.18, 0.2, '#9fbcc0');
    gb.noGlow();
    for (let i = 0; i < 6; i++) gb.box(ox - 0.24 + i * 0.096, 0.05, oz + 0.101, 0.008, 0.18, 0.008, trim);
    gb.box(ox, 0.23, oz, 0.5, 0.012, 0.22, trim);
    gb.gable(ox, 0.235, oz, 0.5, 0.22, 0.07, '#c8dadc', '#c8dadc', 0.02, false, 0.012);
    for (let i = 0; i < 4; i++) gb.sphere(ox - 0.18 + i * 0.12, 0.09, oz, 0.03, rng.pick(LEAF), 0);
  } else {
    vegPatch(c, -side * 0.56, -0.8); vegPatch(c, -side * 0.8, -0.8);
    beehives(c, -side * 0.68, -0.64);
  }
  smallTree(c, -0.22, -0.84, 1); smallTree(c, 0.2, -0.86, 0.9);
  bench(c, 0, -0.72, 0);
  if (f.turned) gb.pop();
};

// Mansion Quadrangle: four ranges of flats round a garden court, the way in
// through the middle of the street range; in one of its plans: hipped (flat
// behind a cornice with pavilion roofs on the corners at the Grand Mansion
// Court); under mansards with domed corner turrets; or gabled, a gate tower
// over the entrance with a clock, bays up the street front.
MODELS.quadrangle = (c, L) => {
  const { gb, rng, pal } = c;
  const f = rowFrame(c), plan = planOf(c, 3);
  const floors = L ? 6 : 4, fh = 0.25, h = floors * fh;
  const wall = pal.style === 'brick' || (!pal.forced && rng.chance(0.5)) ? pal.brick : pal.stoneWall, trim = '#e3dccd';
  const RD = 0.42, fz = 0.6, W = 1.84, sl = 2 * fz - RD, ff = fz + RD / 2;
  const roofType = plan === 1 ? 'mansard' : plan === 2 ? 'gable' : L ? 'flat' : 'hip', base = { h, floors, wall, roof: pal.slate, roofType, rh: plan === 1 ? 0.3 : 0.26, plinth: STONE_D, fancy: false };
  // (with a clock tower over the entrance, the door is in the tower's foot)
  house(c, { ...base, x: 0, z: fz, w: W, d: RD, doorX: 0, doorW: 0.14, noDoor: plan === 2, nFront: 11, door: '#3a2f28', chimney: true, chimneyPos: 'ends' });
  house(c, { ...base, x: 0, z: -fz, w: W, d: RD, noDoor: true, nFront: 11, chimney: true, chimneyPos: 'ends' });
  for (const s of [-1, 1]) house(c, { ...base, x: s * (W / 2 - RD / 2), z: 0, ry: (-s * Math.PI) / 2, w: sl, d: RD, noDoor: true, nFront: 4, chimney: false });
  // string courses all round, and iron balconies on the street
  for (let k = 1; k < floors; k++) {
    const y = k * fh - 0.008;
    for (const z of [fz, -fz]) gb.box(0, y, z, W + 0.02, 0.014, RD + 0.02, trim);
    for (const s of [-1, 1]) gb.box(s * (W / 2 - RD / 2), y, 0, RD + 0.02, 0.014, sl, trim);
    if (plan !== 2) for (const x of [-0.62, -0.28, 0.28, 0.62]) {
      gb.box(x, k * fh, ff + 0.035, 0.2, 0.012, 0.07, trim);
      gb.box(x, k * fh + 0.012, ff + 0.068, 0.2, 0.045, 0.006, IRON);
    }
  }
  if (plan === 1) {
    for (const z of [fz, -fz]) { gb.push(0, 0, z); mansardDormers(c, 7, W * 0.86, RD, h, { h1: 0.3 * 0.78, inset: Math.min(0.3 * 0.78 * 0.34, RD * 0.22) }, wall, pal.slate, 0.7); gb.pop(); }
    for (const sx of [-1, 1]) turret(c, 'dome', sx * (W / 2 - 0.08), ff - 0.06, 0, h + fh, 0.11, fh, wall, '#5f8f7e', 0.8);
  } else if (plan === 2) {
    for (const x of [-0.62, -0.28, 0.28, 0.62]) tallBay(c, x, ff, fh, floors, wall, pal.slate, 0.8, true, floors, 0.16);
    tower(c, 'pyramid', 0, ff - 0.08, 0.3, h + 0.3, wall, pal.slate, { clock: true, door: 0.2 });
    door(c, 0, ff + 0.07, 0.13, 0.2, '#3a2f28');
    gb.arch(0, 0.2, ff + 0.07, 0.085, 0.012, 8, trim);
  } else {
    // a canopy on columns over the entrance
    for (const s of [-1, 1]) gb.cyl(s * 0.1, 0.02, ff + 0.08, 0.012, 0.014, 0.24, 8, trim);
    gb.gable(0, 0.26, ff + 0.05, 0.26, 0.11, 0.07, trim, pal.slate, 0.02);
  }
  if (L && plan === 0) {
    // a cornice, attic windows and a pavilion roof at each corner
    for (const z of [fz, -fz]) gb.box(0, h + 0.045, z, W + 0.03, 0.03, RD + 0.03, trim);
    for (const s of [-1, 1]) gb.box(s * (W / 2 - RD / 2), h + 0.045, 0, RD + 0.03, 0.03, sl, trim);
    for (const x of [-0.42, -0.14, 0.14, 0.42]) for (const z of [fz, -fz]) {
      gb.cbox(x, h + 0.04, z, 0.12, 0.1, 0.12, wall, 0, 0.01);
      win(c, x, h + 0.06, z + Math.sign(z) * 0.06, 0.05, 0.06, z > 0 ? 'f' : 'b');
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const x = sx * 0.73, z = sz * 0.62;
      gb.cbox(x, h, z, 0.3, 0.2, 0.3, wall, 0, 0.012);
      gb.box(x, h + 0.2, z, 0.32, 0.02, 0.32, trim);
      gb.roof(x, h + 0.22, z, 0.32, 0.32, 0.2, 0, pal.slate);
      win(c, x, h + 0.05, z + sz * 0.15, 0.06, 0.09, sz > 0 ? 'f' : 'b');
      win(c, x + sx * 0.15, h + 0.05, z, 0.06, 0.09, sx > 0 ? 'r' : 'l');
    }
  }
  // the garden court: a lawn, gravel walks and trees (a fountain later)
  const cw = W - 2 * RD - 0.04, cd = sl - 0.04, gy = c.gy(0, 0);
  gb.box(0, gy - 0.008, 0, cw, 0.012, cd, LAWN_G);
  gb.box(0, gy - 0.004, 0, cw, 0.012, 0.07, GRAVEL);
  gb.box(0, gy - 0.004, 0, 0.07, 0.012, cd, GRAVEL);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) smallTree(c, sx * 0.25, sz * 0.2, 0.85);
  if (L) basin(c, 0, 0, 0.09, 0.1);
  else {
    gb.cyl(0, gy - 0.01, 0, 0.07, 0.07, 0.02, 12, '#5e432c');
    flowers(c, 0, 0, 8, 0.05);
    washingLine(c, 0.32, -0.33);
  }
  bench(c, -0.12, 0.3, Math.PI); bench(c, 0.12, -0.3, 0);
  frontage(c, -0.94, 0.94, 0.94, [0], 'railings');
  lamp(c, -0.2, 0.92, 0.3); lamp(c, 0.2, 0.92, 0.3);
  if (f.turned) gb.pop();
};

// Market Halls: a stone Corn Exchange behind a portico, an iron-and-glass
// Covered Market Hall, and the Grand Galleria (see galleria).
MODELS.markethall = (c, L) => {
  const { gb, rng, pal } = c;
  const f = rowFrame(c);
  const trim = '#e3dccd';
  if (L >= 2) galleria(c);
  else if (L === 0) {
    // the Corn Exchange: a stone hall under one long roof, a portico on the street
    const wall = pal.stoneWall, roof = pal.slate, hz = -0.24, hw = 1.16, hd = 1.12, h = 0.5, fz = hz + hd / 2;
    footing(c, 0, hz, hw, hd);
    gb.cbox(0, 0, hz, hw, h, hd, wall, 0, 0.02);
    gb.push(0, 0, hz); quoins(c, hw, hd, h, wall); gb.pop();
    gb.gable(0, h, hz, hw, hd, 0.34, wall, roof, 0.05, true, 0.035);
    door(c, 0, fz, 0.14, 0.22, '#4e3424');
    const plan = planOf(c, 3);
    if (plan === 1) {
      // three great arches across the front instead of a portico
      for (const x of [-0.26, 0, 0.26]) { gb.arch(x, 0.24, fz + 0.004, 0.1, 0.02, 10, trim); if (x) { gb.glow(WARM[0], WARM[1], WARM[2], 1.2); gb.box(x, 0.02, fz + 0.006, 0.18, 0.22, 0.01, GLASS); gb.noGlow(); } }
      gb.gable(0, h + 0.01, fz + 0.01, hw, 0.03, 0.34 * 0.95, trim, trim, 0.01, true);
    } else portico(c, 0, fz, 0.78, 0.4, 6, roof, trim);
    for (const s of [-1, 1]) win(c, s * 0.46, 0.12, fz, 0.09, 0.2, 'f', 0.9);
    for (let i = 0; i < 4; i++) {
      const z = hz - hd / 2 + (i + 0.5) * (hd / 4);
      win(c, hw / 2, 0.3, z, 0.08, 0.14, 'r', 0.9); win(c, -hw / 2, 0.3, z, 0.08, 0.14, 'l', 0.9);
    }
    for (const x of [-0.3, 0.3]) win(c, x, 0.14, hz - hd / 2, 0.09, 0.2, 'b', 0.9);
    gb.glow(1.2, 1.1, 0.8, 1.02); gb.cyl(0, 0.66, fz + 0.004, 0.06, 0.06, 0.01, 12, '#efe8da', 0, Math.PI / 2); gb.noGlow();
    // a cupola on the ridge with a wheatsheaf vane (or, on the second plan,
    // a bell-cote on the front gable)
    const top = h + 0.34;
    if (plan === 2) bellcote(c, 0, top - 0.02, fz - 0.02, wall, roof);
    else {
      gb.cbox(0, top - 0.05, hz, 0.14, 0.14, 0.14, trim, 0, 0.01);
      gb.roof(0, top + 0.09, hz, 0.17, 0.17, 0.12, 0, roof);
      gb.box(0, top + 0.21, hz, 0.01, 0.08, 0.01, '#c9a43a');
      gb.sphere(0, top + 0.3, hz, 0.022, '#d9b84a', 0);
    }
    // lean-to shops along both sides, their awnings out over the pavement
    for (const s of [-1, 1]) {
      const x = s * (hw / 2 + 0.14), sz = hz + 0.02, sd = hd - 0.3, ox = s * (hw / 2 + 0.28);
      footing(c, x, sz, 0.28, sd);
      gb.cbox(x, 0, sz, 0.28, 0.26, sd, shade(wall, 0.95), 0, 0.012);
      gb.wedge(x, 0.26, sz, sd + 0.04, 0.32, 0.08, pal.roof, (s * Math.PI) / 2);
      for (let i = 0; i < 3; i++) {
        const z = sz - sd / 2 + (i + 0.5) * (sd / 3);
        plainDoor(c, ox, z - 0.07, 0.08, 0.17, rng.pick(DOORS), s > 0 ? 'r' : 'l');
        win(c, ox, 0.05, z + 0.05, 0.1, 0.12, s > 0 ? 'r' : 'l', 0.95);
        gb.boxC(ox + s * 0.055, 0.21, z, 0.11, 0.012, sd / 3 - 0.03, i % 2 ? '#e9dfc9' : pal.awning, 0, 0, -s * 0.45);
      }
    }
    // market day out front: stalls, sacks of grain, a cart
    marketStall(c, -0.58, 0.74, 0.15, 0.85, pal.awning);
    marketStall(c, 0.6, 0.72, -0.2, 0.85, pal.awning2);
    for (let i = 0; i < 4; i++) { const x = -0.2 + (i % 2) * 0.06, z = 0.82 + Math.floor(i / 2) * 0.05; gb.blob(x, c.gy(x, z) + 0.025, z, 0.03, 0.035, 0.026, '#d8c8a0'); }
    handcart(c, 0.28, 0.86); barrel(c, -0.36, 0.9); crate(c, 0.38, 0.62);
    lamp(c, -0.34, 0.58, 0.3); lamp(c, 0.34, 0.58, 0.3);
    crate(c, -0.3, -0.9); crate(c, -0.22, -0.88, 0.9, '#a88458'); barrel(c, 0.3, -0.9);
  } else {
    // the Covered Market Hall: a glazed nave between brick gable walls, lower
    // aisles either side with shops round the outside
    const brick = pal.brick, roof = pal.slate, hz = -0.12, hd = 1.56, nw = 0.8, nh = 0.7, rh = 0.32, aw = 0.36, ah = 0.44, fz = hz + hd / 2;
    footing(c, 0, hz, nw + 2 * aw, hd);
    gb.cbox(0, 0, hz, nw, ah, hd, brick, 0, 0.012);
    gb.glow(1.6, 1.4, 1.0, 1.5); gb.box(0, ah, hz, nw - 0.02, nh - ah, hd - 0.04, GLASS_ROOF); gb.noGlow();
    for (let i = 0; i <= 8; i++) for (const s of [-1, 1]) gb.box(s * (nw / 2 - 0.004), ah, hz - hd / 2 + 0.02 + (i * (hd - 0.04)) / 8, 0.014, nh - ah, 0.014, IRON);
    gb.gable(0, nh, hz, nw + 0.02, hd - 0.02, rh, '#5a6268', '#4a5258', 0.03, true, 0.016);
    glassRoof(c, 0, nh, hz, nw + 0.02, hd - 0.02, rh, true, 8);
    // a louvred lantern along the middle of the ridge lets the air out
    gb.cbox(0, nh + rh - 0.03, hz, 0.12, 0.09, 0.6, '#5a6268', 0, 0.006);
    for (const s of [-1, 1]) for (let i = 0; i < 6; i++) gb.box(s * 0.062, nh + rh + 0.0, hz - 0.25 + i * 0.1, 0.006, 0.045, 0.06, '#3a4248');
    gb.gable(0, nh + rh + 0.06, hz, 0.16, 0.64, 0.06, '#5a6268', '#4a5258', 0.02, true, 0.014);
    // and (its own plan) a clock tower at one front corner
    if (planOf(c, 2)) tower(c, c.form.b < 0.5 ? 'spire' : 'pyramid', c.form.side * (nw / 2 + aw - 0.1), fz - 0.1, 0.18, 1.0, brick, roof, { clock: true });
    for (const s of [-1, 1]) {
      const ax = s * (nw / 2 + aw / 2), ox = s * (nw / 2 + aw);
      gb.cbox(ax, 0, hz, aw, ah, hd - 0.06, brick, 0, 0.014);
      gb.wedge(ax, ah, hz, hd - 0.02, aw + 0.06, 0.12, roof, (s * Math.PI) / 2);
      for (let i = 0; i < 5; i++) {
        const z = hz - hd / 2 + 0.2 + i * ((hd - 0.4) / 4);
        plainDoor(c, ox, z - 0.07, 0.08, 0.17, rng.pick(DOORS), s > 0 ? 'r' : 'l');
        win(c, ox, 0.05, z + 0.06, 0.1, 0.14, s > 0 ? 'r' : 'l', 0.95);
        win(c, ox, 0.28, z, 0.07, 0.08, s > 0 ? 'r' : 'l', 0.8);
        gb.boxC(ox + s * 0.055, 0.23, z, 0.11, 0.012, (hd - 0.4) / 4 - 0.04, i % 2 ? '#e9dfc9' : pal.awning, 0, 0, -s * 0.45);
      }
    }
    // the brick gable ends, each with a wheel window, the street one with a clock
    for (const e of [1, -1]) {
      const z = hz + e * (hd / 2 + 0.02);
      gb.cbox(0, 0, z, nw + 2 * aw + 0.04, ah + 0.04, 0.06, shade(brick, 0.95), 0, 0.01);
      gb.cbox(0, 0, z, nw + 0.06, nh, 0.06, brick, 0, 0.01);
      gb.roof(0, nh, z, 0.06, nw + 0.06, rh, 0.06, brick, Math.PI / 2);
      gb.push(0, 0, z, e > 0 ? 0 : Math.PI);
      gb.cyl(0, nh - 0.04, 0.03, 0.18, 0.18, 0.008, 16, trim, 0, Math.PI / 2);
      gb.glow(1.6, 1.4, 1.0, 1.5); gb.cyl(0, nh - 0.04, 0.034, 0.16, 0.16, 0.008, 16, GLASS_ROOF, 0, Math.PI / 2); gb.noGlow();
      for (let k = 0; k < 4; k++) gb.boxC(0, nh - 0.04, 0.044, 0.32, 0.012, 0.006, IRON, 0, 0, (k * Math.PI) / 4);
      gb.pop();
    }
    door(c, 0, fz + 0.05, 0.2, 0.26, '#3a3230');
    gb.cyl(0, 0.26, fz + 0.054, 0.1, 0.1, 0.012, 12, '#3a3230', 0, Math.PI / 2);
    sign(c, 0, ah - 0.06, fz + 0.06, 0.5, 0.06, '#3b2f2a');
    gb.glow(1.8, 1.4, 0.6, 3.1); gb.box(0, ah - 0.045, fz + 0.068, 0.42, 0.03, 0.008, '#e0c070'); gb.noGlow();
    gb.glow(1.2, 1.1, 0.8, 1.02); gb.cyl(0, nh + 0.22, fz + 0.054, 0.045, 0.045, 0.01, 12, '#efe8da', 0, Math.PI / 2); gb.noGlow();
    // flower and fruit stalls on the pavement
    marketStall(c, -0.6, 0.84, 0, 0.85, pal.awning);
    marketStall(c, 0.6, 0.84, 0, 0.85, pal.awning2);
    lamp(c, -0.3, 0.86, 0.3); lamp(c, 0.3, 0.86, 0.3);
  }
  if (f.turned) gb.pop();
};

// Grand Galleria: four three-storey blocks of shops round a cross of glazed
// arcades, a glass dome over the crossing and a triumphal arch on the street.
function galleria(c) {
  const { gb, rng, pal } = c;
  const wall = pal.stoneWall, trim = '#e3dccd', roof = pal.slate, A = 0.25, H = 0.78;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    house(c, {
      x: sx * 0.6, z: sz * 0.6, w: 0.64, d: 0.62, h: H, floors: 3, wall, roof, roofType: 'hip', rh: 0.2, plinth: STONE_D, noDoor: true,
      nFront: 3, fancy: false, chimney: true, chimneyPos: 'center', shopWindow: true, lit: 0.9,
    });
    for (let k = 1; k < 3; k++) gb.box(sx * 0.6, k * 0.26 - 0.008, sz * 0.6, 0.66, 0.014, 0.64, trim);
  }
  // the glazed arcades and the dome where they cross
  gb.box(0, 0, 0, 2 * A, 0.01, 1.9, '#d8d0c0');
  gb.box(0, 0, 0, 1.9, 0.01, 2 * A, '#d8d0c0');
  for (const along of [true, false]) {
    const w = along ? 2 * A : 1.86, d = along ? 1.86 : 2 * A;
    gb.gable(0, H, 0, w, d, 0.22, '#5a6268', '#4a5258', 0.02, along, 0.014);
    glassRoof(c, 0, H, 0, w, d, 0.22, along, 10);
  }
  gb.cyl(0, H + 0.12, 0, 0.3, 0.3, 0.14, 16, trim);
  gb.glow(1.6, 1.4, 1.0, 1.5); gb.sphere(0, H + 0.26, 0, 0.29, GLASS_ROOF, 1, 0.8); gb.noGlow();
  // iron ribs up the dome, each lying along its curve halfway up
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2, r = 0.29 * Math.SQRT1_2 * 1.04;
    gb.boxC(Math.cos(a) * r, H + 0.26 + 0.29 * 0.8 * Math.SQRT1_2 * 1.04, Math.sin(a) * r, 0.012, 0.012, 0.2, IRON, -0.675, Math.atan2(-Math.cos(a), -Math.sin(a)));
  }
  gb.cyl(0, H + 0.48, 0, 0.05, 0.05, 0.08, 8, trim);
  gb.cone(0, H + 0.56, 0, 0.06, 0.08, 8, '#5f7f86');
  // a triumphal arch on the street, smaller glazed screens at the other ends
  const fz = 0.82;
  gb.cbox(0, 0, fz, 2 * A + 0.14, H + 0.2, 0.08, trim, 0, 0.012);
  door(c, 0, fz + 0.04, 0.22, 0.3, '#2a2422');
  gb.cyl(0, 0.3, fz + 0.044, 0.11, 0.11, 0.012, 12, '#2a2422', 0, Math.PI / 2);
  gb.glow(1.6, 1.4, 1.0, 1.5); gb.cyl(0, 0.3, fz + 0.05, 0.085, 0.085, 0.008, 12, GLASS_ROOF, 0, Math.PI / 2); gb.noGlow();
  for (const s of [-1, 1]) gb.cyl(s * 0.19, 0.02, fz + 0.06, 0.018, 0.02, H - 0.05, 8, '#f2ede0');
  gb.box(0, H + 0.03, fz + 0.045, 2 * A + 0.1, 0.06, 0.012, '#3b2f2a');
  gb.glow(1.8, 1.4, 0.6, 3.1); gb.box(0, H + 0.045, fz + 0.053, 2 * A, 0.03, 0.006, '#e0c070'); gb.noGlow();
  for (const [x, z, ry] of [[0, -0.9, Math.PI], [0.9, 0, Math.PI / 2], [-0.9, 0, -Math.PI / 2]]) {
    gb.push(x, 0, z, ry);
    gb.cbox(0, 0, 0, 2 * A + 0.06, H, 0.05, trim, 0, 0.01);
    gb.box(0, 0, 0.026, 0.18, 0.26, 0.01, '#2a2422');
    gb.glow(1.6, 1.4, 1.0, 1.5); gb.box(0, 0.32, 0.026, 2 * A - 0.08, H - 0.4, 0.01, GLASS_ROOF); gb.noGlow();
    gb.pop();
  }
  // flags on the dome, lamps and flower stalls in front
  for (const s of [-1, 1]) { gb.box(s * 0.36, H + 0.2, 0.36, 0.01, 0.3, 0.01, '#3a3a3e'); gb.box(s * 0.36 + 0.05, H + 0.42, 0.36, 0.1, 0.06, 0.004, rng.pick(['#a8473a', '#3f6a8f', '#d9b84a'])); }
  lamp(c, -0.3, 0.92, 0.32); lamp(c, 0.3, 0.92, 0.32);
  for (const s of [-1, 1]) for (let i = 0; i < 4; i++) flowers(c, s * (0.4 + i * 0.14), 0.95, 3, 0.02);
}

// Coaching House: the inn on the street with a carriage arch through to a
// cobbled yard, stables down both sides and the coach house across the back.
MODELS.coachinginn = (c, L) => {
  const { gb, rng, pal } = c;
  const f = rowFrame(c);
  const floors = L + 2, fh = 0.26, h = floors * fh, D = 0.46, W = 1.76, fz = 0.6, ff = fz + D / 2, bf = fz - D / 2;
  const grand = L === 2, wall = grand ? '#ebe4d6' : pal.wall, roof = grand ? pal.slate : pal.roof;
  // the carriage arch is wide and high enough for a coach (see coach)
  const ax = (rng.chance(0.5) ? 1 : -1) * 0.46, aw = 0.24, ah = 0.3, dx = -Math.sign(ax) * 0.12;
  const jet = !grand && pal.timber && pal.jetty ? 0.03 : 0;
  footing(c, 0, fz, W, D);
  gb.cbox(0, 0, fz, W, fh, D, wall, 0, 0.02);
  gb.cbox(0, fh, fz, W + jet * 2, h - fh, D + jet * 2, wall, 0, 0.018);
  if (jet) gb.box(0, fh - 0.012, fz, W + jet * 2 + 0.01, 0.024, D + jet * 2 + 0.01, TIMBER);
  if (!grand && pal.timber) { gb.push(0, 0, fz); timber(c, W + jet * 2, D + jet * 2, h, floors); gb.pop(); }
  door(c, dx, ff, 0.1, 0.18, pal.door);
  // the carriage arch, right through to the yard
  for (const [z, e] of [[ff, 1], [bf, -1]]) {
    gb.cyl(ax, ah - aw / 2, z + (e > 0 ? 0.002 : -0.012), aw / 2 + 0.025, aw / 2 + 0.025, 0.01, 12, STONE, 0, Math.PI / 2);
    gb.box(ax, 0, z + e * 0.008, aw + 0.05, ah - aw / 2, 0.01, STONE);
    gb.box(ax, 0, z + e * 0.012, aw, ah - aw / 2, 0.012, '#2a2018');
    gb.cyl(ax, ah - aw / 2, z + (e > 0 ? 0.006 : -0.018), aw / 2, aw / 2, 0.012, 12, '#2a2018', 0, Math.PI / 2);
  }
  const n = 9, bw = W / n;
  for (let k = 0; k < floors; k++) for (let i = 0; i < n; i++) {
    const x = -W / 2 + (i + 0.5) * bw, y = k * fh + fh * 0.36, jz = k ? jet : 0;
    const hole = k === 0 && Math.abs(x - ax) < aw / 2 + 0.07;
    if (!hole && !(k === 0 && Math.abs(x - dx) < 0.12)) win(c, x, y, ff + jz, 0.075, 0.1, 'f', 0.95);
    if (!hole && rng.chance(0.75)) win(c, x, y, bf - jz, 0.075, 0.1, 'b', 0.9);
  }
  for (const s of [-1, 1]) for (let k = 0; k < floors; k++) win(c, s * (W / 2 + (k ? jet : 0)), k * fh + fh * 0.36, fz, 0.07, 0.1, s > 0 ? 'r' : 'l', 0.9);
  const rh = 0.28;
  if (grand) gb.hip(0, h, fz, W + 0.02, D + 0.02, 0.3, roof, 0.05);
  else gb.gable(0, h, fz, W + jet * 2 + 0.02, D + jet * 2, rh, wall, roof, 0.05, false, 0.035);
  for (const s of [-1, 1]) chimney(c, s * W * 0.36, h - 0.05, h + (grand ? 0.38 : rh + 0.08), fz, 'home', stackColor(c));
  if (L >= 1) {
    for (const x of [-0.5, 0, 0.5]) {
      const dz = fz + (D / 2) * 0.42, dy = h + (grand ? 0.3 : rh) * 0.1;
      gb.cbox(x, dy, dz, 0.1, 0.12, 0.12, wall, 0, 0.012);
      gb.gable(x, dy + 0.12, dz, 0.1, 0.13, 0.07, wall, roof, 0.025, true, 0.022);
      win(c, x, dy + 0.025, dz + 0.06, 0.05, 0.065, 'f');
    }
  }
  // the hanging sign, lanterns by the arch, benches and barrels outside
  const sx = -Math.sign(ax) * 0.84;
  gb.box(sx, h * 0.5, ff + 0.06, 0.012, 0.012, 0.12, '#2f2c2a');
  sign(c, sx, h * 0.5 - 0.12, ff + 0.11, 0.11, 0.11, rng.pick(['#7a3a2a', '#2f4a6a', '#3f5a3a']), Math.PI / 2);
  for (const s of [-1, 1]) { gb.glow(2.2, 1.6, 0.8, 3.0); gb.box(ax + s * 0.18, 0.24, ff + 0.03, 0.04, 0.05, 0.04, '#ffe2a0'); gb.noGlow(); }
  bench(c, dx - Math.sign(ax) * 0.26, ff + 0.1, Math.PI);
  barrel(c, -Math.sign(ax) * 0.62, ff + 0.07); barrel(c, -Math.sign(ax) * 0.68, ff + 0.1, 0.9);
  if (grand) {
    // a veranda along the street, and flags on the roof
    for (let i = 0; i < 8; i++) gb.cyl(-W / 2 + 0.1 + (i * (W - 0.2)) / 7, 0, ff + 0.1, 0.012, 0.014, 0.26, 6, '#ece6da');
    gb.box(0, 0.26, ff + 0.06, W - 0.1, 0.02, 0.14, '#ece6da');
    for (const x of [-0.3, 0.3]) { gb.box(x, h + 0.12, fz, 0.01, 0.3, 0.01, '#3a3a3e'); gb.box(x + 0.05, h + 0.34, fz, 0.1, 0.06, 0.004, rng.pick(['#a8473a', '#3f6a8f'])); }
    lamp(c, -0.7, 0.95, 0.3); lamp(c, 0.7, 0.95, 0.3);
  }
  // the yard: stables down both sides...
  const cz = -0.76, cd = 0.32, ch = L ? 0.4 : 0.34;
  const yz0 = cz + cd / 2, sh = L ? 0.46 : 0.28, sd = bf - yz0 - 0.06, szc = (bf + yz0) / 2 - 0.03, timberSide = L ? shade(wall, 0.95) : pal.wood;
  for (const s of [-1, 1]) {
    const x = s * (W / 2 - 0.15), w = 0.3, inner = x - (s * w) / 2, face = s > 0 ? 'l' : 'r';
    footing(c, x, szc, w, sd);
    gb.cbox(x, 0, szc, w, sh, sd, timberSide, 0, 0.012);
    gb.gable(x, sh, szc, w, sd, 0.16, timberSide, pal.roof, 0.04, true, 0.03);
    for (let i = 0; i < 4; i++) {
      const z = szc - sd / 2 + (i + 0.5) * (sd / 4);
      plainDoor(c, inner, z, 0.09, 0.17, '#5e432c', face);
      gb.box(inner - s * 0.012, 0.085, z, 0.008, 0.008, 0.095, '#3f342c');
      if (L) win(c, inner, 0.3, z, 0.06, 0.08, face, 0.7);
      else win(c, x + (s * w) / 2, 0.08, z, 0.05, 0.06, s > 0 ? 'r' : 'l', 0.4);
    }
  }
  // ...and the coach house across the back, open to the yard
  footing(c, 0, cz, W, cd);
  gb.box(0, 0, cz - cd / 2 + 0.01, W, ch, 0.02, timberSide);
  for (const s of [-1, 1]) gb.box(s * (W / 2 - 0.01), 0, cz, 0.02, ch, cd, timberSide);
  for (let i = 0; i <= 4; i++) gb.box(-W / 2 + 0.02 + (i * (W - 0.04)) / 4, 0, cz + cd / 2 - 0.02, 0.03, ch, 0.03, '#5e432c');
  gb.box(0, 0.002, cz, W - 0.04, 0.01, cd - 0.04, '#3a3230');
  gb.gable(0, ch, cz, W + 0.02, cd + 0.02, 0.16, timberSide, pal.roof, 0.04, false, 0.03);
  coach(c, -0.215, cz + 0.02, Math.PI / 2, rng.pick(['#3f5466', '#5a2a2a', '#2f4a3a']));
  const e = Math.sign(ax);
  if (L) {
    // a clock turret over the coach house, and a coach ready to leave
    gb.cbox(0, ch + 0.08, cz, 0.1, 0.12, 0.1, '#ece6da', 0, 0.008);
    gb.glow(1.2, 1.1, 0.8, 1.02); gb.cyl(0, ch + 0.14, cz + 0.051, 0.032, 0.032, 0.006, 10, '#efe8da', 0, Math.PI / 2); gb.noGlow();
    gb.roof(0, ch + 0.2, cz, 0.12, 0.12, 0.1, 0, pal.slate);
    gb.box(0, ch + 0.3, cz, 0.008, 0.06, 0.008, '#c9a43a');
    coach(c, -e * 0.04, -0.33, (e * Math.PI) / 2, '#3f5466', true);
  }
  // in the yard: a trough and pump, a horse drinking, hay and barrels
  const tx = -e * 0.45, ty = c.gy(tx, 0.12);
  gb.cbox(tx, ty - 0.01, 0.12, 0.06, 0.05, 0.16, STONE, 0, 0.008);
  gb.box(tx, ty + 0.035, 0.12, 0.045, 0.008, 0.14, POOL);
  gb.cyl(tx, ty, 0.24, 0.014, 0.016, 0.14, 6, '#3a3a3e');
  gb.box(tx + e * 0.02, ty + 0.12, 0.24, 0.05, 0.008, 0.008, '#3a3a3e');
  horse(c, -e * 0.27, 0.12, (-e * Math.PI) / 2, rng.pick(['#7a5232', '#4a3a30', '#c8b8a0']));
  for (let i = 0; i < 3; i++) hayBale(c, e * 0.5, 0.18 - i * 0.08, 0);
  barrel(c, e * 0.52, 0.27); barrel(c, e * 0.46, 0.3, 0.9);
  if (f.turned) gb.pop();
};

// Timber Works: the counting house at the gate, a sawmill (with an engine
// house and a tall stack at Steam Sawmills), drying sheds of planks and a
// yard of logs with a crane.
MODELS.timberworks = (c, L) => {
  const { gb, rng, pal } = c;
  const f = rowFrame(c);
  house(c, {
    x: 0.63, z: 0.67, w: 0.42, d: 0.3, h: 0.3, floors: 1, wall: L ? pal.brick : pal.wall, roof: pal.slate, roofType: 'gable', rh: 0.16,
    nFront: 2, doorX: -0.08, chimney: true, chimneyPos: 'center', fancy: false, lit: 0.8,
  });
  sign(c, 0.63, 0.2, 0.825, 0.24, 0.05, '#3b2f2a');
  // the sawmill, its big doors open to the yard and a louvre on the ridge
  const mx = -0.42, mz = -0.5, mw = 0.96, md = 0.66, mh = L ? 0.6 : 0.46, mf = mz + md / 2;
  worksShed(c, mx, mz, mw, md, mh, 2, L ? pal.brick : pal.wood, pal.slate, 0.24, (u) => Math.abs(u - mx) < 0.2);
  gb.box(mx, 0, mf + 0.004, 0.25, 0.21, 0.01, '#2a2018');
  gb.box(mx + 0.2, 0, mf + 0.012, 0.13, 0.22, 0.01, '#6e5034');
  gb.box(mx + 0.06, 0.225, mf + 0.016, 0.44, 0.012, 0.01, IRON);
  gb.cbox(mx, mh + 0.2, mz, 0.34, 0.06, 0.12, pal.wood, 0, 0.008);
  gb.gable(mx, mh + 0.26, mz, 0.38, 0.14, 0.05, pal.wood, pal.slate, 0.02, false, 0.02);
  if (!L) chimney(c, mx - mw * 0.36, mh - 0.06, mh + 0.34, mz, 'work', '#7f3f2e');
  else {
    // the engine house and its tall stack
    const ex = 0.2, ez = -0.66;
    footing(c, ex, ez, 0.28, 0.36);
    gb.cbox(ex, 0, ez, 0.28, 0.46, 0.36, pal.brick, 0, 0.014);
    gb.hip(ex, 0.46, ez, 0.28, 0.36, 0.12, pal.slate, 0.03);
    for (const z of [ez - 0.08, ez + 0.08]) { win(c, ex + 0.14, 0.14, z, 0.06, 0.18, 'r', 0.9); win(c, ex - 0.14, 0.14, z, 0.06, 0.18, 'l', 0.9); }
    win(c, ex, 0.14, ez + 0.18, 0.08, 0.18, 'f', 0.9);
    gb.cyl(ex, 0, -0.88, 0.05, 0.075, 1.45, 10, '#7f3f2e');
    gb.cyl(ex, 1.45, -0.88, 0.062, 0.062, 0.04, 10, '#5e2e22');
    c.addSmoke(ex, 1.52, -0.88, 'heavy');
  }
  // the drying sheds, open-fronted and stacked with planks
  shed(c, 0.66, -0.5, 0.56, 0.68, 0.36, pal.roof);
  for (const [x, z] of [[0.52, -0.62], [0.8, -0.62], [0.52, -0.38], [0.8, -0.38]]) plankStack(c, x, z, rng.int(3, 5), Math.PI / 2);
  // the yard: logs waiting for the saw, stacks of sawn timber, sawdust
  logs(c, -0.86, 0.06, 4, 0); logs(c, -0.86, 0.34, 3, 0); logs(c, -0.56, 0.2, 4, 0.08);
  for (const [x, z, n] of [[0.0, 0.08, 5], [0.22, 0.08, 4], [0.0, 0.4, 3]]) plankStack(c, x, z, n, Math.PI / 2);
  gb.blob(-0.08, c.gy(-0.08, -0.08), -0.08, 0.1, 0.05, 0.08, '#d4bc88');
  gb.blob(0.32, c.gy(0.32, 0.36), 0.36, 0.06, 0.03, 0.05, '#d4bc88');
  sawhorse(c, -0.3, 0.52, 0.4); sawhorse(c, 0.36, -0.08, -0.2);
  const by = c.gy(0.4, 0.42);
  gb.cbox(0.4, by, 0.42, 0.18, 0.06, 0.08, '#7a5a3c', 0, 0.006);
  gb.cyl(0.4, by + 0.06, 0.42, 0.04, 0.04, 0.006, 12, '#b8b8bc', 0, 0, Math.PI / 2);
  if (L) {
    // a gantry crane over the log pile
    for (const x of [-0.9, -0.36]) {
      const y = c.gy(x, 0.2);
      for (const a of [-0.25, 0.25]) gb.boxC(x, y + 0.31, 0.2, 0.016, 0.64, 0.016, '#5e432c', a, 0, 0);
    }
    gb.box(-0.63, c.gy(-0.63, 0.2) + 0.6, 0.2, 0.62, 0.03, 0.03, '#3a3a3e');
    gb.box(-0.6, c.gy(-0.6, 0.2) + 0.58, 0.2, 0.06, 0.03, 0.05, '#c09040');
    gb.box(-0.6, c.gy(-0.6, 0.2) + 0.36, 0.2, 0.004, 0.22, 0.004, '#d9cfb4');
    gb.cyl(-0.7, c.gy(-0.6, 0.2) + 0.33, 0.2, 0.024, 0.024, 0.2, 6, '#7d5b3b', 0, 0, Math.PI / 2);
    lamp(c, 0.12, 0.88, 0.3); lamp(c, 0.38, 0.88, 0.3);
  } else ginPole(c, -0.66, 0.5, 0.62, Math.PI / 2);
  // a timber wagon by the gate, the size of the carts on the roads
  const wx = 0.04, wz = 0.72, wy = c.gy(wx, wz);
  gb.push(wx, wy, wz, 0.1);
  gb.cbox(0, 0.045, 0, 0.16, 0.035, 0.34, '#86663f', 0, 0.006);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) gb.cyl(sx * 0.09, 0.045, sz * 0.11, 0.045, 0.045, 0.015, 8, '#4e3a2a', 0, 0, Math.PI / 2);
  for (const sx of [-0.045, 0, 0.045]) gb.cyl(sx, 0.1, -0.16, 0.022, 0.022, 0.32, 6, '#7d5b3b', 0, Math.PI / 2);
  gb.box(0, 0.08, 0.2, 0.014, 0.014, 0.1, '#5b4231');
  gb.pop();
  fence(c, -0.95, -0.95, 0.95, 0.95, FENCE, { x: 0.25, z: 0.95, w: 0.14 });
  if (f.turned) gb.pop();
};

// Cathedral Close: the cathedral down one side of the plot, its west front
// and towers on the street, and the school and deanery round a green close.
MODELS.cathedralclose = (c, L) => {
  const { gb, rng, pal } = c;
  const f = rowFrame(c);
  const stone = pal.stoneWall, roof = pal.slate, dark = shade(stone, 0.8);
  const side = rng.chance(0.5) ? 1 : -1, cx = -side * 0.46;
  const nw = 0.4, nh = L ? 0.62 : 0.52, nd = 1.08, nz = -0.1, wz = nz + nd / 2, zc = nz - nd / 2 + 0.3;
  // the west door first: it is the way in
  door(c, cx, wz, 0.12, 0.22, '#4e3424');
  footing(c, cx, nz, nw + 0.24, nd);
  gb.cbox(cx, 0, nz, nw, nh, nd, stone, 0, 0.02);
  gb.gable(cx, nh, nz, nw, nd, 0.32, stone, roof, 0.05, true, 0.035);
  // aisles under lean-to roofs, coloured glass and buttresses down the sides
  for (const s of [-1, 1]) {
    const ax = cx + s * (nw / 2 + 0.06), ah = nh * 0.55;
    gb.cbox(ax, 0, nz + 0.02, 0.12, ah, nd - 0.16, stone, 0, 0.012);
    gb.wedge(ax, ah, nz + 0.02, nd - 0.12, 0.16, 0.08, roof, (s * Math.PI) / 2);
    for (let i = 0; i < 5; i++) {
      const z = nz - nd / 2 + 0.16 + (i * (nd - 0.3)) / 4;
      if (Math.abs(z - zc) < 0.16) continue;
      stainedGlass(c, ax + s * 0.062, 0.08, z, 0.05, ah * 0.6, i + (s > 0 ? 0 : 1), 'r');
      stainedGlass(c, cx + s * (nw / 2 + 0.007), ah + 0.07, z, 0.05, (nh - ah) * 0.6, i + 2, 'r');
      gb.cbox(ax + s * 0.07, 0, z + 0.1, 0.04, ah * 0.85, 0.05, dark, 0, 0.008);
    }
  }
  // the transepts and the crossing tower (a spire on the Cathedral Close)
  const tw = 0.84;
  footing(c, cx, zc, tw, 0.32);
  gb.cbox(cx, 0, zc, tw, nh, 0.32, stone, 0, 0.016);
  gb.gable(cx, nh, zc, tw, 0.32, 0.3, stone, roof, 0.05, false, 0.035);
  for (const s of [-1, 1]) roseWindow(c, cx + s * (tw / 2 + 0.002), nh * 0.62, zc, 0.07, s);
  const ct = nh + (L ? 0.62 : 0.36);
  gb.cbox(cx, nh, zc, 0.26, ct - nh, 0.26, stone, 0, 0.012);
  for (const [fx, fz] of [[0, 0.131], [0.131, 0], [-0.131, 0], [0, -0.131]]) gb.box(cx + fx, ct - 0.2, zc + fz, Math.abs(fz) ? 0.06 : 0.01, 0.13, Math.abs(fx) ? 0.06 : 0.01, '#2a2826');
  parapet(c, cx, ct, zc, 0.26, 0.26, stone);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) gb.cone(cx + sx * 0.11, ct + 0.02, zc + sz * 0.11, 0.025, 0.14, 6, roof);
  if (L) { gb.cone(cx, ct, zc, 0.12, 0.62, 8, roof, Math.PI / 8); gb.box(cx, ct + 0.62, zc, 0.01, 0.07, 0.01, '#c9a43a'); }
  // the choir and its round apse at the east end
  gb.cbox(cx, 0, -0.7, 0.34, nh * 0.9, 0.18, stone, 0, 0.012);
  gb.gable(cx, nh * 0.9, -0.7, 0.34, 0.18, 0.24, stone, roof, 0.04, true, 0.03);
  gb.cyl(cx, 0, -0.79, 0.16, 0.16, nh * 0.85, 10, stone);
  gb.cone(cx, nh * 0.85, -0.79, 0.18, 0.2, 10, roof);
  for (const a of [-0.7, 0, 0.7]) stainedGlass(c, cx + Math.sin(a) * 0.165, 0.12, -0.79 - Math.cos(a) * 0.165, 0.04, nh * 0.42, 1, 'b', -a);
  // the west front: two towers, a rose window over the door
  const th = L ? 1.3 : 1.06;
  for (const s of [-1, 1]) {
    const tx = cx + s * 0.19, tz = wz - 0.04;
    footing(c, tx, tz, 0.17, 0.17);
    gb.cbox(tx, 0, tz, 0.17, th, 0.17, stone, 0, 0.014);
    gb.box(tx, th * 0.7, tz + 0.086, 0.05, 0.13, 0.012, '#2a2826');
    gb.box(tx + s * 0.086, th * 0.7, tz, 0.012, 0.13, 0.05, '#2a2826');
    if (L) gb.cone(tx, th, tz, 0.12, 0.42, 8, roof, Math.PI / 8);
    else { parapet(c, tx, th, tz, 0.17, 0.17, stone); for (const a of [-1, 1]) for (const b2 of [-1, 1]) gb.cone(tx + a * 0.07, th + 0.02, tz + b2 * 0.07, 0.022, 0.12, 6, roof); }
  }
  roseWindow(c, cx, nh * 0.66, wz, 0.08);
  gb.box(cx, 0.22, wz + 0.006, 0.16, 0.05, 0.012, dark);
  // the school down the far side of the close, a bellcote on its roof
  const sx = side * 0.76, sh = L ? 0.78 : 0.52;
  house(c, {
    x: sx, z: -0.1, ry: (-side * Math.PI) / 2, w: 0.96, d: 0.32, h: sh, floors: L ? 3 : 2, wall: stone, roof, roofType: 'gable', rh: 0.22,
    nFront: 5, doorX: 0, doorW: 0.1, chimney: true, chimneyPos: 'ends', plinth: STONE, fancy: false, lit: 0.85,
  });
  gb.cbox(sx, sh + 0.12, -0.1, 0.08, 0.12, 0.08, stone, 0, 0.006);
  gb.roof(sx, sh + 0.24, -0.1, 0.11, 0.11, 0.08, 0, roof);
  gb.box(sx, sh + 0.15, -0.1, 0.03, 0.04, 0.09, '#c9a43a');
  // the deanery across the back
  house(c, { x: side * 0.32, z: -0.76, w: 0.44, d: 0.3, h: 0.46, floors: 2, wall: pal.wall, roof: pal.roof, roofType: 'gable', rh: 0.22, nFront: 3, doorX: 0, chimney: true, chimneyPos: 'ends', plinth: STONE });
  // the green: lawn, paths, trees, the old graves by the church
  const gx = side * 0.3;
  gb.box(gx, c.gy(gx, 0.15) - 0.008, 0.15, 0.56, 0.012, 1.4, LAWN_G);
  gravel(c, gx, 0.62, 0.56, 0.08);
  gravel(c, gx, 0.79, 0.08, 0.34);
  gravel(c, side * 0.5, 0.2, 0.08, 0.84);
  gravel(c, cx, 0.75, 0.42, 0.4, '#b8b0a2');
  smallTree(c, side * 0.18, 0.3, 1.1); smallTree(c, side * 0.4, -0.38, 1);
  for (let i = 0; i < 6; i++) { const x = side * (0.06 + (i % 2) * 0.08), z = -0.42 + Math.floor(i / 2) * 0.16; gb.cbox(x, c.gy(x, z) - 0.01, z, 0.05, 0.07, 0.016, '#a39e94', 0, 0.006); }
  bench(c, side * 0.32, 0.5, Math.PI); bench(c, side * 0.12, -0.1, side > 0 ? -Math.PI / 2 : Math.PI / 2);
  frontage(c, side > 0 ? 0.0 : -0.95, side > 0 ? 0.95 : 0.0, 0.95, [gx], L ? 'railings' : 'wall');
  if (L) {
    // a covered walk along the cathedral where it faces the close
    const px = cx + side * 0.4;
    for (let i = 0; i < 6; i++) gb.box(px, 0, nz - 0.4 + i * 0.16, 0.014, 0.2, 0.014, '#cfc6b4');
    gb.wedge(px - side * 0.04, 0.2, nz, 0.9, 0.12, 0.05, roof, (side * Math.PI) / 2);
    lamp(c, cx - 0.2, 0.92, 0.3); lamp(c, cx + 0.2, 0.92, 0.3);
  }
  if (f.turned) gb.pop();
};

// Infirmary Court: a gatehouse under a red cross, rooms round a garden court,
// the ward block and its chapel across the back.
MODELS.infirmary = (c, L) => {
  const { gb, rng, pal } = c;
  const f = rowFrame(c);
  const wall = L ? pal.stoneWall : pal.wall, roof = L ? pal.slate : pal.roof, RD = 0.32, fh = 0.28, floors = L ? 2 : 1, h = floors * fh;
  const W = 1.84, fz = 0.66, gw = 0.34, gd = RD + 0.08, gh = h + 0.26, gf = fz + gd / 2;
  const wz = -0.72, wf = wz + 0.18, sz0 = fz - RD / 2;   // the ward block's court face, the street range's
  footing(c, 0, fz, gw, gd);
  gb.cbox(0, 0, fz, gw, gh, gd, '#ebe4d6', 0, 0.016);
  gb.hip(0, gh, fz, gw, gd, 0.16, roof, 0.04);
  door(c, 0, gf, 0.11, 0.19, '#3f4f5a');
  plainDoor(c, 0, fz - gd / 2, 0.11, 0.19, '#3f4f5a', 'b');
  gb.box(0, 0.25, gf + 0.002, 0.09, 0.09, 0.008, '#c8423a');
  gb.box(0, 0.28, gf + 0.006, 0.006, 0.07, 0.006, '#f2ede0'); gb.box(0, 0.31, gf + 0.006, 0.07, 0.006, 0.006, '#f2ede0');
  for (const s of [-1, 1]) win(c, s * 0.09, gh - 0.17, gf, 0.065, 0.09, 'f', 0.9);
  if (L) {
    gb.cbox(0, gh + 0.12, fz, 0.1, 0.1, 0.1, '#ebe4d6', 0, 0.008);
    gb.glow(1.2, 1.1, 0.8, 1.02); gb.cyl(0, gh + 0.17, fz + 0.051, 0.03, 0.03, 0.006, 10, '#efe8da', 0, Math.PI / 2); gb.noGlow();
    gb.roof(0, gh + 0.22, fz, 0.12, 0.12, 0.09, 0, pal.slate);
  }
  // rooms on the street either side of the gate, and down both sides
  for (const s of [-1, 1]) {
    const len = W / 2 - gw / 2;
    courtRange(c, s * (gw / 2 + len / 2), fz, len, RD, h, floors, wall, roof, false, -1, 3, true);
    courtRange(c, s * (W / 2 - RD / 2), (wf + sz0) / 2, sz0 - wf, RD, h, floors, wall, roof, true, -s, 4, true);
  }
  // the ward block across the back, its chapel reaching into the court
  house(c, {
    x: 0, z: wz, w: W, d: 0.36, h: L ? 0.84 : 0.56, floors: L ? 3 : 2, wall: L ? pal.stoneWall : '#ebe4d6', roof, roofType: 'hip', rh: 0.22,
    noDoor: true, nFront: 9, fancy: false, chimney: true, chimneyPos: 'ends', plinth: STONE, lit: 0.85,
  });
  const chz = -0.44, chh = L ? 0.5 : 0.42;
  gb.cbox(0, 0, chz, 0.24, chh, 0.2, '#ebe4d6', 0, 0.012);
  gb.gable(0, chh, chz, 0.24, 0.2, 0.18, '#ebe4d6', roof, 0.04, true, 0.03);
  stainedGlass(c, 0, 0.12, chz + 0.102, 0.05, chh * 0.5, 0, 'f');
  for (const s of [-1, 1]) stainedGlass(c, s * 0.122, 0.12, chz, 0.04, chh * 0.4, 1, 'r');
  gb.cbox(0, chh + 0.1, chz + 0.06, 0.06, 0.08, 0.04, '#ebe4d6', 0, 0.006);
  gb.box(0, chh + 0.18, chz + 0.06, 0.008, 0.06, 0.008, '#c9a43a');
  // the garden court: lawn and walks, beds, benches, a well (a fountain later)
  const gy = c.gy(0, 0.0), cd = sz0 - wf - 0.04;
  gb.box(0, gy - 0.008, (wf + sz0) / 2, 1.16, 0.012, cd, LAWN_G);
  gb.box(0, gy - 0.004, (wf + sz0) / 2, 0.08, 0.012, cd, GRAVEL);
  gb.box(0, gy - 0.004, 0.1, 1.16, 0.012, 0.08, GRAVEL);
  if (L) basin(c, 0, 0.1, 0.08, 0.1);
  else {
    gb.cyl(0, gy - 0.02, 0.1, 0.06, 0.07, 0.08, 10, STONE);
    for (const s of [-1, 1]) gb.box(s * 0.05, gy + 0.06, 0.1, 0.012, 0.14, 0.012, '#4e3a2a');
    gb.gable(0, gy + 0.2, 0.1, 0.14, 0.12, 0.05, '#6e4a2c', '#8a432e', 0.02);
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) flowers(c, sx * 0.3, 0.1 + sz * 0.26, 6, 0.08);
  smallTree(c, -0.42, -0.2, 0.9); smallTree(c, 0.42, 0.4, 0.85);
  vegPatch(c, 0.38, -0.22);
  bench(c, -0.18, 0.42, Math.PI); bench(c, 0.18, -0.22, 0);
  if (L) {
    lamp(c, -0.24, 0.96, 0.3); lamp(c, 0.24, 0.96, 0.3);
  }
  if (f.turned) gb.pop();
};

// College Quad: a gate tower on the street, battlemented ranges round a
// lawned quadrangle, the chapel down one side, the library down the other
// and the great hall across the back.
MODELS.collegequad = (c, L) => {
  const { gb, rng, pal } = c;
  const f = rowFrame(c);
  c.arched = true;
  const stone = pal.stoneWall, roof = pal.slate, dark = shade(stone, 0.85);
  const floors = L ? 3 : 2, fh = 0.26, h = floors * fh, RD = 0.32, W = 1.84, fz = 0.64;
  // the gate tower, its arch the way into the quad
  const gw = 0.36, gd = RD + 0.1, gh = h + (L ? 0.48 : 0.34), gf = fz + gd / 2;
  footing(c, 0, fz, gw, gd);
  gb.cbox(0, 0, fz, gw, gh, gd, stone, 0, 0.016);
  gb.cyl(0, 0.2, gf + 0.002, 0.1, 0.1, 0.01, 12, dark, 0, Math.PI / 2);
  door(c, 0, gf, 0.14, 0.2, '#4e3424');
  plainDoor(c, 0, fz - gd / 2, 0.14, 0.2, '#4e3424', 'b');
  gb.cbox(0, 0.32, gf + 0.03, 0.16, 0.16, 0.06, stone, 0, 0.008);
  gb.glow(WARM[0], WARM[1], WARM[2], 1.3); gb.box(0, 0.35, gf + 0.062, 0.12, 0.1, 0.006, GLASS); gb.noGlow();
  for (let k = 1; k < floors + 1; k++) win(c, 0, k * fh + 0.1, gf, 0.07, 0.1, 'f', 0.85);
  parapet(c, 0, gh, fz, gw, gd, stone);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * (gw / 2), z = fz + sz * (gd / 2);
    gb.cyl(x, 0, z, 0.05, 0.055, gh + 0.12, 8, stone);
    gb.cone(x, gh + 0.12, z, 0.06, 0.14, 8, roof);
  }
  if (L) {
    // a lantern and an ogee dome over the gate (the Great Quadrangle's tower)
    gb.cyl(0, gh, fz, 0.12, 0.12, 0.2, 8, stone);
    for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; gb.glow(WARM[0], WARM[1], WARM[2], 1.2); gb.box(Math.cos(a) * 0.115, gh + 0.06, fz + Math.sin(a) * 0.115, 0.03, 0.09, 0.03, GLASS, -a); gb.noGlow(); }
    gb.sphere(0, gh + 0.24, fz, 0.13, roof, 1, 1.15);
    gb.cone(0, gh + 0.36, fz, 0.05, 0.14, 8, roof);
    gb.sphere(0, gh + 0.51, fz, 0.018, '#d9b84a', 0);
  }
  // the ranges on the street, either side of the gate
  for (const s of [-1, 1]) {
    const len = W / 2 - gw / 2, x = s * (gw / 2 + len / 2);
    courtRange(c, x, fz, len, RD, h, floors, stone, roof, false, 0, 4, false, 0.14);
    battlements(c, x, h, fz + RD / 2 - 0.02, len, false, stone);
    battlements(c, x, h, fz - RD / 2 + 0.02, len, false, stone);
  }
  // the chapel down one side: tall coloured windows, buttresses, a slender spire
  const side = rng.chance(0.5) ? 1 : -1, qz0 = -0.56, qz1 = fz - RD / 2, sl = qz1 - qz0, szc = (qz0 + qz1) / 2;
  const chx = side * (W / 2 - RD / 2), chh = L ? 0.74 : 0.62;
  footing(c, chx, szc, RD, sl);
  gb.cbox(chx, 0, szc, RD, chh, sl, stone, 0, 0.016);
  gb.gable(chx, chh, szc, RD, sl, 0.3, stone, roof, 0.05, true, 0.035);
  for (let i = 0; i < 5; i++) {
    const z = szc - sl / 2 + (i + 0.5) * (sl / 5);
    for (const s of [-1, 1]) {
      stainedGlass(c, chx + s * (RD / 2 + 0.007), 0.14, z, 0.05, chh * 0.6, i + (s > 0 ? 0 : 1), 'r');
      if (i < 4) gb.cbox(chx + s * (RD / 2 + 0.02), 0, z + sl / 10, 0.04, chh * 0.8, 0.05, dark, 0, 0.008);
    }
  }
  gb.cbox(chx, chh + 0.24, szc, 0.06, 0.1, 0.06, stone, 0, 0.006);
  gb.cone(chx, chh + 0.34, szc, 0.05, 0.3, 6, roof);
  // the library down the other side
  courtRange(c, -side * (W / 2 - RD / 2), szc, sl, RD, h, floors, stone, roof, true, 0, 5, false, 0.14);
  for (const s of [-1, 1]) battlements(c, -side * (W / 2 - RD / 2) + s * (RD / 2 - 0.02), h, szc, sl, true, stone);
  // the great hall across the back, a louvre on its ridge and an oriel at the dais
  const hz = -0.74, hd = 0.36, hh = L ? 0.86 : 0.7, hw = 1.24, hx = side * 0.3;
  footing(c, hx, hz, hw, hd);
  gb.cbox(hx, 0, hz, hw, hh, hd, stone, 0, 0.018);
  gb.gable(hx, hh, hz, hw, hd, 0.32, stone, roof, 0.05, false, 0.035);
  for (let i = 0; i < 6; i++) {
    const x = hx - hw / 2 + (i + 0.5) * (hw / 6);
    gb.glow(WARM[0], WARM[1], WARM[2], 1.2 + rng.float(0, 0.5));
    gb.box(x, 0.2, hz + hd / 2 + 0.006, 0.06, hh * 0.55, 0.014, GLASS);
    gb.box(x, 0.2, hz - hd / 2 - 0.006, 0.06, hh * 0.55, 0.014, GLASS);
    gb.noGlow();
    if (i < 5) gb.cbox(x + hw / 12, 0, hz + hd / 2 + 0.02, 0.05, hh * 0.85, 0.04, dark, 0, 0.008);
  }
  gb.cbox(hx, hh + 0.24, hz, 0.12, 0.1, 0.12, stone, 0, 0.008);
  gb.roof(hx, hh + 0.34, hz, 0.15, 0.15, 0.12, 0, roof);
  gb.cbox(hx - side * (hw / 2 - 0.1), 0.18, hz + hd / 2 + 0.05, 0.14, 0.34, 0.1, stone, 0, 0.008);
  gb.glow(WARM[0], WARM[1], WARM[2], 1.4); gb.box(hx - side * (hw / 2 - 0.1), 0.22, hz + hd / 2 + 0.102, 0.1, 0.26, 0.006, GLASS); gb.noGlow();
  // the master's lodge in the last corner, a stack in the middle of its ridge
  house(c, {
    x: -side * 0.74, z: hz, w: 0.34, d: hd, h: L ? 0.72 : 0.52, floors: L ? 3 : 2, wall: stone, roof, roofType: 'gable', rh: 0.22, alongZ: true,
    noDoor: true, nFront: 1, chimney: true, chimneyPos: 'center', fancy: false, lit: 0.85,
  });
  // the quad: a lawn not to be walked on, paths round it and across
  const qw = W - 2 * RD - 0.06, qd = sl - 0.06, qzc = szc + 0.02, gy = c.gy(0, qzc);
  gb.box(0, gy - 0.008, qzc, qw, 0.012, qd, LAWN_G);
  gb.box(0, gy - 0.004, qzc, qw, 0.012, 0.06, GRAVEL);
  gb.box(0, gy - 0.004, qzc, 0.06, 0.012, qd, GRAVEL);
  if (L) basin(c, 0, qzc, 0.1, 0.12);
  else {
    gb.cbox(0, gy - 0.01, qzc, 0.06, 0.12, 0.06, STONE, 0, 0.008);
    gb.cyl(0, gy + 0.11, qzc, 0.04, 0.04, 0.008, 10, '#c9a43a');
  }
  bench(c, -0.32, qzc - 0.4, 0); bench(c, 0.32, qzc + 0.4, Math.PI);
  lamp(c, -0.3, 0.96, 0.3); lamp(c, 0.3, 0.96, 0.3);
  if (f.turned) gb.pop();
};


// ------------------------------------------------- side-branch buildings

// A foundry: a casting shed, a cupola furnace glowing and stacks of iron, in
// one of its plans: a tall gable shed with round stacks behind; a shed with a
// monitor roof along its ridge and a square stack; or twin sheds with their
// gables to the street, a stack between them.
MODELS.foundry = (c, L) => {
  const { gb, pal } = c;
  const plan = planOf(c, 3), wall = L ? '#6a4a3a' : pal.brick, H = L ? 0.6 : 0.48;
  if (plan === 2) {
    for (const x of [-0.27, 0.13]) house(c, { x, z: -0.14, w: 0.36, d: 0.56, h: H - 0.04, wall, roof: '#3f3f44', roofType: 'gable', alongZ: true, rh: 0.2, nFront: 1, doorX: 0, doorW: 0.14, noDoor: x > 0, chimney: false, fancy: false, lit: 1 });
    gb.cbox(-0.07, 0, -0.36, 0.11, L ? 1.3 : 1.05, 0.11, '#5e2e22', 0, 0.01);
    c.addSmoke(-0.07, L ? 1.35 : 1.1, -0.36, 'heavy');
  } else {
    house(c, { x: -0.08, z: -0.14, w: 0.7, d: 0.52, h: H, wall, roof: '#3f3f44', roofType: 'gable', rh: plan === 1 ? 0.14 : 0.2, nFront: 3, doorX: 0, doorW: 0.16, chimney: false, fancy: false, lit: 1 });
    if (plan === 1) {
      // a monitor along the ridge, its windows glowing, and a square stack
      gb.cbox(-0.08, H + 0.08, -0.14, 0.6, 0.09, 0.2, '#4a4a4e', 0, 0.006);
      gb.glow(2.2, 1.1, 0.35, 1.4); for (const s2 of [-1, 1]) gb.box(-0.08, H + 0.1, -0.14 + s2 * 0.102, 0.54, 0.05, 0.008, GLASS); gb.noGlow();
      gb.gable(-0.08, H + 0.17, -0.14, 0.64, 0.24, 0.05, '#4a4a4e', '#3f3f44', 0.02, false, 0.02);
      gb.cbox(-0.34, 0, -0.38, 0.1, L ? 1.25 : 1.0, 0.1, '#5e2e22', 0, 0.01);
      c.addSmoke(-0.34, L ? 1.3 : 1.05, -0.38, 'heavy');
    } else {
      const stacks = L ? [[-0.34, -0.36], [0.3, -0.36]] : [[-0.34, -0.36]];
      for (const [x, z] of stacks) { gb.cyl(x, 0.2, z, 0.05, 0.07, (L ? 1.3 : 1.05) - 0.2, 10, '#5e2e22'); c.addSmoke(x, L ? 1.35 : 1.1, z, 'heavy'); }
    }
  }
  gb.cyl(0.36, 0, 0.1, 0.1, 0.12, 0.4, 10, '#4a4a4e');
  gb.glow(2.4, 1.2, 0.3, 2.0); gb.box(0.36, 0.06, 0.2, 0.08, 0.08, 0.02, '#ff9a40'); gb.noGlow();
  c.addGlow(0.36, 0.1, 0.22, 'forge');
  for (let i = 0; i < 3; i++) gb.box(-0.3 + i * 0.12, c.gy(-0.3 + i * 0.12, 0.38), 0.38, 0.1, 0.03 + i * 0.01, 0.06, '#5a5a5e');
  gb.blob(0.1, c.gy(0.1, 0.4), 0.4, 0.12, 0.05, 0.08, '#2a2826');
};

MODELS.orchard = (c, L) => {
  const { gb, rng, pal } = c;
  // rows of fruit trees, a cider mill with a press, and barrels
  house(c, { x: 0.44, z: -0.5, w: 0.62, d: 0.46, h: L ? 0.48 : 0.36, floors: L ? 2 : 1, wall: pal.wall, roof: pal.thatched ? pal.thatch : pal.roof, roofType: pal.thatched ? 'thatch' : 'gable', rh: 0.24, nFront: 2, doorX: 0, chimney: true, timber: pal.timber });
  const fruit = rng.pick(['#c8402f', '#e0b030', '#9ab830']);
  for (let row = 0; row < 4; row++) for (let i = 0; i < (row < 2 ? 3 : 5); i++) {
    const x = -0.82 + i * (row < 2 ? 0.28 : 0.38), z = -0.75 + row * 0.42;
    if (row < 2 && x > -0.05) continue;
    const y = c.gy(x, z);
    gb.cyl(x, y, z, 0.014, 0.018, 0.12, 5, '#6e5034');
    gb.blob(x, y + 0.1, z, 0.1, 0.08, 0.1, rng.pick(LEAF));
    for (let k = 0; k < 3; k++) gb.sphere(x + rng.float(-0.06, 0.06), y + 0.14 + rng.float(-0.02, 0.03), z + rng.float(-0.06, 0.06), 0.014, fruit, 0);
  }
  for (let i = 0; i < (L ? 6 : 3); i++) barrel(c, 0.2 + (i % 3) * 0.08, -0.18 + Math.floor(i / 3) * 0.08);
  gb.box(0.72, c.gy(0.72, -0.18), -0.18, 0.12, 0.14, 0.12, '#7a5a3c');
  gb.cyl(0.72, c.gy(0.72, -0.18) + 0.14, -0.18, 0.012, 0.012, 0.1, 6, '#3a2f28');
  fence(c, -0.96, -0.96, 0.96, 0.96, FENCE, { x: 0, z: 0.96, w: 0.12 });
  c.work = [-0.88, -0.88, 0.0, 0.88];
};

// A paper mill: a long mill with a water wheel, its drying lofts (louvred
// boards along the top floor, or a louvred loft along the ridge), a hipped or
// gabled roof, the stack at the back or a works stack standing free.
MODELS.papermill = (c, L) => {
  const { gb, pal } = c;
  const plan = planOf(c, 3), H = L ? 0.62 : 0.5;
  house(c, { x: -0.04, z: -0.12, w: 0.76, d: 0.48, h: H, floors: 2, wall: L ? pal.brick : pal.wall, roof: pal.slate, roofType: plan === 1 ? 'hip' : 'gable', rh: 0.22, nFront: 4, doorX: 0, chimney: false, fancy: false, lit: 0.9 });
  if (plan === 2) {
    // a louvred drying loft along the ridge, a works stack standing free
    gb.cbox(-0.04, H + 0.12, -0.12, 0.6, 0.12, 0.18, pal.wood, 0, 0.006);
    for (const s2 of [-1, 1]) for (let i = 0; i < 3; i++) gb.box(-0.04, H + 0.14 + i * 0.03, -0.12 + s2 * 0.092, 0.58, 0.008, 0.008, '#3a2f28');
    gb.gable(-0.04, H + 0.24, -0.12, 0.64, 0.22, 0.06, pal.wood, pal.slate, 0.02, false, 0.02);
    gb.cyl(-0.36, 0, -0.38, 0.05, 0.065, 0.95, 8, '#7f3f2e'); c.addSmoke(-0.36, 1.0, -0.38, 'work');
  } else chimney(c, -0.3, 0.4, 0.95, -0.28, 'work', '#7f3f2e');
  if (plan !== 2) for (let i = 0; i < 4; i++) gb.box(-0.3 + i * 0.2, H, 0.13, 0.12, 0.05, 0.015, '#e8e0cc');
  const wheel = new GeoBuilder();
  for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; wheel.boxC(Math.cos(a) * 0.15, Math.sin(a) * 0.15, 0, 0.12, 0.02, 0.07, '#6e5034', 0, 0, a + Math.PI / 2); wheel.boxC(Math.cos(a) * 0.075, Math.sin(a) * 0.075, 0, 0.15, 0.012, 0.012, '#5e432c', 0, 0, a); }
  c.spin = { geo: wheel.build(), x: 0.42, y: 0.15, z: -0.1, speed: 0.6, ry: Math.PI / 2 };
  for (let i = 0; i < 3; i++) crate(c, -0.36 + i * 0.09, 0.4, 0.9, '#e8e0cc');
  sign(c, -0.04, 0.3, 0.125, 0.24, 0.05, '#3b2f2a');
};

MODELS.musichall = (c, L) => {
  const { gb, rng, pal } = c;
  const wall = L ? '#ebe4d6' : pal.wall, trim = '#e3dccd';
  // a gaily painted hall with a lit marquee and posters
  house(c, { z: -0.12, w: 0.82, d: 0.56, h: L ? 0.7 : 0.54, floors: 2, wall, roof: pal.slate, roofType: L ? 'hip' : 'gable', rh: 0.24, nFront: 3, doorX: 0, doorW: 0.16, chimney: false, fancy: false, lit: 1 });
  gb.box(0, 0.26, 0.2, 0.6, 0.03, 0.14, '#3a2f28');
  gb.glow(2.2, 1.6, 0.6, 3.0);
  for (let i = 0; i < 9; i++) gb.sphere(-0.28 + i * 0.07, 0.285, 0.27, 0.012, '#ffe2a0', 0);
  gb.noGlow();
  gb.box(0, 0.32, 0.17, 0.5, 0.08, 0.012, rng.pick(['#7a2a5a', '#2a3a7a', '#7a2a2a']));
  gb.glow(1.8, 1.4, 0.6, 3.1); gb.box(0, 0.335, 0.18, 0.4, 0.04, 0.006, '#e0c070'); gb.noGlow();
  for (const x of [-0.36, 0.36]) gb.box(x, 0.06, 0.165, 0.1, 0.14, 0.008, rng.pick(['#d8a630', '#c8423a', '#3f6a8f']));
  if (L) { gb.cbox(0, 0.7, -0.12, 0.3, 0.12, 0.3, trim, 0, 0.01); gb.sphere(0, 0.84, -0.12, 0.14, '#5f7f86', 1, 0.7); }
  lamp(c, -0.42, 0.42, 0.3); lamp(c, 0.42, 0.42, 0.3);
};

// A red-brick engine house with big doors, its engine waiting outside and a
// tower for drying the hoses, in one of its plans: a gable roof, the tower at
// the back; a parapet with the name in a pediment, the tower on a front
// corner with a clock; a stepped gable to the street over the doors, the
// tower slim at the back; or a hipped roof, the tower over the middle with
// an open belfry for the alarm bell.
MODELS.firestation = (c, L) => {
  const { gb, pal } = c;
  const F = c.form, plan = planOf(c, 4), side = F.side;
  const wall = '#9a3a2a', H = L ? 0.6 : 0.46, trim = '#e3dccd';
  const roofType = ['gable', 'parapet', 'gable', 'hip'][plan];
  house(c, { x: -side * 0.06, z: -0.12, w: 0.7, d: 0.54, h: H, floors: 2, wall, roof: pal.slate, roofType, alongZ: plan === 2, gableFront: 'stepped', rh: plan === 2 ? 0.28 : 0.2, nFront: 3, noDoor: true, chimney: plan !== 3, fancy: false, lit: 0.9 });
  const x0 = -side * 0.06, bays = L ? [-0.24, 0, 0.24] : [-0.14, 0.14];
  entrance(c, x0 + bays[L ? 1 : 0], 0.152);
  for (const x of bays) {
    gb.box(x0 + x, 0, 0.152, 0.18, 0.22, 0.012, trim);
    gb.box(x0 + x, 0, 0.158, 0.15, 0.19, 0.012, '#c8423a');
    gb.box(x0 + x, 0.09, 0.166, 0.15, 0.008, 0.006, trim);
    if (plan === 2 || plan === 3) gb.arch(x0 + x, 0.2, 0.15, 0.08, 0.016, 8, trim);
  }
  const th = L ? 1.0 : 0.8;
  if (plan === 1) {
    gb.gable(x0, H + 0.04, 0.155, 0.36, 0.03, 0.1, trim, trim, 0.01, true);
    gb.box(x0, H - 0.02, 0.158, 0.3, 0.05, 0.012, '#2a2a30');
    gb.glow(1.8, 1.4, 0.6, 3.1); gb.box(x0, H - 0.008, 0.165, 0.24, 0.024, 0.006, GOLD); gb.noGlow();
    tower(c, 'pyramid', side * 0.38, 0.06, 0.16, th, wall, pal.slate, { clock: true });
  } else if (plan === 2) {
    tower(c, 'spire', side * 0.38, -0.3, 0.13, th, wall, pal.slate);
  } else if (plan === 3) {
    tower(c, 'belfry', x0, -0.22, 0.18, H + 0.26, wall, pal.slate, { clock: true });
  } else {
    const tx = side * 0.38, tz = -0.24;
    footing(c, tx, tz, 0.16, 0.16);
    gb.cbox(tx, 0, tz, 0.16, th, 0.16, wall, 0, 0.01);
    gb.roof(tx, th, tz, 0.2, 0.2, 0.14, 0, pal.slate);
    gb.cyl(tx, th - 0.14, tz + 0.085, 0.03, 0.03, 0.012, 8, '#d8a630', 0, Math.PI / 2);
  }
  // the engine itself, waiting outside
  const ex = x0, ez = 0.36, ey = c.gy(ex, ez);
  gb.box(ex, ey + 0.03, ez, 0.12, 0.07, 0.26, '#c8423a');
  for (const s of [-1, 1]) for (const z of [-0.08, 0.08]) gb.cyl(ex + s * 0.065, ey + 0.035, ez + z, 0.035, 0.035, 0.012, 8, '#3a2f28', 0, 0, Math.PI / 2);
  gb.cyl(ex, ey + 0.11, ez - 0.04, 0.03, 0.03, 0.08, 8, '#d8a630', 0, Math.PI / 2);
};

function tint(geo, t) {
  const c = geo.attributes.color;
  for (let i = 0; i < c.count; i++) c.setXYZ(i, c.getX(i) * (1 + t[0]), c.getY(i) * (1 + t[1]), c.getZ(i) * (1 + t[2]));
  c.needsUpdate = true;
}

// Grime: surfaces darken toward the ground, like real weathered buildings.
function weather(geo) {
  const p = geo.attributes.position, c = geo.attributes.color;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const k = y < 0 ? 0.8 : 0.8 + 0.2 * Math.min(1, y / 0.28);
    c.setXYZ(i, c.getX(i) * k, c.getY(i) * k, c.getZ(i) * k);
  }
  c.needsUpdate = true;
}

// ---------------------------------------------------------------- entry

const hasExt = (b) => !!(b.ext && (b.ext.x0 || b.ext.x1 || b.ext.z0 || b.ext.z1));

// The models drawn either way round (see buildModel): no spinning wheels,
// fountains or work areas in them, and no street corner of their own.
const MIRRORED = new Set(['builder', 'lumber', 'workshop', 'joinery', 'contractor', 'craftshouse', 'brewhouse', 'foundry', 'timberworks', 'watchhouse', 'inn', 'teagarden', 'fishmarket', 'coachinginn', 'well', 'pump', 'powerplant', 'coachstop', 'musichall', 'markethall', 'deptstore', 'arcade']);

// The part of the world a building may use, in its own local frame: its plot,
// grown or shrunk by any garden land bought from or sold to a neighbour
// (b.ext, in its own frame: x0 its -x side, x1 +x, z0 its back, z1 its front).
function plotBox(b, Ex, Ez) {
  const box = landBox(b, Ex, Ez);
  // the front may come forward into the street's verge (b.front, set by the world)
  if (b.front) box.z1 += b.front;
  return box;
}

function landBox(b, Ex, Ez) {
  if (!hasExt(b)) return { x0: -Ex, x1: Ex, z0: -Ez, z1: Ez };
  const e = b.ext;
  return { x0: -Ex - e.x0, x1: Ex + e.x1, z0: -Ez - e.z0, z1: Ez + e.z1 };
}

// A building stands on its plot exactly as the player set it down: at its
// middle, facing the way it faces (no small random turn or offset: a town
// without a grid has all the turns it needs).
export function jitterOf() { return { yaw: 0, ox: 0, oz: 0 }; }

// Outdoor area (fields, lawns, squares) as a wander area in the building's
// own frame ([x0, z0, x1, z1, its plot]: see sim/agents.js inArea), or null.
// Must match the c.work rectangles set by the models above.
export function workArea(b) {
  let r = null;
  if (BUILDINGS[b.type].fields) r = BUILDINGS[b.type].fruit ? [-0.88, -0.88, 0.0, 0.88] : [-0.96, -0.96, 0.96, -0.04];   // the trees (MODELS.orchard), or the field behind the farmyard (MODELS.farm)
  else if (b.type === 'garden' || b.type === 'playground' || b.type === 'courts') r = [-0.4, -0.4, 0.4, 0.4];
  else if (b.type === 'plaza' || b.type === 'sportsground') r = [-0.85, -0.85, 0.85, 0.85];
  if (!r) return null;
  return [r[0], r[1], r[2], r[3], ownPlot(b)];
}

export function buildModel(b, opts = {}) {
  const gb = new GeoBuilder();
  gb.vary = 0.09;
  const pal = palette(b.variant, b.look);
  const form = formOf(b.variant, pal);
  const rng = new RNG((b.variant ^ (b.level * 0x9E3779B1)) >>> 0);
  const E = b.size / 2;
  // half-extents of the plot in the model's own frame (along its street, and deep)
  const Ex = b.w / 2, Ez = b.d / 2;
  const jit = { yaw: 0, ox: 0, oz: 0 };
  const th = opts.flat ? 0 : b.a || 0, co = Math.cos(th), si = Math.sin(th);
  const cx = b.x, cz = b.z;
  const ground = opts.ground;
  const makeCtx = (gb, rng) => {
  const c = {
    gb, rng, pal, E, Ex, Ez, box: plotBox(b, Ex, Ez), boxAware: false, level: b.level, variant: b.variant, flavor: b.flavor || null, corner: b.corner || 0, sides: b.sides || 0, shutters: pal.shutters ? pal.accent : null, flowerBoxes: false,
    form, cat: BUILDINGS[b.type] ? BUILDINGS[b.type].cat : null, mainDone: false,   // its form (forms.js), and whether its main body is drawn
    houses: [],   // every house() drawn, where it stands (see annexes)
    frame: pal.frame, winH: pal.winH, arched: (pal.arched ?? pal.style === 'stone') && !(BUILDINGS[b.type].fields && !BUILDINGS[b.type].fruit),
    inWorld: !!ground,   // standing in the town (not a picture in a menu)
    smoke: [], glows: [], spin: null, work: null, fountain: null,
    spots: [],   // where a park's visitors like to stroll to (see parks.js spot)
    beyond: [],   // drawn after the fit, reaching out beyond the plot on purpose (a pier)
    season: opts.season ?? 1, seasonW: opts.seasonW || 0,
    lift: b.lift || 0,   // a gondola station standing taller (worked out by transit.js)
    cables: b.cables ? b.cables.map(a => a - th) : null,   // the headings its cables leave on, in this frame (transit.js)
    // an interchange's berths: where each is and the headings its cables leave on, in this frame (transit.js)
    berths: b.berths ? b.berths.map(B => { const dx = B.x - b.x, dz = B.z - b.z; return { x: dx * co - dz * si, z: dx * si + dz * co, cables: B.cables.map(a => a - th), tint: B.tint || null }; }) : null,
    tint: b.tint || null,   // a gondola station's line's colour, which it wears (transit.js)
    railK: b.rail ? b.rail.k : 2,
    // ground height (relative to the current frame) under local point (x, z)
    gy(x, z) {
      if (!ground) return 0;
      const e = gb.M.elements;
      const lx = e[0] * x + e[8] * z + e[12], lz = e[2] * x + e[10] * z + e[14];
      const wx = cx + lx * co + lz * si, wz = cz - lx * si + lz * co;
      return ground(wx, wz) - b.baseY - e[13];
    },
    // is local point (x, z) on another building's plot or a road (opts.taken,
    // in the town; never in a picture in a menu)? For what reaches out
    // beyond the plot, like a pier, to stop short of it.
    takenAt(x, z) {
      if (!opts.taken) return false;
      const e = gb.M.elements;
      const lx = e[0] * x + e[8] * z + e[12], lz = e[2] * x + e[10] * z + e[14];
      return opts.taken(cx + lx * co + lz * si, cz - lx * si + lz * co, b.id);
    },
    // the surface of the water (as drawn), relative to the current frame
    waterY() { return ground ? CONFIG.WATER_LEVEL - 0.02 - b.baseY - gb.M.elements[13] : -0.03; },
    addSmoke(x, y, z, kind = 'home') { const v = new THREE.Vector3(x, y, z).applyMatrix4(gb.M); c.smoke.push({ x: v.x, y: v.y, z: v.z, kind }); },
    addGlow(x, y, z, kind = 'lamp') { const v = new THREE.Vector3(x, y, z).applyMatrix4(gb.M); c.glows.push({ x: v.x, y: v.y, z: v.z, kind }); },
  };
  return c;
  };
  const c = makeCtx(gb, rng);
  // on a plot bigger than its own footprint the building keeps its usual size
  // and an annex takes the rest (see annexPlan)
  const def = BUILDINGS[b.type];
  const annex = def && !opts.noAnnex ? annexPlan(def, b, Ex, Ez, c.box) : null;
  if (annex) { c.box = annex.main; c.Ex = annex.Ex; c.Ez = annex.Ez; }
  // a building whose plot has grown but which isn't built across it yet
  // keeps the small turn and offset it had on its own plot (the grown plot
  // as a whole has none), so taking land doesn't shift it
  const own = annex && b.spare && (def.merged ? 2 : def.size ** 2) === 1 && !opts.flat ? jitterOf({ type: b.type, variant: b.variant, size: 1 }) : null;
  const fit = own || jit;
  // works and yards that aren't the same either way round are laid out one
  // way or the other (their form's side), unless the plot has grown (its
  // annex keeps to its own side)
  const flip = MIRRORED.has(b.type) && form.side < 0 && !annex;
  if (flip) gb.mirrorX();
  (MODELS[b.type] || PARK_MODELS[b.type] || CIVIC_MODELS[b.type])(c, b.level);
  if (flip) gb.pop();
  let geo = gb.build();
  if (geo) { weather(geo); tint(geo, pal.tint); }
  // Never poke into the neighbours: shrink the model sideways if, after its
  // small random offset and turn, any part would leave its own plot.
  // Models that don't lay themselves out in c.box are centred in it.
  if (geo) {
    geo.computeBoundingBox();
    const bb = geo.boundingBox, B = c.box;
    const bcx = (B.x0 + B.x1) / 2, bcz = (B.z0 + B.z1) / 2, hx = (B.x1 - B.x0) / 2, hz = (B.z1 - B.z0) / 2;
    const tx = c.boxAware ? 0 : bcx, tz = c.boxAware ? 0 : bcz;
    const ex = Math.max(bcx - bb.min.x - tx, bb.max.x + tx - bcx), ez = Math.max(bcz - bb.min.z - tz, bb.max.z + tz - bcz);
    const ya = Math.abs(fit.yaw), cy = Math.cos(ya), sy = Math.sin(ya);
    const m = 0.02 + (fit.m ?? Math.abs(fit.ox) + Math.abs(fit.oz));
    // (it turns about the middle of the plot, so the middle of a box that has
    // come forward into the street turns with it)
    const ys = Math.sin(fit.yaw), mx = Math.abs(bcx * (cy - 1) + bcz * ys), mz = Math.abs(bcz * (cy - 1) - bcx * ys);
    const k = Math.min(1, (hx - m - mx) / (ex * cy + ez * sy), (hz - m - mz) / (ex * sy + ez * cy));
    if (opts.fit) Object.assign(opts.fit, { k, ex, ez, hx, hz, form: c.form });   // (for tests: how much it was shrunk to fit, and its form)
    if (k < 1 || tx || tz) {
      geo.translate(tx - bcx, 0, tz - bcz);
      geo.scale(k, 1, k);
      geo.translate(bcx, 0, bcz);
      geo.computeBoundingSphere();
      const sc = (p) => { p.x = (p.x + tx - bcx) * k + bcx; p.z = (p.z + tz - bcz) * k + bcz; };
      c.smoke.forEach(sc); c.glows.forEach(sc); c.spots.forEach(sc);
      if (c.fountain) { const p = { x: c.fountain[0], z: c.fountain[2] }; sc(p); c.fountain[0] = p.x; c.fountain[2] = p.z; }
      if (c.spin) { sc(c.spin); c.spin.geo.scale(k, k, k); }
      if (c.doorAt) sc(c.doorAt);
      if (c.stair) c.stair.forEach(sc);
      if (c.deck) sc(c.deck);
      if (c.seats) c.seats.forEach(sc);
      if (c.stand) c.stand.forEach(sc);
    }
  }
  if (own && geo) {
    // turned about the middle of its own footprint, and nudged as it was
    const { x: px, z: pz } = annex.pc;
    const ox = own.ox, oz = own.oz, cy = Math.cos(own.yaw), sy = Math.sin(own.yaw);
    geo.translate(-px, 0, -pz); geo.rotateY(own.yaw); geo.translate(px + ox, 0, pz + oz); geo.computeBoundingSphere();
    const mv = (p) => { const x = p.x - px, z = p.z - pz; p.x = px + ox + x * cy + z * sy; p.z = pz + oz - x * sy + z * cy; };
    c.smoke.forEach(mv); c.glows.forEach(mv); c.spots.forEach(mv);
    if (c.fountain) { const p = { x: c.fountain[0], z: c.fountain[2] }; mv(p); c.fountain[0] = p.x; c.fountain[2] = p.z; }
    if (c.spin) { mv(c.spin); c.spin.ry = (c.spin.ry || 0) + own.yaw; }
    if (c.doorAt) { mv(c.doorAt); const d = c.doorAt, dx = d.dx; d.dx = dx * cy + d.dz * sy; d.dz = -dx * sy + d.dz * cy; }
  }
  if (annex && geo) {
    geo.computeBoundingBox();
    const gb2 = new GeoBuilder();
    gb2.vary = 0.09;
    const c2 = makeCtx(gb2, new RNG((b.variant * 2654435761 + 7) >>> 0));
    c2.smoke = c.smoke; c2.glows = c.glows; c2.spots = c.spots; c2.mainDone = true;
    c2.doorAt = c.doorAt || { x: 0, y: 0, z: 0, dx: 0, dz: 1 };   // the building's own door stays the way in
    // the building's main house (the biggest it drew), for an extension to join on to
    const main = c.houses.reduce((m, hs) => (!m || (hs.x1 - hs.x0) * (hs.z1 - hs.z0) > (m.x1 - m.x0) * (m.z1 - m.z0) ? hs : m), null);
    for (const A of annex.areas) buildAnnex(c2, def, A, geo.boundingBox.max.y, !!b.spare, main);
    const g2 = gb2.build();
    if (g2) { weather(g2); tint(g2, pal.tint); geo = mergeGeometries([geo, g2], false); geo.computeBoundingSphere(); }
  }
  // what reaches out beyond the plot on purpose (a harbour's pier over the
  // water) is drawn after the fit, so it doesn't shrink the building
  if (c.beyond.length && geo) {
    const gb3 = new GeoBuilder();
    gb3.vary = 0.09;
    const c3 = makeCtx(gb3, new RNG((b.variant * 2654435761 + 13) >>> 0));
    c3.smoke = c.smoke; c3.glows = c.glows; c3.spots = c.spots; c3.mainDone = true;
    for (const draw of c.beyond) draw(c3);
    const g3 = gb3.build();
    if (g3) { weather(g3); tint(g3, pal.tint); geo = mergeGeometries([geo, g3], false); geo.computeBoundingSphere(); }
  }
  // its real footprint: the corners of all it stands on, in world space
  let foot = null;
  if (geo) {
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    foot = [[bb.min.x, bb.min.z], [bb.max.x, bb.min.z], [bb.max.x, bb.max.z], [bb.min.x, bb.max.z]].map(([lx, lz]) => [cx + lx * co + lz * si, cz - lx * si + lz * co]);
  }
  return { geo, smoke: c.smoke, glows: c.glows, spin: c.spin, work: c.work, fountain: c.fountain, jitter: jit, door: c.doorAt || null, open: !!c.openAir, houses: c.houses, spots: c.spots, foot, stair: c.stair || null, deck: c.deck || null, seats: c.seats || null, stand: c.stand || null };
}

// A home, shop or service built out across the land it took: the house itself
// goes on. Beside it, an extension on the same front line with the same
// walls, eaves, roof and timbering, its ridge running on a little lower;
// behind it, a back wing a storey lower with its ridge running back (an L, or
// with both on a 2×2 estate, a U). No second door or chimney. Returns false
// when there's no room, and a free-standing wing is built instead.
function extendHouse(c, def, A, m) {
  // (in the main house's own roof, as it was drawn in its form)
  const style = { wall: m.wall, roof: m.roof, timber: m.timber, plinth: m.plinth, chimney: false, form: false };
  const roofType = ['thatch', 'hip', 'flat', 'parapet', 'mansard', 'gambrel'].includes(m.roofType) ? m.roofType : 'gable';
  if (A.where === 'beside') {
    const right = (A.x0 + A.x1) / 2 > (m.x0 + m.x1) / 2;
    const near = right ? m.x1 - 0.01 : m.x0 + 0.01, far = right ? A.x1 - 0.1 : A.x0 + 0.1;
    const w = Math.abs(far - near), d = m.z1 - m.z0 - 0.03;
    if (w < 0.25 || d < 0.2) return false;
    house(c, {
      ...style, x: (near + far) / 2, z: (m.z0 + m.z1) / 2 - 0.015, w, d, h: m.h, floors: m.floors, roofType, rh: m.rh * 0.88,
      alongZ: !m.ridgeX, noDoor: def.cat !== 'commercial', shopWindow: def.cat === 'commercial',
    });
    return true;
  }
  const near = m.z0 + 0.01, far = A.z0 + 0.1, d = near - far;
  const w = Math.min(m.x1 - m.x0, A.x1 - A.x0 - 0.16) * 0.62;
  if (d < 0.22 || w < 0.22) return false;
  const floors = Math.max(1, m.floors - 1);
  house(c, {
    ...style, x: (m.x0 + m.x1) / 2, z: (near + far) / 2, w, d, h: m.h * floors / m.floors, floors,
    roofType: roofType === 'thatch' ? 'thatch' : 'gable', rh: m.rh * 0.8, alongZ: true, noDoor: true,
  });
  return true;
}

// --------------------------------------------------------------- annexes
// A plot that has grown past the building's own footprint (a 1×1 building on
// a 2×1 or 1×2 plot, anything on a 2×2 estate) keeps the building at its
// usual size at the front, on one side, and puts an annex in the same style on
// the new land: a wing for homes, shops and services, a work shed with goods
// for industry, a tank or transformer house for utilities, more garden for
// parks. Returns null when the plot is the building's usual size.
function annexPlan(def, b, Ex, Ez, B) {
  const bw = def.merged ? 2 : def.size, bd = def.merged ? 1 : def.size;
  if (4 * Ex * Ez <= bw * bd + 0.01) return null;
  // the base footprint as it lies on this plot (a row building may be turned)
  const [lw, ld] = Ez > Ex + 1e-6 && bw !== bd ? [bd, bw] : [bw, bd];
  const extraW = 2 * Ex - lw, extraD = 2 * Ez - ld;
  if (extraW < 0.5 && extraD < 0.5) return null;
  // which end the building itself keeps: the end it stood at when the land
  // was taken (b.spare), so it doesn't move; older saves go by its seed
  const sp = b.spare && b.spare.sx != null ? b.spare : null;
  const side = sp && sp.sx ? sp.sx : (b.variant >>> 4) & 1 ? 1 : -1;
  const main = { x0: B.x0, x1: B.x1, z0: B.z0, z1: B.z1 };
  const areas = [];
  if (extraW >= 0.5) {
    if (side < 0) { main.x1 = B.x1 - extraW; areas.push({ x0: main.x1, x1: B.x1, z0: B.z0, z1: B.z1, where: 'beside' }); }
    else { main.x0 = B.x0 + extraW; areas.push({ x0: B.x0, x1: main.x0, z0: B.z0, z1: B.z1, where: 'beside' }); }
  }
  if (extraD >= 0.5) {
    // land behind; or, the rare time it was taken in front, the land in front
    if (sp && sp.sz < 0) { main.z1 = B.z0 + ld; areas.push({ x0: main.x0, x1: main.x1, z0: main.z1, z1: B.z1, where: 'beside' }); }
    else { main.z0 = B.z0 + extraD; areas.push({ x0: main.x0, x1: main.x1, z0: B.z0, z1: main.z0, where: 'behind' }); }
  }
  // the building itself may come forward further than the plot as a whole
  // (b.ownFront: its own part has the street in front, the rest not)
  const fwd = sp && sp.sz >= 0 ? b.ownFront ?? b.front ?? 0 : 0;
  if (sp && sp.sz >= 0) main.z1 += fwd - (b.front || 0);
  // the middle of the building's own footprint, as it was on its own plot
  const pc = { x: (main.x0 + main.x1) / 2, z: (main.z0 + main.z1 - (sp && sp.sz < 0 ? 0 : sp ? fwd : b.front || 0)) / 2 };
  return { main, areas, Ex: lw / 2, Ez: ld / 2, pc };
}

// One annex in area A (local frame, street side at +z). `top` is how tall the
// main building stands, so a wing can match it a storey lower. spare: land
// taken but not built on yet, kept as a garden. main: the building's main
// house, so a home, shop or service is extended rather than given a second
// building (see extendHouse).
function buildAnnex(c, def, A, top, spare = false, main = null) {
  if (!spare && main && !def.park && def.cat !== 'industry' && def.cat !== 'utilities' && extendHouse(c, def, A, main)) return;
  const { gb, rng, pal } = c;
  const aw = A.x1 - A.x0, ad = A.z1 - A.z0, cx = (A.x0 + A.x1) / 2;
  const beside = A.where === 'beside';
  const L = def.levels[c.level] || def.levels[0];
  if (def.park || spare) {
    // more garden: a gravel walk, trees, beds and a bench, inside a hedge
    // (a park's following the seasons)
    hedge(c, cx, A.z0 + 0.06, aw - 0.12, 0.05);
    gb.box(cx, c.gy(cx, (A.z0 + A.z1) / 2) - 0.008, (A.z0 + A.z1) / 2, 0.09, 0.012, ad - 0.2, '#c8b894');
    for (const sx of [-1, 1]) {
      if (def.park) parkTree(c, cx + sx * aw * 0.28, A.z0 + ad * 0.3, rng.float(0.9, 1.2), 'round');
      else smallTree(c, cx + sx * aw * 0.28, A.z0 + ad * 0.3, rng.float(0.9, 1.2));
      if (def.park) blooms(c, cx + sx * aw * 0.25, A.z0 + ad * 0.72, rng.int(5, 8), 0.08);
      else flowers(c, cx + sx * aw * 0.25, A.z0 + ad * 0.72, rng.int(5, 8), 0.08);
    }
    bench(c, cx + aw * 0.16, (A.z0 + A.z1) / 2, -Math.PI / 2);
    if (def.park) spot(c, cx, (A.z0 + A.z1) / 2);
    return;
  }
  if (def.cat === 'industry') {
    // a work shed of planks with a big door, and goods stacked in the yard
    const w = Math.min(0.78, aw - 0.24), d = Math.min(0.48, ad - 0.36);
    if (w < 0.25 || d < 0.2) return;
    const z = beside ? A.z1 - 0.3 - d / 2 : A.z0 + 0.1 + d / 2;
    house(c, { x: cx, z, w, d, h: 0.3, floors: 1, wall: pal.wood, roof: pal.slate, roofType: 'gable', rh: 0.14, chimney: false, noDoor: true, noBack: true, fancy: false, nFront: 2, lit: 0.5 });
    gb.box(cx, 0, z + d / 2 + 0.006, Math.min(0.22, w * 0.4), 0.21, 0.012, '#4e3828');
    const yz = z + d / 2 + 0.11;
    if (yz < A.z1 - 0.04) {
      crate(c, cx - w * 0.38, yz); crate(c, cx - w * 0.38 + 0.07, yz + 0.02, 0.9); barrel(c, cx + w * 0.36, yz);
      logs(c, cx + w * 0.12, yz + 0.03, 2, 0);
    }
    return;
  }
  if (def.cat === 'utilities') {
    if (L.kw) {
      // a transformer house with insulators, behind a low fence
      const z = (A.z0 + A.z1) / 2;
      gb.cbox(cx, 0, z, 0.3, 0.26, 0.24, pal.brick, 0, 0.012);
      gb.hip(cx, 0.26, z, 0.3, 0.24, 0.1, pal.slate, 0.03);
      for (const sx of [-1, 0, 1]) { gb.cyl(cx + sx * 0.08, 0.36, z, 0.012, 0.016, 0.06, 6, '#e8e2d4'); }
      fence(c, cx - 0.24, z - 0.2, cx + 0.24, z + 0.2, '#6a6a70', { x: cx, z: z + 0.2, w: 0.06 });
    } else {
      // a round water tank on legs and a little pump hut
      const z = (A.z0 + A.z1) / 2;
      for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) gb.box(cx + lx * 0.09, 0, z + lz * 0.09, 0.025, 0.3, 0.025, '#5e432c');
      gb.cyl(cx, 0.3, z, 0.15, 0.15, 0.2, 12, pal.wood);
      gb.cone(cx, 0.5, z, 0.16, 0.08, 12, pal.slate);
      house(c, { x: cx + Math.min(0.28, aw * 0.3), z: z + 0.16, w: 0.2, d: 0.18, h: 0.2, floors: 1, wall: pal.stoneWall, roof: pal.slate, roofType: 'gable', rh: 0.1, chimney: false, fancy: false, nFront: 1 });
    }
    return;
  }
  // homes, shops and services: a wing in the same materials, a storey lower
  // than the building if it's tall, level with the street front when it's
  // beside the building and tucked up behind it otherwise
  const floors = top > 0.75 ? 2 : 1;
  const w = Math.min(0.86, aw - 0.24), d = Math.min(beside ? 0.5 : 0.54, ad - 0.3);
  if (w < 0.25 || d < 0.2) return;
  const z = beside ? A.z1 - 0.22 - d / 2 : A.z1 - 0.1 - d / 2;
  const thatch = pal.thatched && floors === 1;
  house(c, {
    x: cx, z, w, d, h: floors * 0.27, floors, wall: pal.wall, roof: thatch ? pal.thatch : pal.roof,
    roofType: thatch ? 'thatch' : pal.hip ? 'hip' : 'gable', rh: 0.2, timber: pal.timber,
    chimney: def.cat === 'residential' && rng.chance(0.6), noDoor: !beside,
    shopWindow: def.cat === 'commercial' && beside, plinth: def.cat === 'services' ? STONE : null,
  });
  if (beside && def.cat === 'residential') {
    const fz = z + d / 2 + 0.1;
    if (fz < A.z1 - 0.04) { bush(c, cx - w * 0.3, fz, 0.8); flowers(c, cx + w * 0.25, fz, 5, 0.06); }
  } else if (!beside) {
    const gz = A.z0 + 0.12;
    if (gz < z - d / 2 - 0.08) { smallTree(c, cx - aw * 0.3, gz + 0.02, 0.9); bench(c, cx + aw * 0.15, gz, 0); }
  }
}

