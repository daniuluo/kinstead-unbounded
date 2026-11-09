// Transit: horse-drawn coach lines on roads, steam trains on rails, gondola
// cabins on a cable slung straight from station to station, and delivery
// carts trundling from farms and workshops to the shops.

import * as THREE from 'three';
import { BUILDINGS, TRANSIT, LINE_COLORS, GONDOLA_COLORS, stopOf } from '../defs.js';
import { CONFIG } from '../config.js';
import { GeoBuilder } from '../render/geo.js';
import { MAT } from '../render/materials.js';
import { routeCentre, offsetPath, smoothPolyline, untangle, thin } from './path.js';
import { bridgeDeckY, isOpen, plotOf, ownPlot, HALF } from '../world/world.js';
import { rect, rectsOverlap, aabbOf, toWorld, angleOf, angDiff } from '../world/geom.js';

const WARM = [1.7, 1.2, 0.55];

// A horse's body, head and tail; its legs are separate pieces (horseLegs) so
// they can trot.
const LEGS = [[-0.025, 0.06], [0.025, 0.06], [-0.025, -0.06], [0.025, -0.06]];
const LEG_H = 0.08;
// legs swing this far either way; the gait advances with distance so that
// hooves on the ground don't slide
const LEG_SWING = 0.45, GAIT_PER_TILE = 1 / (LEG_H * LEG_SWING);
const COACH_HORSE = { z: 0.26, color: '#7a5232' }, CART_HORSE = { z: 0.22, color: '#8a6542' };

function horse(gb, x, z, color = '#7a5232') {
  gb.push(x, 0, z, 0);
  gb.box(0, 0.075, 0, 0.07, 0.07, 0.17, color);
  gb.box(0, 0.12, 0.1, 0.045, 0.07, 0.05, color, 0, -0.5);
  gb.box(0, 0.15, 0.14, 0.04, 0.035, 0.07, color);
  gb.box(0, 0.12, 0.07, 0.012, 0.06, 0.05, '#3a2a1f', 0, -0.4);
  gb.box(0, 0.09, -0.09, 0.012, 0.05, 0.012, '#3a2a1f', 0, 0.6);
  gb.pop();
}

function wheels(gb, z, w, r = 0.04, color = '#3a2a1f') {
  for (const sx of [-1, 1]) gb.cyl(sx * (w + 0.008), r, z, r, r, 0.015, 8, color, 0, 0, Math.PI / 2);
}

function coachModel(color) {
  const gb = new GeoBuilder();
  horse(gb, 0, COACH_HORSE.z, COACH_HORSE.color);
  gb.box(0, 0.09, 0.16, 0.014, 0.014, 0.12, '#5b4231');
  gb.box(0, 0.06, -0.02, 0.18, 0.17, 0.34, color);
  gb.box(0, 0.23, -0.02, 0.2, 0.025, 0.37, '#3a3a3e');
  gb.box(0, 0.06, -0.02, 0.19, 0.025, 0.35, '#3a2a1f');
  for (const sx of [-1, 1]) for (const z of [-0.1, 0.05]) {
    gb.glow(WARM[0], WARM[1], WARM[2], 1.15);
    gb.box(sx * 0.091, 0.13, z, 0.006, 0.06, 0.09, '#34475b');
    gb.noGlow();
  }
  gb.box(0, 0.2, 0.15, 0.12, 0.012, 0.06, '#3a2a1f');
  gb.cyl(0, 0.212, 0.14, 0.022, 0.026, 0.05, 6, '#2f3640');
  gb.sphere(0, 0.275, 0.14, 0.02, '#f1c8a5');
  gb.cyl(0, 0.29, 0.14, 0.028, 0.028, 0.012, 8, '#2b1d14');
  wheels(gb, 0.08, 0.09); wheels(gb, -0.12, 0.09, 0.05);
  gb.glow(2.2, 1.6, 0.8, 3.0); gb.box(0.1, 0.16, 0.13, 0.02, 0.03, 0.02, '#ffe2a0'); gb.noGlow();
  return gb.build();
}

function cartModel(cargo) {
  const gb = new GeoBuilder();
  horse(gb, 0, CART_HORSE.z, CART_HORSE.color);
  gb.box(0, 0.06, -0.04, 0.17, 0.05, 0.26, '#8a6542');
  for (const sx of [-1, 1]) gb.box(sx * 0.085, 0.11, -0.04, 0.01, 0.04, 0.26, '#7a5636');
  gb.box(0, 0.11, -0.17, 0.17, 0.04, 0.01, '#7a5636');
  if (cargo === 'logs') for (let i = 0; i < 3; i++) gb.cyl(-0.05 + i * 0.05, 0.13, -0.17, 0.022, 0.022, 0.26, 6, '#7a5636', 0, Math.PI / 2);
  else if (cargo === 'hay') gb.blob(0, 0.14, -0.04, 0.08, 0.06, 0.12, '#d9b44a');
  else if (cargo === 'fish') { gb.box(0, 0.11, -0.04, 0.14, 0.04, 0.2, '#9fb2bd'); }
  else if (cargo === 'materials') {
    // a building on the move: beams, stone blocks and a stack of roof tiles
    for (let i = 0; i < 3; i++) gb.box(-0.045 + i * 0.045, 0.11, -0.04, 0.035, 0.03, 0.3, '#a8855a');
    for (let i = 0; i < 2; i++) gb.box(0, 0.14 + i * 0.035, -0.12 + i * 0.03, 0.12, 0.035, 0.06, '#b3a996');
    gb.box(0, 0.14, 0.03, 0.1, 0.05, 0.07, '#9c4a32');
  }
  else for (let i = 0; i < 3; i++) gb.box(0, 0.11 + (i % 2) * 0.05, -0.12 + i * 0.07, 0.07, 0.05, 0.06, '#a47c4f');
  gb.box(0, 0.09, 0.12, 0.012, 0.012, 0.1, '#5b4231');
  wheels(gb, -0.04, 0.095, 0.045);
  return gb.build();
}

function engineModel() {
  const gb = new GeoBuilder();
  gb.box(0, 0.035, 0, 0.17, 0.03, 0.46, '#2c2c30');
  gb.cyl(0, 0.13, -0.1, 0.07, 0.07, 0.3, 10, '#2f5a3a', 0, Math.PI / 2);
  gb.cyl(0, 0.13, 0.181, 0.06, 0.06, 0.012, 10, '#2c2c30', 0, Math.PI / 2);
  gb.cyl(0, 0.19, 0.14, 0.022, 0.03, 0.09, 8, '#2c2c30');
  gb.cyl(0, 0.2, 0.0, 0.025, 0.025, 0.035, 8, '#c9a43a');
  gb.box(0, 0.065, -0.17, 0.18, 0.2, 0.13, '#2f5a3a');
  gb.box(0, 0.265, -0.17, 0.2, 0.02, 0.16, '#2c2c30');
  for (const sx of [-1, 1]) { gb.glow(WARM[0], WARM[1], WARM[2], 1.1); gb.box(sx * 0.091, 0.17, -0.17, 0.006, 0.05, 0.06, '#34475b'); gb.noGlow(); }
  gb.box(0, 0.035, 0.24, 0.17, 0.03, 0.03, '#b5533a');
  gb.glow(2.4, 1.9, 1.0, 3.0); gb.cyl(0, 0.12, 0.19, 0.022, 0.022, 0.01, 8, '#ffe2a0', 0, Math.PI / 2); gb.noGlow();
  for (const z of [0.13, 0.0, -0.13]) wheels(gb, z, 0.075, 0.042, '#a8432f');
  return gb.build();
}

function carriageModel(color) {
  const gb = new GeoBuilder();
  gb.box(0, 0.03, 0, 0.17, 0.03, 0.5, '#2c2c30');
  gb.box(0, 0.06, 0, 0.18, 0.17, 0.48, color);
  gb.roof(0, 0.23, 0, 0.5, 0.2, 0.04, 0.5, '#4a4a50', Math.PI / 2);
  for (const sx of [-1, 1]) for (let k = 0; k < 4; k++) {
    gb.glow(WARM[0], WARM[1], WARM[2], 1.05 + k * 0.05);
    gb.box(sx * 0.091, 0.13, -0.17 + k * 0.115, 0.006, 0.06, 0.07, '#34475b');
    gb.noGlow();
  }
  for (const z of [0.16, -0.16]) wheels(gb, z, 0.075, 0.035, '#2c2c30');
  return gb.build();
}

// A gondola cabin, hung from its grip on the cable (the origin), after the
// cabins of La Paz's Mi Teleférico: a rounded body in the line's colour up
// to the sills, a pale band along them, big windows all round between posts
// in the colour, a door in one side, a rounded roof in the colour with a fan
// cowl on it, lights inside and at each end, lit all night, and over it the
// hanger, a tube about as long as the cabin is tall sweeping up from the
// middle of the roof to the grip and its running wheels on the cable, a
// little to the outside of the rope (the cabin's right, away from the
// towers' sheaves, which run to the left of the line, its cable to the
// right). Its floor is G_HANG below the cable. A cabin holds six villagers standing, two across and
// three deep (each about 0.07 round, a grown-up 0.15 tall), and passes the
// pylons' masts and a cabin on the other cable (2 G_OFF over) with room
// between: H high, W across, D long, its panels up to SILL, walls T thick.
const CABIN = { H: 0.19, W: 0.16, D: 0.24, SILL: 0.06, T: 0.008 };
const CAB_DARK = '#26292c', CAB_FRAME = '#33383c', CAB_METAL = '#c4cacd', CAB_BAND = '#f1f0ea';
function cabinModel(color) {
  const gb = new GeoBuilder();
  const F = -G_HANG, { H, W, D, SILL, T } = CABIN, top = F + H;
  // the grip on the cable, its two running wheels, and the hanger down to
  // the roof, swept a little forward and back in
  gb.box(-0.006, -0.016, 0, 0.022, 0.028, 0.07, CAB_DARK);
  for (const z of [-0.026, 0.026]) gb.cyl(-0.014, 0.002, z, 0.011, 0.011, 0.016, 8, CAB_DARK, 0, 0, Math.PI / 2);
  gb.boxC(-0.01, -0.03, 0.006, 0.012, 0.03, 0.012, CAB_METAL, 0.35);
  gb.cyl(-0.01, top + 0.03, 0.012, 0.006, 0.006, -0.042 - (top + 0.03), 6, CAB_METAL);
  gb.boxC(-0.006, top + 0.022, 0.006, 0.01, 0.026, 0.01, CAB_METAL, -0.5);
  // the roof, rounded, and a fan cowl on it
  gb.cbox(0, top - 0.006, 0, W + 0.012, 0.024, D + 0.012, color, 0, 0.011);
  gb.cbox(0, top + 0.016, -0.05, 0.07, 0.012, 0.06, CAB_BAND, 0, 0.005);
  // the floor and the skirt under it, dark and rounded
  gb.cbox(0, F - 0.02, 0, W + 0.004, 0.024, D + 0.004, CAB_DARK, 0, 0.009);
  // the body to the sills, and a pale band along them
  for (const sd of [-1, 1]) {
    gb.box(0, F, sd * (D / 2 - T / 2), W, SILL, T, color);
    gb.box(sd * (W / 2 - T / 2), F, 0, T, SILL, D, color);
    gb.box(0, F + SILL - 0.009, sd * (D / 2 - T / 2), W + 0.003, 0.009, T + 0.003, CAB_BAND);
    gb.box(sd * (W / 2 - T / 2), F + SILL - 0.009, 0, T + 0.003, 0.009, D + 0.003, CAB_BAND);
  }
  // the window frames: a post at each corner and a rail under the roof, one
  // big pane in each end; in one long side the door, between two posts, and
  // a post in the middle of the other (all in the colour, part of the body)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) gb.cbox(sx * (W / 2 - 0.007), F, sz * (D / 2 - 0.007), 0.016, H, 0.016, color, 0, 0.004);
  for (const sd of [-1, 1]) {
    gb.box(0, top - 0.016, sd * (D / 2 - T / 2), W, 0.01, T + 0.002, CAB_FRAME);
    gb.box(sd * (W / 2 - T / 2), top - 0.016, 0, T + 0.002, 0.01, D, CAB_FRAME);
  }
  for (const z of [-0.085, 0.005]) gb.box(W / 2 - T / 2, F, z, T + 0.003, H, 0.012, color);
  gb.box(-W / 2 + T / 2, F, 0, T + 0.003, H, 0.012, color);
  // the door's two leaves meet over a handle in the panel under the window
  gb.box(W / 2 - T / 2 + 0.002, F + 0.006, -0.04, 0.004, SILL - 0.016, 0.002, CAB_FRAME);
  gb.box(W / 2 - T / 2 + 0.002, F + SILL * 0.5, -0.03, 0.005, 0.004, 0.008, CAB_METAL);
  // its lights, lit all night: a panel along the ceiling and the floor warm
  // in its light, seen through the glass, and a lamp at each end under the
  // roof, white ahead and red behind
  gb.glow(WARM[0], WARM[1], WARM[2], 3.1);
  gb.box(0, top - 0.022, 0, 0.05, 0.006, D - 0.06, '#ffe9b8');
  gb.noGlow();
  gb.glow(1.5, 1.1, 0.55, 3.1);
  gb.box(0, F + 0.004, 0, W - 0.03, 0.003, D - 0.03, '#7d7b76');
  gb.noGlow();
  for (const sd of [-1, 1]) {
    gb.glow(...(sd > 0 ? [2.2, 2.0, 1.7] : [2.4, 0.35, 0.25]), 3.1);
    gb.box(0, top - 0.032, sd * (D / 2 + 0.005), 0.03, 0.014, 0.006, sd > 0 ? '#fff6e0' : '#ff5a46');
    gb.noGlow();
  }
  return gb.build();
}

// A cabin's windows: a pane of clear glass in each side between the sills,
// the corner posts and the rail, drawn see-through (MAT.glass) so the riders
// show through it.
function cabinGlass() {
  const gb = new GeoBuilder();
  const F = -G_HANG, { H, W, D, SILL, T } = CABIN, y0 = F + SILL, h = H - SILL - 0.018;
  for (const sd of [-1, 1]) {
    gb.box(0, y0, sd * (D / 2 - T / 2), W - 0.03, h, 0.003, '#ffffff');
    gb.box(sd * (W / 2 - T / 2), y0, 0, 0.003, h, D - 0.03, '#ffffff');
  }
  return gb.build();
}

