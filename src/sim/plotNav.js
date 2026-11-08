// Ways about an open plot (a farmyard, a park, a market square, a yard):
// a fine grid over the plot (in the plot's own frame, turned with it: the
// cells are only a way to find a path round things, nothing stands on
// them), blocked wherever the building's model stands at
// a villager's height (walls, sheds, stalls, statues, trunks, tall hedges),
// and the shortest way between two points on it that keeps to the open
// cells. Built from the model as drawn, so only where it is drawn: in the
// headless tests villagers walk straight, as they always did.

import { toLocal, toWorld } from '../world/geom.js';

const CELL = 0.05;
// a triangle blocks the way if any of it is between these heights above
// the plot's floor (low crops, flower beds, paving and low fences don't)
const LO = 0.09, HI = 0.13;

// The grid for building b drawn as mesh (its geometry in the mesh's frame,
// turned by mesh.rotation.y and placed at mesh.position), over its plot (R,
// a rectangle: geom.js) and a cell or two round it; the cells beyond the
// plot are blocked, as a neighbour's building may stand right up to its
// edge. Null without a model.
export function plotGrid(b, mesh, R) {
  const geo = mesh && mesh.geometry, pos = geo && geo.attributes && geo.attributes.position;
  if (!pos) return null;
  let x0 = -R.hw, z0 = -R.hd, x1 = R.hw, z1 = R.hd;
  const px0 = x0, pz0 = z0, px1 = x1, pz1 = z1;
  x0 -= CELL * 2; z0 -= CELL * 2; x1 += CELL * 2; z1 += CELL * 2;
  const nx = Math.ceil((x1 - x0) / CELL), nz = Math.ceil((z1 - z0) / CELL);
  const blocked = new Uint8Array(nx * nz);
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const cx = x0 + (i + 0.5) * CELL, cz = z0 + (k + 0.5) * CELL;
    if (cx < px0 || cx > px1 || cz < pz0 || cz > pz1) blocked[k * nx + i] = 2;
  }
  const th = mesh.rotation.y, co = Math.cos(th), si = Math.sin(th), px = mesh.position.x, pz = mesh.position.z;
  const floor = b.baseY - mesh.position.y;
  const P = pos.array, I = geo.index ? geo.index.array : null, n = I ? I.length : pos.count;
  // (the model's points in the plot's own frame)
  const mark = (x, z) => {
    const i = Math.floor((x - x0) / CELL), k = Math.floor((z - z0) / CELL);
    if (i >= 0 && k >= 0 && i < nx && k < nz) blocked[k * nx + i] = 1;
  };
  const local = (wx, wz) => toLocal(R, wx, wz);
  const W = [0, 0, 0, 0, 0, 0];
  for (let t = 0; t + 2 < n; t += 3) {
    let ya = Infinity, yb = -Infinity;
    for (let v = 0; v < 3; v++) {
      const j = I ? I[t + v] : t + v, y = P[j * 3 + 1] - floor;
      ya = Math.min(ya, y); yb = Math.max(yb, y);
      const lx = P[j * 3], lz = P[j * 3 + 2];
      const [qx, qz] = local(px + lx * co + lz * si, pz - lx * si + lz * co);
      W[v * 2] = qx; W[v * 2 + 1] = qz;
    }
    if (yb < LO || ya > HI) continue;
    // the triangle as seen from above: its edges, and whatever it covers
    let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    for (let v = 0; v < 3; v++) {
      const ax = W[v * 2], az = W[v * 2 + 1], cx = W[((v + 1) % 3) * 2], cz = W[((v + 1) % 3) * 2 + 1];
      const L = Math.hypot(cx - ax, cz - az), m = Math.max(1, Math.ceil(L / (CELL * 0.5)));
      for (let s = 0; s <= m; s++) mark(ax + ((cx - ax) * s) / m, az + ((cz - az) * s) / m);
      bx0 = Math.min(bx0, ax); bx1 = Math.max(bx1, ax); bz0 = Math.min(bz0, az); bz1 = Math.max(bz1, az);
    }
    const area = (W[2] - W[0]) * (W[5] - W[1]) - (W[4] - W[0]) * (W[3] - W[1]);
    if (Math.abs(area) < CELL * CELL) continue;
    for (let z = Math.floor((bz0 - z0) / CELL); z <= Math.floor((bz1 - z0) / CELL); z++) for (let x = Math.floor((bx0 - x0) / CELL); x <= Math.floor((bx1 - x0) / CELL); x++) {
      const cx = x0 + (x + 0.5) * CELL, cz = z0 + (z + 0.5) * CELL;
      const d1 = (W[2] - W[0]) * (cz - W[1]) - (W[3] - W[1]) * (cx - W[0]);
      const d2 = (W[4] - W[2]) * (cz - W[3]) - (W[5] - W[3]) * (cx - W[2]);
      const d3 = (W[0] - W[4]) * (cz - W[5]) - (W[1] - W[5]) * (cx - W[4]);
      if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) mark(cx, cz);
    }
  }
  // a cell's room round all of it, so a villager (about that wide) going
  // round a corner doesn't brush through it (tight: the grid as drawn, for
  // squeezing up a portico's steps between its columns)
  const wide = blocked.slice();
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    if (blocked[k * nx + i] !== 1) continue;
    for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
      const a = i + di, c = k + dk;
      if (a >= 0 && c >= 0 && a < nx && c < nz) wide[c * nx + a] = 1;
    }
  }
  const g = { x0, z0, nx, nz, blocked: wide, R };
  g.tight = { x0, z0, nx, nz, blocked, R };
  return g;
}

