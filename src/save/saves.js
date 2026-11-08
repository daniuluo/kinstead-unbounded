// Save format + local (browser) save slots + file export/import.

import { World, ownPlot } from '../world/world.js';
import { Terrain } from '../world/terrain.js';
import { Net } from '../world/net.js';
import { BUILDINGS, TECHS } from '../defs.js';
import { titleFor, dressValid } from '../config.js';
import { rect, roundAngle } from '../world/geom.js';
import { fromGrid } from './fromGrid.js';
import { cleanText, cleanColor, hasKey, newTownId, isTownId } from '../util/text.js';
import { pack, unpack } from './pack.js';

export const SAVE_FORMAT = 'hearthvale-save';   // the game's old name, kept so every save still loads
// 2: the town without a grid (roads and track as networks of curves,
// plots anywhere at any angle). Version 1 saves (on squares) are made over
// as they load (fromGrid.js).
export const SAVE_VERSION = 2;

function toB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b) {
  const s = atob(b);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

export function serialize(world) {
  const H = world.terrain.H;
  const q = new Int16Array(H.length);
  for (let i = 0; i < H.length; i++) q[i] = Math.round(H[i] * 1000);
  const trees = [];
  for (const t of world.trees) trees.push(Math.round(t.x * 100), Math.round(t.z * 100), t.k, Math.round(t.s * 100), Math.round(t.r * 100));
  return {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    name: world.townName,
    townId: world.townId || null,
    seed: world.seed,
    N: world.N,
    heights: toB64(new Uint8Array(q.buffer)),
    // the networks of roads and track: { n: nodes, e: edges } (net.js toRec)
    roads: world.roads.toRec(),
    rails: world.rails.toRec(),
    // farm fields: [id, farm, x, z, a]
    ...(world.parcels.size ? { fields: [...world.parcels.values()].map(f => [f.id, f.farm, f.x, f.z, f.a]) } : {}),
    // [id, type, level, x, z (its middle), variant, a (the way it faces), built, w, d (along the street and deep), flavor, con, leases, look, spare]
    buildings: [...world.buildings.values()].map(b => [b.id, b.type, b.level, b.x, b.z, b.variant, b.a, b.built, b.w, b.d, b.flavor || null, b.con || null, b.leases && b.leases.length ? b.leases : null, b.look || null, b.spare ? [b.spare.w, b.spare.d, ...(b.spare.sx != null ? [b.spare.sx, b.spare.sz] : [])] : null]),
    trees,
    residents: [...world.residents.values()].map(r => [r.id, r.first, r.last, r.age, r.home ?? -1, r.job ?? -1, r.look, r.wealth ?? null, r.fam ?? null, r.years != null ? Math.round(r.years * 100) / 100 : null, r.edu ?? null, r.edYrs ?? null]),
    lines: world.lines.map(l => ({ id: l.id, mode: l.mode, name: l.name, color: l.color, stops: l.stops.slice(), vehicles: l.vehicles })),
    state: {
      money: Number.isFinite(world.money) ? world.money : 0, sandbox: world.sandbox, taxRate: world.taxRate, day: world.day, hours: world.hours, nextId: world.nextId,
      entry: world.entry, history: world.history, titleIdx: world.titleIdx, stats: world.stats, research: world.research, eduScale: 5,
    },
    meta: { day: world.day, pop: world.population, money: Number.isFinite(world.money) ? Math.round(world.money) : '∞', title: titleFor(world.population).name },
  };
}

export function deserialize(data) {
  if (!data || data.format !== SAVE_FORMAT) throw new Error('This file is not a Kinstead save.');
  if (data.version > SAVE_VERSION) throw new Error('This save was made by a newer version of Kinstead.');
  // a town laid out on squares: made over as a gridless one first
  if (!(data.version >= 2)) data = fromGrid(data);
  const N = data.N;
  const raw = fromB64(data.heights);
  const q = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const H = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) H[i] = q[i] / 1000;
  const w = new World(N, data.seed, new Terrain(N, H));
  w.townName = cleanText(data.name, 40) || 'Kinstead';
  w.townId = isTownId(data.townId) ? data.townId : newTownId();
  w.roads = Net.fromRec(data.roads, 'road');
  w.rails = Net.fromRec(data.rails, 'rail');
  for (const e of w.roads.edges.values()) if (!dressValid(e.dress)) e.dress = 0;
  const tr = data.trees || [];
  for (let i = 0; i + 4 < tr.length; i += 5) w.addTree(tr[i] / 100, tr[i + 1] / 100, tr[i + 2], tr[i + 3] / 100, tr[i + 4] / 100);
  for (let [id, type, level, x, z, variant, a, built, bw, bd, flavor, con, leases, look, spare] of data.buildings) {
    if (type === 'house' && level >= 2) [type, level] = level === 2 ? ['flats', 0] : ['villa', level - 2];
    if (!hasKey(BUILDINGS, type) || ![x, z].every(Number.isFinite)) continue;
    w.restoreBuilding({ id, type, level, x, z, variant, a: Number.isFinite(a) ? a : 0, built, w: bw, d: bd, flavor, con, leases, look, spare });
  }
  const oldEdu = (data.state && data.state.eduScale) !== 5;
  for (const [id, first, last, age, home, job, look, wealth, fam, years, edu, edYrs] of data.residents) {
    const r = { id, first: cleanText(first, 24), last: cleanText(last, 24), age, home: home >= 0 ? home : null, job: job >= 0 ? job : null, look, mood: 60 };
    if (wealth != null) r.wealth = wealth;
    if (fam != null) r.fam = fam;
    if (years != null) r.years = years;
    // saves before the five-stage scale: primary → elementary, secondary → high school, advanced → college
    if (edu != null) r.edu = oldEdu ? [0, 1, 3, 4][edu] ?? edu : edu;
    if (edYrs && typeof edYrs === 'object') r.edYrs = edYrs;
    w.residents.set(id, r);
  }
  w.lines = (Array.isArray(data.lines) ? data.lines : []).map(l => ({ ...l, name: cleanText(l.name, 40), color: cleanColor(l.color), stops: (Array.isArray(l.stops) ? l.stops : []).filter(s => w.buildings.has(s)) }));
  const s = data.state;
  Object.assign(w, {
    money: s.money, taxRate: s.taxRate, day: s.day, hours: s.hours, nextId: s.nextId,
    entry: s.entry && w.roads.nodes.has(s.entry.node) ? { node: s.entry.node, x: w.roads.nodes.get(s.entry.node).x, z: w.roads.nodes.get(s.entry.node).z } : { node: -1, x: 0, z: 0 },
    history: s.history || [], titleIdx: s.titleIdx || 0,
  });
  Object.assign(w.stats, s.stats || {});
  if (s.sandbox) w.setSandbox(s.sandbox);
  // saves from before research existed keep everything they could already build
  if (s.research) w.research = { done: [], current: null, progress: 0, bank: 0, ...s.research };
  else w.research.done = Object.keys(TECHS);
  // farmland, for the farms that are there, on ground nothing else stands on
  if (Array.isArray(data.fields)) {
    for (const [id, farm, x, z, a] of data.fields) {
      const b = w.buildings.get(farm);
      if (!b || !BUILDINGS[b.type].fields || ![id, x, z].every(Number.isFinite)) continue;
      if (w._plotBlock(rect(x, z, a || 0, 0.5, 0.5), { fields: true })) continue;
      w._addField(farm, x, z, a || 0, id);
    }
  }
  w._countFields();
  w.updateRoadNetwork();
  // (a town made over from squares: a building that no longer reaches its
  // street turns to face the nearest, where it can)
  if (data.refaced) {
    for (const b of w.buildings.values()) {
      if (b.access || BUILDINGS[b.type].park) continue;
      const a = w.faceRoad(b.x, b.z, 1.6);
      if (a == null) continue;
      const R = ownPlot({ ...b, a });
      if (w.accessFor(R) && !w._plotBlock(R, { except: [b], fields: true })) { b.a = roundAngle(a); w._file(b); }
    }
    w.updateRoadNetwork();
  }
  w.updateRailLinks();
  return w;
}

