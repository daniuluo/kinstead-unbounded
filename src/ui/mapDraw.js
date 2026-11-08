// Drawing a town from above on a 2D canvas (the starter picker's little
// maps, the merge window's pictures): its roads and track as the curves
// they are, its plots as the rectangles they are, at their angles. The
// canvas's own transform is in world units.

import { plotOf, HALF, RAIL_HALF } from '../world/world.js';

export function strokeNet(g, net, color, width) {
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const e of net.edges.values()) {
    g.strokeStyle = typeof color === 'function' ? color(e) : color;
    g.lineWidth = typeof width === 'function' ? width(e) : width;
    g.beginPath();
    e.pts.forEach(([x, z], i) => (i ? g.lineTo(x, z) : g.moveTo(x, z)));
    g.stroke();
  }
}

// Roads (coloured by level: roadCol[level]) and track.
export function drawNets(g, w, roadCol, railCol = '#4a403c') {
  strokeNet(g, w.rails, railCol, RAIL_HALF * 2 + 0.06);
  strokeNet(g, w.roads, (e) => roadCol[e.level] || roadCol[1], (e) => HALF[e.level] * 2 + 0.06);
}

// A plot as a filled polygon, shrunk by inset.
export function fillPlot(g, b, color, inset = 0) {
  const R = plotOf(b), cx = R.cx, cz = R.cz;
  g.fillStyle = color;
  g.beginPath();
  R.pts.forEach(([x, z], i) => {
    const dx = x - cx, dz = z - cz, L = Math.hypot(dx, dz) || 1, k = Math.max(0, L - inset * Math.SQRT2) / L;
    const px = cx + dx * k, pz = cz + dz * k;
    if (i) g.lineTo(px, pz); else g.moveTo(px, pz);
  });
  g.closePath();
  g.fill();
}
