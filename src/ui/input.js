// Mouse / keyboard / touch: camera control and all the building tools.
//
// Nothing here keeps to squares. A building is set down with its middle
// wherever the pointer is, facing the nearest street (turned from there by
// Z / C, Shift for fine steps; Tab lines it up with the street instead, its
// front at the usual distance from it). A road or track is drawn as the
// pointer moves, fitted with a smooth curve when the button comes up (Shift:
// straight from where the drag began); its ends join the roads they reach.

import * as THREE from 'three';
import { BUILDINGS, TRANSIT, stopOf } from '../defs.js';
import { capOf, floorHeight, plotOf, ownPlot, sizeOf, HALF, RAIL_HALF, World } from '../world/world.js';
import { ROAD_LEVELS } from '../config.js';
import { buildModel } from '../render/buildings.js';
import { MAT } from '../render/materials.js';
import { fmt, esc } from './ui.js';
import { householdsIn } from '../sim/people.js';
import { planRoadEdit, planDress, edgeAt, edgesInBox, lengthOf } from '../world/streets.js';
import { selEdges, dressOp } from './roadSelect.js';
import { rect, simplify, toLocal, toWorld, wrapAngle } from '../world/geom.js';

const OK = '#7fdc6a', BAD = '#ff6b5a', SOFT = '#ffffff', GOLD = '#ffd84a', WARN = '#ffa64a';

// The keys that still answer with the interface hidden: the game speed and
// the camera (W A S D and the arrows pan in update()).
const HIDDEN_KEYS = new Set([' ', ',', '.', '/', '[', ']', 't', 'q', 'e', 'home', '+', '=', '-', '_']);
// how fast a drag turns (across) and tilts (up and down) the view, in radians a pixel
const ORBIT_TURN = 0.006, ORBIT_TILT = 0.004;
// how far apart the points of a stroke are kept as it is drawn, and how
// closely the curve laid through them follows them
const STROKE_STEP = 0.25, STROKE_TOL = 0.12;
const deg = (r) => Math.round((wrapAngle(r) * 180) / Math.PI);

