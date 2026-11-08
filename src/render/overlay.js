// Overlays that hug the terrain: the cursor and placement previews (plots
// as the rectangles they are, at any angle; roads as ribbons along their
// curves; round brushes), other players' pointers, and data maps.

import * as THREE from 'three';
import { bridgeDeckY } from '../world/world.js';

function tileMesh(order) {
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  const m = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  m.renderOrder = order;
  m.frustumCulled = false;
  return m;
}

export class Overlay {
  constructor(world, scene) {
    this.world = world;
    this.scene = scene;
    this.cursor = tileMesh(6);
    this.remote = tileMesh(5);
    this.map = tileMesh(3);
    this.routes = new THREE.Group();
    scene.add(this.cursor, this.remote, this.map, this.routes);
    this._c = new THREE.Color();
  }

  // The height an overlay lies at over (x, z): on the ground (or the
  // water, a bridge's deck), lift above it; y: a height of its own (a plot
  // drawn at its building's floor).
  _y(x, z, lift, y = null) {
    if (y != null) return y;
    const w = this.world, t = w.terrain;
    const r = w.roadHeight(x, z);
    if (r != null) return r + lift - 0.03;
    if (w.waterAt(x, z)) return Math.max(t.heightAt(x, z), 0.02) + 0.02;
    return t.heightAt(x, z) + lift;
  }

