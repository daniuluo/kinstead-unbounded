// Everything visual about the world: terrain, roads, nature, buildings and ambient effects.

import * as THREE from 'three';
import { MAT, glowTexture, U } from './materials.js';
import { TerrainView } from './terrainView.js';
import { RoadsView } from './roadsView.js';
import { NatureView } from './natureView.js';
import { Overlay } from './overlay.js';
import { Particles } from './particles.js';
import { buildModel, workArea } from './buildings.js';
import { PARK_SEASON_STEPS } from './parks.js';
import { siteGeo, bodyBox } from './construction.js';
import { Rain } from './rain.js';
import { ownPlot } from '../world/world.js';
import { toWorld } from '../world/geom.js';
import { BUILDINGS } from '../defs.js';

const easeOutBack = (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };

export class WorldView {
  constructor(world, renderer) {
    this.world = world;
    this.R = renderer;
    const scene = this.scene = renderer.scene;
    this.terrain = new TerrainView(world, scene);
    this.roads = new RoadsView(world, scene);
    this.nature = new NatureView(world, scene);
    this.overlay = new Overlay(world, scene);
    this.smoke = new Particles(scene, 1200, { soft: 0.05 });
    this.glow = new Particles(scene, 1600, { additive: true });
    this.fx = new Particles(scene, 1500, { additive: true });
    this.weather = new Particles(scene, 900, { soft: 0.2 });
    this.rain = new Rain(scene, (x, z) => Math.max(world.terrain.heightAt(x, z), 0));
    this.effectsK = 1;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.groundFn = (x, z) => world.terrain.heightAt(x, z);
    // another building's plot or a road at (x, z) (not building id's own):
    // what a pier reaching out beyond its plot stops short of
    this.takenFn = (x, z, id) => {
      if (!world.inBounds(x, z)) return false;
      const o = world.buildingAt(x, z);
      return (!!o && o.id !== id) || !!world.roadAt(x, z, 0.05);
    };
    this.items = new Map();
    this.anims = [];
    this.pending = [];
    this.dirty = { roads: false, doors: false, nature: false, terrain: false, paint: false, glows: true };
    this.season = 1;
    this.seasonW = 0;
    this._parkSeason = 1 * PARK_SEASON_STEPS;   // the step of the season the parks are drawn at
    this._reseason = new Set();   // parks still to redraw for it, a few a frame
    this.poolTex = glowTexture();
    this.pools = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
      map: this.poolTex, color: '#ffb35c', transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    }));
    this.pools.renderOrder = 3;
    this.pools.frustumCulled = false;
    scene.add(this.pools);
    for (const b of world.buildings.values()) this.addBuilding(b, false);
    this.dirty.roads = true;   // door paths need the buildings' doors
    this.dirty.paint = true;

    // A building come, gone or changed: the ground it paints and the path
    // from its door are redrawn there (all of it for a farm, whose fields
    // reach further; RoadsView says when more of the streets change).
    const local = (b, gone = false) => {
      if (BUILDINGS[b.type]?.fields || this.world.fieldTiles?.has(b.id)) this.dirty.paint = true;
      else this.terrain.markBuilding(b, gone);
      this.dirty.doors = true;
    };
    this._h = {
      add: (b) => { this.addBuilding(b, true); local(b); this.dirty.nature = true; },
      remove: (b) => { this._dropPreview(b); this.removeBuilding(b); local(b, true); this.dirty.nature = true; },
      change: (b) => {
        // a finished site swaps to the real building with a puff of dust and
        // sparkle rather than the pop-up used for instant changes
        this._dropPreview(b);
        const prev = this.items.get(b.id);
        const finished = !!(prev && prev.site && !b.con);
        this.removeBuilding(b, true);
        this.addBuilding(b, !finished, true);
        local(b);
        // street trees and hedges leave room for the new front door; a farm's
        // crop rows and fences follow what it has become
        if (this.nature.dressed || BUILDINGS[b.type].fields) this.dirty.nature = true;
        if (finished) { const p = this.items.get(b.id).mesh.position; this.dust(p.x, b.baseY, p.z, b.size, true); }
      },
      roads: () => { this.dirty.roads = true; this.dirty.nature = true; this.dirty.paint = true; },
      rails: () => { this.dirty.roads = true; this.dirty.nature = true; this.dirty.paint = true; },
      refit: (b) => { if (!this.items.has(b.id)) return; this._dropPreview(b); this.removeBuilding(b, true); this.addBuilding(b, false); local(b); if (this.nature.dressed) this.dirty.nature = true; },
      trees: () => { this.dirty.nature = true; this.dirty.paint = true; },
      terrain: () => { this.dirty.terrain = true; this.dirty.roads = true; this.dirty.nature = true; },
      // the street lamps follow the town's power supply
      power: (sim) => { this.roads.lit = (x, z) => sim.lampLit(x, z); this.dirty.roads = true; },
      // power lines laid underground: their poles come down
      lines: () => { this.dirty.roads = true; },
      // streets dressed with trees, hedges, lamps or a planted median
      dress: () => { this.dirty.roads = true; this.dirty.nature = true; },
      // farmland added or taken out, or a farm growing something else
      fields: () => { this.dirty.paint = true; this.dirty.nature = true; },
    };
    world.on('building:add', this._h.add);
    world.on('building:remove', this._h.remove);
    world.on('building:change', this._h.change);
    world.on('building:refit', this._h.refit);
    world.on('roads', this._h.roads);
    world.on('rails', this._h.rails);
    world.on('trees', this._h.trees);
    world.on('terrain', this._h.terrain);
    world.on('power', this._h.power);
    world.on('lines', this._h.lines);
    world.on('dress', this._h.dress);
    world.on('fields', this._h.fields);
    this.fireflyTimer = 0;
    this.time = 0;
  }

  // The Effects setting: 'full', 'reduced' (about half the smoke, dust,
  // sparks, fireworks, snow and rain) or 'off'. Lit windows and lamps stay.
  setEffects(level) {
    const k = level === 'off' ? 0 : level === 'reduced' ? 0.5 : 1;
    this.effectsK = k;
    for (const p of [this.smoke, this.fx, this.weather]) p.keep = k;
  }

  // ----------------------------------------------------------- buildings
  addBuilding(b, animate = false, upgrade = false) {
    if (b.con) { this._addSite(b, animate); return; }
    const model = buildModel(b, { season: this.season, seasonW: this.seasonW, ground: this.groundFn, taken: this.takenFn });
    const mesh = new THREE.Mesh(model.geo, MAT.building);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(b.x, b.baseY, b.z);
    mesh.rotation.y = b.a;
    mesh.userData.buildingId = b.id;
    let spin = null;
    if (model.spin) {
      spin = new THREE.Mesh(model.spin.geo, MAT.building);
      spin.position.set(model.spin.x, model.spin.y, model.spin.z);
      spin.rotation.y = model.spin.ry || 0;
      spin.castShadow = true;
      spin.userData.buildingId = b.id;
      spin.userData.speed = model.spin.speed;
      mesh.add(spin);
    }
    this.group.add(mesh);
    mesh.updateMatrixWorld(true);
    const toWorld = (p) => new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(mesh.matrixWorld);
    const item = {
      b, mesh, spin,
      smoke: model.smoke.map(s => ({ ...toWorld(s), kind: s.kind, acc: Math.random() })),
      glows: model.glows.map(g => ({ ...toWorld(g), kind: g.kind, ground: b.baseY })),
      fountain: model.fountain ? toWorld({ x: model.fountain[0], y: model.fountain[1], z: model.fountain[2] }) : null,
      work: model.work,
    };
    // Outdoor work / wander area in world space, and where a park's visitors stroll to
    b.work = workArea(b);
    b.spots = model.spots && model.spots.length ? model.spots.map(p => { const v = toWorld({ x: p.x, y: 0, z: p.z }); return [v.x, v.z]; }) : null;
    b.door = this._doorOf(model, mesh, b);
    b.foot = model.foot;   // all it stands on, in world space
    b.open = !!model.open;   // open-air: villagers wander in it rather than going in
    // a gondola station's way up from the street and its deck, for its riders
    b.stair = model.stair ? model.stair.map(p => toWorld(p)) : null;
    b.deck = model.deck ? toWorld(model.deck) : null;
    // its benches (where a villager sits, and the way they face) and places to stand
    b.seats = model.seats ? model.seats.map(p => ({ ...toWorld(p), h: p.h + mesh.rotation.y, at: b.id })) : null;
    b.stand = model.stand ? model.stand.map(p => toWorld(p)) : null;
    this.items.set(b.id, item);
    if (animate) {
      mesh.scale.set(1, 0.01, 1);
      this.anims.push({ mesh, t: 0, dur: upgrade ? 0.55 : 0.7 });
      this.dust(mesh.position.x, b.baseY, mesh.position.z, b.size, upgrade);
    }
    this.dirty.glows = true;
  }

  // A building site: the finished model is kept and re-cut as work progresses.
  _addSite(b, animate) {
    const opts = { season: this.season, seasonW: this.seasonW, ground: this.groundFn, taken: this.takenFn };
    const con = b.con;
    const up = con.kind === 'upgrade';
    const target = buildModel(up ? { ...b, type: con.toType || b.type, level: con.to, look: con.look !== undefined ? con.look : b.look, flavor: con.flavor !== undefined ? con.flavor : b.flavor } : b, opts);
    const old = up ? buildModel(b, opts) : null;
    for (const m of [target, old]) if (m && m.spin) m.spin.geo.dispose();
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), MAT.site);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(b.x, b.baseY, b.z);
    mesh.rotation.y = b.a;
    mesh.userData.buildingId = b.id;
    this.group.add(mesh);
    const th = mesh.rotation.y, co = Math.cos(th), si = Math.sin(th), cx = mesh.position.x, cz = mesh.position.z;
    const t = this.world.terrain;
    const gy = (lx, lz) => t.heightAt(cx + lx * co + lz * si, cz - lx * si + lz * co) - b.baseY;
    const site = {
      target: target.geo, old: old ? old.geo : null, box: bodyBox(target.geo), oldBox: old ? bodyBox(old.geo) : null,
      gy, Ex: b.w / 2, Ez: b.d / 2, key: '', puff: 0,
    };
    const item = { b, mesh, spin: null, smoke: [], glows: [], fountain: null, work: null, site };
    b.work = workArea(b);
    b.spots = null;
    mesh.updateMatrixWorld(true);
    b.door = this._doorOf(old || target, mesh, b);
    b.foot = target.foot;
    b.open = !!(old || target).open;
    b.stair = b.deck = b.seats = b.stand = null;
    this.items.set(b.id, item);
    this._refreshSite(item);
    if (animate) this.dust(cx, b.baseY, cz, b.size, false);
    this.dirty.glows = true;
  }

  // The model's front door in world space, with its outward direction.
  _doorOf(model, mesh, b) {
    const d = model.door;
    if (!d) return null;
    const p = new THREE.Vector3(d.x, d.y, d.z).applyMatrix4(mesh.matrixWorld);
    const th = mesh.rotation.y, co = Math.cos(th), si = Math.sin(th);
    return { x: p.x, y: p.y, z: p.z, dx: d.dx * co + d.dz * si, dz: -d.dx * si + d.dz * co, ground: b.baseY };
  }

  _refreshSite(item) {
    const b = item.b, con = b.con, s = item.site;
    if (!con) return;
    const p = Math.min(1, con.done / Math.max(con.work, 1e-6));
    const key = `${con.kind}|${con.wait || ''}|${Math.floor(p * 48)}`;
    if (key === s.key) return;
    s.key = key;
    const geo = siteGeo({ target: s.target, old: s.old, box: s.box, oldBox: s.oldBox, kind: con.kind, p, wait: con.wait, Ex: s.Ex, Ez: s.Ez, gy: s.gy, seed: b.variant });
    item.mesh.geometry.dispose();
    item.mesh.geometry = geo;
  }

  removeBuilding(b, quiet = false) {
    const it = this.items.get(b.id);
    if (!it) return;
    this.group.remove(it.mesh);
    it.mesh.geometry.dispose();
    if (it.site) { it.site.target.dispose(); if (it.site.old) it.site.old.dispose(); }
    if (it.spin) it.spin.geometry.dispose();
    this.items.delete(b.id);
    if (!quiet) this.dust(it.mesh.position.x, b.baseY, it.mesh.position.z, b.size, false);
    this.dirty.glows = true;
  }

  // Show what an upgrade (in a chosen style) will look like, in place of the
  // building itself. spec: { type, level, look } or null to clear.
  setPreview(b, spec) {
    const key = b && spec ? `${b.id}|${spec.type}|${spec.level}|${spec.look}|${this.season}` : '';
    if (key === this._previewKey) return;
    this._previewKey = key;
    if (this.preview) {
      this.group.remove(this.preview.mesh);
      this.preview.mesh.geometry.dispose();
      const it = this.items.get(this.preview.id);
      if (it) it.mesh.visible = true;
      this.preview = null;
    }
    const it = b && spec ? this.items.get(b.id) : null;
    if (!it || it.site) return;
    const model = buildModel({ ...b, type: spec.type, level: spec.level, look: spec.look, con: null }, { season: this.season, seasonW: this.seasonW, ground: this.groundFn, taken: this.takenFn });
    if (model.spin) model.spin.geo.dispose();
    const mesh = new THREE.Mesh(model.geo, MAT.building);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.copy(it.mesh.position);
    mesh.rotation.copy(it.mesh.rotation);
    mesh.userData.buildingId = b.id;
    it.mesh.visible = false;
    this.group.add(mesh);
    this.preview = { id: b.id, mesh };
  }

  _dropPreview(b) { if (this.preview && this.preview.id === b.id) this.setPreview(null, null); }

  pickBuilding(raycaster) {
    const hits = raycaster.intersectObjects(this.group.children, true);
    for (const h of hits) {
      const id = h.object.userData.buildingId;
      if (id !== undefined) return this.world.buildings.get(id) || null;
    }
    return null;
  }

  // ------------------------------------------------------------- effects
  dust(x, y, z, size, sparkle) {
    for (let i = 0; i < 26 * size; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * 0.5 * size;
      this.smoke.emit({
        x: x + Math.cos(a) * r, y: y + 0.05, z: z + Math.sin(a) * r,
        vx: Math.cos(a) * 0.4, vy: 0.15 + Math.random() * 0.3, vz: Math.sin(a) * 0.4,
        drag: 2.5, wind: 0.2, life: 0.9 + Math.random() * 0.6, size: 0.12, size1: 0.35,
        r: 0.82, g: 0.76, b: 0.66, alpha: 0.6, alpha1: 0,
      });
    }
    if (sparkle) {
      for (let i = 0; i < 30; i++) {
        const a = Math.random() * Math.PI * 2;
        this.fx.emit({
          x: x + Math.cos(a) * 0.3 * size, y: y + 0.2 + Math.random() * 0.6, z: z + Math.sin(a) * 0.3 * size,
          vx: Math.cos(a) * 0.3, vy: 0.5 + Math.random() * 0.4, vz: Math.sin(a) * 0.3, gravity: -0.6, wind: 0,
          life: 1 + Math.random() * 0.6, size: 0.09, size1: 0.02, r: 1, g: 0.85, b: 0.4, alpha: 1, alpha1: 0,
        });
      }
    }
  }

  fireworks(x, y, z) {
    const colors = [[1, 0.4, 0.4], [0.5, 0.8, 1], [1, 0.9, 0.4], [0.7, 1, 0.5], [1, 0.6, 1]];
    for (let k = 0; k < 7; k++) {
      this.pending.push({
        at: this.time + k * 0.45 + Math.random() * 0.3,
        fn: () => {
          const cx = x + (Math.random() - 0.5) * 3, cy = y + 3 + Math.random() * 1.5, cz = z + (Math.random() - 0.5) * 3;
          const c = colors[(Math.random() * colors.length) | 0];
          for (let i = 0; i < 70; i++) {
            const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, s = 1.2 + Math.random() * 0.5;
            const q = Math.sqrt(1 - u * u);
            this.fx.emit({
              x: cx, y: cy, z: cz, vx: q * Math.cos(th) * s, vy: u * s, vz: q * Math.sin(th) * s,
              gravity: -0.8, drag: 1.2, wind: 0, life: 1.4 + Math.random() * 0.6,
              size: 0.12, size1: 0.03, r: c[0], g: c[1], b: c[2], alpha: 1, alpha1: 0,
            });
          }
        },
      });
    }
  }

  _rebuildGlows() {
    const statics = [];
    const pools = [];
    const add = (g, warm = true) => {
      statics.push({ x: g.x, y: g.y, z: g.z, size: g.kind === 'forge' ? 0.5 : 0.42, r: 1, g: g.kind === 'forge' ? 0.5 : 0.78, b: g.kind === 'forge' ? 0.15 : 0.42, a: g.kind === 'forge' ? 0.7 : 0.75, always: g.kind === 'forge' });
      if (warm && g.kind !== 'forge') pools.push([g.x, g.ground, g.z]);
    };
    for (const l of this.roads.lamps) add({ ...l, kind: 'lamp' });
    for (const it of this.items.values()) {
      // stopped: dark; no power: a dim lantern and no pool of light
      if (it.light === 'off') continue;
      for (const g of it.glows) {
        if (it.light === 'candle' && g.kind !== 'forge') statics.push({ x: g.x, y: g.y, z: g.z, size: 0.3, r: 1, g: 0.66, b: 0.32, a: 0.45 });
        else add(g);
      }
    }
    this.glow.setStatics(statics);
    // ground light pools
    const pos = [], uv = [];
    const t = this.world.terrain;
    for (const [x, gy, z] of pools) {
      const s = 0.55;
      const pts = [[x - s, z - s, 0, 0], [x - s, z + s, 0, 1], [x + s, z + s, 1, 1], [x - s, z - s, 0, 0], [x + s, z + s, 1, 1], [x + s, z - s, 1, 0]];
      for (const [px, pz, u, v] of pts) {
        const h = Math.max(gy, t.heightAt(px, pz)) + 0.05;
        pos.push(px, h, pz); uv.push(u, v);
      }
    }
    const g = this.pools.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.computeBoundingSphere();
  }

  // Windows and lamps follow each building's power and working state
  // (Sim._working): electric light, candles and lanterns without power, or
  // dark once its work has stopped.
  _syncLights() {
    for (const it of this.items.values()) {
      if (it.site) continue;
      const b = it.b;
      const light = !BUILDINGS[b.type].levels[b.level].housing && b.working === 0 && b.workers.length === 0 ? 'off'
        : b.working === 0 && (b.blockers || []).includes('power') ? 'off'
        : b.powered === false ? 'candle' : null;
      if (light === it.light) continue;
      it.light = light;
      const mat = light === 'off' ? MAT.buildingOff : light === 'candle' ? MAT.buildingCandle : MAT.building;
      it.mesh.material = mat;
      if (it.spin) it.spin.material = mat;
      this.dirty.glows = true;
    }
  }

  // The season, and how far it has turned towards the next (0 .. 1): the
  // ground, trees and farm crops are repainted in sixteen steps over the
  // turn, so it comes on gradually without repainting every frame.
  setSeason(s, w = 0) {
    const q = Math.round(w * 16) / 16;
    if (s === this.season && q === this.seasonW) return;
    this.season = s;
    this.seasonW = q;
    this.terrain.setSeason(s, q);
    this.nature.setSeason(s, q);
    // fountains on boulevards freeze over for the winter
    if (this.roads.setSeason(s, q)) this.dirty.roads = true;
    for (const it of [...this.items.values()]) if (it.b.type === 'farm') { this.removeBuilding(it.b, true); this.addBuilding(it.b, false); }
    // parks (and the seat of government, with its gardens) follow the
    // season in fewer steps, and are redrawn a few at a time over the next
    // frames (see update)
    const pk = s * PARK_SEASON_STEPS + Math.floor(q * PARK_SEASON_STEPS + 1e-6);
    if (pk !== this._parkSeason) {
      this._parkSeason = pk;
      for (const it of this.items.values()) if ((BUILDINGS[it.b.type].park || BUILDINGS[it.b.type].seat) && !it.site) this._reseason.add(it.b.id);
    }
  }

  update(dt, gameDt, env) {
    this.time += dt;
    U.uTime.value = this.time;
    if (this.dirty.terrain) { this.terrain.rebuild(); this.dirty.terrain = false; this.dirty.paint = false; }
    if (this.dirty.paint) { this.terrain.repaint(); this.dirty.paint = false; }
    else if (this.terrain.pending) this.terrain.repaintPending();
    if (this.dirty.doors && !this.dirty.roads) {
      if (this.roads.needsRebuild()) this.dirty.roads = true;
      else this.roads.rebuildDoors();
    }
    this.dirty.doors = false;
    if (this.dirty.roads) { this.roads.rebuild(); this.dirty.roads = false; this.dirty.glows = true; }
    if (this.dirty.nature) { this.nature.rebuild(); this.dirty.nature = false; }
    if (this.dirty.glows) { this._rebuildGlows(); this.dirty.glows = false; }

    // parks redrawn for the turn of the season, a few milliseconds' worth a frame
    if (this._reseason.size) {
      const t0 = performance.now();
      for (const id of this._reseason) {
        this._reseason.delete(id);
        const it = this.items.get(id);
        if (it && !it.site && this.preview?.id !== id) { this.removeBuilding(it.b, true); this.addBuilding(it.b, false); }
        if (performance.now() - t0 > 3) break;
      }
    }
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.time >= this.pending[i].at) { this.pending[i].fn(); this.pending.splice(i, 1); }
    }
    // building sites: re-cut as the work advances, kick up dust while crews work
    for (const it of this.items.values()) {
      if (!it.site) continue;
      this._refreshSite(it);
      const b = it.b;
      if (!b._crew || gameDt <= 0) continue;
      it.site.puff += dt * b._crew * 0.7 * Math.min(3, Math.sqrt(gameDt / Math.max(dt, 1e-4)));
      while (it.site.puff >= 1) {
        it.site.puff -= 1;
        const [px, pz] = toWorld(ownPlot(b), (Math.random() - 0.5) * b.w, (Math.random() - 0.5) * b.d);
        this.smoke.emit({
          x: px, y: b.baseY + 0.03 + Math.random() * 0.2, z: pz, vx: (Math.random() - 0.5) * 0.15, vy: 0.08, vz: (Math.random() - 0.5) * 0.15,
          drag: 2, wind: 0.3, life: 0.8 + Math.random() * 0.5, size: 0.05, size1: 0.18, r: 0.8, g: 0.74, b: 0.64, alpha: 0.42, alpha1: 0,
        });
      }
    }
    for (let i = this.anims.length - 1; i >= 0; i--) {
      const a = this.anims[i];
      a.t += dt;
      const k = Math.min(1, a.t / a.dur);
      a.mesh.scale.y = Math.max(0.01, easeOutBack(k));
      if (k >= 1) { a.mesh.scale.y = 1; this.anims.splice(i, 1); }
    }

    const hours = env.hours, night = env.night, season = env.season;
    this._syncLights();
    // chimney smoke
    if (gameDt > 0) {
      const homeRate = (hours > 6 && hours < 9.5) || (hours > 17 && hours < 23) ? 1.6 : (night > 0.5 ? 0.5 : 0.3);
      const seasonK = season === 3 ? 1.6 : season === 1 ? 0.6 : 1;
      const speedK = Math.min(3, gameDt / Math.max(dt, 1e-4));
      for (const it of this.items.values()) {
        // how well it works (Sim._working): stopped works have cold
        // chimneys, still wheels and a dry fountain
        const k = Math.min(1, it.b.working ?? 1), wet = !(it.b.blockers || []).includes('water');
        if (it.spin && k > 0) it.spin.rotation.z -= dt * it.spin.userData.speed * (0.4 + 0.6 * k) * Math.min(4, Math.max(0.25, speedK));
        if (it.fountain && k > 0 && wet) {
          // a steady jet, leaving room in the pool for the chimneys
          it.jet = (it.jet || 0) + dt * 40;
          if (this.smoke.items.length > this.smoke.max * 0.7) it.jet = 0;
          for (; it.jet >= 1; it.jet--) {
            const a = Math.random() * Math.PI * 2, s = 0.15 + Math.random() * 0.12;
            this.smoke.emit({
              x: it.fountain.x, y: it.fountain.y, z: it.fountain.z, vx: Math.cos(a) * s, vy: 0.55 + Math.random() * 0.2, vz: Math.sin(a) * s,
              gravity: -2.2, wind: 0, life: 0.55, size: 0.035, size1: 0.025, r: 0.85, g: 0.93, b: 1, alpha: 0.85, alpha1: 0.4,
            });
          }
        }
        if (!it.smoke.length) continue;
        const working = k > 0 && it.b.workers.length > 0 && hours > 6.5 && hours < 19.5;
        const idle = k > 0 ? 1 : 0;
        for (const s of it.smoke) {
          const rate = s.kind === 'home' ? homeRate * seasonK * (it.b.residents.length ? 1 : 0)
            : s.kind === 'heavy' ? (working ? 3.5 * (0.4 + 0.6 * k) : 0.4 * idle) : (working ? 1.6 * (0.4 + 0.6 * k) : 0.25 * idle);
          s.acc += dt * rate * Math.sqrt(speedK);
          while (s.acc >= 1) {
            s.acc -= 1;
            const dark = s.kind === 'heavy' ? 0.55 : 0.88;
            const shade = dark * (1 - night * 0.65);
            this.smoke.emit({
              x: s.x + (Math.random() - 0.5) * 0.02, y: s.y, z: s.z + (Math.random() - 0.5) * 0.02,
              vx: (Math.random() - 0.5) * 0.03, vy: 0.14 + Math.random() * 0.06, vz: (Math.random() - 0.5) * 0.03,
              drag: 0.6, wind: 1, life: 3.5 + Math.random() * 2,
              size: 0.06, size1: s.kind === 'heavy' ? 0.42 : 0.3, r: shade, g: shade, b: shade * 1.03,
              alpha: s.kind === 'heavy' ? 0.6 : 0.45, alpha1: 0, fadeIn: 0.1,
            });
          }
        }
      }
    }

    // fireflies on warm nights
    if (night > 0.6 && season <= 2) {
      this.fireflyTimer += dt;
      while (this.fireflyTimer > 0.08) {
        this.fireflyTimer -= 0.08;
        const tg = this.R.rig.target;
        const x = tg.x + (Math.random() - 0.5) * 22, z = tg.z + (Math.random() - 0.5) * 22;
        if (!this.world.inBounds(x, z) || !this.world.treesNear(x, z, 0.7).length) continue;
        this.fx.emit({
          x, y: this.world.terrain.heightAt(x, z) + 0.15 + Math.random() * 0.4, z,
          vx: (Math.random() - 0.5) * 0.1, vy: (Math.random() - 0.5) * 0.04, vz: (Math.random() - 0.5) * 0.1,
          wind: 0, life: 4 + Math.random() * 3, size: 0.07, size1: 0.07, r: 0.75, g: 1, b: 0.35,
          alpha: 0.9, alpha1: 0.9, blink: 3 + Math.random() * 3, phase: Math.random() * 6, fadeIn: 0.2,
        });
      }
    }

    // snowfall
    if (env.snowing) {
      const tg = this.R.rig.target;
      const n = Math.floor(dt * 70) + (Math.random() < (dt * 70) % 1 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        this.weather.emit({
          x: tg.x + (Math.random() - 0.5) * 28, y: tg.y + 5 + Math.random() * 2, z: tg.z + (Math.random() - 0.5) * 28,
          vx: 0.1, vy: -0.55 - Math.random() * 0.2, vz: 0.05, wind: 0.6, life: 10,
          size: 0.045, size1: 0.045, r: 1, g: 1, b: 1, alpha: 0.9, alpha1: 0.9, fadeIn: 0.1,
        });
      }
    }

    // rain
    this.rain.update(dt, (env.rain || 0) * this.effectsK, this.R.rig.target);

    const scale = this.R.pixelsPerUnit();
    const windK = [0.12, 0.05];
    this.smoke.update(dt, scale, 1, windK);
    this.glow.update(dt, scale, night, windK);
    this.fx.update(dt, scale, 1, windK);
    this.weather.update(dt, scale, 1, windK);
    this.pools.material.opacity = Math.max(0, night - 0.2) * 0.55;
  }

  dispose() {
    this.terrain.dispose(); this.roads.dispose(); this.nature.dispose(); this.overlay.dispose();
    for (const it of this.items.values()) {
      it.mesh.geometry.dispose();
      if (it.spin) it.spin.geometry.dispose();
      if (it.site) { it.site.target.dispose(); if (it.site.old) it.site.old.dispose(); }
    }
    this.scene.remove(this.group, this.pools);
    this.pools.geometry.dispose();
    for (const p of [this.smoke, this.glow, this.fx, this.weather]) p.dispose(this.scene);
    this.rain.dispose();
  }
}