// What there is to stand on in front of a door: the tops of its steps,
// porch, portico and plinth (faces turned up, no higher than top), as a
// height for each fine cell over the plot (-Infinity where there is none),
// so a villager going in climbs the steps rather than walking through them.
const STEP_CELL = 0.025;
export function stepsGrid(b, mesh, x0, z0, x1, z1, top) {
  const geo = mesh && mesh.geometry, pos = geo && geo.attributes && geo.attributes.position;
  if (!pos) return null;
  const nx = Math.ceil((x1 - x0) / STEP_CELL), nz = Math.ceil((z1 - z0) / STEP_CELL);
  const h = new Float32Array(nx * nz).fill(-Infinity);
  const th = mesh.rotation.y, co = Math.cos(th), si = Math.sin(th), px = mesh.position.x, py = mesh.position.y, pz = mesh.position.z;
  const P = pos.array, I = geo.index ? geo.index.array : null, n = I ? I.length : pos.count;
  const W = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  let any = false;
  for (let t = 0; t + 2 < n; t += 3) {
    for (let v = 0; v < 3; v++) {
      const j = I ? I[t + v] : t + v, lx = P[j * 3], lz = P[j * 3 + 2];
      W[v * 3] = px + lx * co + lz * si; W[v * 3 + 1] = py + P[j * 3 + 1]; W[v * 3 + 2] = pz - lx * si + lz * co;
    }
    const y = (W[1] + W[4] + W[7]) / 3;
    if (Math.max(W[1], W[4], W[7]) > top) continue;
    // facing up: the normal's height over its length
    const ux = W[3] - W[0], uy = W[4] - W[1], uz = W[5] - W[2], vx = W[6] - W[0], vy = W[7] - W[1], vz = W[8] - W[2];
    const nxv = uy * vz - uz * vy, nyv = uz * vx - ux * vz, nzv = ux * vy - uy * vx;
    if (Math.abs(nyv) < 0.7 * Math.hypot(nxv, nyv, nzv)) continue;
    const bx0 = Math.min(W[0], W[3], W[6]), bx1 = Math.max(W[0], W[3], W[6]), bz0 = Math.min(W[2], W[5], W[8]), bz1 = Math.max(W[2], W[5], W[8]);
    for (let k = Math.max(0, Math.floor((bz0 - z0) / STEP_CELL)); k <= Math.min(nz - 1, Math.floor((bz1 - z0) / STEP_CELL)); k++) for (let i = Math.max(0, Math.floor((bx0 - x0) / STEP_CELL)); i <= Math.min(nx - 1, Math.floor((bx1 - x0) / STEP_CELL)); i++) {
      const cx = x0 + (i + 0.5) * STEP_CELL, cz = z0 + (k + 0.5) * STEP_CELL;
      const d1 = (W[3] - W[0]) * (cz - W[2]) - (W[5] - W[2]) * (cx - W[0]);
      const d2 = (W[6] - W[3]) * (cz - W[5]) - (W[8] - W[5]) * (cx - W[3]);
      const d3 = (W[0] - W[6]) * (cz - W[8]) - (W[2] - W[8]) * (cx - W[6]);
      if (!((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0))) continue;
      const c = k * nx + i;
      if (y > h[c]) { h[c] = y; any = true; }
    }
  }
  return any ? { x0, z0, nx, nz, h } : null;
}
// The height to stand at over (x, z) on a steps grid, or -Infinity.
export function stepAt(s, x, z) {
  const i = Math.floor((x - s.x0) / STEP_CELL), k = Math.floor((z - s.z0) / STEP_CELL);
  return i >= 0 && k >= 0 && i < s.nx && k < s.nz ? s.h[k * s.nx + i] : -Infinity;
}

// (world points in the plot's own frame, and back)
const lc = (g, x, z) => (g.R ? toLocal(g.R, x, z) : [x, z]);
const wc = (g, x, z) => (g.R ? toWorld(g.R, x, z) : [x, z]);
const cellOf = (g, x, z) => { [x, z] = lc(g, x, z); return [Math.min(g.nx - 1, Math.max(0, Math.floor((x - g.x0) / CELL))), Math.min(g.nz - 1, Math.max(0, Math.floor((z - g.z0) / CELL)))]; };
const cellXZ = (g, i, k) => wc(g, g.x0 + (i + 0.5) * CELL, g.z0 + (k + 0.5) * CELL);
const free = (g, i, k) => i >= 0 && k >= 0 && i < g.nx && k < g.nz && !g.blocked[k * g.nx + i];