  // A four-cornered patch (corners in order round it), split into small
  // cells so it follows the ground.
  _patch(pos, col, P, color, alpha, lift, y, fine = 0.25) {
    const L = Math.max(Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]), Math.hypot(P[2][0] - P[1][0], P[2][1] - P[1][1]));
    const n = Math.max(1, Math.min(24, Math.ceil(L / fine)));
    const at = (u, v) => {
      const ax = P[0][0] + (P[1][0] - P[0][0]) * u, az = P[0][1] + (P[1][1] - P[0][1]) * u;
      const bx = P[3][0] + (P[2][0] - P[3][0]) * u, bz = P[3][1] + (P[2][1] - P[3][1]) * u;
      const x = ax + (bx - ax) * v, z = az + (bz - az) * v;
      return [x, this._y(x, z, lift, y), z];
    };
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const a = at(i / n, j / n), b = at((i + 1) / n, j / n), c = at((i + 1) / n, (j + 1) / n), d = at(i / n, (j + 1) / n);
      for (const v of [a, b, c, a, c, d]) { pos.push(v[0], v[1], v[2]); col.push(color.r, color.g, color.b, alpha); }
    }
  }
  // A band along a line, half wide either side of it.
  _band(pos, col, line, half, color, alpha, lift, y) {
    for (let i = 0; i + 1 < line.length; i++) {
      const [ax, az] = line[i], [bx, bz] = line[i + 1], L = Math.hypot(bx - ax, bz - az);
      if (L < 1e-6) continue;
      const nx = (-(bz - az) / L) * half, nz = ((bx - ax) / L) * half;
      this._patch(pos, col, [[ax - nx, az - nz], [bx - nx, bz - nz], [bx + nx, bz + nz], [ax + nx, az + nz]], color, alpha, lift, y);
    }
  }

  // What to draw: [{ pts: [[x, z] x 4] (a plot), color, alpha, border, y }],
  // [{ line: [[x, z]...], width, color, alpha }] (a road, or a stroke being
  // drawn), [{ x, z, r }] (a round brush), or [{ x, z }] (a unit square).
  setCursor(shapes) { this._shapes(this.cursor, shapes); }

  // Shapes on the data map's layer (a home's plot in the colour of its happiness).
  setMapShapes(shapes) { this._shapes(this.map, shapes); }

  // Other players' pointers and selections in multiplayer (the same shapes, own layer).
  setRemote(shapes) { this._shapes(this.remote, shapes); }

  _shapes(mesh, shapes) {
    const pos = [], col = [];
    const c = this._c;
    for (const s of shapes) {
      c.set(s.color);
      const alpha = s.alpha ?? 0.35, rim = Math.min(1, alpha + 0.45);
      if (s.line) {
        this._band(pos, col, s.line, (s.width || 0.3) / 2, c, alpha, 0.07, s.y ?? null);
        continue;
      }
      let P = s.pts;
      if (!P && s.r) {
        // a round brush: a ring of patches
        const n = 20;
        for (let k = 0; k < n; k++) {
          const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
          this._patch(pos, col, [[s.x, s.z], [s.x + Math.cos(a0) * s.r, s.z + Math.sin(a0) * s.r], [s.x + Math.cos(a1) * s.r, s.z + Math.sin(a1) * s.r], [s.x, s.z]], c, alpha, 0.07, null);
        }
        continue;
      }
      if (!P) P = [[s.x, s.z], [s.x + 1, s.z], [s.x + 1, s.z + 1], [s.x, s.z + 1]];
      this._patch(pos, col, P, c, alpha, 0.07, s.y ?? null);
      if (s.border !== false) {
        // a brighter rim, just inside the edge
        for (let k = 0; k < P.length; k++) {
          const a = P[k], b = P[(k + 1) % P.length], m = [(P[0][0] + P[2][0]) / 2, (P[0][1] + P[2][1]) / 2];
          const ins = (p, t) => [p[0] + (m[0] - p[0]) * t, p[1] + (m[1] - p[1]) * t];
          const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, t = Math.min(0.2, 0.06 / Math.max(0.1, Math.hypot(m[0] - a[0], m[1] - a[1])));
          void L;
          this._patch(pos, col, [a, b, ins(b, t), ins(a, t)], c, rim, 0.075, s.y != null ? s.y + 0.005 : null);
        }
      }
    }
    this._apply(mesh, pos, col);
  }

  _tileQuad(pos, col, x, z, color, alpha, lift = 0.06, inset = 0) {
    this._patch(pos, col, [[x + inset, z + inset], [x + 1 - inset, z + inset], [x + 1 - inset, z + 1 - inset], [x + inset, z + 1 - inset]], color, alpha, lift, null, 1);
  }

  // values: Float32Array(N*N) 0..1 or null to clear; colorFn(v) -> [hex, alpha]
  setMap(values, colorFn) {
    if (!values) { this._apply(this.map, [], []); return; }
    const pos = [], col = [];
    const w = this.world, N = w.N, c = this._c;
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
      const v = values[z * N + x];
      const r = colorFn(v, x, z);
      if (!r) continue;
      c.set(r[0]);
      this._tileQuad(pos, col, x, z, c, r[1], 0.06, 0.02);
    }
    this._apply(this.map, pos, col);
  }

  // Coloured ribbons for transit routes: [{points:[[x,y,z]...], color}]
  setRoutes(routes) {
    for (const ch of [...this.routes.children]) { ch.geometry.dispose(); ch.material.dispose(); this.routes.remove(ch); }
    for (const r of routes) {
      if (r.points.length < 2) continue;
      const pos = [];
      const wdt = r.width || 0.07;
      for (let i = 0; i < r.points.length - 1; i++) {
        const a = r.points[i], b = r.points[i + 1];
        const dx = b[0] - a[0], dz = b[2] - a[2];
        const len = Math.hypot(dx, dz) || 1;
        const nx = (-dz / len) * wdt, nz = (dx / len) * wdt;
        const ya = a[1] + 0.09, yb = b[1] + 0.09;
        pos.push(a[0] + nx, ya, a[2] + nz, b[0] + nx, yb, b[2] + nz, b[0] - nx, yb, b[2] - nz);
        pos.push(a[0] + nx, ya, a[2] + nz, b[0] - nx, yb, b[2] - nz, a[0] - nx, ya, a[2] - nz);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        color: r.color, transparent: true, opacity: r.opacity ?? 0.85, depthWrite: false, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
      }));
      m.renderOrder = 7;
      m.frustumCulled = false;
      this.routes.add(m);
    }
  }

  _apply(mesh, pos, col) {
    const g = mesh.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 4));
    g.computeBoundingSphere();
    mesh.visible = pos.length > 0;
  }

  dispose() {
    this.setRoutes([]);
    this.scene.remove(this.cursor, this.remote, this.map, this.routes);
    this.cursor.geometry.dispose(); this.remote.geometry.dispose(); this.map.geometry.dispose();
  }
}