// A tower under a gondola line, as Mi Teleférico's: a pale steel tube
// tapering up from a round concrete footing, a band of the line's colour
// round its top, and across the top a crossarm with a walkway and a rail
// along it, a train of four sheaves under each rope and a red lamp, lit at
// night. p: where it stands (x, z, the ground g), the cable's height there
// (h) and the line's heading (ry).
const SHEAVE = '#2b2b2e', TOWER = '#e3e5e4', TOWER_D = '#a9b0b4';
function pylon(gb, p, color) {
  const H = p.h - p.g;
  gb.push(p.x, p.g, p.z, p.ry);
  gb.cyl(0, -0.12, 0, 0.1, 0.12, 0.16, 10, '#b3ada2');
  gb.cyl(0, 0, 0, 0.03, 0.058, H - 0.06, 12, TOWER);
  gb.cyl(0, H - 0.36, 0, 0.034, 0.036, 0.09, 12, color);
  gb.box(0, H - 0.08, 0, 0.07, 0.045, 0.07, TOWER_D);
  // the crossarm just under the ropes, inside them, its walkway and rail
  // (a cabin's roof passes a little lower, its hanger outside the sheaves)
  const A = 2 * G_OFF - 0.05;
  gb.box(0, H - 0.045, 0, A, 0.03, 0.05, TOWER_D);
  gb.box(0, H - 0.015, 0, A, 0.005, 0.1, TOWER_D);
  for (const sd of [-1, 1]) {
    gb.box(0, H + 0.028, sd * 0.048, A, 0.005, 0.005, TOWER_D);
    for (const u of [-0.5, 0, 0.5]) gb.box(u * A, H - 0.01, sd * 0.048, 0.005, 0.04, 0.005, TOWER_D);
  }
  // under each rope, a rocker and its train of sheaves, the rope on them
  for (const sd of [-1, 1]) {
    gb.box(sd * (G_OFF - 0.012), H - 0.04, 0, 0.01, 0.012, 0.2, '#5d6266');
    for (let k = 0; k < 4; k++) gb.cyl(sd * (G_OFF - 0.012) - 0.006, H - 0.014, -0.075 + k * 0.05, 0.012, 0.012, 0.012, 8, SHEAVE, 0, 0, Math.PI / 2);
  }
  gb.glow(2.6, 0.45, 0.3, 2.6);
  gb.sphere(0, H + 0.045, 0, 0.011, '#ff5a46');
  gb.noGlow();
  gb.pop();
}
const CABLE_MAT = new THREE.LineBasicMaterial({ color: '#26282b' });

const CARGO = { farm: 'hay', lumber: 'logs', fishery: 'fish', workshop: 'crates' };
// Coaches and carts keep this far to the right of the middle of the road,
// clear of an oncoming one and of the villagers walking at its edge.
const LANE = 0.13;
// What a vehicle takes up, as a box along its heading: [ahead of its middle,
// behind it, half its width]; a train's engine and each carriage its own.
const BODY = { coach: [0.33, 0.21, 0.105], cart: [0.3, 0.17, 0.09], rail: [0.25, 0.25, 0.09], cabin: [0.12, 0.12, 0.08] };
// the gap a vehicle keeps behind one ahead, and in front of a villager; how
// long one waits before it looks for a ring of them stuck (see _ring); how
// far through a junction it claims its way (_through); how far it backs up
const GAP = 0.05, GAP_FOOT = 0.04, RING_WAIT = 3, THROUGH = 2.5, BACK = 0.35;
// how long a goods cart stuck in such a ring waits before it finds another way
const CART_GIVE_UP = 30;
let serial = 0;
const CAR_SPACING = 0.56;   // distance between train car centres along the track
// the sharpest a train may turn through a switch or a joint in the track
const RAIL_TURN = (60 * Math.PI) / 180;
// Gondolas: the two cables run G_OFF either side of the line, G_CABLE above a
// station's floor (its deck is level with a cabin's floor, G_HANG lower; see
// MODELS.gondola), or up to G_LIFT higher where a station stands taller to
// clear its neighbours (b.lift). Pylons stand about G_SPAN apart, never more
// than G_MAXH tall, and hold the cable G_GROUND above the ground and G_ROOF
// above the roofs it passes over, so the cabins clear them; between them
// it sags a little (sagOf a span's length). A cabin hangs straight down on
// its hanger, about as long as the cabin is tall, while the cable climbs
// past it; no span is steeper than G_STEEP, so the cable always clears its
// roof, end to end. Through a station the cable runs level, G_LEVEL out
// from where it turns or bends, so where it crosses itself there (on a sharp
// bend) it crosses level, the cabins passing under it.
// what a trip by gondola costs on top, in tiles of level walking (see plan):
// up a station's stairs or down them; and changing lines, across a deck
const STATION_STAIRS = 1.2, CHANGE = 1;
// An interchange's berths: the middle of each quarter of its deck, from the
// middle of its plot (see berthPoint)
const HUB_BERTHS = [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]];
// (how far apart two lines' cables must hang: their cabins clear of each other)
const CABLES_APART = 2 * 0.14 + CABIN.W + 0.06;
const G_OFF = 0.14, G_CABLE = 1.14, G_HANG = 0.36, G_LIFT = 3.5, G_SPAN = 6, G_MAXH = 6, G_GROUND = 1.14, G_ROOF = 0.51, G_STEEP = 1, G_LEVEL = 0.45;
const sagOf = (len) => Math.min(0.12, len * 0.006);
// (for the tests: how a cabin hangs from the cable, and its size)
export { G_HANG, CABIN };
// Why a gondola line can't run (route.blocked: what is in the cable's way).
// (by: a building, another line's cable, or null for the ground)
export const blockedReason = (bl) => `The cable can't clear ${typeof bl.by === 'string' ? bl.by : bl.by ? `the ${BUILDINGS[bl.by.type].levels[bl.by.level].name}` : 'the ground'}: move a station, or put one nearer it`;

