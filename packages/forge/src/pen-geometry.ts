// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// forge/pen-geometry.ts — the arithmetic a pen tool needs, and NOTHING ELSE.
//
// The template is the artifact; this file is what lets a human argue with it by hand. A pen
// tool is four questions asked sixty times a second — where is the curve, which bit of it is
// under the cursor, where does it split, and is this point inside — and every one of them has
// a wrong answer that still looks plausible on screen.
//
// PURE MATH, NO DOM. That is a hard boundary, not a preference. This module is reached from
// the browser through `@foilkit/forge/geometry`, and the reason that subpath exists at all is
// that the editor could not import `@foilkit/forge` — the barrel pulls `node:fs`, `node:zlib`
// and `node:child_process` — and so hand-ported forge functions into
// `apps/editor/src/staging/provisionalDiff.ts` with a byte-parity test holding the copy in
// step. One hand-ported copy is a workaround; two is a fork. So: no `document`, no `window`,
// no `node:` anything, forever, and `tools/check-geometry-browser-safe.mjs` fails the build
// rather than trusting this paragraph.
//
// The three answers that look plausible and are wrong, since each one is a function below:
//
//   * "closest point on the curve" by sampling. Sample a cubic at 32 points and the reported
//     distance is off by up to half a step — small, until the user is dragging and the anchor
//     they grab is not the one under the cursor. `projectToPrim` seeds from a coarse sweep and
//     then refines with Newton on the actual stationarity condition.
//   * "add an anchor here" by re-fitting. Splitting a cubic is EXACT — de Casteljau gives two
//     cubics that trace the original curve exactly — and anything approximate makes clicking a
//     path nudge its shape, which is the one thing a vector editor may never do.
//   * a bounding box from the control hull. Correct as a bound, useless as a box: a handle
//     pulled well outside the curve inflates the hull, and marquee selection starts catching
//     paths whose ink is nowhere near the rubber band. `pathBounds` solves the derivative.

import type { Vec } from './line-snap.ts';
import {
  arcGeometry,
  cubicAt,
  flattenPath,
  type CubicPrim,
  type Prim,
  type VPath,
} from './vector-template.ts';

const v = (x: number, y: number): Vec => ({ x, y });
const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
const pt = (p: [number, number]): Vec => ({ x: p[0], y: p[1] });
const TAU = Math.PI * 2;

// ── Where the curve is ─────────────────────────────────────────────────────

/**
 * The point at parameter t on any primitive, with `from` supplying the start the language
 * leaves implicit.
 *
 * t is the primitive's OWN parameter, not arc length: t = 0.5 on a cubic is the de Casteljau
 * midpoint, which is generally not the halfway point along the curve. Everything in this file
 * speaks the same t, so `projectToPrim`'s t feeds `splitCubic` directly — that pairing is the
 * whole "click a segment, get an anchor exactly there" gesture.
 */
export function evalPrim(from: Vec, pr: Prim, t: number): Vec {
  switch (pr.k) {
    case 'line':
      return v(from.x + (pr.to[0] - from.x) * t, from.y + (pr.to[1] - from.y) * t);
    case 'arc': {
      const g = arcGeometry(from, pr);
      // A degenerate arc is the straight chord — the same fallback `flattenPath` takes, so
      // the pen never reports a point the rasteriser would not have drawn.
      if (!g) return v(from.x + (pr.to[0] - from.x) * t, from.y + (pr.to[1] - from.y) * t);
      const a = g.a0 + g.sweepAng * t;
      return v(g.cx + g.r * Math.cos(a), g.cy + g.r * Math.sin(a));
    }
    case 'cubic':
      return cubicAt(from, pr, t);
    default: {
      const unhandled: never = pr;
      throw new Error(`evalPrim: unknown primitive ${JSON.stringify(unhandled)}`);
    }
  }
}

/** First derivative of a cubic at t. Zero-length only where the curve has a genuine cusp. */
export function cubicTangent(from: Vec, pr: CubicPrim, t: number): Vec {
  const mt = 1 - t;
  const w0 = 3 * mt * mt, w1 = 6 * mt * t, w2 = 3 * t * t;
  return v(
    w0 * (pr.c1[0] - from.x) + w1 * (pr.c2[0] - pr.c1[0]) + w2 * (pr.to[0] - pr.c2[0]),
    w0 * (pr.c1[1] - from.y) + w1 * (pr.c2[1] - pr.c1[1]) + w2 * (pr.to[1] - pr.c2[1]),
  );
}

