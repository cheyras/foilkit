// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// The cubic primitive and the pen tool's arithmetic, in the order the mistakes happen:
//   1. the cubic flattens to the SAME error the arc case promises;
//   2. splitting a curve does not move it;
//   3. a cubic lands where the old language put the same shape — px round trip, IoU;
//   4. reversing a cubic reverses it, handles and all;
//   5. THE SCALING BUG: a cubic carries three points and a converter that scales one of them
//      leaves the handles in the other coordinate space;
//   6. hit priority — anchor over handle over segment, which is what makes an editor feel right;
//   7. the bounding box is the curve's, not the control hull's;
//   8. inside/outside agrees with the rasteriser, holes included.
//
// The curve arithmetic here is INDEPENDENT of the implementation's. `cubicAt` uses the
// Bernstein form; every check below evaluates by repeated linear interpolation instead, which
// is a different computation of the same curve. Calling the shipped helper to verify the
// shipped helper would prove only that it agrees with itself — the trap `vector-template.test.ts`
// case 4 names, and the reason its arc test recovers the circle from the output rather than
// deriving it the way the flattener does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flattenPath, rasterizeTemplate, reversePath, mapPathCoords,
  DEFAULT_VECTOR_FIT_PARAMS,
  type CubicPrim, type Prim, type VPath, type VectorTemplate,
} from '../vector-template.ts';
import {
  evalPrim, projectToPrim, splitCubic, hitTestPath, pathAnchors,
  pointInPath, pathWinding, pathBounds,
} from '../pen-geometry.ts';
import { rasterizePolygons, type Vec } from '../line-snap.ts';
import { iou } from '../region-learn.ts';

// ── an independent cubic ───────────────────────────────────────────────────