// ------------------------------------------------------------ local slots

const INDEX_KEY = 'hearthvale.saves.v1';
const SLOT_KEY = (id) => `hearthvale.slot.${id}`;

export const LocalSaves = {
  list() {
    try { return JSON.parse(localStorage.getItem(INDEX_KEY) || '[]'); } catch { return []; }
  },
  _writeIndex(idx) { localStorage.setItem(INDEX_KEY, JSON.stringify(idx)); },
  save(id, data, thumb) {
    const idx = this.list().filter(e => e.id !== id);
    // packed to about a third (src/save/pack.js), so big towns fit in the browser
    const text = pack(JSON.stringify(data));
    const entry = { id, name: data.name, town: data.townId || null, day: data.meta.day, pop: data.meta.pop, money: data.meta.money, title: data.meta.title, savedAt: data.savedAt, thumb: thumb || null };
    try {
      localStorage.setItem(SLOT_KEY(id), text);
      idx.unshift(entry);
      this._writeIndex(idx);
    } catch (e) {
      // Out of space: retry without thumbnails.
      try {
        for (const x of idx) x.thumb = null;
        entry.thumb = null;
        localStorage.setItem(SLOT_KEY(id), text);
        idx.unshift(entry);
        this._writeIndex(idx);
      } catch {
        throw new Error('Browser storage is full. Delete an old save or export to a file.');
      }
    }
    return entry;
  },
  load(id) {
    const s = localStorage.getItem(SLOT_KEY(id));
    if (!s) throw new Error('Save not found.');
    return JSON.parse(unpack(s));
  },
  remove(id) {
    localStorage.removeItem(SLOT_KEY(id));
    this._writeIndex(this.list().filter(e => e.id !== id));
  },
  has(id) { return !!localStorage.getItem(SLOT_KEY(id)); },
  // Copy one slot to another (quietly does nothing if storage is full).
  copy(from, to) {
    const s = localStorage.getItem(SLOT_KEY(from)), e = this.list().find(x => x.id === from);
    if (!s || !e) return false;
    try {
      localStorage.setItem(SLOT_KEY(to), s);
      this._writeIndex([...this.list().filter(x => x.id !== to), { ...e, id: to }]);
      return true;
    } catch { return false; }
  },
};

export function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function readJSONFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => { try { resolve(JSON.parse(fr.result)); } catch { reject(new Error('That file is not valid JSON.')); } };
    fr.onerror = () => reject(fr.error);
    fr.readAsText(file);
  });
}

export function saveFileName(world) {
  return fileNameOf(world.townName, world.day);
}

// File name for an already-serialized save (e.g. a browser slot).
export function saveFileNameFor(data) {
  return fileNameOf(data.name || 'town', data.meta?.day ?? data.state?.day ?? 1);
}

function fileNameOf(name, day) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'town';
  return `${slug}-day${day}.kinstead.json`;
}