/** Second derivative of a cubic at t; Newton needs it and nothing else does. */
function cubicCurvatureVec(from: Vec, pr: CubicPrim, t: number): Vec {
  const mt = 1 - t;
  return v(
    6 * mt * (pr.c2[0] - 2 * pr.c1[0] + from.x) + 6 * t * (pr.to[0] - 2 * pr.c2[0] + pr.c1[0]),
    6 * mt * (pr.c2[1] - 2 * pr.c1[1] + from.y) + 6 * t * (pr.to[1] - 2 * pr.c2[1] + pr.c1[1]),
  );
}

// ── Which bit of it is under the cursor ────────────────────────────────────

export interface PrimProjection {
  /** Parameter of the closest point, clamped to [0, 1] — a primitive has no outside. */
  t: number;
  point: Vec;
  dist: number;
}

/**
 * How many parameter samples seed the cubic solve.
 *
 * A cubic's distance function has up to five stationary points, so Newton alone lands in
 * whichever basin it started in — and on an S-curve that basin is routinely the far lobe.
 * Sampling first costs 25 evaluations and makes the seed the right lobe; Newton then buys the
 * sub-sample precision that sampling alone cannot, at four iterations.
 */
const PROJECT_SEEDS = 24;
const NEWTON_STEPS = 8;

/** Closest point on a primitive to `p`. Exact for lines and arcs; refined for cubics. */
export function projectToPrim(from: Vec, pr: Prim, p: Vec): PrimProjection {
  switch (pr.k) {
    case 'line':
      return projectToChord(from, pt(pr.to), p);
    case 'arc': {
      const g = arcGeometry(from, pr);
      if (!g) return projectToChord(from, pt(pr.to), p);
      // The closest point on a full circle is the radial projection of `p`; the only work is
      // deciding whether that lands inside the swept range, and which end to fall back to if
      // it does not. Doing it in parameter space rather than angle space keeps the wrap-around
      // in one place: t runs 0..1 across the sweep and 1..`full` around the unswept remainder.
      const S = g.sweepAng;
      let delta = Math.atan2(p.y - g.cy, p.x - g.cx) - g.a0;
      if (S > 0) { while (delta < 0) delta += TAU; while (delta >= TAU) delta -= TAU; }
      else { while (delta > 0) delta -= TAU; while (delta <= -TAU) delta += TAU; }
      let t = delta / S;
      if (t > 1) {
        // Outside the sweep. The unswept gap belongs to whichever end of it is nearer, and
        // the split is at the gap's midpoint — not at whichever end the loop happened to test.
        const full = TAU / Math.abs(S);
        t = t - 1 < full - t ? 1 : 0;
      }
      const point = evalPrim(from, pr, t);
      return { t, point, dist: dist(point, p) };
    }
    case 'cubic': {
      let bestT = 0;
      let bestD2 = Infinity;
      for (let i = 0; i <= PROJECT_SEEDS; i++) {
        const t = i / PROJECT_SEEDS;
        const q = cubicAt(from, pr, t);
        const d2 = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
        if (d2 < bestD2) { bestD2 = d2; bestT = t; }
      }
      // Newton on f(t) = (B(t) - p) · B'(t), whose roots are exactly the stationary points of
      // the distance. Every candidate is scored before it is accepted, so a step that
      // overshoots (a near-cusp makes f' tiny) leaves the seed's answer standing rather than
      // replacing it with something worse.
      let t = bestT;
      for (let i = 0; i < NEWTON_STEPS; i++) {
        const b = cubicAt(from, pr, t);
        const d1 = cubicTangent(from, pr, t);
        const d2v = cubicCurvatureVec(from, pr, t);
        const dx = b.x - p.x, dy = b.y - p.y;
        const f = dx * d1.x + dy * d1.y;
        const df = d1.x * d1.x + d1.y * d1.y + dx * d2v.x + dy * d2v.y;
        if (!(Math.abs(df) > 1e-12)) break;
        const next = Math.max(0, Math.min(1, t - f / df));
        if (!Number.isFinite(next)) break;
        const q = cubicAt(from, pr, next);
        const nd2 = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
        if (nd2 < bestD2) { bestD2 = nd2; bestT = next; }
        if (Math.abs(next - t) < 1e-12) break;
        t = next;
      }
      const point = cubicAt(from, pr, bestT);
      return { t: bestT, point, dist: Math.sqrt(bestD2) };
    }
    default: {
      const unhandled: never = pr;
      throw new Error(`projectToPrim: unknown primitive ${JSON.stringify(unhandled)}`);
    }
  }
}

function projectToChord(a: Vec, b: Vec, p: Vec): PrimProjection {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 < 1e-24 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const point = v(a.x + t * dx, a.y + t * dy);
  return { t, point, dist: dist(point, p) };
}