export class Transit {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    this.scene = game.renderer.scene;
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.vehicles = [];
    this.carts = [];
    this.routes = new Map();
    this.waiting = new Map();
    this.riders = new Map();
    this.cartPlan = [];
    this.held = new Map();   // a bit of a junction or turning place → the vehicles with a claim on it (see _knot, _cell, _through)
    this.wants = new Map();  // ...and the one who has waited longest for a way through it
    this._knots = new Map(); // (what each road junction is, see _zoneAt)
    this._turns = [];        // (where a line turns back on itself: [x, z])
    this.world.on('roads', () => this._knots.clear());
    this.dirty = true;
    this.geoCache = new Map();
    this.cables = new Map();   // gondola line id → its drawn cable, pylons and bullwheels
    const mark = () => { this.dirty = true; };
    for (const e of ['roads', 'rails', 'lines', 'building:remove', 'building:add', 'building:change']) this.world.on(e, mark);
    this.stats = {};
  }

  // ----------------------------------------------------------- line admin
  stopsOfMode(mode) {
    return [...this.world.buildings.values()].filter(b => stopOf(b, mode));
  }

  createLine(mode, stops) {
    const w = this.world;
    const cfg = TRANSIT[mode];
    if (stops.length < 2) return { ok: false, reason: 'A line needs at least two stops' };
    const site = stops.map(id => w.buildings.get(id)).find(b => b && !isOpen(b));
    if (site) return { ok: false, reason: `The ${BUILDINGS[site.type].levels[site.level].name.toLowerCase()} is still being built` };
    if (w.money < cfg.vehicleCost) return { ok: false, reason: 'Not enough money' };
    const used = new Set(w.lines.map(l => l.color)), named = new Set(w.lines.map(l => l.name));
    let color = LINE_COLORS.find(c => !used.has(c)) || LINE_COLORS[w.lines.length % LINE_COLORS.length];
    let n = w.lines.filter(l => l.mode === mode).length + 1, name = `${cfg.lineName} ${n}`;
    while (named.has(name)) name = `${cfg.lineName} ${++n}`;
    // (a gondola line in the next of Mi Teleférico's colours, named for it)
    const mi = mode === 'gondola' && GONDOLA_COLORS.find(([c, nm]) => !used.has(c) && !named.has(`${nm} Line`));
    if (mi) { color = mi[0]; name = `${mi[1]} Line`; }
    // a plain gondola station takes one line, an interchange one at each berth
    if (mode === 'gondola') for (const id of new Set(stops)) {
      const b = w.buildings.get(id), hub = b && BUILDINGS[b.type].hub;
      const there = w.lines.filter(l => l.mode === 'gondola' && l.stops.includes(id));
      if (b && there.length >= (hub || 1)) return { ok: false, reason: hub ? `The ${BUILDINGS[b.type].levels[b.level].name} has a berth for ${hub} lines, and every one is taken` : `${there[0].name} calls at that gondola station already: where lines meet, build a ${BUILDINGS.gondolahub.levels[0].name}` };
    }
    const line = { id: w.newId(), mode, name, color, stops: stops.slice(), vehicles: 1 };
    const route = this._route(line);
    if (!route) return { ok: false, reason: mode === 'rail' ? "Trains can't reverse: join the stations with a loop of track" : mode === 'gondola' ? 'Pick gondola stations' : 'Stops are not connected by road' };
    if (route.blocked) return { ok: false, reason: blockedReason(route.blocked) };
    const along = mode === 'gondola' ? this._sharpBend(line) || this._alongCable(stops.map(id => w.buildings.get(id)), line) || this._crossCable(route, line) || this._overStation(route, line) : null;
    if (along) return { ok: false, reason: along };
    w.money -= cfg.vehicleCost;
    w.lines.push(line);
    w.emit('lines');
    return { ok: true, line };
  }

  // Would a new gondola line turn back on itself at a station on the way,
  // by more than a third of a turn? Its cable on the inside of the bend
  // would cross itself there, its cabins coming in meeting those going out:
  // why not, or null.
  _sharpBend(line) {
    const w = this.world, stops = line.stops.map(id => w.buildings.get(id));
    if (stops.some(b => !b)) return null;
    const P = this._ends(line, stops);
    for (let i = 1; i + 1 < P.length; i++) {
      const ax = P[i][0] - P[i - 1][0], az = P[i][1] - P[i - 1][1], bx = P[i + 1][0] - P[i][0], bz = P[i + 1][1] - P[i][1];
      if ((ax * bx + az * bz) / ((Math.hypot(ax, az) * Math.hypot(bx, bz)) || 1) <= -0.5 + 1e-6) return `Its cable would turn back too sharply at the ${BUILDINGS[stops[i].type].levels[stops[i].level].name}: pick stations it turns less at, or change lines at a ${BUILDINGS.gondolahub.levels[0].name}`;
    }
    return null;
  }

  // Would a gondola line through stops (station buildings) have a span of
  // cable running along another line's, or back along one of its own? Two
  // cables can't hang in one place, nor their cabins pass through each
  // other: why not, or null.
  _alongCable(stops, line) {
    const mine = [], theirs = [], P = this._ends(line, stops);
    for (let i = 0; i < stops.length - 1; i++) mine.push({ a: P[i], b: P[i + 1] });
    for (const l of this.world.lines) {
      if (l.mode !== 'gondola') continue;
      const bs = l.stops.map(id => this.world.buildings.get(id)).filter(Boolean), Q = this._ends(l, bs);
      for (let i = 0; i < bs.length - 1; i++) theirs.push({ a: Q[i], b: Q[i + 1], line: l });
    }
    // (q within a few degrees of p's way, and near enough beside it for
    // their cabins to meet over more than half a tile, not counting where
    // the two come in to a station they share)
    const along = (p, q) => {
      const ux = p.b[0] - p.a[0], uz = p.b[1] - p.a[1], L = Math.hypot(ux, uz);
      const vx = q.b[0] - q.a[0], vz = q.b[1] - q.a[1], M = Math.hypot(vx, vz);
      if (L < 1e-6 || M < 1e-6 || Math.abs(ux * vz - uz * vx) / (L * M) > 0.3) return false;
      const ends = [p.a, p.b].filter(e => [q.a, q.b].some(o => Math.hypot(o[0] - e[0], o[1] - e[1]) < 0.01));
      let close = 0;
      for (let t = 0.125; t < L; t += 0.25) {
        const x = p.a[0] + (ux * t) / L, z = p.a[1] + (uz * t) / L;
        if (ends.some(e => Math.hypot(x - e[0], z - e[1]) < 0.75)) continue;
        const k = Math.max(0, Math.min(1, ((x - q.a[0]) * vx + (z - q.a[1]) * vz) / (M * M)));
        if (Math.hypot(x - q.a[0] - vx * k, z - q.a[1] - vz * k) < CABLES_APART) close += 0.25;
      }
      return close > 0.5;
    };
    for (let i = 0; i < mine.length; i++) {
      for (const q of theirs) if (along(mine[i], q)) return `Its cable would run along ${q.line.name}'s: pick stations off its way`;
      for (let j = 0; j < i; j++) if (along(mine[i], mine[j])) return "Its cable would double back over itself: pick stations that don't";
    }
    return null;
  }

  // Would a new gondola line's route cross another line's, or its own,
  // with too little height between them for one cabin to pass over another?
  // (Its own, not where it comes in to one of its stations, round the wheel
  // or across.) Why not, or null.
  _crossCable(route, line) {
    const w = this.world, ends = this._ends(line, line.stops.map(id => w.buildings.get(id)).filter(Boolean));
    const near = (x, z) => ends.some(([ex, ez]) => Math.hypot(ex - x, ez - z) < 0.75);
    const meet = (A, B, self) => {
      for (let i = 0; i < A.pts.length - 1; i++) {
        const [ax, az] = A.pts[i], [bx, bz] = A.pts[i + 1], dx = bx - ax, dz = bz - az;
        for (let j = self ? i + 2 : 0; j < B.pts.length - 1; j++) {
          const [cx, cz] = B.pts[j], [ex, ez] = B.pts[j + 1], fx = ex - cx, fz = ez - cz;
          if (Math.max(ax, bx) < Math.min(cx, ex) || Math.min(ax, bx) > Math.max(cx, ex) || Math.max(az, bz) < Math.min(cz, ez) || Math.min(az, bz) > Math.max(cz, ez)) continue;
          const den = dx * fz - dz * fx;
          if (Math.abs(den) < 1e-9) continue;
          const t = ((cx - ax) * fz - (cz - az) * fx) / den, u = ((cx - ax) * dz - (cz - az) * dx) / den;
          if (t < 0 || t > 1 || u < 0 || u > 1) continue;
          const x = ax + dx * t, z = az + dz * t;
          const ya = A.ys[i] + (A.ys[i + 1] - A.ys[i]) * t, yb = B.ys[j] + (B.ys[j + 1] - B.ys[j]) * u;
          // (its own, crossing level through a station on a sharp bend, the
          // cabins under it; otherwise a cabin's hanger and more apart)
          if (self && near(x, z) && Math.abs(ya - yb) < 0.02) continue;
          if (Math.abs(ya - yb) < G_HANG + 0.1) return true;
        }
      }
      return false;
    };
    for (const l of w.lines) {
      const R = l.mode === 'gondola' && (this.routes.get(l.id) || this._route(l));
      if (R && meet(route, R, false)) return `Its cable would cross ${l.name}'s with no room for a cabin to pass over: pick other stations`;
    }
    if (meet(route, route, true)) return "Its cable would cross itself: pick stations that don't";
    return null;
  }

  // Would a new gondola line's cable pass over another line's station (whose
  // roof and wheel stand in its cabins' way, and which may rise for its own
  // line)? Why not, or null.
  _overStation(route, line) {
    const w = this.world, mine = new Set(line.stops);
    for (let i = 0; i + 1 < route.pts.length; i++) {
      const [ax, az] = route.pts[i], [bx, bz] = route.pts[i + 1], L = Math.hypot(bx - ax, bz - az) || 1e-6, nx = -(bz - az) / L, nz = (bx - ax) / L;
      for (let u = 0; u <= L; u += 0.2) for (const o of [-0.1, 0, 0.1]) {
        const x = ax + ((bx - ax) * u) / L + nx * o, z = az + ((bz - az) * u) / L + nz * o, b = w.buildingAt(x, z);
        if (b && !mine.has(b.id) && stopOf(b, 'gondola')) return `Its cable would pass over the ${BUILDINGS[b.type].levels[b.level].name} of another line: pick other stations`;
      }
    }
    return null;
  }

  deleteLine(id) {
    const w = this.world;
    const line = w.lines.find(l => l.id === id);
    if (!line) return;
    w.lines = w.lines.filter(l => l !== line);
    for (const v of this.vehicles.filter(v => v.line === line)) this._removeVehicle(v);
    for (const [stop, list] of this.waiting) this.waiting.set(stop, list.filter(q => { if (q.plan.line === line) { this._giveUp(q); return false; } return true; }));
    w.emit('lines');
  }

  setVehicles(id, n) {
    const w = this.world;
    const line = w.lines.find(l => l.id === id);
    if (!line) return { ok: false };
    n = Math.max(1, Math.min(TRANSIT[line.mode].maxVehicles, n));
    if (n === line.vehicles) return { ok: false, reason: null };
    if (n > line.vehicles) {
      const cost = TRANSIT[line.mode].vehicleCost;
      if (w.money < cost) return { ok: false, reason: 'Not enough money' };
      w.money -= cost;
    }
    line.vehicles = n;
    w.emit('lines');
    return { ok: true };
  }

  // ------------------------------------------------------------ routing
  _stopTile(b, mode) { return mode === 'rail' ? b.rail : b.access; }

  // lifts: for a gondola line, how much taller each station stands (see
  // _cableRoute); without them its stations are free to rise.
  _route(line, lifts = null) {
    const w = this.world, paths = this.game.paths;
    const stops = line.stops.map(id => w.buildings.get(id)).filter(Boolean);
    if (stops.length < 2) return null;
    if (line.mode === 'gondola') return stops.every(b => stopOf(b, 'gondola')) ? this._cableRoute(stops, lifts, this._ends(line, stops), line) : null;
    const stopAt = stops.map(b => this._stopTile(b, line.mode));
    if (stopAt.some(t => !t)) return null;
    const rail = line.mode === 'rail';
    // the middle of the road (or track) round the whole loop, stop to stop
    let C = [];
    if (rail) {
      const loop = this._railLoop(stopAt);
      if (!loop) return null;
      C = loop;
    } else {
      for (let i = 0; i < stops.length; i++) {
        const leg = paths.road(stopAt[i], stopAt[(i + 1) % stops.length]);
        if (!leg) return null;
        for (const q of routeCentre(w.roads, leg)) {
          const last = C[C.length - 1];
          if (!last || Math.abs(last[0] - q[0]) + Math.abs(last[1] - q[1]) > 1e-6) C.push(q);
        }
      }
      if (C.length < 2) return null;
      // (no whisker of a step to swing its lane about, see thin)
      C = thin(C);
      // (where it turns back, at the end of the line, it swings right across
      // the road: one at a time there, as in a junction, see _zoneAt)
      const n = C.length;
      for (let i = 0; i < n; i++) {
        const a = C[(i - 1 + n) % n], b = C[i], c = C[(i + 1) % n];
        const d1x = b[0] - a[0], d1z = b[1] - a[1], d2x = c[0] - b[0], d2z = c[1] - b[1], L1 = Math.hypot(d1x, d1z), L2 = Math.hypot(d2x, d2z);
        if (L1 > 1e-6 && L2 > 1e-6 && (d1x * d2x + d1z * d2z) / (L1 * L2) < -0.9) this._turns.push([b[0], b[1]]);
      }
    }
    // (round the loop: its first point again at its end, the turn there too)
    if (Math.hypot(C[0][0] - C[C.length - 1][0], C[0][1] - C[C.length - 1][1]) > 1e-6) C.push(C[0].slice());
    let pts = rail ? C.map(p => [p[0], p[1]]) : untangle(offsetPath([C[C.length - 2], ...C, C[1]], LANE).slice(1, -1));
    pts = smoothPolyline(pts, rail ? 0.5 : 0.3, rail ? 6 : 4);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const length = cum[cum.length - 1];
    if (length < 0.5) return null;
    // locate each stop along the polyline, in order
    const marks = [];
    let from = 0;
    for (let i = 0; i < stops.length; i++) {
      const cx = stopAt[i].x, cz = stopAt[i].z;
      let best = from, bd = Infinity;
      for (let k = from; k < pts.length; k++) {
        const d = Math.hypot(pts[k][0] - cx, pts[k][1] - cz);
        if (d < bd) { bd = d; best = k; }
        if (d > bd + 3) break;
      }
      marks.push({ stop: stops[i].id, s: cum[best] });
      from = best;
    }
    return { pts, cum, length, marks, mode: line.mode };
  }

  // Where a gondola line's cable ends at each of its stations (stops,
  // buildings): the middle of a plain one, its own berth at an interchange.
  _ends(line, stops) { return stops.map(b => this.berthPoint(b, line) || [b.x, b.z]); }

  // At an interchange (def.hub), the middle of the berth a gondola line calls
  // at ([x, z]), or null (a plain station, or no berth free for it). The
  // lines through it take a berth each in turn, the oldest first, each the
  // one facing most the way it goes on to its stations either side.
  berthPoint(b, line) {
    const def = b && BUILDINGS[b.type];
    if (!def || !def.hub) return null;
    const w = this.world, cx = b.x, cz = b.z, R = ownPlot(b);
    const lines = w.lines.filter(l => l.mode === 'gondola' && l.stops.includes(b.id));
    if (!lines.includes(line)) lines.push(line);
    lines.sort((p, q) => p.id - q.id);
    const free = HUB_BERTHS.map((_, k) => k);
    for (const l of lines) {
      if (!free.length) break;
      let dx = 0, dz = 0;
      l.stops.forEach((id, i) => {
        if (id !== b.id) return;
        for (const j of [i - 1, i + 1]) {
          const o = w.buildings.get(l.stops[j]);
          if (!o || o === b) continue;
          const ox = o.x - cx, oz = o.z - cz, L = Math.hypot(ox, oz) || 1;
          dx += ox / L; dz += oz / L;
        }
      });
      let k = free[0], best = -Infinity;
      // (the berths turn with the building)
      const at = (f) => toWorld(R, HUB_BERTHS[f][0], HUB_BERTHS[f][1]);
      for (const f of free) { const [bx, bz] = at(f), s = (bx - cx) * dx + (bz - cz) * dz; if (s > best + 1e-9) { best = s; k = f; } }
      if (l === line) return at(k);
      free.splice(free.indexOf(k), 1);
    }
    return null;
  }

  // A closed route through every station (in order) that a train can drive
  // without ever reversing: legs over (edge, way along it) that never turn
  // back, through switches no sharper than RAIL_TURN, coming back into the
  // first station heading the same way it set off. The middle of the track
  // along it ([[x, z]]), or null if the track has no such loop.
  _railLoop(stops) {
    let best = null;
    for (const d0 of [1, -1]) {
      let cur = { e: stops[0].e, s: stops[0].s, d: d0 }, pieces = [], len = 0, ok = true;
      for (let k = 1; k <= stops.length; k++) {
        const g = stops[k % stops.length];
        const leg = this._railLeg(cur, g, k === stops.length ? d0 : 0);
        if (!leg) { ok = false; break; }
        pieces = pieces.concat(leg.pieces); len += leg.len;
        cur = { e: g.e, s: g.s, d: leg.d };
      }
      if (ok && (!best || len < best.len)) best = { pieces, len };
    }
    if (!best) return null;
    const C = routeCentre(this.world.rails, { pieces: best.pieces });
    return C.length >= 2 ? C : null;
  }

  // The way along the track from a (edge, s, heading d: 1 along the edge, -1
  // against it) to goal (edge, s), arriving heading gd (0: either way):
  // { pieces, len, d (the heading it arrives at) }, or null.
  _railLeg(a, goal, gd) {
    const net = this.world.rails, ea = net.edges.get(a.e), eg = net.edges.get(goal.e);
    if (!ea || !eg) return null;
    // straight on along the same edge
    if (a.e === goal.e && (goal.s - a.s) * a.d > 1e-6 && (!gd || gd === a.d)) return { pieces: [{ e: a.e, s0: a.s, s1: goal.s }], len: Math.abs(goal.s - a.s), d: a.d };
    // a search over (edge, heading) from the end of a's edge it is heading for
    const key = (e, d) => e + ':' + d, dist = new Map(), prev = new Map(), q = [];
    const first = { e: a.e, d: a.d, c: a.d > 0 ? ea.len - a.s : a.s };
    dist.set(key(a.e, a.d), first.c); prev.set(key(a.e, a.d), null);
    q.push(first);
    let found = null;
    while (q.length) {
      q.sort((p, r) => p.c - r.c);
      const st = q.shift(), k = key(st.e, st.d);
      if (st.c > dist.get(k) + 1e-9) continue;
      const e = net.edges.get(st.e), n = st.d > 0 ? e.b : e.a;
      // the way it arrives at the node
      const hin = net.dirAt(e, n) + Math.PI;
      for (const id of net.nodes.get(n).edges) {
        const f = net.edges.get(id), d = f.a === n ? 1 : -1;
        if (id === st.e && f.a !== f.b) continue;
        if (angDiff(net.dirAt(f, n), hin) > RAIL_TURN) continue;
        const kk = key(id, d);
        // into the goal's edge, heading the right way: done
        if (id === goal.e && (!gd || gd === d)) {
          const c = st.c + (d > 0 ? goal.s : f.len - goal.s);
          if (!found || c < found.c) found = { c, from: k, e: id, d };
        }
        const c = st.c + f.len;
        if (c < (dist.get(kk) ?? Infinity)) { dist.set(kk, c); prev.set(kk, k); q.push({ e: id, d, c }); }
      }
    }
    if (!found) return null;
    // trace back
    const pieces = [{ e: found.e, s0: found.d > 0 ? 0 : net.edges.get(found.e).len, s1: goal.s }];
    for (let k = found.from; k; k = prev.get(k)) {
      const [id, d] = k.split(':').map(Number), e = net.edges.get(id);
      const isFirst = prev.get(k) == null;
      pieces.push({ e: id, s0: isFirst ? a.s : d > 0 ? 0 : e.len, s1: d > 0 ? e.len : 0 });
    }
    pieces.reverse();
    return { pieces, len: found.c, d: found.d };
  }

  // ------------------------------------------------------------ gondolas
  // A gondola line runs out along its stations on one cable and back on the
  // other, G_OFF either side of the straight line from station to station,
  // round a bullwheel at each end station (and round the outside of any
  // station where the line doubles back). pts: the path of a cabin's grip;
  // ys: the cable's height along it, level through the stations and slung
  // from pylon to pylon between them.
  // lifts: how much taller than usual each station stands (by id), so the
  // cable clears what is round it. Without them the stations are free to
  // rise as far as G_LIFT, and the route says how far each must (lifts);
  // with them they are held there. blocked: what the cable still can't
  // clear, if anything.
  // ends: where the cable ends at each station (_ends). line: the line it is
  // (it passes over or well under older lines' cables, see _overCables).
  _cableRoute(stops, lifts = null, ends = null, line = null) {
    const n = stops.length;
    const P = ends || stops.map(b => [b.x, b.z]);
    // a station's height, shared by the spans either side of it (and by
    // every visit to it, should a line come back through it)
    const ref = new Map();
    for (const b of stops) if (!ref.has(b.id)) {
      const h = (b.baseY || 0) + G_CABLE + (lifts ? lifts.get(b.id) || 0 : 0);
      ref.set(b.id, { h, base: (b.baseY || 0) + G_CABLE, max: lifts ? h : h + G_LIFT, station: true });
    }
    const legs = [];
    for (let i = 0; i < n - 1; i++) legs.push(this._span(P[i], P[i + 1], stops[i], stops[i + 1], ref.get(stops[i].id), ref.get(stops[i + 1].id)));
    let blocked = this._solve(legs);
    // and over any older line's cable it doesn't pass well under; again
    // once it has risen, till it asks no more (where the two cross at a
    // shallow angle, rising over one stretch of the other can bring it level
    // with the other a little further on)
    const others = line ? this._olderCables(line) : [];
    for (let pass = 0; pass < 6 && others.length && legs.reduce((more, leg) => this._overCables(leg, others) || more, false); pass++) blocked = this._solve(legs);
    // a station rises in steps of a quarter tile (the cable only goes higher)
    const lift = new Map();
    for (const [id, s] of ref) if (!lifts) { const k = Math.ceil((s.h - s.base) / 0.25 - 1e-6) * 0.25; s.h = s.base + k; if (k > 0) lift.set(id, k); }
    const H = stops.map(b => ref.get(b.id).h);
    // the stations in the order a cabin calls at them: out, then back
    const seq = [];
    for (let i = 0; i < n; i++) seq.push(i);
    for (let i = n - 2; i >= 1; i--) seq.push(i);
    const m = seq.length;
    const dir = (i, j) => { const dx = P[j][0] - P[i][0], dz = P[j][1] - P[i][1], L = Math.hypot(dx, dz) || 1; return [dx / L, dz / L]; };
    const wheels = [];
    // how the cable gets through each station: a mitre where it bends a
    // little, round a wheel where it turns back
    const joins = seq.map((si, k) => {
      const din = dir(seq[(k - 1 + m) % m], si), dout = dir(si, seq[(k + 1) % m]);
      const r1 = [-din[1], din[0]], r2 = [-dout[1], dout[0]], V = P[si];
      const dot = r1[0] * r2[0] + r1[1] * r2[1];
      if (1 + dot > 0.5) return { pts: [[V[0] + ((r1[0] + r2[0]) * G_OFF) / (1 + dot), V[1] + ((r1[1] + r2[1]) * G_OFF) / (1 + dot)]], mid: 0, si };
      // a sharp bend towards the other cable: straight across
      if (din[0] * dout[1] - din[1] * dout[0] > 1e-9) return { pts: [[V[0] + r1[0] * G_OFF, V[1] + r1[1] * G_OFF], [V[0] + r2[0] * G_OFF, V[1] + r2[1] * G_OFF]], mid: 0, si };
      let phi = Math.atan2(r2[0] * din[0] + r2[1] * din[1], dot);
      if (phi < 0) phi += Math.PI * 2;
      const steps = Math.max(2, Math.ceil(phi / (Math.PI / 10))), pts = [];
      for (let j = 0; j <= steps; j++) {
        const t = (phi * j) / steps, c = Math.cos(t), s = Math.sin(t);
        pts.push([V[0] + (r1[0] * c + din[0] * s) * G_OFF, V[1] + (r1[1] * c + din[1] * s) * G_OFF]);
      }
      if (!wheels.some(wh => wh.x === V[0] && wh.z === V[1])) wheels.push({ x: V[0], z: V[1], y: H[si] });
      return { pts, mid: steps >> 1, si };
    });
    const pts = [], ys = [], markIdx = [];
    const add = (x, z, y) => {
      const q = pts[pts.length - 1];
      if (q && Math.hypot(q[0] - x, q[1] - z) < 1e-4) return;
      pts.push([x, z]); ys.push(y);
    };
    for (let k = 0; k < m; k++) {
      const J = joins[k];
      J.pts.forEach((p, j) => { add(p[0], p[1], H[J.si]); if (j === J.mid) markIdx.push(pts.length - 1); });
      // then straight on to the next station, sagging between the pylons
      const N = joins[(k + 1) % m], a = J.pts[J.pts.length - 1], b = N.pts[0];
      const leg = legs[Math.min(J.si, N.si)];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]), steps = Math.max(1, Math.ceil(len / 0.2));
      for (let j = 1; j < steps; j++) {
        const x = a[0] + ((b[0] - a[0]) * j) / steps, z = a[1] + ((b[1] - a[1]) * j) / steps;
        add(x, z, leg.prof((x - leg.a[0]) * leg.ux + (z - leg.a[1]) * leg.uz));
      }
    }
    pts.push([...pts[0]]); ys.push(ys[0]);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const marks = joins.map((J, k) => ({ stop: stops[J.si].id, s: cum[markIdx[k]] }));
    // what the drawing depends on: it is redrawn only when this changes
    const sig = P.map((p, i) => `${p[0]},${p[1]},${H[i].toFixed(3)}`).join(';') + '|' + legs.map(l => l.pylons.map(p => `${p.x.toFixed(2)},${p.z.toFixed(2)},${p.h.toFixed(2)}`).join(';')).join('|');
    return { pts, ys, cum, length: cum[cum.length - 1], marks, mode: 'gondola', legs, wheels, sig, lifts: lift, blocked };
  }

  // One span of a gondola line, from station centre a to station centre b
  // (A and B the stations, s0 and s1 their heights): what the cable must
  // clear along it, where its pylons stand, and prof(u), the cable's height
  // u along it once _solve has set the heights. A pylon goes up every
  // G_SPAN or so, wherever along that stretch there is room for one (best
  // on open ground, then in a field or a park, then on a road's verge).
  _span(a, b, A, B, s0, s1) {
    const w = this.world, t = w.terrain;
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1e-6;
    const ux = dx / L, uz = dz / L;
    const at = (u) => [a[0] + ux * u, a[1] + uz * u];
    // the least height the cable may run at, every quarter tile along, and
    // what sets it there (by: a building, or null for the ground): the ground
    // across as far as a cabin reaches out from the middle, on its cable
    // G_OFF out, and every building on a tile any of that stretch touches
    // (the stretch a quarter tile long, HL either way, and HW either side)
    const NS = Math.max(1, Math.ceil(L / 0.25)), req = [], by = [];
    const HL = L / NS / 2, HW = G_OFF + 0.16, ha = angleOf(ux, uz);
    for (let k = 0; k <= NS; k++) {
      const [x0, z0] = at((L * k) / NS);
      let need = -Infinity, what = null;
      for (const o of [-0.3, -0.15, 0, 0.15, 0.3]) {
        const x = x0 - uz * o, z = z0 + ux * o;
        if (w.inBounds(x, z)) need = Math.max(need, Math.max(t.heightAt(x, z), CONFIG.WATER_LEVEL) + G_GROUND);
      }
      // (every plot the stretch passes over)
      const S = rect(x0, z0, ha, HW, HL);
      for (const ob of w.plots.query(aabbOf(S))) {
        if (ob === A || ob === B || !rectsOverlap(S, plotOf(ob), 0)) continue;
        const h = this._topOf(ob) + G_ROOF;
        if (h > need) { need = h; what = ob; }
      }
      req.push(need); by.push(what);
    }
    const pylons = [];
    const n = Math.max(0, Math.ceil(L / G_SPAN) - 1);
    for (let j = 1; j <= n; j++) {
      const u0 = (L * j) / (n + 1);
      let best = null;
      for (let u = Math.max(1, u0 - G_SPAN / 2); u <= Math.min(L - 1, u0 + G_SPAN / 2); u += 0.1) {
        if (pylons.some(p => Math.abs(p.u - u) < 1.5)) continue;
        const [x, z] = at(u), kind = this._pylonSpot(x, z);
        if (kind < 0) continue;
        const score = kind * 2 + Math.abs(u - u0);
        if (!best || score < best.score) best = { u, x, z, score };
      }
      if (!best) continue;
      const g = t.heightAt(best.x, best.z), need = req[Math.round((best.u / L) * NS)];
      pylons.push({ u: best.u, x: best.x, z: best.z, g, h: Math.min(g + G_MAXH, Math.max(g + 1.3, need)), max: g + G_MAXH, ry: Math.atan2(ux, uz) });
    }
    pylons.sort((p, q) => p.u - q.u);
    // (through a station the cable runs level on its sheaves, out to its edge)
    const lv = Math.min(G_LEVEL, L / 2);
    const sup = [{ u: lv, s: s0 }, ...pylons.map(p => ({ u: p.u, s: p })), { u: L - lv, s: s1 }];
    const prof = (u) => {
      u = Math.min(L, Math.max(0, u));
      let i = 0;
      while (i < sup.length - 2 && sup[i + 1].u < u) i++;
      const p0 = sup[i], p1 = sup[i + 1], len = p1.u - p0.u || 1e-6, f = Math.min(1, Math.max(0, (u - p0.u) / len));
      return p0.s.h + (p1.s.h - p0.s.h) * f - sagOf(len) * 4 * f * (1 - f);
    };
    return { a, ux, uz, L, NS, HL, HW, req, by, sup, prof, pylons, at };
  }

  // The cables of the gondola lines before this one (or all of them, for a
  // new line) as last worked out, each with its line's name.
  _olderCables(line) {
    const out = [];
    for (const l of this.world.lines) {
      if (l === line) break;
      const R = l.mode === 'gondola' && this.routes.get(l.id);
      if (R) out.push({ R, name: l.name });
    }
    return out;
  }

  // Where an older line's cable (others, from _olderCables) crosses a span,
  // within its cabins' way (HW either side): unless the span's cable runs
  // well under it (a cabin and its hanger and more), it must pass over, its
  // cabins' floors a little over that cable; not near either of its
  // stations (an interchange's berths keep their lines apart there). Adds
  // that to what the span must clear (req); whether it asks more anywhere.
  _overCables(leg, others) {
    // (room for a cabin and its hanger, and a little more: the cable is only
    // held to it at points along the span, and sags a little between them)
    const { a, ux, uz, L, NS, HL, HW, req, by } = leg, room = G_HANG + 0.2, end = 0.6;
    let more = false;
    for (const { R, name } of others) for (let i = 0; i + 1 < R.pts.length; i++) {
      const [px, pz] = R.pts[i], [qx, qz] = R.pts[i + 1];
      const pu = (px - a[0]) * ux + (pz - a[1]) * uz, pv = (pz - a[1]) * ux - (px - a[0]) * uz;
      const qu = (qx - a[0]) * ux + (qz - a[1]) * uz, qv = (qz - a[1]) * ux - (qx - a[0]) * uz;
      if ((pv > HW && qv > HW) || (pv < -HW && qv < -HW) || Math.max(pu, qu) < end || Math.min(pu, qu) > L - end) continue;
      // (the part of it within the way)
      let t0 = 0, t1 = 1;
      if (Math.abs(qv - pv) > 1e-9) { const ta = (-HW - pv) / (qv - pv), tb = (HW - pv) / (qv - pv); t0 = Math.max(0, Math.min(ta, tb)); t1 = Math.min(1, Math.max(ta, tb)); }
      if (t0 > t1) continue;
      const ua = pu + (qu - pu) * t0, ub = pu + (qu - pu) * t1, u0 = Math.max(end, Math.min(ua, ub)) - HL, u1 = Math.min(L - end, Math.max(ua, ub)) + HL;
      const y = Math.max(R.ys[i] + (R.ys[i + 1] - R.ys[i]) * t0, R.ys[i] + (R.ys[i + 1] - R.ys[i]) * t1);
      if (Math.max(leg.prof(u0), leg.prof((u0 + u1) / 2), leg.prof(u1)) <= y - room) continue;
      for (let k = Math.max(0, Math.ceil(u0 / (L / NS))); k <= Math.min(NS, Math.floor(u1 / (L / NS))); k++) {
        if (y + room > req[k] + 1e-6) { req[k] = y + room; by[k] = `${name}'s cable`; more = true; }
      }
    }
    return more;
  }

  // Set the heights of a line's pylons and stations so the cable clears
  // everything under every span: where it runs too low, the pylons either
  // side rise first (the nearer one more), and a station only when they are
  // as tall as they go, or there are none. Then each pylon is made at least
  // nearly as tall as the lower of its neighbours, so the cable never dips
  // to one for nothing. Returns what still stands in the way, if anything.
  _solve(legs) {
    const raise = (s, d) => { const h0 = s.h; s.h = Math.min(s.max, s.h + d); return s.h - h0; };
    for (let pass = 0; pass < 16; pass++) {
      let moved = false;
      for (const leg of legs) for (let i = 0; i < leg.sup.length - 1; i++) {
        const p0 = leg.sup[i], p1 = leg.sup[i + 1], len = p1.u - p0.u, S = sagOf(len);
        for (let k = 0; k <= leg.NS; k++) {
          const u = (leg.L * k) / leg.NS;
          if (u <= p0.u || u >= p1.u) continue;
          const f = (u - p0.u) / len;
          let left = leg.req[k] - (p0.s.h + (p1.s.h - p0.s.h) * f - S * 4 * f * (1 - f));
          if (left <= 1e-3) continue;
          const ends = [[p0.s, 1 - f], [p1.s, f]].sort((a, b) => (!!a[0].station - !!b[0].station) || b[1] - a[1]);
          for (const [s, wt] of ends) if (left > 1e-4 && wt > 1e-3) { const got = raise(s, left / wt) * wt; left -= got; if (got > 1e-4) moved = true; }
        }
      }
      if (!moved) break;
    }
    for (const leg of legs) for (let i = 1; i < leg.sup.length - 1; i++) {
      const p = leg.sup[i].s;
      p.h = Math.min(p.max, Math.max(p.h, Math.min(leg.sup[i - 1].s.h, leg.sup[i + 1].s.h) - 0.25));
    }
    // and where a span is steeper than G_STEEP, its lower end rises (a pylon,
    // or a station if it may), so the cable clears the cabins' roofs
    for (let pass = 0; pass < 16; pass++) {
      let moved = false;
      for (const leg of legs) for (let i = 0; i < leg.sup.length - 1; i++) {
        const a = leg.sup[i].s, b = leg.sup[i + 1].s, len = leg.sup[i + 1].u - leg.sup[i].u;
        const [lo, hi] = a.h < b.h ? [a, b] : [b, a], short = hi.h - G_STEEP * len - lo.h;
        if (short > 1e-3 && raise(lo, short) > 1e-4) moved = true;
      }
      if (!moved) break;
    }
    for (const leg of legs) for (let k = 0; k <= leg.NS; k++) {
      const u = (leg.L * k) / leg.NS;
      if (leg.req[k] - leg.prof(u) > 0.02) { const [x, z] = leg.at(u); return { by: leg.by[k], x, z }; }
    }
    return null;
  }

  // Stand each gondola station as tall as its lines need (b.lift, worked
  // out afresh every time, never saved), redrawing those that change.
  // Returns whether any did.
  _lift(lifts) {
    let changed = false;
    for (const b of this.world.buildings.values()) {
      if (!stopOf(b, 'gondola')) continue;
      const k = lifts.get(b.id) || 0;
      if (k === (b.lift || 0)) continue;
      if (k) b.lift = k; else delete b.lift;
      this.world.emit('building:refit', b);
      changed = true;
    }
    return changed;
  }

  // The headings each gondola station's cables leave it on, to the next
  // station along each of its lines and back (b.cables, worked out afresh,
  // never saved), so its way up stands clear of the cabins coming and
  // going, and the colour of its line (b.tint), which it wears; at an
  // interchange, each berth's (b.berths: where each is, in the world, its
  // cables' headings and its line's colour), so its benches and railings
  // stand clear of them too. Redrawing those that change.
  _exits() {
    const w = this.world, out = new Map(), tint = new Map();
    for (const line of w.lines) {
      if (line.mode !== 'gondola') continue;
      const st = line.stops.map(id => w.buildings.get(id)).filter(Boolean), P = this._ends(line, st);
      for (let i = 0; i + 1 < st.length; i++) {
        const h = Math.atan2(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]);
        for (const [s, p, k] of [[st[i], P[i], h], [st[i + 1], P[i + 1], h + Math.PI]]) {
          const key = BUILDINGS[s.type].hub ? `${s.id}:${p[0]},${p[1]}` : s.id, l = out.get(key) || [];
          if (!tint.has(key)) tint.set(key, line.color);
          const r = Math.round(Math.atan2(Math.sin(k), Math.cos(k)) * 100) / 100;
          if (!l.includes(r)) l.push(r);
          out.set(key, l);
        }
      }
    }
    for (const b of w.buildings.values()) {
      if (!stopOf(b, 'gondola')) continue;
      if (BUILDINGS[b.type].hub) {
        const R = ownPlot(b);
        const berths = HUB_BERTHS.map(([ox, oz]) => { const [bx, bz] = toWorld(R, ox, oz), key = `${b.id}:${bx},${bz}`; return { x: bx, z: bz, cables: (out.get(key) || []).sort((p, q) => p - q), tint: tint.get(key) || null }; });
        if (JSON.stringify(berths) === JSON.stringify(b.berths || null)) continue;
        b.berths = berths;
        w.emit('building:refit', b);
        continue;
      }
      const l = (out.get(b.id) || []).sort((x, y) => x - y), t = tint.get(b.id) || null;
      if (l.join() === (b.cables || []).join() && t === (b.tint || null)) continue;
      if (l.length) b.cables = l; else delete b.cables;
      if (t) b.tint = t; else delete b.tint;
      w.emit('building:refit', b);
    }
  }

  // Can a pylon stand at (x, z), and how good a spot is it: 0 open ground,
  // 1 a field or a park, 2 the verge of a road; -1 not at all (on a
  // building, in the road, on track or in water).
  _pylonSpot(x, z) {
    const w = this.world;
    if (!w.inBounds(x, z) || x < 0.2 || z < 0.2 || x > w.N - 0.2 || z > w.N - 0.2) return -1;
    if (w.railAt(x, z, 0.12) || w.waterAt(x, z)) return -1;
    const b = w.buildingAt(x, z);
    if (b) return BUILDINGS[b.type].park ? 1 : -1;
    if (w.roadAt(x, z, 0.1)) return -1;
    if (w.roadAt(x, z, 0.3)) return 2;
    return w.fieldAt(x, z) ? 1 : 0;
  }

  // How high a building reaches: the top of its model as drawn, or a fair
  // guess (headless, or before it is drawn).
  _topOf(b) {
    const it = this.game.view && this.game.view.items && this.game.view.items.get(b.id);
    const g = it && (it.site ? it.site.target : it.mesh && it.mesh.geometry);
    if (g && g.attributes && g.attributes.position) {
      if (!g.boundingBox) g.computeBoundingBox();
      return (b.baseY || 0) + g.boundingBox.max.y;
    }
    const def = BUILDINGS[b.type];
    return (b.baseY || 0) + (def.park ? 0.35 : 0.55 + 0.2 * (b.level + 1) * Math.sqrt(b.w * b.d));
  }

  // Each gondola line's cables, pylons and bullwheels, drawn again only when
  // its route or what it has to clear changes.
  _drawCables() {
    const keep = new Set();
    for (const line of this.world.lines) {
      const r = this.routes.get(line.id);
      if (line.mode !== 'gondola' || !r) continue;
      keep.add(line.id);
      const old = this.cables.get(line.id);
      if (old && old.sig === r.sig) continue;
      if (old) this._dropCable(old);
      this.cables.set(line.id, this._cableMeshes(r, line.color));
    }
    for (const [id, c] of this.cables) if (!keep.has(id)) { this._dropCable(c); this.cables.delete(id); }
  }

  _cableMeshes(r, color) {
    const gb = new GeoBuilder(), seen = new Set();
    for (const leg of r.legs) for (const p of leg.pylons) {
      const key = `${p.x.toFixed(2)},${p.z.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pylon(gb, p, color);
    }
    // each bullwheel: a rim the cable runs round, its spokes and its hub
    for (const wh of r.wheels) {
      gb.cyl(wh.x, wh.y - 0.016, wh.z, G_OFF + 0.014, G_OFF + 0.014, 0.022, 20, '#3a3f44');
      gb.cyl(wh.x, wh.y - 0.012, wh.z, G_OFF - 0.014, G_OFF - 0.014, 0.016, 20, '#8f979c');
      for (let k = 0; k < 3; k++) gb.boxC(wh.x, wh.y - 0.002, wh.z, 2 * G_OFF - 0.01, 0.008, 0.014, '#5d6266', 0, (k * Math.PI) / 3);
      gb.cyl(wh.x, wh.y - 0.02, wh.z, 0.028, 0.028, 0.07, 10, SHEAVE);
    }
    // the cable, thick enough to see close up...
    const pos = new Float32Array((r.pts.length - 1) * 6);
    for (let i = 0; i < r.pts.length - 1; i++) {
      const [x0, z0] = r.pts[i], [x1, z1] = r.pts[i + 1], y0 = r.ys[i], y1 = r.ys[i + 1];
      const hz = Math.hypot(x1 - x0, z1 - z0);
      gb.boxC((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, 0.009, 0.009, Math.hypot(hz, y1 - y0) + 0.004, '#2b2b2e', -Math.atan2(y1 - y0, hz), Math.atan2(x1 - x0, z1 - z0));
      pos.set([x0, y0, z0, x1, y1, z1], i * 6);
    }
    const mesh = new THREE.Mesh(gb.build(), MAT.building);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // ...and a line a pixel wide, so far off it never breaks up
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const wire = new THREE.LineSegments(lg, CABLE_MAT);
    this.group.add(mesh, wire);
    return { sig: r.sig, mesh, wire };
  }

  _dropCable(c) {
    this.group.remove(c.mesh, c.wire);
    c.mesh.geometry.dispose();
    c.wire.geometry.dispose();
  }

  _sample(route, s) {
    const { pts, cum, length } = route;
    s = ((s % length) + length) % length;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
    const a = pts[lo], b = pts[hi];
    const L = cum[hi] - cum[lo] || 1;
    const t = (s - cum[lo]) / L;
    const y = route.ys ? route.ys[lo] + (route.ys[hi] - route.ys[lo]) * t : 0;
    return { x: a[0] + (b[0] - a[0]) * t, y, z: a[1] + (b[1] - a[1]) * t, heading: Math.atan2(b[0] - a[0], b[1] - a[1]) };
  }

  // Where a coach or cart (a BODY of f ahead, b behind) stands at s along
  // its route: its front and back (near enough its horse and its back
  // wheels) both on the way, the body between, so round a corner it cuts in
  // behind rather than swinging its nose out across the other lane.
  _pose(route, s, f, b) {
    const L = route.length, loop = !!route.marks, at = (u) => this._sample(route, loop ? u : Math.max(0, Math.min(L - 1e-3, u)));
    const F = at(s + f * 0.9), R = at(s - b * 0.9), dx = F.x - R.x, dz = F.z - R.z;
    if (Math.hypot(dx, dz) < 1e-4) return at(s);
    const k = b / (f + b);
    return { x: R.x + dx * k, z: R.z + dz * k, heading: Math.atan2(dx, dz) };
  }

  // A route's path in 3D (for the overlay): along the ground, or the cable.
  routePoints(route) {
    if (route.ys) return route.pts.map(([x, z], i) => [x, route.ys[i] - 0.12, z]);
    return route.pts.map(([x, z]) => [x, this._height(route.mode, x, z), z]);
  }

  _height(mode, x, z) {
    const w = this.world;
    if (mode !== 'rail') { const r = w.roadHeight(x, z); if (r != null) return r + 0.012; }
    if (w.waterAt(x, z)) return bridgeDeckY() + (mode === 'rail' ? 0.045 : 0);
    return w.terrain.heightAt(x, z) + (mode === 'rail' ? 0.06 : 0.03);
  }

  // Four legs hung from the hips of the horse pulling this mesh.
  _horseLegs(mesh, h) {
    const geo = this._geo('leg' + h.color, () => { const gb = new GeoBuilder(); gb.box(0, -LEG_H, 0, 0.018, LEG_H, 0.018, h.color); return gb.build(); });
    return LEGS.map(([lx, lz]) => {
      const leg = new THREE.Mesh(geo, MAT.building);
      leg.position.set(lx, LEG_H, h.z + lz);
      leg.castShadow = true;
      mesh.add(leg);
      return leg;
    });
  }

  // A trot: diagonal pairs of legs swing together; standing still, they settle.
  _poseLegs(legs, gait, moving, dt) {
    const a = Math.sin(gait) * LEG_SWING;
    legs.forEach((leg, i) => {
      const want = moving ? (i === 0 || i === 3 ? a : -a) : 0;
      leg.rotation.x = moving ? want : leg.rotation.x * Math.max(0, 1 - dt * 8);
    });
  }

  _geo(key, fn) {
    let g = this.geoCache.get(key);
    if (!g) { g = fn(); this.geoCache.set(key, g); }
    return g;
  }

  rebuild() {
    this.dirty = false;
    const w = this.world;
    // how tall each gondola station must stand, for the tallest of its lines
    // (once more if that changes a station another line passes over)
    // (each line's route kept as it is worked out, for the lines after it:
    // they pass over or under its cable, see _overCables)
    let lifts;
    for (let again = 0; again < 2; again++) {
      lifts = new Map();
      for (const line of w.lines) {
        const r = line.mode === 'gondola' ? this._route(line) : null;
        if (r) for (const [id, k] of r.lifts) lifts.set(id, Math.max(lifts.get(id) || 0, k));
        if (r && !r.blocked) this.routes.set(line.id, r);
      }
      if (!this._lift(lifts)) break;
    }
    this._exits();
    this.routes.clear();
    this._turns = []; this._knots.clear();
    for (const line of w.lines) {
      // (a gondola line with its stations held at those heights; it doesn't
      // run while something stands in the cable's way)
      const r = this._route(line, lifts);
      line.broken = !r || !!r.blocked;
      if (r && r.blocked) line.blocked = blockedReason(r.blocked); else delete line.blocked;
      if (r && !r.blocked) this.routes.set(line.id, r);
    }
    // sync vehicles
    for (const v of [...this.vehicles]) {
      const r = this.routes.get(v.line.id);
      if (!w.lines.includes(v.line) || !r) { this._removeVehicle(v); continue; }
      v.route = r;
      v.s = Math.min(v.s, r.length);
      v.next = this._nextMark(r, v.s);
    }
    for (const line of w.lines) {
      const r = this.routes.get(line.id);
      if (!r) continue;
      const mine = this.vehicles.filter(v => v.line === line);
      while (mine.length > line.vehicles) this._removeVehicle(mine.pop());
      for (let k = mine.length; k < line.vehicles; k++) mine.push(this._spawnVehicle(line, r, this._clearStart(line, r, (r.length * k) / line.vehicles)));
    }
    this._drawCables();
    this.game.emit('transit:routes');
  }

  // Where a new coach or train starts along its route r: at s, or a little
  // further on if another vehicle stands there (on a road two lines share).
  _clearStart(line, r, s) {
    if (line.mode === 'gondola') return s;
    const others = this.vehicles.filter(v => v.line.mode !== 'gondola' && v.route).map(v => this._sample(v.route, v.s));
    for (let k = 0; k < 12; k++) {
      const q = this._sample(r, s + k * 0.3);
      if (others.every(o => Math.hypot(o.x - q.x, o.z - q.z) > 0.9)) return (s + k * 0.3) % r.length;
    }
    return s;
  }

  _nextMark(route, s) {
    for (let i = 0; i < route.marks.length; i++) if (route.marks[i].s > s + 1e-3) return i;
    return 0;
  }

  _spawnVehicle(line, route, s) {
    const meshes = [];
    if (line.mode === 'rail') {
      meshes.push(new THREE.Mesh(this._geo('engine', engineModel), MAT.building));
      for (let k = 0; k < 2; k++) meshes.push(new THREE.Mesh(this._geo('car' + line.color, () => carriageModel(line.color)), MAT.building));
    } else if (line.mode === 'gondola') {
      const m = new THREE.Mesh(this._geo('cabin' + line.color, () => cabinModel(line.color)), MAT.building);
      m.rotation.order = 'YXZ';   // it swings fore and aft on its grip
      // its windows, glass you see the riders through, swinging with it
      m.add(new THREE.Mesh(this._geo('cabinGlass', cabinGlass), MAT.glass));
      meshes.push(m);
    } else {
      meshes.push(new THREE.Mesh(this._geo('coach' + line.color, () => coachModel(line.color)), MAT.building));
    }
    for (const m of meshes) { m.castShadow = true; m.receiveShadow = true; this.group.add(m); }
    // (a coach's horse trots; a train and a gondola cabin have none)
    const legs = line.mode === 'coach' ? this._horseLegs(meshes[0], COACH_HORSE) : null;
    // (not on top of another vehicle: on along its way to where there's room)
    if (line.mode !== 'gondola' && this.bodies) {
      for (let k = 0; k < 40; k++) {
        const p = this._sample(route, s);
        if (!this.bodies.some(o => !o.air && Math.hypot(o.x - p.x, o.z - p.z) < 0.7)) break;
        s = (s + 0.35) % route.length;
      }
    }
    const v = { line, route, s, meshes, legs, gait: 0, state: 'move', dwell: 0, next: this._nextMark(route, s), passengers: [], smokeAcc: 0, swing: s * 1.7, n: ++serial, wait: 0, by: null };
    this.vehicles.push(v);
    // where it stands from the start (so nothing else is put there before it moves)
    const mode = line.mode;
    for (let k = 0; k < meshes.length; k++) {
      const p = this._sample(route, s + (mode === 'rail' ? (1 - k) * CAR_SPACING : -k * 0.6));
      meshes[k].position.set(p.x, mode === 'gondola' ? p.y : this._height(mode, p.x, p.z), p.z);
      meshes[k].rotation.y = p.heading;
      if (this.bodies) this.bodies.push({ x: p.x, y: meshes[k].position.y, z: p.z, hx: Math.sin(p.heading), hz: Math.cos(p.heading), ...(([f, b, w]) => ({ f, b, w }))(mode === 'gondola' ? BODY.cabin : mode === 'rail' ? BODY.rail : BODY.coach), owner: v, air: mode === 'gondola' });
    }
    return v;
  }

  _removeVehicle(v) {
    for (const m of v.meshes) this.group.remove(m);
    for (const p of v.passengers) this._dropOff(p, null);
    this.vehicles = this.vehicles.filter(x => x !== v);
  }

  // --------------------------------------------------------- passengers
  // The quickest way by transit from building A to building B, if it beats
  // walking (walk: how long the walk takes, in tiles of level walking, each
  // unit climbed CONFIG.CLIMB of them): one line, or two with a change at a
  // stop both call at (an interchange, say). Each costed the same way: the
  // walks to the first stop and from the last (climbing counted), a gondola
  // station's stairs, the wait (half the time between cabins; a coach,
  // about 3) and the ride; at = the call to board at, going the right way,
  // next = the second line's leg. Null if walking is as quick.
  plan(A, B, walk) {
    if (walk < 9 || !this.world.lines.length) return null;
    const w = this.world, WS = CONFIG.WALK_SPEED;
    const on = (a, b) => { const d = Math.abs(a.x - b.x) + Math.abs(a.z - b.z); return d > 8 ? Infinity : d + CONFIG.CLIMB * Math.max(0, (b.baseY || 0) - (a.baseY || 0)); };
    const lines = [];
    for (const line of w.lines) {
      const route = this.routes.get(line.id);
      if (!route || line.broken) continue;
      const cfg = TRANSIT[line.mode], cable = line.mode === 'gondola';
      const stops = [...new Set(route.marks.map(m => m.stop))].map(id => w.buildings.get(id)).filter(st => st && st.access);
      const ride = (s1, s2) => {
        let d = Infinity, at = 0;
        route.marks.forEach((m, i) => { if (m.stop === s1.id) for (const n of route.marks) if (n.stop === s2.id) { const e = ((n.s - m.s) + route.length) % route.length; if (e < d) { d = e; at = i; } } });
        return { t: (d * WS) / cfg.speed, at };
      };
      lines.push({ line, stops, ride, wait: cable ? ((route.length / Math.max(1, line.vehicles) / 2) * WS) / cfg.speed : 3, stairs: cable ? STATION_STAIRS : 0 });
    }
    let best = null;
    const offer = (cost, plan) => { if (cost < walk * 0.95 && (!best || cost < best.cost)) best = { ...plan, cost }; };
    // one line
    for (const L of lines) for (const sA of L.stops) {
      const eA = on(A, sA);
      if (eA === Infinity) continue;
      for (const sB of L.stops) {
        const eB = sB === sA ? Infinity : on(sB, B);
        if (eB === Infinity) continue;
        const r = L.ride(sA, sB);
        offer(eA + 2 * L.stairs + L.wait + r.t + eB, { line: L.line, board: sA, alight: sB, at: r.at });
      }
    }
    // two, changing at a stop both call at
    for (const L1 of lines) for (const L2 of lines) {
      if (L1 === L2) continue;
      for (const X of L1.stops) {
        if (!L2.stops.includes(X)) continue;
        let f = null, g = null;
        for (const sA of L1.stops) {
          const eA = sA === X ? Infinity : on(A, sA);
          if (eA === Infinity) continue;
          const r = L1.ride(sA, X), c = eA + L1.stairs + L1.wait + r.t;
          if (!f || c < f.c) f = { c, sA, at: r.at };
        }
        for (const sB of L2.stops) {
          const eB = sB === X ? Infinity : on(sB, B);
          if (eB === Infinity) continue;
          const r = L2.ride(X, sB), c = L2.wait + r.t + L2.stairs + eB;
          if (!g || c < g.c) g = { c, sB, at: r.at };
        }
        if (f && g) offer(f.c + CHANGE + g.c, { line: L1.line, board: f.sA, alight: X, at: f.at, next: { line: L2.line, board: X, alight: g.sB, at: g.at } });
      }
    }
    return best;
  }

  // A trip planned by transit (see plan; walk: the walk it beats): counted
  // for each line it takes, with the time it saves (in tiles of level
  // walking) and, for a trip of two lines, the change.
  tally(plan, walk) {
    for (let p = plan; p; p = p.next) {
      const st = (this.stats[p.line.id] ||= { riders: 0, fares: 0 });
      st.trips = (st.trips || 0) + 1;
      st.saved = (st.saved || 0) + Math.max(0, walk - plan.cost);
      if (plan.next) st.changes = (st.changes || 0) + 1;
    }
  }

  // How much a gondola line climbs, from its lowest station to its highest
  // (their decks, as they stand).
  climbOf(line) {
    const hs = line.stops.map(id => this.world.buildings.get(id)).filter(Boolean).map(b => (b.baseY || 0) + (b.lift || 0));
    return hs.length ? Math.max(...hs) - Math.min(...hs) : 0;
  }

  // How far over a cabin's roof (and the fan cowl on it) the cables run, at
  // the closest anywhere along a gondola route (negative: through it), and
  // where: the cabin hanging straight down from its grip at every point
  // along the way, against every bit of either cable over it (for the tests).
  cabinClearance(route) {
    const { W, D, H } = CABIN, roof = -G_HANG + H + 0.028, { pts, ys } = route;
    let clear = Infinity, at = null;
    for (let s = 0; s < route.length; s += 0.04) {
      const q = this._sample(route, s), c = Math.cos(q.heading), sn = Math.sin(q.heading);
      for (let i = 0; i + 1 < pts.length; i++) {
        const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
        if (Math.min(Math.hypot(ax - q.x, az - q.z), Math.hypot(bx - q.x, bz - q.z)) > 0.6) continue;
        for (let u = 0; u <= 1; u += 0.1) {
          const x = ax + (bx - ax) * u - q.x, z = az + (bz - az) * u - q.z;
          if (Math.abs(x * c - z * sn) > W / 2 + 0.01 || Math.abs(x * sn + z * c) > D / 2 + 0.01) continue;
          const d = ys[i] + (ys[i + 1] - ys[i]) * u - q.y - roof;
          if (d < clear) { clear = d; at = { x: q.x, z: q.z }; }
        }
      }
    }
    return { clear, at };
  }

  wait(r, plan, destId) {
    if (!this.world.buildings.get(plan.board.id) || !this.world.lines.includes(plan.line)) {
      this.game.agents._arrive(r, plan.board.id);
      return;
    }
    const list = this.waiting.get(plan.board.id) || [];
    list.push({ r, plan, dest: destId, since: this.world.day * 24 + this.world.hours });
    this.waiting.set(plan.board.id, list);
    this.game.agents.waitAt(r, plan.board, plan.line);
  }

  _giveUp(q) {
    const r = q.r;
    r.skipTransit = true;
    r.loc = 'in';
    r.at = q.plan.board.id;
    if (r.walk) this.game.agents._drop(r.walk);
    this.game.agents.go(r, q.dest);
  }

  // A passenger off at stop (at: where a gondola cabin stands there, to
  // step out of it), or home if the line is gone. Returns how long stepping
  // out takes.
  _dropOff(p, stop, at = null) {
    this.riders.delete(p.r.id);
    if (!this.world.residents.has(p.r.id)) return 0;
    if (stop) return this.game.agents.alight(p.r, stop, p.dest, at) || 0;
    if (p.r.walk) this.game.agents._drop(p.r.walk);
    p.r.loc = 'in'; p.r.at = p.r.home;
    return 0;
  }

  // A passenger changing lines at stop (p.next: the rest of the trip): out
  // of the cabin (at) or the coach and over to wait for the next line there.
  // Returns how long stepping out takes.
  _change(p, stop, at) {
    this.riders.delete(p.r.id);
    if (!this.world.residents.has(p.r.id)) return 0;
    const t = this.game.agents.changeAt(p.r, stop, at, p.next.line);
    const list = this.waiting.get(stop.id) || [];
    list.push({ r: p.r, plan: p.next, dest: p.dest, since: this.world.day * 24 + this.world.hours });
    this.waiting.set(stop.id, list);
    return t;
  }

  // How much slower a horse goes at s along route (a coach's or a cart's):
  // up a hill, half as much slower as a walker (see agents.climbCost).
  _uphill(route, s) {
    const a = this._sample(route, s), b = this._sample(route, s + 0.3), w = this.world;
    return 1 + CONFIG.CLIMB * 0.5 * Math.max(0, (w.walkHeight(b.x, b.z) - w.walkHeight(a.x, a.z)) / 0.3);
  }

  // How high a gondola cabin's floor stands (its riders stand on it).
  cabinFloor(v) { return v.meshes[0].position.y - G_HANG + 0.006; }

  // Where on a gondola station's deck a villager waits: round its middle (at
  // an interchange, round the berth of line, the one they wait for), clear
  // of the way the cabins of every line through it pass (world [x, z] spots,
  // at the deck's height).
  deckSpots(stop, line = null) {
    const d = stop.deck;
    if (!d) return null;
    const bp = line && this.berthPoint(stop, line), [mx, mz] = bp || [d.x, d.z];
    const segs = [];
    for (const l of this.world.lines) {
      const r = l.mode === 'gondola' && l.stops.includes(stop.id) ? this.routes.get(l.id) : null;
      if (!r) continue;
      for (let i = 0; i + 1 < r.pts.length; i++) {
        const a = r.pts[i], b = r.pts[i + 1];
        if (Math.hypot((a[0] + b[0]) / 2 - mx, (a[1] + b[1]) / 2 - mz) < 0.7) segs.push([a, b]);
      }
    }
    const away = (x, z, [a, b]) => {
      const ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / L2));
      return Math.hypot(x - a[0] - ex * t, z - a[1] - ez * t);
    };
    // (the places the station's model leaves clear of its benches and
    // lamps, or failing those, round its middle)
    const all = [];
    const cand = stop.stand && stop.stand.length ? stop.stand.map(p => [p.x, p.z]).filter(([x, z]) => !bp || Math.hypot(x - mx, z - mz) < 0.42) : [];
    if (!cand.length) for (let k = 0; k < 16; k++) for (const rad of [0.22, 0.17]) cand.push([mx + Math.sin((k * Math.PI) / 8) * rad, mz + Math.cos((k * Math.PI) / 8) * rad]);
    for (const [x, z] of cand) all.push([x, z, Math.min(Infinity, ...segs.map(sg => away(x, z, sg)))]);
    // (on a busy deck, where nowhere is quite clear, the spots furthest from
    // the cabins' way)
    const clear = all.filter(p => p[2] > CABIN.W / 2 + 0.045);
    return (clear.length ? clear : all.sort((a, b) => b[2] - a[2]).slice(0, 3)).map(p => [p[0], p[1]]);
  }

  forget(r) {
    for (const [k, list] of this.waiting) this.waiting.set(k, list.filter(q => q.r !== r));
    for (const v of this.vehicles) v.passengers = v.passengers.filter(p => p.r !== r);
    this.riders.delete(r.id);
  }

  vehicleOf(r) {
    const v = this.riders.get(r.id);
    if (!v) return null;
    const m = v.meshes[0];
    return { x: m.position.x, y: m.position.y, z: m.position.z };
  }

  lineNameOf(r) { const v = this.riders.get(r.id); return v ? v.line.name : null; }

  _atStop(v, mark) {
    const w = this.world, route = v.route;
    const stop = w.buildings.get(mark.stop);
    if (!stop) return;
    // a gondola cabin stands here, its riders step out and in (and it waits
    // for them); the waiting board only once up on the deck
    const cable = v.line.mode === 'gondola', at = cable ? this._sample(route, mark.s) : null;
    if (at) at.v = v;
    let wait = 0;
    const keep = [];
    for (const p of v.passengers) {
      if (p.alight === mark.stop) wait = Math.max(wait, p.next && this.world.lines.includes(p.next.line) ? this._change(p, stop, at) : this._dropOff(p, stop, at));
      else keep.push(p);
    }
    v.passengers = keep;
    const list = this.waiting.get(mark.stop) || [];
    const cap = TRANSIT[v.line.mode].capacity;
    const remain = [];
    let fares = 0;
    for (const q of list) {
      if (q.plan.line === v.line && (q.plan.at == null || q.plan.at === v.next || route.marks[q.plan.at]?.stop !== mark.stop) && v.passengers.length < cap && this.world.residents.has(q.r.id) && this.game.agents.onDeck(q.r)) {
        wait = Math.max(wait, this.game.agents.board(q.r, at && { ...at, seat: v.passengers.length }) || 0);
        v.passengers.push({ r: q.r, alight: q.plan.alight.id, dest: q.dest, next: q.plan.next || null });
        this.riders.set(q.r.id, v);
        fares += this.game.sim.recordVisit(stop, TRANSIT[v.line.mode].fare);
      } else remain.push(q);
    }
    this.waiting.set(mark.stop, remain);
    if (wait) v.dwell = Math.max(v.dwell, wait);
    if (fares) {
      const p = v.meshes[0].position;
      this.game.emit('coins', { x: p.x, y: p.y + 0.4, z: p.z, v: fares });
      const st = (this.stats[v.line.id] ||= { riders: 0, fares: 0 });
      st.riders += fares / TRANSIT[v.line.mode].fare; st.fares += fares;
    }
  }

  // --------------------------------------------------------------- update
  update(dt) {
    if (this.dirty) this.rebuild();
    const speed = this.game.speed;
    const w = this.world;
    const now = w.day * 24 + w.hours;
    this.bodies = this._bodies();
    this.frame = (this.frame || 0) + 1;
    for (const [k, hs] of this.held) {
      const keep = hs.filter(h => h.frame >= this.frame - 1);
      if (keep.length) this.held.set(k, keep); else this.held.delete(k);
    }
    for (const [k, q] of this.wants) if (q.frame < this.frame - 1) this.wants.delete(k);
    for (const o of this.bodies) if (!o.air) this._hold(o);
    // impatient passengers walk instead
    for (const [k, list] of this.waiting) {
      if (!list.length) continue;
      const keep = [];
      for (const q of list) { if (now - q.since > 3.5) this._giveUp(q); else keep.push(q); }
      this.waiting.set(k, keep);
    }
    for (const v of this.vehicles) {
      const cfg = TRANSIT[v.line.mode];
      const route = v.route;
      const rail = v.line.mode === 'rail', cable = v.line.mode === 'gondola';
      if (v.state === 'dwell') {
        v.dwell -= dt * speed;
        // (at a stop in a junction or where it turns back, it keeps its claim
        // on the way on through it, so nobody comes in where it will go)
        if (!cable && !rail && speed) this._through(v, route, v.s + BODY.coach[0], 0.3, 0);
        if (v.dwell <= 0) { v.state = 'move'; v.next = (v.next + 1) % route.marks.length; }
      } else if (speed) {
        const mark = route.marks[v.next];
        let dist = mark.s - v.s;
        if (dist < 0) dist += route.length;
        let step = dt * speed * cfg.speed;
        if (!rail && !cable) step /= this._uphill(route, v.s);   // (the horses slower up a hill)
        if (rail || cable) {
          // pull away gently and brake into the platform; a cabin lets go of
          // the cable in a station and creeps through it
          const prevMark = route.marks[(v.next - 1 + route.marks.length) % route.marks.length];
          let since = v.s - prevMark.s;
          if (since < 0) since += route.length;
          step *= rail ? Math.min(1, 0.25 + Math.min(dist, since) * 0.6) : Math.min(1, 0.3 + Math.min(dist, since) * 1.6);
        }
        // no closer than a little behind whatever is ahead: another coach or
        // a cart, a train at a crossing, a cabin waiting in the station, a
        // villager in the way
        step = this._clear(v, v.meshes[0], cable ? 'cabin' : rail ? 'rail' : 'coach', step, dt * speed, route, v.s + (rail ? CAR_SPACING : 0));
        if (v.legs) v.gait += Math.min(step, dist) * GAIT_PER_TILE;
        if (step >= dist) {
          v.s = mark.s;
          v.state = 'dwell';
          v.dwell = rail ? 2.6 : cable ? 1 : 1.4;
          v.wait = 0; v.by = null;
          this._atStop(v, mark);
        } else v.s = ((v.s + step) % route.length + route.length) % route.length;
      }
      if (cable) {
        // a cabin hangs from the cable, swinging a little on its grip
        const p = this._sample(route, v.s), m = v.meshes[0];
        m.position.set(p.x, p.y, p.z);
        m.rotation.y = p.heading;
        v.swing += dt * speed * 2.2;
        m.rotation.x = Math.sin(v.swing) * (v.state === 'move' ? 0.05 : 0.015);
        continue;
      }
      // place meshes: trains are centred on their position (engine in front)
      for (let k = 0; k < v.meshes.length; k++) {
        const off = rail ? (1 - k) * CAR_SPACING : -k * 0.6;
        const p = rail ? this._sample(route, v.s + off) : this._pose(route, v.s + off, BODY.coach[0], BODY.coach[1]);
        const m = v.meshes[k];
        m.position.set(p.x, this._height(v.line.mode, p.x, p.z), p.z);
        m.rotation.y = p.heading;
      }
      if (v.legs) this._poseLegs(v.legs, v.gait, v.state === 'move' && speed > 0, dt * speed);
      if (rail && speed) {
        v.smokeAcc += dt * (v.state === 'move' ? 6 : 1.5);
        const m = v.meshes[0];
        while (v.smokeAcc > 1) {
          v.smokeAcc -= 1;
          const fx = m.position.x + Math.sin(m.rotation.y) * 0.14, fz = m.position.z + Math.cos(m.rotation.y) * 0.14;
          this.game.view.smoke.emit({
            x: fx, y: m.position.y + 0.3, z: fz, vx: (Math.random() - 0.5) * 0.05, vy: 0.3, vz: (Math.random() - 0.5) * 0.05,
            drag: 0.8, life: 2.5, size: 0.08, size1: 0.4, r: 0.92, g: 0.92, b: 0.95, alpha: 0.55, alpha1: 0, fadeIn: 0.05,
          });
        }
      }
    }
    this._updateCarts(dt);
  }

  // -------------------------------------------------------------- traffic
  // Every vehicle and cart as it stands (its box, BODY): for keeping their
  // distance from each other, and for the villagers to keep out of the way.
  _bodies() {
    const out = [];
    const add = (m, k, owner, air) => {
      const p = m.position, h = m.rotation.y;
      out.push({ x: p.x, y: p.y, z: p.z, hx: Math.sin(h), hz: Math.cos(h), f: k[0], b: k[1], w: k[2], owner, air });
    };
    for (const v of this.vehicles) {
      const mode = v.line.mode;
      if (mode === 'gondola') add(v.meshes[0], BODY.cabin, v, true);
      else for (const m of v.meshes) add(m, mode === 'rail' ? BODY.rail : BODY.coach, v, false);
    }
    for (const c of this.carts) if (c.placed) add(c.mesh, BODY.cart, c, false);
    return out;
  }

  // Junctions, bends and turning places, a road with other than two ways on
  // from it or two not straight across (the other lane of a wide road, road
  // beside it all along, isn't a way on), and where a line turns back: one
  // vehicle in one at a time, the first to come, so none meets another
  // crossing or turning in it. 1 for a junction, 2 for a bend, 0 otherwise
  // (kept till the roads change).
  // A road junction: a node of the network where other than two roads
  // meet, or two at a sharp bend (zone kind 1 a junction, 2 a bend), as
  // { r (how far round it the zone reaches), kind }, or null (kept till the
  // roads change).
  _knotOf(n) {
    if (this._knots.has(n.id)) return this._knots.get(n.id);
    const net = this.world.roads, es = n.edges.map(id => net.edges.get(id));
    let kind = 0;
    if (es.length === 1) kind = 0;
    else if (es.length !== 2) kind = 1;
    else if (Math.PI - angDiff(net.dirAt(es[0], n.id), net.dirAt(es[1], n.id)) > 0.6) kind = 2;
    // (wide enough that one waiting at its edge is clear of the back of a
    // coach turning through it, which swings out round the corner)
    let r = Math.max(...es.map(e => HALF[e.level])) + 0.42;
    // (two junctions a short stretch apart are one wide junction: their
    // zones meet halfway along it, so a vehicle claims its way through both
    // at once and never stands between them waiting on one with its tail in
    // the other)
    if (kind) for (const e of es) {
      if (e.len >= 2.2) continue;
      const o = net.nodes.get(net.other(e, n.id)), oe = o ? o.edges.map(id => net.edges.get(id)) : [];
      const knot = oe.length > 2 || (oe.length === 2 && Math.PI - angDiff(net.dirAt(oe[0], o.id), net.dirAt(oe[1], o.id)) > 0.6);
      if (knot) r = Math.max(r, Math.min(1.15, e.len / 2 + 0.05));
    }
    const out = kind ? { r, kind } : null;
    this._knots.set(n.id, out);
    return out;
  }
  // The junction zone (x, z) is in: a junction's own (round its node), or
  // a turning place where a line turns back; { k (its key), kind (1 a
  // junction or turning place, 2 a bend), x, z (its middle) }, or null.
  _zoneAt(x, z) {
    const w = this.world;
    for (const n of w.roads.nodeIx.near(x, z, 1.2)) {
      const K = this._knotOf(n);
      if (K && Math.hypot(n.x - x, n.z - z) < K.r) return { k: n.id, kind: K.kind, x: n.x, z: n.z };
    }
    for (let i = 0; i < this._turns.length; i++) {
      const [tx, tz] = this._turns[i];
      // (as wide as a junction's: a coach turning round swings its back out as far)
      if (Math.hypot(tx - x, tz - z) < 0.7) return { k: 1e6 + i, kind: 1, x: tx, z: tz };
    }
    return null;
  }
  _knot(x, z) { const Z = this._zoneAt(x, z); return Z ? Z.kind : 0; }

  // The bit of a junction zone (x, z) is in (a square 0.15 across, of the
  // ten by ten round its middle, as a key for claims on it; -1 off a
  // junction): two vehicles may be in one junction at once, so long as
  // their ways through it don't cross.
  _cell(x, z) {
    const Z = this._zoneAt(x, z);
    if (!Z) return -1;
    const i = Math.max(0, Math.min(9, Math.floor((x - Z.x + 0.75) / 0.15))), j = Math.max(0, Math.min(9, Math.floor((z - Z.z + 0.75) / 0.15)));
    return Z.k * 128 + j * 10 + i;
  }

  // The bits of junction a vehicle's piece o stands on: it keeps its claim
  // on them while it does.
  _hold(o) {
    const h = Math.atan2(o.hx, o.hz), l = o.w * 0.8;
    for (const u of [o.f, o.f / 2, 0, -o.b / 2, -o.b]) for (const s of [-l, 0, l]) {
      const c = this._cell(o.x + o.hx * u + o.hz * s, o.z + o.hz * u - o.hx * s);
      if (c >= 0) this._claim(c, o.owner, h, h, null);
    }
  }

  // A claim on bit of junction k by owner, going into its tile heading and
  // out of it h1, straight across or not (null: as it was, or straight).
  _claim(k, owner, heading, h1, straight) {
    let hs = this.held.get(k);
    if (!hs) this.held.set(k, hs = []);
    const h = hs.find(q => q.owner === owner);
    if (!h) hs.push({ owner, frame: this.frame, heading, h1, straight: straight ?? true });
    else { h.frame = this.frame; if (straight != null) { h.heading = heading; h.h1 = h1; h.straight = straight; } }
  }

  // The way through the junction just ahead of a vehicle (its front at sF
  // along route; one within reach of it): every bit of junction it will
  // pass over (see _cell) till it's out the other side, two and a half tiles
  // at most. If another has a claim on any of them, crossing or turning
  // there, how far it may go (short of that tile, or of that bit if it's in
  // the tile already) and who it waits for; otherwise it claims them all at
  // once (so none ever stands in one tile of a wide junction waiting for
  // another who stands in the next waiting for it). Two going straight
  // through side by side or the opposite way, or opposite ways round a bend,
  // don't stand in each other's way; nor does one behind going the same way
  // (it waits behind this one anyway). And whoever has waited longest for a
  // way through goes next (a stream of vehicles along a road doesn't keep
  // one waiting to cross it for ever); but one in the junction already, or
  // through this bit of it, or one waiting for this one, doesn't wait its
  // turn.
  _through(v, route, sF, reach, dt) {
    const me = v.mesh || v.meshes[0], mx = Math.sin(me.rotation.y), mz = Math.cos(me.rotation.y);
    const behind = (u) => {
      const m = u.mesh || u.meshes[0];
      return Math.sin(m.rotation.y) * mx + Math.cos(m.rotation.y) * mz > 0.5 && (m.position.x - me.position.x) * mx + (m.position.z - me.position.z) * mz < 0;
    };
    const w = this.world, loop = !!route.marks, tiles = [];
    const rail = v.line && v.line.mode === 'rail', [f0, b0, w0] = BODY[rail ? 'rail' : v.line ? 'coach' : 'cart'], l = w0 * 0.9;
    let out = -1;   // (how far on it's out the other side)
    for (let d = 0; d <= THROUGH; d += 0.1) {
      if (!loop && sF + d > route.length) break;
      const q = this._sample(route, sF + d), Z = this._zoneAt(q.x, q.z);
      if (!Z) { if (tiles.length) { out = d; break; } if (d > reach) break; continue; }
      const k = Z.k;
      let t = tiles[tiles.length - 1];
      // (back into one it passed through already, as round a turning place
      // just beyond a junction: the way back is claimed when it gets there)
      if (t && t.k !== k && tiles.some(o => o.k === k)) break;
      if (!t || t.k !== k) tiles.push(t = { k, d, h0: q.heading, bend: Z.kind === 2, cells: new Map() });
      t.h1 = q.heading;
      // (all it will stand on, its front there: corners, sides and middle)
      const p = rail ? this._sample(route, sF + d - f0) : this._pose(route, sF + d - f0, f0, b0), hx = Math.sin(p.heading), hz = Math.cos(p.heading);
      for (const u of [f0, 0, -b0]) for (const s of [-l, 0, l]) {
        const c = this._cell(p.x + hx * u + hz * s, p.z + hz * u - hx * s);
        if (c >= 0 && !t.cells.has(c)) t.cells.set(c, d);
      }
    }
    if (!tiles.length) { v.jw = 0; return null; }
    // (one in the junction already goes through it from the way it faces
    // now: with its front round a corner and the rest of it still swinging
    // round behind, it isn't going straight through yet, whatever its way
    // is from its front on)
    if (tiles[0].d === 0) tiles[0].h0 = me.rotation.y;
    for (const t of tiles) t.straight = Math.abs(Math.atan2(Math.sin(t.h1 - t.h0), Math.cos(t.h1 - t.h0))) < 0.25;
    const fresh = (h) => h.owner !== v && h.frame >= this.frame - 1;
    const apart = (h, t) => (h.straight && t.straight && Math.abs(Math.cos(h.heading - t.h0)) > 0.95) || (t.bend && Math.cos(h.heading - t.h1 - Math.PI) > 0.9) || behind(h.owner);
    // (short of that tile, or of that bit if it's in it already; but one not
    // in any yet waits short of the first, however far on the trouble is:
    // tiles that touch leave nowhere to stand between them, and one waiting
    // in a turning place for the junction beside it stands where a coach
    // turning round there must swing)
    const short = (t, d) => ({ room: Math.max(0, (tiles[0].d > 0 ? tiles[0].d : t.d > 0 ? t.d : d) - 0.15) });
    let block = null;
    for (const t of tiles) {
      for (const [c, d] of t.cells) {
        if (d === 0) continue;   // (on it already)
        const h = (this.held.get(c) || []).find(h => fresh(h) && !apart(h, t));
        if (h) { block = { ...short(t, d), by: h.owner, why: 'a junction' }; break; }
      }
      if (block) break;
    }
    // (nor into one with no room to stand on the other side, behind one
    // waiting there: it would stand in the way of everyone crossing)
    if (!block && tiles[0].d > 0 && out > 0) {
      for (let d = out + 0.05; d <= out + f0 + b0 + 0.05 && !block; d += 0.1) {
        if (!loop && sF + d > route.length) break;
        const q = this._sample(route, sF + d);
        for (const o of this.bodies) {
          const u = o.owner;
          if (u === v || o.air || !(u.wait > 0 || u.state === 'dwell')) continue;
          const mid = (o.f - o.b) / 2, half = (o.f + o.b) / 2, rx = q.x - (o.x + o.hx * mid), rz = q.z - (o.z + o.hz * mid);
          if (Math.abs(rx) + Math.abs(rz) > half + o.w + w0 + 0.1) continue;
          if (Math.abs(rx * o.hx + rz * o.hz) < half + GAP && Math.abs(rx * o.hz - rz * o.hx) < o.w + w0) { block = { ...short(tiles[0], 0), by: u, why: 'no room past a junction' }; break; }
        }
      }
    }
    if (!block && tiles[0].d > 0) for (const t of tiles) {
      for (const [c, d] of t.cells) {
        const q = this.wants.get(c);
        if (d === 0 || !q || !fresh(q) || q.jw <= (v.jw || 0) || q.owner.by === v || apart(q, t)) continue;
        if ((this.held.get(c) || []).some(h => h.owner === v)) continue;
        block = { ...short(t, d), by: q.owner, why: 'its turn at a junction' };
        break;
      }
      if (block) break;
    }
    if (block) {
      v.jw = tiles[0].d > 0 ? (v.jw || 0) + dt : 0;
      for (const t of tiles) for (const c of t.cells.keys()) {
        const q = this.wants.get(c);
        if (!q || !fresh(q) || q.jw < v.jw) this.wants.set(c, { owner: v, frame: this.frame, heading: t.h0, h1: t.h1, straight: t.straight, jw: v.jw });
      }
      return block;
    }
    v.jw = 0;
    for (const t of tiles) for (const c of t.cells.keys()) this._claim(c, v, t.h0, t.h1, t.straight);
    return null;
  }

  // Is v one of a ring of vehicles each waiting for the next (by), none of
  // which can ever move (a coach turning across one coming the other way,
  // each a whisker into the other's way)? 1 if so: they squeeze by, as close
  // as they can without touching; 3 if they still can't and v is the
  // youngest of them: it backs up a little (see _clear), to let the others
  // by; a cart in one a good while finds another way (CART_GIVE_UP); 2 if
  // even that doesn't do and v is the oldest: it goes on regardless. How
  // long the ring has stood is the longest any of it has waited (one that
  // squeezes by a little starts its own wait afresh).
  _ring(v) {
    if (v.wait < RING_WAIT) return 0;
    let u = v.by, oldest = v, youngest = v, long = v.wait;
    for (let k = 0; u && u.wait >= RING_WAIT && k < 16; k++) {
      if (u === v) return long <= RING_WAIT * 4 ? 1 : youngest === v ? 3 : oldest === v && v.wait > RING_WAIT * 16 ? 2 : 1;
      if (u.n < oldest.n) oldest = u;
      if (u.n > youngest.n) youngest = u;
      long = Math.max(long, u.wait);
      u = u.by;
    }
    return 0;
  }

  // The youngest of a ring of vehicles stuck waiting for each other backs up
  // (a negative step), BACK at most, so long as nothing stands behind it.
  _backUp(v, kind, step, t, px, pz, hx, hz) {
    v.wait += t;
    const [f, b, w0] = BODY[kind], back = Math.min(step * 0.5, BACK - (v.backed || 0));
    if (back <= 0 || (!v.line && v.s < back)) return 0;
    for (const o of this.bodies) {
      if (o.owner === v || o.air) continue;
      const rx = o.x - px, rz = o.z - pz, along = -(rx * hx + rz * hz);
      if (along <= 0 || Math.abs(rx) + Math.abs(rz) > b + 1.2) continue;   // (the one it backs away from, ahead of it)
      // (the corridor behind it, as the one ahead in _clear, turned round)
      const c = -(o.hx * hx + o.hz * hz), sn = -(o.hx * hz - o.hz * hx), mid = (o.f - o.b) / 2, half = (o.f + o.b) / 2;
      const ca = along + mid * c, cl = -(rx * hz - rz * hx) + mid * sn;
      const ea = Math.abs(c) * half + Math.abs(sn) * o.w, el = Math.abs(sn) * half + Math.abs(c) * o.w;
      if (Math.abs(cl) < el + w0 + 0.01 && ca - ea < b + back + GAP) return 0;
    }
    v.backed = (v.backed || 0) + back;
    return -back;
  }

  // How far vehicle v (its front piece m, a kind of BODY) may go this frame,
  // at most step, without coming within GAP of another vehicle or GAP_FOOT of
  // a villager ahead of it, or into a junction another is in. One held up
  // long gives up waiting for villagers (who should have stepped aside);
  // vehicles queue for as long as it takes, but for a ring of them each
  // waiting for the next (see _ring). Held up, it keeps how long (v.wait),
  // for whom (v.by: a vehicle, or null for a villager) and what for (v.why,
  // which the collision playtest tallies).
  _clear(v, m, kind, step, t, route = null, s0 = 0) {
    if (step <= 0) return step;
    const [f, , w0] = BODY[kind], hx = Math.sin(m.rotation.y), hz = Math.cos(m.rotation.y), px = m.position.x, pz = m.position.z, py = m.position.y;
    const look = step + GAP + 0.04, air = kind === 'cabin';
    // (in a ring of vehicles each waiting for the next: closer)
    let ring = this._ring(v);
    if (ring === 3 && air) ring = 1;
    if (ring === 3) return this._backUp(v, kind, step, t, px, pz, hx, hz);
    const give = ring ? -0.015 : 0.01;
    let room = Infinity, by = null, why = '';
    for (const o of this.bodies) {
      // (going on regardless, still not into the back of one going its way)
      if (o.owner === v || o.air !== air || (air && Math.abs(o.y - py) > 0.25) || (ring === 2 && o.hx * hx + o.hz * hz < 0.7)) continue;
      const rx = o.x - px, rz = o.z - pz;
      if (Math.abs(rx) + Math.abs(rz) > look + f + 1) continue;
      const c = o.hx * hx + o.hz * hz, sn = o.hx * hz - o.hz * hx, mid = (o.f - o.b) / 2, half = (o.f + o.b) / 2;
      const ca = rx * hx + rz * hz + mid * c, cl = rx * hz - rz * hx + mid * sn;
      const ea = Math.abs(c) * half + Math.abs(sn) * o.w, el = Math.abs(sn) * half + Math.abs(c) * o.w;
      if (Math.abs(cl) >= el + w0 + give || ca - ea >= f + look) continue;
      // (already overlapping one ahead of its middle, or level with it and
      // the older: wait till it's clear)
      if (ca + ea <= f) { if (ca - ea < f && (ca > 0.02 || (ca > -0.02 && o.owner.n < v.n))) { room = Math.min(room, 0); by = o.owner; why = 'touching'; } continue; }
      const gap = Math.max(0, ca - ea - f) - (ring ? 0.01 : GAP);
      if (gap < room) { room = gap; by = o.owner; why = 'behind'; }
    }
    // round a bend: points along its way just ahead, against every other
    // vehicle (and villager) there
    if (route && ring !== 2) {
      const ag = !air && v.wait <= 4 && this.game.agents.near ? this.game.agents : null;
      for (let d = 0.05; d <= look + 1e-6 && d < room + GAP; d += 0.05) {
        const q = this._sample(route, s0 + f + d), qy = air ? q.y : py;
        let hit = false;
        for (const o of this.bodies) {
          if (o.owner === v || o.air !== air || (air && Math.abs(o.y - qy) > 0.25)) continue;
          const mid = (o.f - o.b) / 2, half = (o.f + o.b) / 2, rx = q.x - (o.x + o.hx * mid), rz = q.z - (o.z + o.hz * mid);
          if (Math.abs(rx) + Math.abs(rz) > half + o.w + w0 + 0.2) continue;
          // (as wide as it is across the other's length, turned across it)
          const sn = Math.abs(Math.sin(q.heading) * o.hz - Math.cos(q.heading) * o.hx);
          if (Math.abs(rx * o.hx + rz * o.hz) < half + w0 * sn + 0.01 && Math.abs(rx * o.hz - rz * o.hx) < o.w + w0 + give - 0.01) { hit = o.owner; break; }
        }
        if (!hit && ag) for (const p of ag.near(q.x, q.z, w0 + 0.08)) {
          if (Math.abs(p.y - py) > 0.15) continue;
          const dq = Math.hypot(p.x - q.x, p.z - q.z);
          if (dq < w0 || (p.moving && !(p.hold > 0.1) && dq < w0 + 0.07 && (q.x - p.x) * Math.sin(p.heading) + (q.z - p.z) * Math.cos(p.heading) > 0.3 * dq)) { hit = 'foot'; break; }
        }
        if (hit) { if (Math.max(0, d - GAP) < room) { room = Math.max(0, d - GAP); by = hit === 'foot' ? null : hit; why = hit === 'foot' ? 'a villager' : 'round a bend'; } break; }
      }
    }
    // a junction or a turning place just ahead that another is in, or about
    // to go into: wait short of it (standing clear of another's back swinging
    // round as it turns there), or claim the way through it
    // (in a ring, one in the junction already, waiting only for its turn
    // at the rest of it, goes on through and out, its way clear of the
    // others' bodies: the ring is of claims, not of bodies)
    const inside = this._knot(px + hx * f, pz + hz * f);
    if (!air && route && ring !== 2 && !(ring && inside && /junction/.test(v.why || ''))) {
      const r = this._through(v, route, s0 + f, look + 0.15, t);
      if (r && r.room < room) { room = r.room; by = r.by; why = r.why; }
    }
    // villagers in the way (not for a cabin), unless held up a while: just
    // ahead of it, crossing in front of its middle or about to (not those on
    // the pavement beside it, clear of its side)
    if (!air && v.wait <= 4) {
      const ag = this.game.agents;
      for (const p of ag.near ? ag.near(px + hx * (f + look) / 2, pz + hz * (f + look) / 2, (f + look) / 2 + w0 + 0.1) : []) {
        if (Math.abs(p.y - py) > 0.15) continue;
        const rx = p.x - px, rz = p.z - pz, along = rx * hx + rz * hz, lat = rx * hz - rz * hx;
        // (and one just aside of its way, stepping into it, not waiting for it)
        const into = p.moving && !(p.hold > 0.1) && Math.abs(lat) < w0 + 0.07 && (Math.sin(p.heading) * hz - Math.cos(p.heading) * hx) * Math.sign(lat) < -0.3;
        if ((Math.abs(lat) >= w0 && !into) || along <= 0 || along - 0.034 >= f + look) continue;
        const gap = Math.max(0, along - 0.034 - f) - GAP_FOOT;
        if (gap < room) { room = gap; by = null; why = 'a villager'; }
      }
    }
    if (room >= step) { v.wait = 0; v.by = null; v.backed = 0; return step; }
    v.wait += t;
    v.by = by; v.why = why;
    return Math.max(0, room);
  }

  // ---------------------------------------------------------------- carts
  planCarts() {
    const w = this.world;
    const shops = [...w.buildings.values()].filter(b => BUILDINGS[b.type].shop && b.connected && b.access && isOpen(b));
    if (!shops.length) return;
    for (const b of w.buildings.values()) {
      const def = BUILDINGS[b.type];
      if (def.cat !== 'industry' || !b.connected || !b.access || !b.workers.length) continue;
      const trips = 1 + Math.floor(b.level / 1);
      for (let k = 0; k < trips; k++) {
        const to = shops[(Math.random() * shops.length) | 0];
        this.cartPlan.push({ day: w.day, t: 8 + Math.random() * 9, from: b.id, to: to.id });
      }
    }
  }

  // A cart of building materials for a building being moved. Calls back on
  // arrival; returns false if there is no road between the two plots.
  haul(A, B, onArrive) {
    if (!A.access || !B.access) return false;
    const pts = this._cartWay(A, B);
    if (!pts) return false;
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
    const mesh = new THREE.Mesh(this._geo('cartmaterials', () => cartModel('materials')), MAT.building);
    mesh.castShadow = true;
    this.group.add(mesh);
    this.carts.push({ route: { pts, cum, length: cum[cum.length - 1] }, s: 0, mesh, legs: this._horseLegs(mesh, CART_HORSE), gait: 0, to: B.id, cb: onArrive, n: ++serial, wait: 0, by: null, placed: false });
    return true;
  }

  _updateCarts(dt) {
    const w = this.world, speed = this.game.speed;
    for (let i = this.cartPlan.length - 1; i >= 0; i--) {
      const c = this.cartPlan[i];
      if (c.day < w.day) { this.cartPlan.splice(i, 1); continue; }
      if (c.day === w.day && w.hours >= c.t) {
        this.cartPlan.splice(i, 1);
        const A = w.buildings.get(c.from), B = w.buildings.get(c.to);
        if (!A || !B || !A.access || !B.access || this.carts.length > 30) continue;
        const pts = this._cartWay(A, B);
        if (!pts) continue;
        const cum = [0];
        for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
        // (not on top of another vehicle: it waits till the road there is clear)
        const p0 = pts[0];
        if (this.bodies && this.bodies.some(o => !o.air && Math.hypot(o.x - p0[0], o.z - p0[1]) < 0.8)) { this.cartPlan.push(c); continue; }
        const cargo = CARGO[A.type] || 'crates';
        const mesh = new THREE.Mesh(this._geo('cart' + cargo, () => cartModel(cargo)), MAT.building);
        mesh.castShadow = true;
        this.group.add(mesh);
        const cart = { route: { pts, cum, length: cum[cum.length - 1] }, s: 0, mesh, legs: this._horseLegs(mesh, CART_HORSE), gait: 0, to: B.id, n: ++serial, wait: 0, by: null, placed: false };
        this.carts.push(cart);
        // (on the road from now: the next to set off waits for it)
        const h = Math.atan2(pts[1][0] - p0[0], pts[1][1] - p0[1]);
        if (this.bodies) this.bodies.push({ x: p0[0], y: 0, z: p0[1], hx: Math.sin(h), hz: Math.cos(h), f: BODY.cart[0], b: BODY.cart[1], w: BODY.cart[2], owner: cart, air: false });
      }
    }
    for (let i = this.carts.length - 1; i >= 0; i--) {
      const c = this.carts[i];
      const go = (dt * speed * CONFIG.CART_SPEED) / this._uphill(c.route, c.s);
      const step = c.placed ? this._clear(c, c.mesh, 'cart', go, dt * speed, c.route, c.s) : go;
      c.s += step;
      // (stuck a good while in a ring of vehicles each waiting for the next:
      // it finds another way, and is there)
      if (c.placed && c.wait > CART_GIVE_UP && this._ring(c)) c.s = c.route.length;
      c.gait += step * GAIT_PER_TILE;
      if (c.s >= c.route.length) {
        this.group.remove(c.mesh);
        this.carts.splice(i, 1);
        if (c.cb) { c.cb(); continue; }
        const B = w.buildings.get(c.to);
        if (B) {
          const v = this.game.sim.recordVisit(B, 4);
          const p = c.mesh.position;
          if (v) this.game.emit('coins', { x: p.x, y: p.y + 0.35, z: p.z, v });
        }
        continue;
      }
      const p = this._pose(c.route, Math.min(c.s, c.route.length - 1e-3), BODY.cart[0], BODY.cart[1]);
      c.mesh.position.set(p.x, this._height('coach', p.x, p.z), p.z);
      c.mesh.rotation.y = p.heading;
      c.placed = true;
      this._poseLegs(c.legs, c.gait, speed > 0 && step > 0, dt * speed);
    }
  }

  // A cart's way from building A's street to B's, in its lane, or null.
  _cartWay(A, B) {
    const route = this.game.paths.road(A.access, B.access);
    if (!route) return null;
    const C = routeCentre(this.world.roads, route);
    if (C.length < 2 || route.len < 0.3) return null;
    return smoothPolyline(untangle(offsetPath(thin(C), LANE)), 0.3, 3);
  }

  routeRibbons() {
    const out = [];
    for (const line of this.world.lines) {
      const r = this.routes.get(line.id);
      if (!r) continue;
      out.push({ points: this.routePoints(r), color: line.color });
    }
    return out;
  }

  dispose() {
    this.scene.remove(this.group);
    for (const g of this.geoCache.values()) g.dispose();
    for (const c of this.cables.values()) this._dropCable(c);
  }
}
