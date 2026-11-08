// The other players in a multiplayer town: a ring in their colour on the
// ground under their pointer and round whatever building they have
// selected, with a name tag saying what they are doing.

import * as THREE from 'three';
import { plotOf } from '../world/world.js';

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class RemoteCursors {
  constructor(game) {
    this.game = game;
    this.list = new Map();   // player id → { name, color, x, z, sel, act, el }
    this.dirty = false;
    this._v = new THREE.Vector3();
  }

  set(pid, info) {
    let c = this.list.get(pid);
    if (!c) this.list.set(pid, (c = { el: null }));
    Object.assign(c, info);
    this.dirty = true;
  }

  remove(pid) {
    const c = this.list.get(pid);
    if (!c) return;
    c.el?.remove();
    this.list.delete(pid);
    this.dirty = true;
  }

  clear() { for (const pid of [...this.list.keys()]) this.remove(pid); this.update(); }

  update() {
    const g = this.game, w = g.world, view = g.view;
    if (!w || !view) return;
    if (this.dirty || view !== this._view) {
      this.dirty = false;
      this._view = view;
      const tiles = [];
      for (const c of this.list.values()) {
        const b = c.sel != null ? w.buildings.get(c.sel) : null;
        if (b) tiles.push({ pts: plotOf(b).pts, color: c.color, alpha: 0.1, y: b.baseY + 0.04 });
        if (c.x != null && w.inBounds(c.x, c.z)) tiles.push({ x: c.x, z: c.z, r: 0.25, color: c.color, alpha: 0.2 });
      }
      view.overlay.setRemote?.(tiles);
    }
    // name tags follow the camera
    const layer = document.getElementById('popups');
    for (const c of this.list.values()) {
      if (c.x == null || !w.inBounds(c.x, c.z) || g.demo) { if (c.el) c.el.style.display = 'none'; continue; }
      if (!c.el && layer) {
        c.el = document.createElement('div');
        c.el.className = 'netcur';
        layer.appendChild(c.el);
      }
      if (!c.el) continue;
      const html = `<i style="background:${esc(c.color)}"></i>${esc(c.name)}${c.act ? `<small>${esc(c.act)}</small>` : ''}`;
      if (c.el._html !== html) { c.el.innerHTML = html; c.el._html = html; c.el.style.borderColor = c.color; }
      const b = w.buildingAt(c.x, c.z);
      const y = b ? b.baseY + 0.55 : w.terrain.heightAt(c.x, c.z) + 0.12;
      const p = g.renderer.worldToScreen(this._v.set(c.x, y, c.z));
      c.el.style.display = p.behind ? 'none' : '';
      c.el.style.left = `${p.x}px`;
      c.el.style.top = `${p.y}px`;
    }
  }
}