// ── Where it splits ────────────────────────────────────────────────────────

/**
 * Split a cubic at t into two cubics that, walked in order, trace the ORIGINAL CURVE EXACTLY.
 *
 * This is what "add an anchor on a segment" is allowed to cost: nothing. de Casteljau is not
 * an approximation — the two halves are the same curve reparametrised, so the only error is
 * the floating-point arithmetic of six averages, which is why the test asserts the shape is
 * preserved to sub-1e-9 rather than to some visual tolerance.
 *
 * The returned prims carry no start point, matching the language: the first begins at `from`
 * and the second begins where the first ends.
 */
export function splitCubic(from: Vec, pr: CubicPrim, t: number): [CubicPrim, CubicPrim] {
  const p0 = from, p1 = pt(pr.c1), p2 = pt(pr.c2), p3 = pt(pr.to);
  const mix = (a: Vec, b: Vec): Vec => v(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  const a1 = mix(p0, p1), a2 = mix(p1, p2), a3 = mix(p2, p3);
  const b1 = mix(a1, a2), b2 = mix(a2, a3);
  const mid = mix(b1, b2);
  return [
    { k: 'cubic', c1: [a1.x, a1.y], c2: [b1.x, b1.y], to: [mid.x, mid.y] },
    { k: 'cubic', c1: [b2.x, b2.y], c2: [a3.x, a3.y], to: [p3.x, p3.y] },
  ];
}

// ── What is under the cursor ───────────────────────────────────────────────

/**
 * The path's anchor points, in the order the editor numbers them: index 0 is `path.start`,
 * and index i+1 is `prims[i].to`. A closed path therefore ends on an anchor that coincides
 * with index 0 — the language makes the closing primitive explicit, and the pen shows both.
 */
export function pathAnchors(path: VPath): Vec[] {
  return [pt(path.start), ...path.prims.map((p) => pt(p.to))];
}

export interface PathAnchorHit {
  kind: 'anchor';
  /** Index into `pathAnchors(path)`. */
  index: number;
  point: Vec;
  dist: number;
}
export interface PathHandleHit {
  kind: 'handle';
  /** Index of the primitive that owns the handle. */
  index: number;
  which: 'c1' | 'c2';
  point: Vec;
  dist: number;
}
export interface PathSegmentHit {
  kind: 'segment';
  /** Index into `path.prims`. */
  index: number;
  /** Parameter of the closest point on that primitive — feeds `splitCubic` unchanged. */
  t: number;
  point: Vec;
  dist: number;
}
export type PathHit = PathAnchorHit | PathHandleHit | PathSegmentHit;

/**
 * What the cursor is over, within `tol`, or null.
 *
 * THE PRIORITY IS THE FEATURE: anchor, then handle, then segment — and it is a strict tier
 * order, not a distance comparison across kinds. An anchor SITS ON the segments that meet it,
 * so by raw distance the segment is always tied with the anchor and often marginally closer
 * once floating point has its say. Rank by distance alone and clicking an anchor sometimes
 * inserts a new anchor a hair away from the one the user meant to drag, which reads as the
 * editor ignoring the click. Handles beat segments for the same reason: a retracted handle
 * lies exactly on its anchor's curve, and a handle you cannot grab is a handle that does not
 * exist. Within a tier, nearest wins.
 */
export function hitTestPath(path: VPath, p: Vec, tol: number): PathHit | null {
  let best: PathHit | null = null;

  const anchors = pathAnchors(path);
  for (let i = 0; i < anchors.length; i++) {
    const d = dist(anchors[i]!, p);
    if (d <= tol && (best === null || d < best.dist)) best = { kind: 'anchor', index: i, point: anchors[i]!, dist: d };
  }
  if (best) return best;

  for (let i = 0; i < path.prims.length; i++) {
    const pr = path.prims[i]!;
    if (pr.k !== 'cubic') continue;                      // only a cubic has handles to grab
    for (const which of ['c1', 'c2'] as const) {
      const h = pt(pr[which]);
      const d = dist(h, p);
      if (d <= tol && (best === null || d < best.dist)) best = { kind: 'handle', index: i, which, point: h, dist: d };
    }
  }
  if (best) return best;

  let cur = pt(path.start);
  for (let i = 0; i < path.prims.length; i++) {
    const pr = path.prims[i]!;
    const proj = projectToPrim(cur, pr, p);
    if (proj.dist <= tol && (best === null || proj.dist < best.dist)) {
      best = { kind: 'segment', index: i, t: proj.t, point: proj.point, dist: proj.dist };
    }
    cur = pt(pr.to);
  }
  return best;
}

// ── Inside or outside ──────────────────────────────────────────────────────

/**
 * Winding number of the flattened path about `p`.
 *
 * Nonzero winding, matching `rasterizePolygons` — which is the point. The template expresses
 * holes as loops wound the other way, so a hit test that used even-odd, or that counted
 * crossings without their sign, would disagree with the rasteriser exactly on the cut-outs:
 * the medallion would test as filled while rendering as a hole.
 */
export function pathWinding(path: VPath, p: Vec, sagitta: number): number {
  const poly = flattenPath(path, sagitta);
  let wn = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    // The half-open rule (`<=` below, `>` above) is what stops a vertex exactly at the test
    // ray's height being counted twice.
    const side = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
    if (a.y <= p.y) { if (b.y > p.y && side > 0) wn++; }
    else if (b.y <= p.y && side < 0) wn--;
  }
  return wn;
}

