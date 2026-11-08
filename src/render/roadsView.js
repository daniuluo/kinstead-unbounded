// Road surfaces and road furniture: crisp road surfaces with edging stones,
// door paths, bridges, street lamps, power lines and railway track, all
// following the curves of the roads and track as they were laid (see
// world/net.js and world/streets.js). (A soft shoulder under each road is
// painted into the terrain.)

import * as THREE from 'three';
import { MAT } from './materials.js';
import { GeoBuilder } from './geo.js';
import { hash2 } from '../util/rng.js';
import { HALF, RAIL_HALF, bridgeDeckY, isOpen } from '../world/world.js';
import { primsIn, fieldAt, BAND, plainLamps, dressSpots, poleSpots } from '../world/streets.js';
import { pointAt } from '../world/geom.js';
import { heightOn, wetOn } from '../world/net.js';
import { BUILDINGS } from '../defs.js';
import { CONFIG } from '../config.js';

// Road surface colours per road level, with a band of kerb / edging stones
// on cobbled and paved streets.
const SURF = [null, new THREE.Color('#a3835a'), new THREE.Color('#9a9488'), new THREE.Color('#5f5d5a')];
const KERB = [null, null, new THREE.Color('#bbb3a2'), new THREE.Color('#cfc9bc')];

export class RoadsView {
  constructor(world, scene) {
    this.world = world;
    this.scene = scene;
    this.props = new THREE.Mesh(new THREE.BufferGeometry(), MAT.building);
    this.props.castShadow = true;
    this.props.receiveShadow = true;
    scene.add(this.props);
    this.surface = new THREE.Mesh(new THREE.BufferGeometry(), MAT.road);
    this.surface.receiveShadow = true;
    scene.add(this.surface);
    // the paths from front doors to the street, kept apart so a building
    // changing redraws just them (see rebuildDoors)
    this.doors = new THREE.Mesh(new THREE.BufferGeometry(), MAT.road);
    this.doors.receiveShadow = true;
    scene.add(this.doors);
    this.lamps = [];
    // street lamps are electric: lit(x, z) says whether one has power
    this.lit = () => false;
    this.season = 1;
    this.seasonW = 0;
    this.fountains = 0;
    this.rebuild();
  }

  rebuild() {
    const w = this.world, t = w.terrain;
    const gb = new GeoBuilder();
    this.lamps = [];
    this.darkLamps = 0;
    this.poles = 0;
    for (const e of w.roads.edges.values()) this._bridges(gb, e);
    for (const l of plainLamps(w)) this._lamp(gb, l.x, t.heightAt(l.x, l.z), l.z);
    // lamp-lit streets and planted medians (their trees and hedges grow in
    // NatureView)
    const dressed = dressSpots(w);
    for (const l of dressed.lamps) this._lamp(gb, l.x, t.heightAt(l.x, l.z), l.z);
    for (const m of dressed.medians) this._median(gb, m);
    for (const e of w.rails.edges.values()) this._rail(gb, e);
    this.wired = this._wired();
    if (this.wired) this._powerLines(gb);
    const pg = gb.build();
    this.props.geometry.dispose();
    this.props.geometry = pg || new THREE.BufferGeometry();
    this.surface.geometry.dispose();
    this.surface.geometry = this._surfaces();
    this.rebuildDoors();
  }

  // Power lines go up once the town has a working generator.
  _wired() { return [...this.world.buildings.values()].some(b => BUILDINGS[b.type].generator && isOpen(b)); }

  // After a building has come, gone or changed: does more than its door path
  // need redrawing? Dressed streets and lamps leave gaps at doors, and the
  // first (or last) working generator puts up (or takes down) the power lines.
  needsRebuild() {
    for (const e of this.world.roads.edges.values()) if (e.dress || e.level >= 2) return true;
    return this._wired() !== this.wired;
  }

  setSeason(s, sw = 0) { this.season = s; this.seasonW = sw; return false; }