/** de Casteljau by repeated lerp — deliberately not the Bernstein form the module uses. */
function bez(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const L = (a: Vec, b: Vec): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  return L(L(L(p0, p1), L(p1, p2)), L(L(p1, p2), L(p2, p3)));
}
const V = (x: number, y: number): Vec => ({ x, y });
const P = (p: [number, number]): Vec => ({ x: p[0], y: p[1] });
const D = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Distance from a point to a polyline, segment by segment. */
function distToPolyline(p: Vec, poly: Vec[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i]!, b = poly[i + 1]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 < 1e-24 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

// ── 1. the sagitta bound means the same thing for a cubic as for an arc ────

test('cubic flattening honours its sagitta bound, at the same error the arc case promises', () => {
  const c: CubicPrim = { k: 'cubic', c1: [10, 190], c2: [190, 190], to: [190, 10] };
  const p0 = V(10, 10), p1 = P(c.c1), p2 = P(c.c2), p3 = P(c.to);
  const path: VPath = { start: [10, 10], prims: [c, { k: 'line', to: [10, 10] }] };

  const coarse = flattenPath(path, 2.0);
  const fine = flattenPath(path, 0.02);
  assert.ok(fine.length > coarse.length,
    `a tighter sagitta means more chords: 0.02 gave ${fine.length}, 2.0 gave ${coarse.length}`);

  // One independently-evaluated copy of the true curve, dense enough that half a sample
  // spacing (~0.01 on a curve about 400 long) is well inside every tolerance asserted below.
  const N = 20000;
  const truth: Vec[] = [];
  for (let i = 0; i <= N; i++) truth.push(bez(p0, p1, p2, p3, i / N));

  for (const sagitta of [2.0, 0.25, 0.02]) {
    const poly = flattenPath(path, sagitta).slice(0, -1);   // drop the closing line's endpoint

    // Every emitted vertex is a point ON the curve — subdivision only ever splits, it never
    // approximates a vertex. The 0.05 is the sampling resolution of `truth`, not slack in
    // the flattener: the real error here is zero to floating point.
    for (const q of poly) {
      let onCurve = Infinity;
      for (const c of truth) onCurve = Math.min(onCurve, D(q, c));
      assert.ok(onCurve < 0.05,
        `sagitta ${sagitta}: flattened vertex (${q.x.toFixed(3)},${q.y.toFixed(3)}) is ${onCurve.toFixed(4)} off the true curve`);
    }

    // And the direction that is actually a promise: no point of the true curve is further
    // from the polyline than the sagitta asked for. A flattener can satisfy the check above
    // with two chords; only this one says "fine enough".
    let worst = 0;
    for (const c of truth) worst = Math.max(worst, distToPolyline(c, poly));
    assert.ok(worst <= sagitta + 1e-9,
      `sagitta ${sagitta}: the true curve strays ${worst.toFixed(5)} from the ${poly.length}-point polyline`);
    // Not vacuous: a flattener that ignored `sagitta` and simply emitted a thousand chords
    // would pass the line above at every tolerance, and this catches it.
    assert.ok(worst > sagitta / 400, `sagitta ${sagitta}: ${poly.length} points is wastefully fine (worst ${worst})`);
  }
});

// ── 2. splitting a curve does not move it ─────────────────────────────────

test('splitCubic preserves the shape — adding an anchor costs nothing', () => {
  const from = V(30, 200);
  const c: CubicPrim = { k: 'cubic', c1: [-40, 20], c2: [260, 10], to: [180, 190] };
  const p0 = from, p1 = P(c.c1), p2 = P(c.c2), p3 = P(c.to);

  for (const t of [0.05, 0.25, 0.5, 0.731, 0.97]) {
    const [a, b] = splitCubic(from, c, t);
    const mid = P(a.to);
    assert.ok(D(mid, bez(p0, p1, p2, p3, t)) < 1e-12,
      `t=${t}: the first half must end at the split point, not near it`);
    assert.deepEqual(b.to, c.to, 'and the second half must end exactly where the original did');
    for (let i = 0; i <= 200; i++) {
      const u = i / 200;
      const left = bez(p0, P(a.c1), P(a.c2), P(a.to), u);
      const right = bez(mid, P(b.c1), P(b.c2), P(b.to), u);
      assert.ok(D(left, bez(p0, p1, p2, p3, t * u)) < 1e-9,
        `t=${t} u=${u}: the first half left the curve by ${D(left, bez(p0, p1, p2, p3, t * u))}`);
      assert.ok(D(right, bez(p0, p1, p2, p3, t + (1 - t) * u)) < 1e-9,
        `t=${t} u=${u}: the second half left the curve by ${D(right, bez(p0, p1, p2, p3, t + (1 - t) * u))}`);
    }
  }
});

test('projectToPrim finds the point splitCubic then splits at', () => {
  // The pairing the editor's "click a segment to add an anchor" gesture is made of: the t
  // that comes out of the projection is the t that goes into the split, unconverted.
  const from = V(0, 0);
  const c: CubicPrim = { k: 'cubic', c1: [0, 120], c2: [200, 120], to: [200, 0] };
  const target = bez(from, P(c.c1), P(c.c2), P(c.to), 0.37);
  const hit = projectToPrim(from, c, target);
  assert.ok(Math.abs(hit.t - 0.37) < 1e-6, `expected t=0.37, got ${hit.t}`);
  assert.ok(hit.dist < 1e-9, `the point is on the curve; got dist ${hit.dist}`);

  // Off the curve, the answer must still be the nearest point and not merely a near one.
  const off = V(60, 200);
  const near = projectToPrim(from, c, off);
  let brute = Infinity;
  for (let i = 0; i <= 100000; i++) brute = Math.min(brute, D(off, bez(from, P(c.c1), P(c.c2), P(c.to), i / 100000)));
  assert.ok(near.dist - brute < 1e-6, `Newton found ${near.dist}, brute force found ${brute}`);
});

test('projectToPrim clamps an arc to its swept range, not to the whole circle', () => {
  // A quarter arc from (100,0) to (0,100) about the origin. A point out beyond the OTHER
  // three quadrants has no radial projection inside the sweep, and the answer is an endpoint.
  const from = V(100, 0);
  const arc: Prim = { k: 'arc', to: [0, 100], r: 100, sweep: 1 };
  const on = projectToPrim(from, arc, V(Math.SQRT1_2 * 200, Math.SQRT1_2 * 200));
  assert.ok(Math.abs(on.t - 0.5) < 1e-9, `the 45-degree direction is halfway along; got t=${on.t}`);
  assert.ok(Math.abs(on.dist - 100) < 1e-9, 'and 100 outside a radius-100 circle');

  const behind = projectToPrim(from, arc, V(-300, -10));
  assert.equal(behind.t, 1, 'a point past the far end clamps to the far end');
  const infront = projectToPrim(from, arc, V(300, -10));
  assert.equal(infront.t, 0, 'and a point before the near end clamps to the near end');
});

// ── 3. the new primitive lands where the old language put the same shape ───

const K = 0.5522847498307933;   // the circle-to-cubic constant, 4/3 * tan(pi/8)

/** The four corner circles of a rounded rect, as the ARC language spells it. */
function roundedRectArcs(x0: number, y0: number, x1: number, y1: number, r: number): VPath {
  return {
    start: [x0 + r, y0],
    prims: [
      { k: 'line', to: [x1 - r, y0] },
      { k: 'arc', to: [x1, y0 + r], r, sweep: 1 },
      { k: 'line', to: [x1, y1 - r] },
      { k: 'arc', to: [x1 - r, y1], r, sweep: 1 },
      { k: 'line', to: [x0 + r, y1] },
      { k: 'arc', to: [x0, y1 - r], r, sweep: 1 },
      { k: 'line', to: [x0, y0 + r] },
      { k: 'arc', to: [x0 + r, y0], r, sweep: 1 },
    ],
  };
}

/** The identical shape, as the CUBIC language spells it. */
function roundedRectCubics(x0: number, y0: number, x1: number, y1: number, r: number): VPath {
  // Handles from the tangent at each end of a quarter circle, travelling with increasing
  // angle (which is what `sweep: 1` means): T(theta) = (-sin theta, cos theta).
  const corner = (cx: number, cy: number, a0: number): CubicPrim => {
    const a1 = a0 + Math.PI / 2;
    const s = V(cx + r * Math.cos(a0), cy + r * Math.sin(a0));
    const e = V(cx + r * Math.cos(a1), cy + r * Math.sin(a1));
    return {
      k: 'cubic',
      c1: [s.x + K * r * -Math.sin(a0), s.y + K * r * Math.cos(a0)],
      c2: [e.x - K * r * -Math.sin(a1), e.y - K * r * Math.cos(a1)],
      to: [e.x, e.y],
    };
  };
  return {
    start: [x0 + r, y0],
    prims: [
      { k: 'line', to: [x1 - r, y0] },
      corner(x1 - r, y0 + r, -Math.PI / 2),
      { k: 'line', to: [x1, y1 - r] },
      corner(x1 - r, y1 - r, 0),
      { k: 'line', to: [x0 + r, y1] },
      corner(x0 + r, y1 - r, Math.PI / 2),
      { k: 'line', to: [x0, y0 + r] },
      corner(x0 + r, y0 + r, Math.PI),
    ],
  };
}

const templateOf = (outer: VPath): VectorTemplate => ({
  id: 't', version: 1, eraId: 'x', scope: 'sheet',
  space: { width: 200, height: 200 },
  outer,
  holes: [],
  provenance: {
    generator: { name: 'test', version: 1, modelId: null, runId: 'test' },
    exemplars: [], fittedAt: '', params: DEFAULT_VECTOR_FIT_PARAMS, statement: '',
  },
});

test('a rounded rect built from cubics rasterises where the arc version does', () => {
  // The claim the third primitive has to earn: it is a new way to SAY a shape, not a new
  // shape. Both paths are written in pixels and normalised through the same converter, so
  // what differs between the two rasters is the primitive and nothing else.
  const toFrac = (p: VPath): VPath => mapPathCoords(p, ([x, y]) => [x / 200, y / 200], (r) => r / 200);
  const arcs = rasterizeTemplate(templateOf(toFrac(roundedRectArcs(20, 20, 180, 180, 40))), 200, 200, { evolves: false });
  const cubics = rasterizeTemplate(templateOf(toFrac(roundedRectCubics(20, 20, 180, 180, 40))), 200, 200, { evolves: false });
  const agreement = iou(arcs, cubics);
  assert.ok(agreement >= 0.99, `cubic rounded rect vs arc rounded rect: IoU ${agreement.toFixed(5)} should be >= 0.99`);

  // And it is a real shape, not two identical empty rasters agreeing perfectly.
  let filled = 0;
  for (const px of cubics) if (px >= 128) filled++;
  assert.ok(filled > 20000 && filled < 32000, `the rounded rect should cover ~25k of 40k px, got ${filled}`);
});

// ── 4. reversing a cubic reverses it ──────────────────────────────────────

test('reversePath on a cubic swaps its handles, and reversing twice is identity', () => {
  const c: CubicPrim = { k: 'cubic', c1: [0, 100], c2: [100, 100], to: [100, 0] };
  const path: VPath = { start: [0, 0], prims: [c, { k: 'line', to: [0, 0] }] };
  const rev = reversePath(path);

  assert.deepEqual(rev.start, [0, 0]);
  assert.deepEqual(rev.prims[0], { k: 'line', to: [100, 0] }, 'the closing line comes first, aimed back');
  assert.deepEqual(rev.prims[1], { k: 'cubic', c1: [100, 100], c2: [0, 100], to: [0, 0] },
    'the cubic keeps its handles and swaps which end they belong to');

  // The shape claim, not just the field layout: walking the reversed cubic backwards traces
  // the original. Leaving the handles unswapped would keep both endpoints and both handle
  // POSITIONS and still fail here, because the curve would bulge the other way.
  const fwd = (u: number): Vec => bez(V(0, 0), P(c.c1), P(c.c2), P(c.to), u);
  const back = rev.prims[1] as CubicPrim;
  for (let i = 0; i <= 100; i++) {
    const u = i / 100;
    const q = bez(V(100, 0), P(back.c1), P(back.c2), P(back.to), u);
    assert.ok(D(q, fwd(1 - u)) < 1e-9, `u=${u}: reversed curve is ${D(q, fwd(1 - u))} off the original`);
  }

  assert.deepEqual(reversePath(rev), path, 'reversing twice returns the path unchanged');
});

// ── 5. THE SCALING BUG ────────────────────────────────────────────────────

test('mapPathCoords scales a cubic\'s HANDLES, not only its endpoint', () => {
  // The highest-value assertion in this file. `rasterizeTemplate`'s toPx and `fitTemplate`'s
  // norm both run through this one function; the bug it exists to prevent is a converter that
  // handles `to` and forgets `c1`/`c2`, which leaves the handles in fractions (~1) while the
  // endpoints are in pixels (~500). Anisotropic factors on purpose, and no coordinate whose
  // x and y scale to the same number, so scaling y by the x factor fails here too. Every
  // value is dyadic and every factor a power of two, so `deepEqual` is comparing arithmetic
  // rather than comparing float noise.
  const src: VPath = {
    start: [0.125, 0.375],
    prims: [
      { k: 'cubic', c1: [0.25, 0.125], c2: [0.375, 0.625], to: [0.5, 0.75] },
      { k: 'arc', to: [0.75, 0.5], r: 0.25, sweep: 1 },
      { k: 'line', to: [0.125, 0.375] },
    ],
  };
  const px = mapPathCoords(src, ([x, y]) => [x * 256, y * 128], (r) => r * 256);
  assert.deepEqual(px.start, [32, 48]);
  assert.deepEqual(px.prims[0], { k: 'cubic', c1: [64, 16], c2: [96, 80], to: [128, 96] });
  assert.deepEqual(px.prims[1], { k: 'arc', to: [192, 64], r: 64, sweep: 1 });
  assert.deepEqual(px.prims[2], { k: 'line', to: [32, 48] });

  // And the inverse — the shape `fitTemplate`'s norm has — returns every one of them.
  const back = mapPathCoords(px, ([x, y]) => [x / 256, y / 128], (r) => r / 256);
  assert.deepEqual(back, src, 'px -> fraction -> px is the identity, handles included');
});

test('a cubic template rasterises through toPx in the right coordinate space', () => {
  // The end-to-end half of the same claim, through `rasterizeTemplate`'s own converter — and
  // with the bug's raster computed alongside, so this cannot rot into "two code paths agree".
  const sag = DEFAULT_VECTOR_FIT_PARAMS.flattenSagittaPx;
  const frac: VPath = {
    start: [0.1, 0.1],
    prims: [{ k: 'cubic', c1: [0.1, 0.9], c2: [0.9, 0.9], to: [0.9, 0.1] }, { k: 'line', to: [0.1, 0.1] }],
  };
  const shipped = rasterizeTemplate(templateOf(frac), 200, 200, { evolves: false, sagittaPx: sag });

  const right: VPath = {
    start: [20, 20],
    prims: [{ k: 'cubic', c1: [20, 180], c2: [180, 180], to: [180, 20] }, { k: 'line', to: [20, 20] }],
  };
  const expected = rasterizePolygons([flattenPath(right, sag)], 200, 200, 4);
  assert.ok(iou(shipped, expected) >= 0.999,
    `the shipped raster should be the pixel-space shape; IoU ${iou(shipped, expected).toFixed(5)}`);

  // What the forgotten-handles bug actually produces: endpoints in pixels, handles left in
  // fractions. It still closes, still rasterises, and is nothing like the right shape.
  const wrong: VPath = {
    start: [20, 20],
    prims: [{ k: 'cubic', c1: [0.1, 0.9], c2: [0.9, 0.9], to: [180, 20] }, { k: 'line', to: [20, 20] }],
  };
  const broken = rasterizePolygons([flattenPath(wrong, sag)], 200, 200, 4);
  assert.ok(iou(expected, broken) < 0.5,
    `the bug this test guards must be visible: IoU ${iou(expected, broken).toFixed(5)} should be well under 0.5`);
});

// ── 6. hit priority ───────────────────────────────────────────────────────

test('hitTestPath reports the anchor, even when the segment through it is closer', () => {
  const c: CubicPrim = { k: 'cubic', c1: [0, 50], c2: [100, 50], to: [100, 0] };
  const path: VPath = { start: [0, 0], prims: [c, { k: 'line', to: [0, 0] }] };
  assert.deepEqual(pathAnchors(path).map((a) => [a.x, a.y]), [[0, 0], [100, 0], [0, 0]]);

  // A point sitting EXACTLY on the curve, close enough to the first anchor to be a grab.
  const p = bez(V(0, 0), P(c.c1), P(c.c2), P(c.to), 0.05);
  const toAnchor = D(p, V(0, 0));
  assert.ok(toAnchor > 1 && toAnchor < 8, `the fixture needs the anchor in reach but not on top; got ${toAnchor}`);

  const hit = hitTestPath(path, p, 8);
  assert.ok(hit, 'something should be hit');
  assert.equal(hit!.kind, 'anchor', `an anchor in tolerance outranks a segment at distance ${projectToPrim(V(0, 0), c, p).dist}`);
  assert.equal(hit!.index, 0);
  // The trap named: by raw distance the segment wins outright, and ranking on distance alone
  // would insert a new anchor a hair from the one the user meant to drag.
  assert.ok(projectToPrim(V(0, 0), c, p).dist < toAnchor, 'the segment really is the closer of the two');

  // Out of the anchor's reach, the same point is a segment hit — the tiers are a priority,
  // not a blanket preference.
  const far = hitTestPath(path, p, 1.0);
  assert.equal(far?.kind, 'segment', 'with a tight tolerance the anchor is out of reach and the segment answers');
});

test('hitTestPath reports a handle over the segment it sits beside', () => {
  const c: CubicPrim = { k: 'cubic', c1: [10, 2], c2: [90, 2], to: [100, 0] };
  const path: VPath = { start: [0, 0], prims: [c, { k: 'line', to: [0, 0] }] };
  const p = bez(V(0, 0), P(c.c1), P(c.c2), P(c.to), 0.15);       // exactly on the curve
  const toHandle = D(p, V(10, 2));
  assert.ok(toHandle > 0.5 && toHandle < 3, `fixture: the handle should be near but not on the point (${toHandle})`);

  const hit = hitTestPath(path, p, 3);
  assert.equal(hit?.kind, 'handle', 'a grabbable handle outranks the segment even at zero segment distance');
  assert.equal(hit?.kind === 'handle' ? hit.which : null, 'c1');
  assert.ok(D(p, V(0, 0)) > 3, 'and no anchor is in reach, so this is the handle/segment tier and not the anchor one');
});

test('hitTestPath returns null when nothing is within tolerance', () => {
  const path: VPath = { start: [0, 0], prims: [{ k: 'line', to: [10, 0] }, { k: 'line', to: [0, 0] }] };
  assert.equal(hitTestPath(path, V(5, 40), 2), null);
});

// ── 7. the bounding box is the curve's, not the hull's ────────────────────

test('pathBounds is tight on a cubic whose control hull is far larger than the curve', () => {
  // Handles pulled to y = 400; the curve never passes y = 300. y(t) = 1200 t (1 - t), whose
  // maximum is exactly 300 at t = 1/2 — worked out by hand so the expected number is not the
  // implementation's own opinion.
  const c: CubicPrim = { k: 'cubic', c1: [0, 400], c2: [100, 400], to: [100, 0] };
  const b = pathBounds({ start: [0, 0], prims: [c, { k: 'line', to: [0, 0] }] });
  assert.ok(Math.abs(b.y1 - 300) < 1e-9, `tight bottom is 300, got ${b.y1}`);
  assert.ok(Math.abs(b.x0) < 1e-9 && Math.abs(b.x1 - 100) < 1e-9, `x should be 0..100, got ${b.x0}..${b.x1}`);
  assert.ok(Math.abs(b.y0) < 1e-9, `top is the endpoints' own y, got ${b.y0}`);

  // The hull is 33% taller. That gap is the whole point: a marquee drawn between y=310 and
  // y=390 must not select this path.
  const hullBottom = Math.max(0, c.c1[1], c.c2[1], c.to[1]);
  assert.equal(hullBottom, 400, 'the control hull really does reach 400');
  assert.ok(b.y1 < hullBottom - 50, 'so the returned box must not');

  // Cross-check against the curve itself rather than against the formula.
  let sampled = -Infinity;
  for (let i = 0; i <= 20000; i++) sampled = Math.max(sampled, bez(V(0, 0), P(c.c1), P(c.c2), P(c.to), i / 20000).y);
  assert.ok(Math.abs(b.y1 - sampled) < 1e-6, `the box bottom ${b.y1} should be the curve's own ${sampled}`);
});

test('pathBounds includes an arc\'s bulge, and only the quadrants it actually sweeps', () => {
  // A half circle from (100,0) to (-100,0) through (0,100). The box must reach y=100 even
  // though no endpoint does, and must NOT reach y=-100, which the circle has and the arc
  // does not.
  const b = pathBounds({ start: [100, 0], prims: [{ k: 'arc', to: [-100, 0], r: 100, sweep: 1 }, { k: 'line', to: [100, 0] }] });
  assert.ok(Math.abs(b.y1 - 100) < 1e-9, `the bulge is at y=100, got ${b.y1}`);
  assert.ok(Math.abs(b.y0) < 1e-9, `the unswept half must not count; got y0 ${b.y0}`);
  assert.ok(Math.abs(b.x0 + 100) < 1e-9 && Math.abs(b.x1 - 100) < 1e-9);
});

// ── 8. inside and outside, holes included ─────────────────────────────────

test('pointInPath is nonzero winding, so an opposite-wound hole reads as outside', () => {
  // Outer square, a bridge in, an inner square wound the other way, and the bridge back —
  // the way a single path expresses a hole. Nonzero winding gives the middle a count of 0.
  const path: VPath = {
    start: [0, 0],
    prims: [
      { k: 'line', to: [100, 0] }, { k: 'line', to: [100, 100] }, { k: 'line', to: [0, 100] }, { k: 'line', to: [0, 0] },
      { k: 'line', to: [30, 30] },                                        // bridge in
      { k: 'line', to: [30, 70] }, { k: 'line', to: [70, 70] }, { k: 'line', to: [70, 30] }, { k: 'line', to: [30, 30] },
      { k: 'line', to: [0, 0] },                                          // bridge back out
    ],
  };
  const sag = 0.05;
  assert.equal(pointInPath(path, V(10, 50), sag), true, 'the ring between the squares is filled');
  assert.equal(pointInPath(path, V(50, 10), sag), true);
  assert.equal(pointInPath(path, V(50, 50), sag), false, 'the counter-wound inner square is a hole');
  assert.equal(pointInPath(path, V(150, 50), sag), false, 'and outside is outside');
  assert.equal(pathWinding(path, V(10, 50), sag), 1, 'the outer loop winds once');
  assert.equal(pathWinding(path, V(50, 50), sag), 0, 'and the hole cancels it exactly');

  // Same shape wound the other way round: still filled, because the rule is NONZERO and not
  // "winding of exactly 1". A cut hole in a template is a reversed loop, so this matters.
  const flipped = reversePath(path);
  assert.equal(pathWinding(flipped, V(10, 50), sag), -1);
  assert.equal(pointInPath(flipped, V(10, 50), sag), true);
  assert.equal(pointInPath(flipped, V(50, 50), sag), false);
});

test('pointInPath agrees with the rasteriser on a curved shape', () => {
  // The claim that makes it useful: the pen's "is this inside" and the fill the artifact
  // renders to are the same question. Checked against `rasterizePolygons`, not against a
  // second winding routine.
  const sag = 0.1;
  const path = roundedRectCubics(20, 20, 180, 180, 40);
  const raster = rasterizePolygons([flattenPath(path, sag)], 200, 200, 4);
  let disagreements = 0;
  for (let y = 0; y < 200; y += 3) {
    for (let x = 0; x < 200; x += 3) {
      const p = V(x + 0.5, y + 0.5);
      const covered = raster[y * 200 + x]! >= 128;
      // Skip the antialiased band: a pixel the rasteriser scores at 40% coverage has no
      // single right answer to a point query, and disagreeing there is not a bug.
      const cov = raster[y * 200 + x]!;
      if (cov > 8 && cov < 247) continue;
      if (pointInPath(path, p, sag) !== covered) disagreements++;
    }
  }
  assert.equal(disagreements, 0, `${disagreements} pixels where the point test and the fill disagree`);
});

test('evalPrim walks every primitive kind end to end', () => {
  const from = V(10, 10);
  const line: Prim = { k: 'line', to: [110, 10] };
  assert.deepEqual(evalPrim(from, line, 0), from);
  assert.deepEqual(evalPrim(from, line, 1), V(110, 10));
  assert.deepEqual(evalPrim(from, line, 0.25), V(35, 10));

  const arc: Prim = { k: 'arc', to: [110, 110], r: 100, sweep: 1 };
  const mid = evalPrim(from, arc, 0.5);
  assert.ok(Math.abs(Math.hypot(mid.x - 10, mid.y - 110) - 100) < 1e-9, 'the midpoint is on the circle');

  const cubic: CubicPrim = { k: 'cubic', c1: [10, 90], c2: [110, 90], to: [110, 10] };
  for (const t of [0, 0.13, 0.5, 0.87, 1]) {
    assert.ok(D(evalPrim(from, cubic, t), bez(from, P(cubic.c1), P(cubic.c2), P(cubic.to), t)) < 1e-12,
      `cubic at t=${t} disagrees with an independent de Casteljau`);
  }
});