// The open cell nearest (x, z) (itself if open), or null.
function nearestFree(g, x, z) {
  const [i, k] = cellOf(g, x, z);
  if (free(g, i, k)) return [i, k];
  for (let r = 1; r < 8; r++) {
    let best = null, bd = Infinity;
    for (let dk = -r; dk <= r; dk++) for (let di = -r; di <= r; di++) {
      if (Math.max(Math.abs(di), Math.abs(dk)) !== r || !free(g, i + di, k + dk)) continue;
      const d = di * di + dk * dk;
      if (d < bd) { bd = d; best = [i + di, k + dk]; }
    }
    if (best) return best;
  }
  return null;
}

// How much of the plot's open ground can be reached from (x, z): { share
// (of its open cells: 1 with none to reach), pts (the middles of the cells
// reached, [x, z] in the world) }, the ways about it as walked.
export function reachFrom(g, x, z) {
  const s = nearestFree(g, x, z);
  let all = 0;
  for (let c = 0; c < g.nx * g.nz; c++) if (!g.blocked[c]) all++;
  if (!all) return { share: 1, pts: [] };
  if (!s) return { share: 0, pts: [] };
  const seen = new Uint8Array(g.nx * g.nz), q = [s[1] * g.nx + s[0]];
  seen[q[0]] = 1;
  for (let h = 0; h < q.length; h++) {
    const c = q[h], i = c % g.nx, k = (c / g.nx) | 0;
    for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
      if ((!di && !dk) || !free(g, i + di, k + dk)) continue;
      if (di && dk && (!free(g, i + di, k) || !free(g, i, k + dk))) continue;
      const nc = (k + dk) * g.nx + i + di;
      if (!seen[nc]) { seen[nc] = 1; q.push(nc); }
    }
  }
  return { share: q.length / all, pts: q.map(c => cellXZ(g, c % g.nx, (c / g.nx) | 0)) };
}

// Is (x, z) open ground on the grid?
export function openAt(g, x, z) { return free(g, ...cellOf(g, x, z)); }

// Is the straight line between two points open all the way?
export function clearLine(g, ax, az, bx, bz) {
  const L = Math.hypot(bx - ax, bz - az), m = Math.max(1, Math.ceil(L / (CELL * 0.5)));
  for (let s = 0; s <= m; s++) {
    const [i, k] = cellOf(g, ax + ((bx - ax) * s) / m, az + ((bz - az) * s) / m);
    if (!free(g, i, k)) return false;
  }
  return true;
}

// The way from (ax, az) to (bx, bz) round what stands in it, as the points
// to walk to in turn (ending at b, or at the open spot nearest it); a
// straight walk if that is clear, and null if there is no way through.
export function plotPath(g, ax, az, bx, bz) {
  const s = nearestFree(g, ax, az), e = nearestFree(g, bx, bz);
  if (!s || !e) return null;
  const end = free(g, ...cellOf(g, bx, bz)) ? [bx, bz] : cellXZ(g, e[0], e[1]);
  const start = [ax, az];
  if (free(g, ...cellOf(g, ax, az)) && clearLine(g, ax, az, end[0], end[1])) return [end];
  // breadth-first over the cells (eight ways, no squeezing past a corner)
  const N = g.nx * g.nz, prev = new Int32Array(N).fill(-1), si = s[1] * g.nx + s[0], ei = e[1] * g.nx + e[0];
  prev[si] = si;
  const q = [si];
  for (let h = 0; h < q.length && prev[ei] < 0; h++) {
    const c = q[h], i = c % g.nx, k = (c / g.nx) | 0;
    for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
      if ((!di && !dk) || !free(g, i + di, k + dk)) continue;
      if (di && dk && (!free(g, i + di, k) || !free(g, i, k + dk))) continue;
      const nc = (k + dk) * g.nx + i + di;
      if (prev[nc] >= 0) continue;
      prev[nc] = c;
      q.push(nc);
    }
  }
  if (prev[ei] < 0) return null;
  const cells = [];
  for (let c = ei; c !== si; c = prev[c]) cells.push(cellXZ(g, c % g.nx, (c / g.nx) | 0));
  cells.reverse();
  cells[cells.length - 1] = end;
  // pull the string tight: keep only the corners it has to go round (first
  // stepping out into the open, if starting up against something)
  const out = [];
  let from = start;
  if (!free(g, ...cellOf(g, ax, az))) { from = cellXZ(g, s[0], s[1]); out.push(from); }
  for (let i = 0; i < cells.length; i++) {
    const next = cells[i + 1];
    if (next && clearLine(g, from[0], from[1], next[0], next[1])) continue;
    out.push(cells[i]);
    from = cells[i];
  }
  return out;
}