  rebuildDoors() {
    const pos = [], col = [];
    this._doorPaths(pos, col);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    this.doors.geometry.dispose();
    this.doors.geometry = g;
  }

  // The road surface, laid from the field (world/streets.js) a unit square
  // at a time over every square a road reaches, in cells a sixteenth across.
  // The field is a distance, so a cell whose corners are all further than its
  // half-diagonal off the road (or onto it) is wholly off (or on). Where the
  // road's edge crosses a cell it is cut in two along the diagonal the edge
  // runs nearer, each half clipped to the roadway and to the band of edging
  // stones along its edge; where the edge curves within it, it is split in
  // four first. Over water, and up the ramps to a bridge, the bridge's deck
  // is the road (see _bridges).
  _surfaces() {
    const w = this.world, t = w.terrain;
    const pos = [], col = [];
    const c = new THREE.Color(), kc = new THREE.Color();
    // the ground the road is laid on (null where a bridge or its ramp is)
    const height = (x, z) => {
      if (w.waterAt(x, z)) return null;
      if (w.roadHeight(x, z) != null) return null;
      return t.heightAt(x, z) + 0.018;
    };
    const cell = (p, color) => {
      const h = p.map(([x, z]) => height(x, z));
      if (h.some(v => v == null)) return;
      let area = 0;
      for (let i = 0; i < 4; i++) { const a = p[i], b = p[(i + 1) & 3]; area += a[0] * b[1] - b[0] * a[1]; }
      for (const k of area < 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]) { pos.push(p[k][0], h[k], p[k][1]); col.push(color.r, color.g, color.b); }
    };
    const G = 16, gs = 1 / G, F = new Float32Array((G + 1) * (G + 1)), REACH = 0.09;
    const at = (i, j) => F[j * (G + 1) + i];
    const clip = (poly, th, above) => {
      const out = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const ia = above ? a[2] >= th : a[2] <= th, ib = above ? b[2] >= th : b[2] <= th;
        if (ia) out.push(a);
        if (ia !== ib) { const k = (th - a[2]) / (b[2] - a[2]); out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, th]); }
      }
      return out;
    };
    const fan = (poly, color) => {
      if (poly.length < 3) return;
      const h = poly.map(([px, pz]) => height(px, pz));
      if (h.some(v => v == null)) return;
      for (let i = 1; i + 1 < poly.length; i++) {
        const a = poly[0], b = poly[i], d = poly[i + 1];
        const turn = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
        const vs = turn < 0 ? [[a, h[0]], [b, h[i]], [d, h[i + 1]]] : [[a, h[0]], [d, h[i + 1]], [b, h[i]]];
        for (const [p, y] of vs) { pos.push(p[0], y, p[1]); col.push(color.r, color.g, color.b); }
      }
    };
    const clipCell = (x, z, i0, j0, i1, j1, kb) => {
      const f00 = at(i0, j0), f10 = at(i1, j0), f01 = at(i0, j1), f11 = at(i1, j1);
      if (f00 > 0 && f10 > 0 && f01 > 0 && f11 > 0) return;
      const x0 = x + i0 * gs, z0 = z + j0 * gs, x1 = x + i1 * gs, z1 = z + j1 * gs;
      const halves = Math.abs(f00 - f11) < Math.abs(f10 - f01)
        ? [[[x0, z0, f00], [x1, z0, f10], [x1, z1, f11]], [[x0, z0, f00], [x1, z1, f11], [x0, z1, f01]]]
        : [[[x0, z0, f00], [x1, z0, f10], [x0, z1, f01]], [[x1, z0, f10], [x1, z1, f11], [x0, z1, f01]]];
      for (const tr of halves) {
        fan(clip(tr, -kb, false), c);
        if (kb) fan(clip(clip(tr, 0, false), -kb, true), kc);
      }
    };
    const square = (x, z) => {
      const prims = primsIn(w, [x, z, x + 1, z + 1]);
      if (!prims.length) return;
      const put = (i, j) => { F[j * (G + 1) + i] = fieldAt(prims, x + i * gs, z + j * gs)[0]; };
      for (let j = 0; j <= G; j += 2) for (let i = 0; i <= G; i += 2) put(i, j);
      for (let J = 0; J < G; J += 2) for (let I = 0; I < G; I += 2) {
        const c00 = at(I, J), c20 = at(I + 2, J), c02 = at(I, J + 2), c22 = at(I + 2, J + 2);
        if (Math.min(c00, c20, c02, c22) > REACH) continue;
        const L = fieldAt(prims, x + (I + 1) * gs, z + (J + 1) * gs)[1];
        if (!L) continue;
        const kb = KERB[L] ? BAND : 0, n = hash2(x * G + I + 1, z * G + J + 1, 3) - 0.5;
        c.copy(SURF[L]).multiplyScalar(1 + n * (L === 2 ? 0.16 : 0.08));
        if (kb) kc.copy(KERB[L]).multiplyScalar(1 + n * 0.08);
        const solid = () => cell([[x + I * gs, z + J * gs], [x + I * gs, z + (J + 2) * gs], [x + (I + 2) * gs, z + (J + 2) * gs], [x + (I + 2) * gs, z + J * gs]], c);
        if (Math.max(c00, c20, c02, c22) < -kb - REACH) { solid(); continue; }
        put(I + 1, J); put(I, J + 1); put(I + 1, J + 1); put(I + 2, J + 1); put(I + 1, J + 2);
        let lo = 9, hi = -9;
        for (let j = J; j <= J + 2; j++) for (let i = I; i <= I + 2; i++) { const f = at(i, j); if (f < lo) lo = f; if (f > hi) hi = f; }
        if (lo > 0) continue;
        if (hi <= -kb) { solid(); continue; }
        const flat = Math.abs(at(I + 1, J) - (c00 + c20) / 2) < 0.002 && Math.abs(at(I + 1, J + 2) - (c02 + c22) / 2) < 0.002
          && Math.abs(at(I, J + 1) - (c00 + c02) / 2) < 0.002 && Math.abs(at(I + 2, J + 1) - (c20 + c22) / 2) < 0.002
          && Math.abs(at(I + 1, J + 1) - (c00 + c20 + c02 + c22) / 4) < 0.002;
        if (flat) { clipCell(x, z, I, J, I + 2, J + 2, kb); continue; }
        for (let j = J; j < J + 2; j++) for (let i = I; i < I + 2; i++) clipCell(x, z, i, j, i + 1, j + 1, kb);
      }
    };
    for (const k of roadSquares(w)) square(k % 65536, Math.floor(k / 65536));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }

  // Once the town makes electricity, poles and wires follow the streets: a
  // pole every couple of units along each road on one verge, wired to the
  // next along it. Streets whose lines have been buried have neither.
  _powerLines(gb) {
    const w = this.world, t = w.terrain, H = 0.5;
    const spots = poleSpots(w);
    const top = (p) => [p.x, t.heightAt(p.x, p.z) + H - 0.05, p.z];
    for (const p of spots) {
      const [px, py, pz] = top(p), g = py - H + 0.05;
      const e = w.roads.edges.get(p.e), q = pointAt(e.pts, e.cum, p.s), ry = Math.atan2(q[3], q[4]) + Math.PI / 2;
      gb.cyl(px, g - 0.02, pz, 0.011, 0.015, H + 0.02, 6, '#5e4630');
      this.poles++;
      gb.box(px, g + H - 0.06, pz, 0.15, 0.013, 0.015, '#5e4630', ry);
      if (p.next < 0) continue;
      const [qx, qy, qz] = top(spots[p.next]);
      const flat = Math.hypot(qx - px, qz - pz), len = Math.hypot(flat, qy - py), mx = (px + qx) / 2, my = (py + qy) / 2 - 0.02, mz = (pz + qz) / 2;
      const wy = Math.atan2(qx - px, qz - pz), ox = Math.cos(wy) * 0.045, oz = -Math.sin(wy) * 0.045;
      for (const s of [-1, 1]) gb.boxC(mx + ox * s, my, mz + oz * s, 0.005, 0.005, len, '#2a2622', -Math.atan2(qy - py, flat), wy);
    }
  }

  // A planted median down the middle of a paved street: a low strip of
  // edging stones filled with soil and grass, in short pieces that follow
  // the ground and the curve, narrowed to a nose at each end.
  _median(gb, m) {
    const t = this.world.terrain, P = m.pts;
    for (let k = 0; k + 1 < P.length; k++) {
      const [ax, az] = P[k], [bx, bz] = P[k + 1], mx = (ax + bx) / 2, mz = (az + bz) / 2, len = Math.hypot(bx - ax, bz - az) + 0.004;
      const ry = Math.atan2(bx - ax, bz - az), y = t.heightAt(mx, mz) + 0.012;
      const wide = k === 0 || k === P.length - 2 ? 0.075 : 0.11;
      gb.box(mx, y, mz, wide, 0.03, len, '#cfc9bc', ry);
      gb.box(mx, y, mz, wide - 0.03, 0.036, len, k % 2 ? '#6c8744' : '#66803f', ry);
    }
  }

  _lantern(gb, x, y, z, ground) {
    const on = this.lit(x, z);
    gb.box(x, y + 0.035, z, 0.004, 0.012, 0.004, '#2f2c2a');
    if (on) gb.glow(2.2, 1.6, 0.8, 3.0);
    gb.box(x, y - 0.005, z, 0.03, 0.04, 0.03, on ? '#ffe2a0' : '#9a958a');
    gb.noGlow();
    gb.cone(x, y + 0.035, z, 0.026, 0.02, 4, '#2f2c2a', Math.PI / 4);
    if (on) this.lamps.push({ x, y: y + 0.015, z, ground }); else this.darkLamps++;
  }

  _lamp(gb, x, y, z) {
    const on = this.lit(x, z);
    gb.cyl(x, y - 0.02, z, 0.012, 0.017, 0.36, 6, '#2f2c2a');
    gb.cbox(x, y - 0.02, z, 0.035, 0.05, 0.035, '#2f2c2a', 0, 0.006);
    if (on) gb.glow(2.2, 1.6, 0.8, 3.0);
    gb.box(x, y + 0.34, z, 0.042, 0.052, 0.042, on ? '#ffe2a0' : '#9a958a');
    gb.noGlow();
    gb.cone(x, y + 0.392, z, 0.037, 0.036, 4, '#2f2c2a', Math.PI / 4);
    if (on) this.lamps.push({ x, y: y + 0.366, z, ground: y }); else this.darkLamps++;
  }

  // Where a road crosses water (and up the ramps from each bank): a deck of
  // planks (stone flags on a cobbled or paved road) following its curve,
  // railings either side, piers down into the water, and an abutment where
  // it meets the bank.
  _bridges(gb, e) {
    const w = this.world, t = w.terrain, hy = w._heights(e);
    const L = e.level, step = 0.125, half = Math.max(0.3, HALF[L] + 0.12);
    const wood = L >= 2 ? '#8a8276' : '#7d5b3b', wood2 = L >= 2 ? '#7a7368' : '#6e4e31', stone = '#8f877a';
    const off = (s) => { const p = pointAt(e.pts, e.cum, s); return Math.abs(heightOn(hy, s) - (t.heightAt(p[0], p[1]) + 0.012)) > 0.004 || wetOn(hy, s); };
    let any = false;
    for (let s = 0; s < e.len; s += step) if (off(s) || off(Math.min(e.len, s + step))) { any = true; break; }
    if (!any) return;
    let k = 0;
    for (let s = 0; s < e.len - 1e-6; s += step, k++) {
      const s1 = Math.min(e.len, s + step);
      if (!off(s) && !off(s1)) continue;
      const a = pointAt(e.pts, e.cum, s), b = pointAt(e.pts, e.cum, s1), y0 = heightOn(hy, s), y1 = heightOn(hy, s1);
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, my = (y0 + y1) / 2, len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const ry = Math.atan2(b[0] - a[0], b[1] - a[1]), pitch = -Math.atan2(y1 - y0, len);
      gb.push(mx, 0, mz, ry);
      gb.boxC(0, my - 0.025, 0, half * 2 + 0.04, 0.05, Math.hypot(len, y1 - y0) + 0.012, k % 2 ? wood : wood2, pitch);
      const wet = wetOn(hy, (s + s1) / 2);
      if (wet) {
        gb.box(0, my - 0.075, 0, half * 2, 0.03, len + 0.01, '#4a3a2c');
        for (const sd of [-1, 1]) {
          if (k % 3 === 0) gb.box(sd * (half + 0.01), my, 0, 0.028, 0.13, 0.028, '#4e3a2a');
          gb.boxC(sd * (half + 0.01), my + 0.11, 0, 0.022, 0.022, len + 0.01, '#5e432c', pitch);
        }
        if (k % 4 === 0) for (const sd of [-1, 1]) gb.cyl(sd * (half - 0.05), -0.9, 0, 0.03, 0.035, my - 0.05 + 0.9, 7, '#3f3126');
      } else {
        // the ramp: on an embankment of stone, to the ground
        const g = t.heightAt(mx, mz), lo = Math.min(g, my) - 0.04;
        if (my - 0.05 - lo > 0.015) gb.box(0, lo, 0, half * 2 - 0.04, my - 0.05 - lo, len + 0.004, stone);
        if (L >= 2) for (const sd of [-1, 1]) gb.boxC(sd * (half + 0.01), my + 0.01, 0, 0.03, 0.03, len + 0.01, '#9a9284', pitch);
      }
      gb.pop();
    }
    void CONFIG;
  }

  // A little path from every front door straight out to the street: stone
  // flags beside cobbled and paved streets, a worn earth path by dirt roads.
  // It runs until it meets the roadway and flares out in a curve where it
  // joins it.
  _doorPaths(pos, col) {
    const w = this.world, t = w.terrain;
    const c = new THREE.Color();
    const R = 0.06;
    const flare = (d) => (d >= R ? 0 : d <= 0 ? R : R - Math.sqrt(R * R - (R - d) * (R - d)));
    const quad = (ax, az, bx, bz, half0, half1, nx, nz, color) => {
      const p = [[ax - nx * half0, az - nz * half0], [ax + nx * half0, az + nz * half0], [bx + nx * half1, bz + nz * half1], [bx - nx * half1, bz - nz * half1]];
      const h = p.map(([x, z]) => t.heightAt(x, z) + 0.016);
      const cross = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]);
      const order = cross > 0 ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
      for (const k of order) { pos.push(p[k][0], h[k], p[k][1]); col.push(color.r, color.g, color.b); }
    };
    for (const b of w.buildings.values()) {
      const d = b.door;
      if (!d || !b.access || BUILDINGS[b.type].park) continue;
      const e = w.roads.edges.get(b.access.e);
      if (!e || w.waterAt(b.access.x, b.access.z)) continue;
      const L = e.level;
      const sx = d.x + d.dx * 0.03, sz = d.z + d.dz * 0.03;
      const prims = primsIn(w, [Math.min(sx, b.access.x) - 0.2, Math.min(sz, b.access.z) - 0.2, Math.max(sx, b.access.x) + 0.2, Math.max(sz, b.access.z) + 0.2]);
      // run out along the door's facing until the edge of the roadway
      let reach = -1;
      for (let s = 0; s <= 1.6; s += 0.01) if (fieldAt(prims, sx + d.dx * s, sz + d.dz * s)[0] <= 0) { reach = s; break; }
      if (reach < 0) continue;
      const len = reach + 0.03;
      if (len < 0.03) continue;
      const nx = -d.dz, nz = d.dx;
      const piece = (a, en, half, color) => {
        const n = en > reach - R ? 3 : 1;
        for (let i = 0; i < n; i++) {
          const s0 = a + ((en - a) * i) / n, s1 = a + ((en - a) * (i + 1)) / n;
          quad(sx + d.dx * s0, sz + d.dz * s0, sx + d.dx * s1, sz + d.dz * s1, half + flare(reach - s0), half + flare(reach - s1), nx, nz, color);
        }
      };
      if (L === 1) {
        c.set('#9a805c');
        const n = Math.ceil(len / 0.08);
        for (let i = 0; i < n; i++) piece((i / n) * len, ((i + 1) / n) * len, 0.036 + 0.006 * Math.sin(i * 2.1), c);
      } else {
        for (let a = 0, i = 0; a < len - 0.02; a += 0.068, i++) {
          const en = Math.min(len, a + 0.056);
          c.set(i % 2 ? '#d6ccb4' : '#c4b89c').multiplyScalar(0.95 + hash2(b.id, i, 7) * 0.1);
          piece(a, en, 0.05, c);
        }
      }
    }
  }

  // Railway track along a track edge's curve: sleepers, two rails, and over
  // water a deck on piers.
  _rail(gb, e) {
    const w = this.world, t = w.terrain;
    const step = 0.125, n = Math.max(1, Math.ceil(e.len / step));
    const yAt = (x, z) => (w.waterAt(x, z) ? bridgeDeckY() : t.heightAt(x, z) + 0.012);
    for (let k = 0; k < n; k++) {
      const a = pointAt(e.pts, e.cum, (e.len * k) / n), b = pointAt(e.pts, e.cum, (e.len * (k + 1)) / n);
      const ay = yAt(a[0], a[1]), by = yAt(b[0], b[1]), len = Math.hypot(b[0] - a[0], b[1] - a[1]), dh = by - ay;
      gb.pushEuler(a[0], ay, a[1], -Math.atan2(dh, len), Math.atan2(b[0] - a[0], b[1] - a[1]));
      const L = Math.hypot(len, dh), water = w.waterAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      if (water) gb.box(0, -0.035, L / 2, RAIL_HALF * 2 + 0.1, 0.045, L + 0.02, '#5e4a38');
      if (k % 2 === 0) gb.box((hash2(k, e.id, 7) - 0.5) * 0.02, -0.004, L / 2, 0.3, 0.022, 0.055, '#5e432c');
      for (const sd of [-1, 1]) gb.box(sd * 0.075, 0.016, L / 2, 0.02, 0.026, L + 0.02, '#7d8187');
      gb.pop();
      if (water && k % 4 === 0) gb.cyl(a[0], -0.9, a[1], 0.032, 0.036, bridgeDeckY() - 0.05 + 0.9, 7, '#3f3126');
    }
  }

  dispose() {
    this.surface.geometry.dispose(); this.scene.remove(this.surface);
    this.doors.geometry.dispose(); this.scene.remove(this.doors);
    this.scene.remove(this.props);
    this.props.geometry.dispose();
  }
}

// The unit squares of ground any road's surface reaches (keys x + z * 65536).
export function roadSquares(w) {
  const out = new Set(), r = HALF[3] + 0.1;
  for (const e of w.roads.edges.values()) {
    for (let i = 0; i + 1 < e.pts.length; i++) {
      const p = e.pts[i], q = e.pts[i + 1];
      const x0 = Math.floor(Math.min(p[0], q[0]) - r), x1 = Math.floor(Math.max(p[0], q[0]) + r), z0 = Math.floor(Math.min(p[1], q[1]) - r), z1 = Math.floor(Math.max(p[1], q[1]) + r);
      for (let z = Math.max(0, z0); z <= Math.min(w.N - 1, z1); z++) for (let x = Math.max(0, x0); x <= Math.min(w.N - 1, x1); x++) out.add(z * 65536 + x);
    }
  }
  return out;
}