/** Is `p` inside the path, under the same nonzero rule the rasteriser fills by? */
export function pointInPath(path: VPath, p: Vec, sagitta: number): boolean {
  return pathWinding(path, p, sagitta) !== 0;
}

// ── How big it is ──────────────────────────────────────────────────────────

export interface Bounds { x0: number; y0: number; x1: number; y1: number }

/**
 * The TIGHT bounding box: the box around the ink, not around the control points.
 *
 * The convex hull of a cubic's four points is a legitimate bound and a bad box. Pull one
 * handle twice as far as the curve ever goes — which is ordinary, it is how you make a curve
 * flatter — and the hull grows while the curve does not. Marquee selection built on that box
 * starts grabbing paths the rubber band never touched, and the user's model of what "select"
 * means quietly stops matching the editor's.
 *
 * So: endpoints always, plus the interior extrema. For a cubic those are the roots of each
 * component of B'(t) in (0, 1) — one quadratic per axis. For an arc they are the quadrant
 * angles that fall inside the swept range, which is the same argument one dimension down and
 * would otherwise leave a quarter-circle's bulge outside the box.
 */
export function pathBounds(path: VPath): Bounds {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (q: Vec): void => {
    if (q.x < x0) x0 = q.x;
    if (q.y < y0) y0 = q.y;
    if (q.x > x1) x1 = q.x;
    if (q.y > y1) y1 = q.y;
  };

  let cur = pt(path.start);
  add(cur);
  for (const pr of path.prims) {
    const to = pt(pr.to);
    switch (pr.k) {
      case 'line':
        break;
      case 'arc': {
        const g = arcGeometry(cur, pr);
        if (g) {
          for (let q = 0; q < 4; q++) {
            const ang = (q * Math.PI) / 2;
            let delta = ang - g.a0;
            if (g.sweepAng > 0) { while (delta < 0) delta += TAU; while (delta >= TAU) delta -= TAU; }
            else { while (delta > 0) delta -= TAU; while (delta <= -TAU) delta += TAU; }
            const t = delta / g.sweepAng;
            if (t > 0 && t < 1) add(v(g.cx + g.r * Math.cos(ang), g.cy + g.r * Math.sin(ang)));
          }
        }
        break;
      }
      case 'cubic': {
        for (const t of cubicExtrema(cur, pr)) add(cubicAt(cur, pr, t));
        break;
      }
      default: {
        const unhandled: never = pr;
        throw new Error(`pathBounds: unknown primitive ${JSON.stringify(unhandled)}`);
      }
    }
    add(to);
    cur = to;
  }
  return { x0, y0, x1, y1 };
}

/** Parameters strictly inside (0, 1) where a cubic's x or y derivative vanishes. */
function cubicExtrema(from: Vec, pr: CubicPrim): number[] {
  const out: number[] = [];
  const axis = (p0: number, p1: number, p2: number, p3: number): void => {
    // B'(t)/3 = a t^2 + b t + c
    const a = -p0 + 3 * p1 - 3 * p2 + p3;
    const b = 2 * (p0 - 2 * p1 + p2);
    const c = -p0 + p1;
    const keep = (t: number): void => { if (t > 0 && t < 1) out.push(t); };
    if (Math.abs(a) < 1e-12) {
      // Degenerate to a linear derivative — a genuinely common case, since a symmetric
      // handle layout kills the quadratic term exactly.
      if (Math.abs(b) > 1e-12) keep(-c / b);
      return;
    }
    const disc = b * b - 4 * a * c;
    if (disc < 0) return;
    const s = Math.sqrt(disc);
    keep((-b + s) / (2 * a));
    keep((-b - s) / (2 * a));
  };
  axis(from.x, pr.c1[0], pr.c2[0], pr.to[0]);
  axis(from.y, pr.c1[1], pr.c2[1], pr.to[1]);
  return out;
}