export class Input {
  constructor(game) {
    this.game = game;
    this.tool = { kind: 'select' };
    this.canvas = game.renderer.canvas;
    this.hover = null;
    this.drag = null;
    this.keys = new Set();
    this.variant = (Math.random() * 1e9) | 0;
    this.turn = 0;          // a new building's turn from facing its street (Z / C)
    this.lineUp = false;    // line new buildings up with the street (Tab)
    this.ray = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.pointers = new Map();
    this.ghost = null;
    this.ghostKey = '';
    this.mouse = { x: 0, y: 0 };
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('pointercancel', (e) => this.onUp(e));
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerleave', () => { if (!this.drag) { this.hover = null; this.refresh(); } });
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.keys.clear());
  }

  get world() { return this.game.world; }
  get ui() { return this.game.ui; }

  setTool(t) {
    const sel = this.ui.selection;
    this.tool = t;
    this.drag = null;
    this.turn = 0;
    this.variant = (Math.random() * 1e9) | 0;
    // the road selection tool keeps its own panel in the inspector
    if (t.kind === 'roadsel') this.ui.inspect({ kind: 'roadsel' });
    else if (t.kind === 'fields') this.ui.inspect({ kind: 'building', id: t.id });
    else if (t.kind !== 'select' || (sel && sel.kind === 'roadsel')) this.ui.inspect(null);
    this.ui.syncToolbar();
    this.game.updateRouteOverlay();
    this.refresh();
  }

  // -------------------------------------------------------------- picking
  _ndc(e) {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.game.renderer.camera);
  }

  // The point of the ground under the pointer: { x, z } (any point: there
  // are no squares to snap to), or null off the map.
  pickPoint(e) {
    if (!this.game.view) return null;
    this._ndc(e);
    const hit = this.ray.intersectObject(this.game.view.terrain.surface, false)[0];
    if (!hit) return null;
    const x = hit.point.x, z = hit.point.z;
    if (!this.world.inBounds(x, z)) return null;
    return { x, z, px: x, pz: z };
  }
  pickTile(e) { return this.pickPoint(e); }

  pickBuilding(e) {
    this._ndc(e);
    return this.game.view.pickBuilding(this.ray);
  }

  // -------------------------------------------------------------- pointer
  onDown(e) {
    if (!this.game.world || this.game.demo) return;
    this.canvas.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.drag = { type: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, ang: Math.atan2(b.y - a.y, b.x - a.x), mode: null, from: [{ ...a }, { ...b }] };
      return;
    }
    const t = this.tool;
    this.mouse = { x: e.clientX, y: e.clientY };
    // middle-drag, or Shift and right-drag: turn and tilt the view
    if (e.button === 1 || (e.button === 2 && e.shiftKey)) { this.drag = { type: 'orbit', moved: 0, button: e.button }; this.game.orbitStart(); return; }
    if (e.button === 2) { this.drag = { type: 'pan', x: e.clientX, y: e.clientY, moved: 0, button: e.button }; return; }
    if (e.button !== 0) return;
    const p = this.pickPoint(e);
    switch (t.kind) {
      case 'select': this.drag = { type: 'maybePan', x: e.clientX, y: e.clientY, moved: 0 }; break;
      case 'road': case 'rail': if (p) this.drag = { type: 'stroke', pts: [[p.x, p.z]], start: p, end: p }; break;
      case 'bulldoze': if (p) this.drag = { type: 'rect', start: p, end: p }; break;
      case 'fields': if (p) this.drag = { type: 'fields', start: p, end: p }; break;
      case 'roadsel': if (p) this.drag = { type: 'pick', start: p, end: p, add: e.shiftKey }; break;
      case 'build': if (p) { const at = this._place(p); this.drag = { type: 'paint', last: at || p }; } break;
      case 'move': if (p) this._moveTo(p); break;
      case 'terrain': case 'trees': if (p) { this._applyAt(p); this.drag = { type: 'paint', last: p }; } break;
      case 'line': this._lineClick(e); break;
    }
    this.refresh();
  }

  onMove(e) {
    if (!this.game.world || this.game.demo) return;
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const d = this.drag;
    if (d && d.type === 'pinch' && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, ang = Math.atan2(b.y - a.y, b.x - a.x);
      const R = this.game.renderer;
      if (!d.mode) {
        // Two fingers side by side dragged up or down together tilt the view;
        // anything else pans, pinches to zoom and twists to turn it.
        const [a0, b0] = d.from, ax = a.x - a0.x, ay = a.y - a0.y, bx = b.x - b0.x, by = b.y - b0.y;
        if (Math.hypot(ax, ay) + Math.hypot(bx, by) < 16) return;
        const side = Math.abs(b0.x - a0.x) > Math.abs(b0.y - a0.y);
        d.mode = side && ay * by > 0 && Math.abs(ay) > 2 * Math.abs(ax) && Math.abs(by) > 2 * Math.abs(bx) ? 'tilt' : 'pinch';
        this.game.orbitStart();
      } else if (d.mode === 'tilt') this.game.orbit(0, (my - d.my) * ORBIT_TILT * 1.5);
      else {
        R.grab(d.mx, d.my, mx - d.mx, my - d.my);
        if (d.d > 10) R.zoomBy(dist / d.d, mx, my);
        const da = d.d > 40 ? Math.atan2(Math.sin(ang - d.ang), Math.cos(ang - d.ang)) : 0;
        d.twist = (d.twist || 0) + da;
        if (Math.abs(d.twist) > 0.17) d.twisting = true;
        if (d.twisting && da) this.game.orbit(da, 0, { x: mx, y: my });
        this.game.setFollow(null);
      }
      Object.assign(d, { d: dist, mx, my, ang });
      return;
    }
    const dx = e.clientX - this.mouse.x, dy = e.clientY - this.mouse.y;
    this.mouse = { x: e.clientX, y: e.clientY };
    if (d && d.type === 'orbit') {
      d.moved += Math.abs(dx) + Math.abs(dy);
      if (d.button !== 2 || d.moved > 6) {
        this.game.orbit(-dx * ORBIT_TURN, dy * ORBIT_TILT);
        this.canvas.style.cursor = 'move';
      }
      return;
    }
    if (d && (d.type === 'pan' || d.type === 'maybePan')) {
      d.moved += Math.abs(dx) + Math.abs(dy);
      if (d.type === 'pan' || d.moved > 6) {
        if (d.type === 'maybePan') d.type = 'pan';
        this.game.renderer.grab(e.clientX - dx, e.clientY - dy, dx, dy);
        this.game.setFollow(null);
        this.canvas.style.cursor = 'grabbing';
      }
      return;
    }
    if (e.target !== this.canvas && !d) { if (this.hover) { this.hover = null; this.refresh(); } return; }
    const p = this.pickPoint(e);
    this.hover = p;
    if (this.tool.kind === 'roadsel' && this.tool.action) { this.tool.action = null; }
    if (d && p && (d.type === 'rect' || d.type === 'pick' || d.type === 'fields')) d.end = p;
    if (d && p && d.type === 'stroke') {
      d.end = p;
      const last = d.pts[d.pts.length - 1];
      if (Math.hypot(p.x - last[0], p.z - last[1]) >= STROKE_STEP) d.pts.push([p.x, p.z]);
    }
    if (d && d.type === 'paint' && p) {
      if (this.tool.kind === 'build') {
        // (another of a small building once the pointer has moved a plot along)
        const [W, D] = sizeOf(this.tool.type);
        if (BUILDINGS[this.tool.type].size === 1 && Math.hypot(p.x - d.last.x, p.z - d.last.z) >= Math.max(W, D) + 0.02) { const at = this._place(p, true); if (at) d.last = at; }
      } else if (Math.hypot(p.x - d.last.x, p.z - d.last.z) >= 0.5) { d.last = p; this._applyAt(p); }
    }
    this.refresh(e);
  }

  onUp(e) {
    this.pointers.delete(e.pointerId);
    const d = this.drag;
    if (!d || !this.game.world) return;
    if (d.type === 'pinch') { if (this.pointers.size < 2) this.drag = null; return; }
    this.canvas.style.cursor = '';
    if ((d.type === 'pan' || d.type === 'orbit') && d.button === 2 && d.moved < 6) {
      // right-click: step back out of the current tool / selection
      if (this.tool.kind === 'line' && this.tool.stops.length) { this.tool.stops.pop(); this.ui.updateHint(); this.game.updateRouteOverlay(); }
      else if (this.tool.kind === 'roadsel' && this.tool.sel.size) this.pickRoads([], false);
      else if (this.tool.kind !== 'select') { this.ui.closeFlyout(); this.setTool({ kind: 'select' }); }
      else this.ui.inspect(null);
    } else if (d.type === 'maybePan') {
      this._selectClick(e);
    } else if (d.type === 'stroke') {
      this._strokeDone(d, e.shiftKey);
    } else if (d.type === 'rect') {
      const moved = Math.hypot(d.end.x - d.start.x, d.end.z - d.start.z) > 0.3;
      const c = moved ? { t: 'bulldoze', box: this._box(d) } : { t: 'bulldoze', x: d.start.x, z: d.start.z };
      this.game.cmd(c, (r) => {
        if (r.n) this.game.sfx('demolish');
        else if (r.reason && !moved) this.ui.toast(r.reason, 'bad');
      });
    } else if (d.type === 'fields') {
      const t = this.tool, fields = this._fieldSpots(d.start, d.end);
      if (fields.length) this.game.cmd({ t: 'fields', id: t.id, fields, add: t.add }, (r) => {
        if (r.ok) {
          this.game.sfx(t.add ? 'build' : 'demolish');
          this.ui.toast(t.add ? `Ploughed ${r.n} field${r.n === 1 ? '' : 's'} · $${r.cost}` : `Took out ${r.n} field${r.n === 1 ? '' : 's'} · +$${r.refund}`, 'good', '🌾');
        } else if (r.reason) this.ui.toast(r.reason, 'bad');
        if (this.ui.selection) this.ui.renderInspector(true);
        const b = this.world.buildings.get(t.id);
        if (t.add && b && (b.fields || 0) >= this.world.fieldMax(b)) this.setTool({ kind: 'select' });
      });
    } else if (d.type === 'pick') {
      const one = Math.hypot(d.end.x - d.start.x, d.end.z - d.start.z) < 0.3;
      this.pickRoads(this._pickEdges(d), d.add || e.shiftKey, one);
    }
    this.drag = null;
    this.refresh();
  }

  onWheel(e) {
    e.preventDefault();
    if (!this.game.world) return;
    // turning a building about to go down: the wheel with Alt (or Ctrl) held
    if ((e.altKey || e.ctrlKey) && (this.tool.kind === 'build' || this.tool.kind === 'move')) {
      this.turn = wrapAngle((this.turn || 0) + Math.sign(e.deltaY) * (e.shiftKey ? 1 : 5) * (Math.PI / 180));
      this.refresh(e);
      return;
    }
    const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016));
    this.game.renderer.zoomBy(f, e.clientX, e.clientY);
  }

  _box(d) { return [Math.min(d.start.x, d.end.x), Math.min(d.start.z, d.end.z), Math.max(d.start.x, d.end.x), Math.max(d.start.z, d.end.z)]; }

  _selectClick(e) {
    const g = this.game;
    if (this.ui.uiHidden) return;
    const r = g.agents.pick(e.clientX, e.clientY);
    if (r) { this.ui.inspect({ kind: 'resident', id: r.id }); g.sfx('click'); return; }
    const b = this.pickBuilding(e);
    if (b) { this.ui.inspect({ kind: 'building', id: b.id }); g.sfx('click'); return; }
    const p = this.pickPoint(e);
    if (p) {
      const bb = this.world.buildingAt(p.x, p.z);
      if (bb) { this.ui.inspect({ kind: 'building', id: bb.id }); return; }
      const rl = this.world.railAt(p.x, p.z, 0.08), rd = this.world.roadAt(p.x, p.z, 0.08);
      if (rd && (!rl || rd.d <= rl.d)) { this.ui.inspect({ kind: 'road', e: rd.e.id, x: p.x, z: p.z }); return; }
      if (rl) { this.ui.inspect({ kind: 'road', rail: true, e: rl.e.id, x: p.x, z: p.z }); return; }
    }
    this.ui.inspect(null);
  }

  // Where a building of the tool's type would go for pointer point p, and
  // the way it would face: { x, z, a, w, d }.
  _spot(type, p, W = null, D = null) {
    const w = this.world, [w0, d0] = sizeOf(type);
    W ??= w0; D ??= d0;
    if (this.lineUp) {
      const s = w.alongRoad(p.x, p.z, D / 2);
      if (s) return { x: s.x, z: s.z, a: wrapAngle(s.a + this.turn), w: W, d: D };
    }
    const face = w.faceRoad(p.x, p.z);
    if (face != null) this._lastFace = face;
    return { x: p.x, z: p.z, a: wrapAngle((face ?? this._lastFace ?? 0) + this.turn), w: W, d: D };
  }

  _place(p, painting = false) {
    const t = this.tool;
    const def = BUILDINGS[t.type];
    const s = this._spot(t.type, p);
    const r3 = (v) => Math.round(v * 1000) / 1000;
    this.game.cmd({ t: 'place', type: t.type, x: r3(s.x), z: r3(s.z), a: r3(s.a), variant: this.variant, ...(t.flavor ? { flavor: t.flavor } : {}) }, (r) => {
      if (r.ok) {
        this.game.sfx('build');
        this.variant = (Math.random() * 1e9) | 0;
        this.ghostKey = '';
        if (def.unique && this.tool === t) { this.ui.closeFlyout(); this.setTool({ kind: 'select' }); }
      } else if (!painting) this.ui.toast(r.reason || "Can't build there", 'bad');
    });
    return s;
  }

  _moveTo(p) {
    const w = this.world, b = w.buildings.get(this.tool.id);
    if (!b) { this.setTool({ kind: 'select' }); return; }
    const s = this._spot(b.type, p, b.w, b.d);
    const name = BUILDINGS[b.type].levels[b.level].name;
    const r3 = (v) => Math.round(v * 1000) / 1000;
    this.game.cmd({ t: 'move', id: b.id, x: r3(s.x), z: r3(s.z), a: r3(s.a) }, (r) => {
      if (!r.ok) { this.ui.toast(r.reason || "Can't move it there", 'bad'); return; }
      this.game.sfx('build');
      this.ui.toast(r.instant ? `Moved the ${name}` : `Builders will take down the ${name}, cart it over and rebuild it here`, 'good', '🏗️');
      if (this.tool.kind === 'move') this.setTool({ kind: 'select' });
      if (r.building) this.ui.inspect({ kind: 'building', id: r.building.id });
    });
  }

  _applyAt(p) {
    const t = this.tool, quiet = !!this.drag;
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const c = t.kind === 'trees' ? { t: 'plant', x: r3(p.x), z: r3(p.z) } : { t: 'terraform', x: r3(p.x), z: r3(p.z), mode: t.mode };
    this.game.cmd(c, (r) => {
      if (r.ok) this.game.sfx(c.t === 'plant' ? 'plant' : 'dig');
      else if (r.reason && !quiet) this.ui.toast(r.reason, 'bad');
    });
  }

  _lineClick(e) {
    const t = this.tool;
    const b = this.pickBuilding(e) || (() => { const p = this.pickPoint(e); return p ? this.world.buildingAt(p.x, p.z) : null; })();
    if (!stopOf(b, t.mode)) { this.ui.toast(`Click a ${TRANSIT[t.mode].stop}`, 'bad'); return; }
    if (t.stops[t.stops.length - 1] === b.id) return;
    if (t.stops.length >= 2 && t.stops[0] === b.id) { this.finishLine(); return; }
    t.stops.push(b.id);
    this.game.sfx('click');
    this.ui.updateHint();
    this.game.updateRouteOverlay();
  }

  finishLine() {
    const t = this.tool;
    if (t.kind !== 'line') return;
    this.game.cmd({ t: 'line', mode: t.mode, stops: t.stops.slice() }, (r) => {
      if (!r.ok) { this.ui.toast(r.reason || "Couldn't start that line", 'bad'); return; }
      this.ui.toast(`${r.line.name} is running!`, 'good', TRANSIT[t.mode].icon);
      this.game.sfx('upgrade');
      if (this.tool === t) this.setTool({ kind: 'line', mode: t.mode, stops: [] });
    });
  }

  // ---------------------------------------------------------------- strokes
  // The points a drag draws a road through: straight from start to end with
  // Shift, else the way the pointer went, thinned (World.curveOf fits a
  // smooth curve through them).
  _ctrlOf(d, straight) {
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const end = [d.end.x, d.end.z];
    let pts = straight ? [d.pts[0], end] : d.pts.concat(Math.hypot(end[0] - d.pts[d.pts.length - 1][0], end[1] - d.pts[d.pts.length - 1][1]) > 0.05 ? [end] : []);
    if (!straight) pts = simplify(pts, STROKE_TOL);
    if (pts.length > 60) pts = simplify(pts, STROKE_TOL * 3);
    return pts.map(([x, z]) => [r3(x), r3(z)]);
  }

  _strokeDone(d, straight) {
    const t = this.tool, w = this.world;
    const ctrl = this._ctrlOf(d, straight || this.keys.has('shift'));
    const long = ctrl.length >= 2 && Math.hypot(ctrl[ctrl.length - 1][0] - ctrl[0][0], ctrl[ctrl.length - 1][1] - ctrl[0][1]) > 0.3;
    if (!long) {
      // a click on a road with the road tool brings that stretch up to the tool's level
      if (t.kind !== 'road') return;
      const e = edgeAt(w, d.start.x, d.start.z, 0.05);
      if (!e) return;
      if (e.level >= t.level) { this.ui.toast(`That is ${ROAD_LEVELS[e.level].name.toLowerCase()} already`, 'bad'); return; }
      this.game.cmd({ t: 'roadlevel', ids: [e.id], level: t.level }, (r) => {
        if (r.ok) this.game.sfx('build'); else if (r.reason) this.ui.toast(r.reason, 'bad');
      });
      return;
    }
    const c = t.kind === 'rail' ? { t: 'rails', ctrl } : { t: 'roads', ctrl, level: t.level };
    this.game.cmd(c, (r) => {
      if (r.placed) this.game.sfx('build');
      else if (r.failed) this.ui.toast(r.failed, 'bad');
    });
  }

  // ------------------------------------------------------------ farm fields
  // The fields a drag lays for the tool's farm: a unit square at each place
  // a whole number of fields along and back from the farm's own plot (in the
  // farm's own frame, at its angle), from the one under start to the one
  // under end: [[x, z, a]].
  _fieldSpots(start, end) {
    const farm = this.world.buildings.get(this.tool.id);
    if (!farm) return [];
    const F = ownPlot(farm), r3 = (v) => Math.round(v * 1000) / 1000;
    const cell = (p) => { const [lx, lz] = toLocal(F, p.x, p.z); return [Math.round(lx + F.hw - 0.5), Math.round(lz + F.hd - 0.5)]; };
    const [i0, j0] = cell(start), [i1, j1] = cell(end), out = [];
    for (let j = Math.min(j0, j1); j <= Math.max(j0, j1); j++) for (let i = Math.min(i0, i1); i <= Math.max(i0, i1); i++) {
      if (out.length >= 400) break;
      const [x, z] = toWorld(F, i + 0.5 - F.hw, j + 0.5 - F.hd);
      out.push([r3(x), r3(z), r3(farm.a)]);
    }
    return out;
  }

  // ------------------------------------------------------ road selection
  // What a click (the stretch between two junctions) or a drag (every road
  // in the box, or along the line) picks: road edge ids.
  _pickEdges(d) {
    const w = this.world;
    const one = Math.hypot(d.end.x - d.start.x, d.end.z - d.start.z) < 0.3;
    if (one) { const e = edgeAt(w, d.start.x, d.start.z); return e ? [e.id] : []; }
    if (this.tool.box) return edgesInBox(w, this._box(d));
    const out = new Set(), L = Math.hypot(d.end.x - d.start.x, d.end.z - d.start.z), n = Math.ceil(L / 0.1);
    for (let k = 0; k <= n; k++) { const e = edgeAt(w, d.start.x + ((d.end.x - d.start.x) * k) / n, d.start.z + ((d.end.z - d.start.z) * k) / n, 0.05); if (e) out.add(e.id); }
    return [...out];
  }

  // Change the road selection: a fresh pick replaces it, Shift adds to it
  // (and Shift-clicking a stretch that is already picked takes it back out).
  // Backspace steps back through these changes.
  pickRoads(ids, add, toggle = false) {
    const t = this.tool;
    if (t.kind !== 'roadsel') return;
    t.hist.push([...t.sel]);
    if (t.hist.length > 60) t.hist.shift();
    if (!add) t.sel = new Set(ids);
    else if (toggle && ids.length && ids.every(k => t.sel.has(k))) for (const k of ids) t.sel.delete(k);
    else for (const k of ids) t.sel.add(k);
    t.confirm = null;
    if (ids.length) this.game.sfx('click');
    this.ui.inspect({ kind: 'roadsel' });
  }

  undoPick() {
    const t = this.tool;
    if (t.kind !== 'roadsel' || !t.hist.length) return;
    t.sel = new Set(t.hist.pop());
    t.confirm = null;
    this.ui.inspect({ kind: 'roadsel' });
  }

  // --------------------------------------------------------------- preview
  // A road edge as a band along its curve, for the overlay.
  _edgeShape(e, color, alpha, rail = false) { return { line: e.pts, width: rail ? RAIL_HALF * 2 + 0.1 : HALF[e.level] * 2 + 0.08, color, alpha }; }
  _plotShape(b, color, alpha, border = true) { return { pts: plotOf(b).pts, color, alpha, border, y: b.baseY + 0.04 }; }

  refresh(e = null) {
    const g = this.game, w = this.world;
    if (!w || !g.view) return;
    const ov = g.view.overlay;
    const t = this.tool, h = this.hover, d = this.drag;
    const shapes = [];
    let tip = null;
    let ghost = null;
    if (t.kind === 'select') {
      const sel = this.ui.selection;
      if (sel && sel.kind === 'building') {
        const b = w.buildings.get(sel.id);
        if (b) shapes.push(this._plotShape(b, GOLD, 0.25));
        for (const s of this.previewTiles || []) shapes.push(s);
      } else if (sel && sel.kind === 'road') {
        const e = (sel.rail ? w.rails : w.roads).edges.get(sel.e);
        if (e) shapes.push(this._edgeShape(e, GOLD, 0.3, sel.rail));
      }
      if (h && e && !d) {
        const r = g.agents.pick(e.clientX, e.clientY);
        const an = r ? null : g.animals.pick(e.clientX, e.clientY);
        const b = r || an ? null : (this.pickBuilding(e) || w.buildingAt(h.x, h.z));
        if (r) tip = `<b>${esc(r.first)} ${esc(r.last)}</b><br>${esc(g.agents.activity(r))}`;
        else if (an) tip = g.animals.describe(an);
        else if (b) {
          const def = BUILDINGS[b.type], L = def.levels[b.level];
          tip = `<b>${L.name}</b>`;
          if (b.con) tip += `<br>🏗️ ${b.con.kind === 'dismantle' || b.con.kind === 'demolish' ? 'coming down' : 'being built'} · ${Math.round(Math.min(1, b.con.done / b.con.work) * 100)}%`;
          else if (L.housing) { const hh = householdsIn(this.world, b); tip += `<br>${b.residents.length}/${capOf(b, 'housing')} residents · ${hh} household${hh === 1 ? '' : 's'} · ${b.happiness}% happy`; }
          else if (L.jobs) tip += `<br>${b.workers.length}/${capOf(b, 'jobs')} workers`;
          const v = !b.con && g.agents.visitorsAt(b);
          if (v && Number.isFinite(v.cap)) tip += `<br>${v.now}/${v.cap} visitors${v.now >= v.cap ? ' · <span class="bad">full</span>' : ''}`;
          if (!b.connected && (!def.park || b.access)) tip += `<br><span class="bad">Not connected</span>`;
          shapes.push(this._plotShape(b, SOFT, 0.14, false));
        } else {
          const rd = w.roadAt(h.x, h.z, 0.08);
          if (rd) shapes.push(this._edgeShape(rd.e, SOFT, 0.12));
          else shapes.push({ x: h.x, z: h.z, r: 0.12, color: SOFT, alpha: 0.12 });
        }
      }
    } else if ((t.kind === 'road' || t.kind === 'rail') && (d || h)) {
      const rail = t.kind === 'rail';
      if (d && d.type === 'stroke') {
        const ctrl = this._ctrlOf(d, this.keys.has('shift'));
        const long = ctrl.length >= 2 && Math.hypot(ctrl[ctrl.length - 1][0] - ctrl[0][0], ctrl[ctrl.length - 1][1] - ctrl[0][1]) > 0.3;
        if (long) {
          const c = rail ? w.checkRail(ctrl) : w.checkRoad(ctrl, t.level);
          const pts = c.pts && c.pts.length >= 2 ? c.pts : World.curveOf(ctrl);
          shapes.push({ line: pts, width: rail ? RAIL_HALF * 2 + 0.1 : HALF[t.level] * 2 + 0.06, color: c.ok ? OK : BAD, alpha: 0.42 });
          // the junctions it would make
          if (c.plan) for (const j of [c.plan.j0, c.plan.j1, ...c.plan.cross].filter(Boolean)) shapes.push({ x: j.x, z: j.z, r: 0.18, color: c.ok ? '#ffffff' : BAD, alpha: 0.5 });
          tip = `${rail ? 'Railway track' : ROAD_LEVELS[t.level].name} · ${(c.len || 0).toFixed(1)} long${c.water ? ` (${c.water.toFixed(1)} bridge)` : ''} · $${fmt(c.cost || 0)}` + (c.ok ? '' : `<br><span class="bad">${esc(c.reason || "Can't lay that")}</span>`) + '<br>Shift: straight';
        }
      } else if (h) {
        const net = rail ? w.rails : w.roads, hit = net.nearest(h.x, h.z, 0.4);
        if (hit) shapes.push(this._edgeShape(hit.e, SOFT, 0.2, rail));
        shapes.push({ x: h.x, z: h.z, r: 0.15, color: OK, alpha: 0.35 });
        tip = `${rail ? 'Railway track' : ROAD_LEVELS[t.level].name}: drag to draw it, any way you like${rail ? '' : '<br>Click a road to bring it up to this'}`;
      }
    } else if (t.kind === 'fields') {
      // the farm and its fields in gold; what a drag would add (green) or
      // can't (red), or which fields it would take out
      const farm = w.buildings.get(t.id);
      if (!farm) { this.setTool({ kind: 'select' }); return; }
      shapes.push(this._plotShape(farm, GOLD, 0.2));
      for (const f of w.fieldsOf(farm.id)) shapes.push({ pts: f.rect.pts, color: GOLD, alpha: 0.18, border: false });
      const list = d && d.type === 'fields' ? this._fieldSpots(d.start, d.end) : h ? this._fieldSpots(h, h) : [];
      if (list.length) {
        const plan = w.planFields(farm.id, list, t.add);
        for (const p of plan.tiles) shapes.push({ pts: rect(p.x, p.z, p.a, 0.5, 0.5).pts, color: p.reason ? BAD : t.add ? OK : WARN, alpha: p.reason ? 0.3 : 0.45 });
        const why = plan.short || (!plan.n && (plan.tiles.find(p => p.reason) || {}).reason);
        tip = t.add ? `${plan.n} field${plan.n === 1 ? '' : 's'} · $${fmt(plan.cost)} · ${plan.have + plan.n} of ${plan.max}` : `Take out ${plan.n} field${plan.n === 1 ? '' : 's'} · +$${fmt(plan.refund)}`;
        if (why) tip += `<br><span class="bad">${why}</span>`;
      }
    } else if (t.kind === 'roadsel') {
      // picked roads in gold; while an action is hovered in the panel, the
      // roads it changes in green, those it leaves alone in red, and the
      // buildings it would cut off
      const act = t.action && t.action !== 'clear' ? t.action : null;
      const list = selEdges(w, t);
      const dop = act && act.startsWith('dress:') ? dressOp(w, list, act) : null;
      const plan = !act ? null : dop ? planDress(w, dop.ids, dop.kind, dop.look) : planRoadEdit(w, list, act, { paths: g.paths });
      if (plan) {
        const changed = new Set(dop ? plan.tiles.filter(p => !p.reason).map(p => p.e) : plan.edges);
        for (const id of list) { const e = w.roads.edges.get(id); if (e) shapes.push(this._edgeShape(e, changed.has(id) ? OK : BAD, changed.has(id) ? 0.45 : 0.3)); }
        const mark = (ids, color) => { for (const id of ids || []) { const b = w.buildings.get(id); if (b) shapes.push(this._plotShape(b, color, 0.3)); } };
        mark(plan.lost, BAD);
        mark(plan.cut, WARN);
      } else for (const id of list) { const e = w.roads.edges.get(id); if (e) shapes.push(this._edgeShape(e, GOLD, 0.4)); }
      if (d && d.type === 'pick') {
        const picked = this._pickEdges(d);
        const one = Math.hypot(d.end.x - d.start.x, d.end.z - d.start.z) < 0.3;
        if (!one) shapes.push(t.box ? { pts: [[d.start.x, d.start.z], [d.end.x, d.start.z], [d.end.x, d.end.z], [d.start.x, d.end.z]], color: SOFT, alpha: 0.07, border: false } : { line: [[d.start.x, d.start.z], [d.end.x, d.end.z]], width: 0.08, color: SOFT, alpha: 0.3 });
        for (const id of picked) { const e = w.roads.edges.get(id); if (e) shapes.push(this._edgeShape(e, SOFT, 0.3)); }
        tip = `${picked.length} stretch${picked.length === 1 ? '' : 'es'} of road (${lengthOf(w, picked).toFixed(1)} long)${d.add ? ' · adding to the selection' : ''}`;
      } else if (h && !plan) {
        const e2 = edgeAt(w, h.x, h.z);
        if (e2) {
          shapes.push(this._edgeShape(e2, SOFT, 0.16));
          tip = `A stretch of road ${e2.len.toFixed(1)} long · click to pick${t.sel.size ? ' · Shift-click to add' : ''}`;
        }
      }
    } else if (t.kind === 'bulldoze' && (d || h)) {
      if (d && Math.hypot(d.end.x - d.start.x, d.end.z - d.start.z) > 0.3) {
        const bx = this._box(d);
        shapes.push({ pts: [[bx[0], bx[1]], [bx[2], bx[1]], [bx[2], bx[3]], [bx[0], bx[3]]], color: BAD, alpha: 0.12 });
        for (const b of w.buildings.values()) if (b.x >= bx[0] && b.x <= bx[2] && b.z >= bx[1] && b.z <= bx[3]) shapes.push(this._plotShape(b, BAD, 0.4));
      } else if (h) {
        const b = w.buildingAt(h.x, h.z);
        if (b) {
          shapes.push(this._plotShape(b, BAD, 0.4));
          tip = `Demolish ${BUILDINGS[b.type].levels[b.level].name}` + (b.con && b.con.kind === 'build' ? '' : '<br>A crew will pull it down; residents move out');
        } else {
          const rl = w.railAt(h.x, h.z, 0.06), rd = w.roadAt(h.x, h.z, 0.06);
          if (rl && (!rd || rl.d < rd.d)) { shapes.push(this._edgeShape(rl.e, BAD, 0.4, true)); tip = 'Take up this stretch of track'; }
          else if (rd) { shapes.push(this._edgeShape(rd.e, BAD, 0.4)); const c = w.removeCheck(rd.e.id); tip = c.ok ? `Take up this stretch of road · +$${fmt(c.refund)}` : `<span class="bad">${esc(c.reason)}</span>`; }
          else shapes.push({ x: h.x, z: h.z, r: 0.4, color: BAD, alpha: w.treesNear(h.x, h.z, 0.4).length ? 0.35 : 0.12 });
        }
      }
    } else if (t.kind === 'build' && h) {
      const def = BUILDINGS[t.type];
      const s = this._spot(t.type, h);
      const c = w.checkBuild(t.type, s.x, s.z, { a: s.a });
      shapes.push({ pts: c.rect.pts, color: c.ok ? OK : BAD, alpha: 0.35 });
      const L = def.levels[0];
      if (L.radius) shapes.push({ x: s.x, z: s.z, r: L.radius, color: def.service ? '#8fd0ff' : '#b8f08f', alpha: 0.1 });
      tip = `<b>${def.levels[0].name}</b> <span class="muted">${def.name}</span> · $${fmt(c.cost)}` + (c.ok ? '' : `<br><span class="bad">${c.reason}</span>`) + `<br>Z / C: turn it (${deg(s.a)}°)${this.lineUp ? ' · Tab: place freely' : ' · Tab: line up with the street'}`;
      if (c.trees) tip += `<br>Clears ${c.trees} tree${c.trees > 1 ? 's' : ''}`;
      ghost = { type: t.type, ...s, ok: c.ok, chk: c, flavor: t.flavor || null };
    } else if (t.kind === 'move' && h) {
      const b = w.buildings.get(t.id);
      if (b) {
        const s = this._spot(b.type, h, b.w, b.d);
        const c = w.moveCheck(b, s.x, s.z, s.a);
        shapes.push(this._plotShape(b, GOLD, 0.25));
        if (c.rect) shapes.push({ pts: c.rect.pts, color: c.ok ? OK : BAD, alpha: 0.35 });
        const name = BUILDINGS[b.type].levels[b.level].name;
        tip = `<b>Move the ${name}</b> · $${fmt(c.cost || w.moveCost(b))}<br>Taken down, carted over and rebuilt` + (c.ok ? '' : `<br><span class="bad">${c.reason}</span>`) + `<br>Z / C: turn it (${deg(s.a)}°)`;
        if (c.rect) ghost = { type: b.type, level: b.level, variant: b.variant, flavor: b.flavor, ...s, ok: c.ok, chk: c };
      }
    } else if ((t.kind === 'terrain' || t.kind === 'trees') && h) {
      const c = t.kind === 'trees' ? w.checkPlant(h.x, h.z) : w.checkTerraform(h.x, h.z);
      shapes.push(t.kind === 'trees' ? { x: h.x, z: h.z, r: 0.12, color: c.ok ? OK : BAD, alpha: 0.4 } : { x: Math.floor(h.x), z: Math.floor(h.z), color: c.ok ? OK : BAD, alpha: 0.35 });
      tip = c.ok ? null : `<span class="bad">${c.reason}</span>`;
    } else if (t.kind === 'line') {
      for (const b of w.buildings.values()) {
        if (!stopOf(b, t.mode)) continue;
        const chosen = t.stops.indexOf(b.id);
        shapes.push(this._plotShape(b, chosen >= 0 ? OK : GOLD, chosen >= 0 ? 0.5 : 0.3));
      }
    }
    // nothing is picked out while the interface is hidden
    if (this.ui.uiHidden) { shapes.length = 0; ghost = null; tip = null; }
    ov.setCursor(shapes);
    this._setGhost(ghost);
    if (e) this.ui.tooltip(tip, e.clientX, e.clientY);
    else if (!tip) this.ui.tooltip(null);
  }

  _setGhost(gh) {
    const scene = this.game.renderer.scene;
    if (!gh) {
      if (this.ghost) { scene.remove(this.ghost); this.ghost.geometry.dispose(); this.ghost = null; this.ghostKey = ''; }
      return;
    }
    const w = this.world;
    const c = gh.chk;
    const minH = Number.isFinite(c.minH) ? c.minH : w.terrain.heightAt(gh.x, gh.z);
    const maxH = Number.isFinite(c.maxH) ? c.maxH : minH;
    const variant = gh.variant ?? this.variant;
    // (drawn again when it moves a fair way, turns, or changes; in between
    // it just moves)
    const key = `${gh.type}|${gh.level || 0}|${gh.w}|${gh.d}|${gh.ok}|${variant}|${gh.flavor || ''}|${Math.round(gh.x * 6)}|${Math.round(gh.z * 6)}|${Math.round(gh.a * 20)}`;
    const R = rect(gh.x, gh.z, gh.a, gh.w / 2, gh.d / 2);
    const baseY = floorHeight(w.terrain, gh.type, R, minH, maxH);
    if (key !== this.ghostKey) {
      this.ghostKey = key;
      if (this.ghost) { scene.remove(this.ghost); this.ghost.geometry.dispose(); }
      const b = { type: gh.type, level: gh.level || 0, variant, flavor: gh.flavor || null, size: Math.max(gh.w, gh.d), w: gh.w, d: gh.d, x: gh.x, z: gh.z, a: gh.a, baseY, minY: minH, rail: c.rail || null };
      const model = buildModel(b, { ground: (x, z) => w.terrain.heightAt(x, z), taken: this.game.view.takenFn, season: this.game.view.season });
      if (model.spin) model.spin.geo.dispose();
      this.ghost = new THREE.Mesh(model.geo, gh.ok ? MAT.ghostOk : MAT.ghostBad);
      this.ghost.renderOrder = 9;
      scene.add(this.ghost);
    }
    this.ghost.position.set(gh.x, baseY + 0.002, gh.z);
    this.ghost.rotation.y = gh.a;
  }

  // -------------------------------------------------------------- keyboard
  onKey(e, down) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const k = e.key.toLowerCase();
    if (down) this.keys.add(k); else { this.keys.delete(k); if (k === 'shift' && this.drag && this.drag.type === 'stroke') this.refresh(); return; }
    const g = this.game, ui = this.ui;
    if (!g.world || g.demo) return;
    if (ui.modalOpen) return;
    if (ui.uiHidden) {
      if (k === 'v' || k === 'escape') { ui.setUIHidden(false); return; }
      if (!HIDDEN_KEYS.has(k)) return;
    }
    if (k === 'escape' && ui.anyWindow && ui.closeModal()) return;
    if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); if (e.shiftKey) g.downloadSave(); else g.quickSave(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (k) {
      case 'escape':
        if (this.tool.kind === 'roadsel' && this.tool.sel.size) this.pickRoads([], false);
        else if (this.tool.kind !== 'select') { ui.closeFlyout(); this.setTool({ kind: 'select' }); }
        else ui.inspect(null);
        break;
      case 'shift': if (this.drag && this.drag.type === 'stroke') this.refresh(); break;
      case ' ': e.preventDefault(); g.setSpeed(g.speed ? 0 : (g.prevSpeed || 1)); break;
      case ',': g.setSpeed(1); break;
      case '.': g.setSpeed(4); break;
      case '/': g.setSpeed(32); break;
      case '[': g.stepSpeed(-1); break;
      case ']': g.stepSpeed(1); break;
      case 't': g.toggleTopDown(); break;
      case 'q': g.rotateView(-1); break;
      case 'e': g.rotateView(1); break;
      case 'home': g.classicView(); break;
      case '+': case '=': g.renderer.zoomBy(1.3); break;
      case '-': case '_': g.renderer.zoomBy(1 / 1.3); break;
      case '1': ui.pressTool('select'); break;
      case 'r': ui.pressTool('roads'); break;
      case '2': ui.pressTool('residential'); break;
      case '3': ui.pressTool('commercial'); break;
      case '4': ui.pressTool('industry'); break;
      case '5': ui.pressTool('services'); break;
      case '6': ui.pressTool('parks'); break;
      case '7': ui.pressTool('transit'); break;
      case '8': ui.pressTool('terrain'); break;
      case 'x': case 'delete': ui.pressTool('bulldoze'); break;
      case 'tab':
        e.preventDefault();
        if (this.tool.kind === 'roadsel') { this.tool.box = !this.tool.box; ui.updateHint(); ui.renderInspector(true); }
        // buildings: placed freely, or lined up with the street
        else if (this.tool.kind === 'build' || this.tool.kind === 'move') { this.lineUp = !this.lineUp; ui.updateHint(); }
        this.ghostKey = '';
        this.refresh();
        break;
      // turn a building to any angle from facing its street (Shift: in small steps)
      case 'z': case 'c':
        if (this.tool.kind === 'build' || this.tool.kind === 'move') {
          const step = ((e.shiftKey ? 5 : 15) * Math.PI) / 180 * (k === 'z' ? 1 : -1);
          this.turn = Math.round(wrapAngle((this.turn || 0) + step) * 1000) / 1000;
          this.ghostKey = '';
          this.refresh();
        }
        break;
      case 'enter': this.finishLine(); break;
      case 'backspace':
        if (this.tool.kind === 'line') { this.tool.stops.pop(); ui.updateHint(); g.updateRouteOverlay(); }
        else if (this.tool.kind === 'roadsel') this.undoPick();
        break;
      case 'o': ui.toggleOverlayMenu(); break;
      case 'b': ui.showBudget(); break;
      case 'p': ui.showPeople(); break;
      case 'k': ui.showResearch(); break;
      case 'u': ui.pressTool('utilities'); break;
      case 'n': ui.togglePopups(); break;
      case 'i': ui.toggleIssues(); break;
      case 'l': ui.showLines(); break;
      case 'm': ui.showMultiplayer(); break;
      case 'h': ui.showHelp(); break;
      case 'v': ui.setUIHidden(true); break;
    }
  }

  update(dt) {
    if (!this.game.world || this.game.demo || this.ui.modalOpen) return;
    const k = this.keys;
    let dx = 0, dy = 0;
    if (k.has('a') || k.has('arrowleft')) dx += 1;
    if (k.has('d') || k.has('arrowright')) dx -= 1;
    if (k.has('w') || k.has('arrowup')) dy += 1;
    if (k.has('s') || k.has('arrowdown')) dy -= 1;
    const orbit = (dx || dy) && k.has('shift');
    if (orbit) {
      if (!this.orbiting) this.game.orbitStart();
      this.game.orbit(-dx * 1.8 * dt, -dy * 0.9 * dt);
    } else if (dx || dy) {
      const s = 700 * dt;
      this.game.renderer.pan(dx * s, dy * s);
      this.game.setFollow(null);
    }
    this.orbiting = orbit;
  }
}
