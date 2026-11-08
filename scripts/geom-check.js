// Checks for the gridless geometry: plots as rectangles at any angle, curves,
// and the road network (laying, joining, crossing, splitting, taking up).
// Usage: node scripts/geom-check.js
import { rect, rectsOverlap, segRectDist, inRect, spline, tightest, offsetLine, simplify, cumulative, pointAt, slice, nearestOn, Index, toLocal, toWorld } from '../src/world/geom.js';
import { Net, edgeHeights, heightOn } from '../src/world/net.js';

let fails = 0, n = 0;
const ok = (c, msg) => { n++; if (c) console.log('ok  ', msg); else { fails++; console.log('FAIL', msg); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// ---- rectangles
{
  const A = rect(0.5, 0.5, 0, 0.5, 0.5), B = rect(1.5, 0.5, 0, 0.5, 0.5), C = rect(1.4, 0.5, Math.PI / 4, 0.5, 0.5);
  ok(!rectsOverlap(A, B), 'two plots side by side touch but do not overlap');
  ok(rectsOverlap(A, C), 'a plot turned 45° into its neighbour overlaps it');
  ok(!rectsOverlap(A, rect(2.3, 0.5, Math.PI / 4, 0.5, 0.5)), 'turned 45° and clear of it, it does not');
  const R = rect(3, 4, 0.7, 0.6, 0.4), [lx, lz] = toLocal(R, ...toWorld(R, 0.2, -0.3));
  ok(near(lx, 0.2) && near(lz, -0.3), 'a point goes into a plot\'s own frame and back');
  const f = toWorld(R, 0, 0.4);
  ok(near(f[0], 3 + Math.sin(0.7) * 0.4) && near(f[1], 4 + Math.cos(0.7) * 0.4), 'a plot facing a fronts towards (sin a, cos a)');
  ok(inRect(R, 3, 4) && !inRect(R, ...toWorld(R, 0.65, 0.1)), 'a point in its plot, and one beyond its side');
  ok(near(segRectDist(A, -1, 2, 2, 2), 1), 'a road a unit beyond a plot is a unit from it');
  ok(segRectDist(A, -1, -1, 2, 2) === 0, 'a road straight through it touches it');
}

// ---- curves
{
  const c = spline([[0, 0], [2, 1], [4, 0]], 0.05);
  const hit = (x, z) => c.some(p => Math.hypot(p[0] - x, p[1] - z) < 0.06);
  ok(hit(0, 0) && hit(2, 1) && hit(4, 0), `a curve passes through what was drawn (${c.length} points)`);
  ok(tightest(c) > 1, `a gentle curve has a wide bend (radius ${tightest(c).toFixed(2)})`);
  ok(tightest([[0, 0], [1, 0], [1.05, 0.3], [0, 0.4]]) < 0.4, 'a hairpin has a tight one');
  ok(simplify([[0, 0], [1, 0.0001], [2, 0], [3, 0]], 0.01).length === 2, 'a straight run keeps only its ends');
  const o = offsetLine([[0, 0], [1, 0], [2, 0]], 0.1);
  ok(o.every(p => near(p[1], 0.1)), 'a lane to the right of a road going +x runs at +z');
  const P = [[0, 0], [3, 0], [3, 4]], cum = cumulative(P), q = pointAt(P, cum, 5);
  ok(near(q[0], 3) && near(q[1], 2), 'a point part-way along a bending line');
  const s = slice(P, cum, 4, 1);
  ok(near(s[0][1], 1) && near(s[s.length - 1][0], 1) && s.length === 3, 'a piece of a line, run backwards');
  ok(near(nearestOn(P, cum, 4, 2).s, 5), 'the nearest point on a line');
  const ix = new Index(2), a = {}, b = {};
  ix.add(a, [0, 0, 1, 1]); ix.add(b, [10, 10, 11, 11]);
  ok(ix.near(0.5, 0.5, 1).length === 1 && ix.near(5, 5, 6).length === 2, 'the index finds what is near');
}

// ---- the road network
{
  const net = new Net();
  const lay = (pts, props = { level: 1 }) => { const p = net.plan(pts); if (p.reason) return p; net.lay(p, props); return p; };
  lay([[0, 5], [10, 5]]);
  ok(net.edges.size === 1 && net.nodes.size === 2, 'a straight road is one edge between two ends');
  const p2 = lay([[5, 0], [5, 10]]);
  ok(p2.cross.length === 1 && net.edges.size === 4 && net.nodes.size === 5, 'a road across it makes a crossroads (4 edges, 5 nodes)');
  const hub = [...net.nodes.values()].find(n => n.edges.length === 4);
  ok(hub && near(hub.x, 5) && near(hub.z, 5), 'the crossroads is where they cross');
  const p3 = lay([[2, 5.25], [2, 9]]);
  ok(!p3.reason && p3.j0 && p3.j0.edge != null && net.edges.size === 6, 'a road started beside another joins it there (a T junction)');
  const p4 = net.plan([[3, 5.2], [9, 6]]);
  ok(p4.reason && /shallow/.test(p4.reason), `a road leaving another at a shallow angle is refused (${p4.reason})`);
  const p5 = net.plan([[5.1, 5.1], [5.2, 9]]);
  ok(p5.reason, `a road along another one is refused (${p5.reason})`);
  // through a junction: one crossing there, at the node
  const p6 = net.plan([[0, 0], [10, 10]]);
  ok(p6.cross.length === 1 && p6.cross[0].node === hub.id, 'a road through a junction crosses at that junction');
  // a curve across a straight road twice
  const before = net.edges.size;
  const curve = spline([[7, 3], [8.5, 7], [9.5, 3]], 0.05);
  const p7 = lay(curve);
  ok(!p7.reason && p7.cross.length === 2 && net.edges.size === before + 2 + 3, `a curve crossing a road twice splits it twice (${net.edges.size - before} more edges)`);
  // every edge's ends are its nodes
  ok([...net.edges.values()].every(e => { const A = net.nodes.get(e.a), B = net.nodes.get(e.b); return near(e.pts[0][0], A.x) && near(e.pts[0][1], A.z) && near(e.pts[e.pts.length - 1][0], B.x) && near(e.pts[e.pts.length - 1][1], B.z); }), 'every edge runs from its node a to its node b');
  // taking one up: the T's stem goes, and the road it met joins up again
  const stem = net.nearest(2, 7, 0.1).e;
  const tee = [stem.a, stem.b];
  net.removeEdge(stem.id); net.tidy(tee);
  ok(net.edges.size === before + 2 + 3 - 2 && !net.nearest(2, 7, 0.1), 'taking up the T\'s stem joins the road it met back into one');
  // reach
  const far = net.addNode(20, 20);
  ok(net.reach(hub.id).has(net.nearest(0, 5, 0.1).e.a) && !net.reach(hub.id).has(far.id), 'the network reaches what it is joined to');
  // records
  const back = Net.fromRec(JSON.parse(JSON.stringify(net.toRec())));
  ok(back.edges.size === net.edges.size && back.nodes.size === net.nodes.size - 1, 'a network saves and loads (an end with no road is dropped)');
  // heights: a bridge's deck, ramps at the banks
  const t = { heightAt: (x) => (x > 4 && x < 6 ? -0.5 : 0.3) };
  const e = new Net().addNode(0, 0) && null;
  const n2 = new Net(), A = n2.addNode(0, 0), B = n2.addNode(10, 0), E = n2.addEdge(A.id, B.id, [[0, 0], [10, 0]]);
  const hy = edgeHeights(E, t, 0.2, (x) => x > 4 && x < 6);
  ok(near(heightOn(hy, 5), 0.2) && near(heightOn(hy, 1), 0.312, 1e-4) && heightOn(hy, 3.8) < 0.31 && heightOn(hy, 3.8) > 0.2, 'a road over water is a deck, with a ramp from each bank');
  void e;
}

console.log(`\n${n - fails}/${n} ${fails ? 'FAILED' : 'passed'}`);
if (fails) process.exit(1);
