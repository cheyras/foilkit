// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// forge/pen-engine.ts — the pen tool's BEHAVIOUR, as a value you can diff.
//
// "Feels like Illustrator" is a claim about behaviour, and behaviour that can only be tested
// through a browser barely gets tested at all. So the pen is a reducer over plain data:
// `reduce(state, input, cfg)`, no React, no `window`, no canvas, no `node:` anything. The DOM
// layer's whole job is to turn real pointer events into `PenInput`, render `state`, and render
// `cursorFor(state)`. Every judgement — what a click means, which handle moves, what the badge
// says — lives here, where a `node --test` file can drive ninety gestures in a millisecond.
//
// THE SPEC IS THE REQUIREMENT. `ILLUSTRATOR-PEN-SPEC.md` is Adobe-verified where it can be and
// honestly marked `[U]` where it cannot; the tests are named after its conformance items so a
// future correction is a one-line change rather than an archaeology project. What follows is
// the set of traps that survive a careless clone, each of which is a named function below.
//
//   * HANDLES ARE ABSOLUTE POINTS, NEVER VECTORS. A retracted handle equals its anchor; there
//     is no null handle. Store offsets instead and every rigid move needs two code paths, one
//     of which will be forgotten — usually the one that moves an anchor and leaves its handles
//     behind, which reads as the curve tearing.
//
//   * `pointType` IS A STORED FLAG. A CORNER may have two perfectly collinear handles, and
//     Illustrator will still break them independently, because it remembers what you said
//     rather than measuring what you drew. Infer the type from geometry and a point silently
//     heals itself into a smooth point the next time you nudge it.
//
//   * SMOOTH POINTS HAVE TWO DIFFERENT RULES AT TWO DIFFERENT TIMES. Created MIRRORED at
//     placement (equal length, opposite direction); edited COLLINEAR-KEEPING-LENGTH afterwards
//     (`dragHandle`). Cloning only the mirrored rule is the single most common way a bezier
//     editor feels wrong: every later handle tug resets the far side's length, and the user's
//     careful asymmetric curve keeps snapping back.
//
//   * THE CURSOR HOLDS THE OUTGOING HANDLE. Dragging toward where you are GOING bulges the
//     segment BEHIND you away from the drag, because `leftDirection = 2Q - C` recomputes every
//     frame and the already-committed previous segment re-renders live. That inverted feel is
//     what people learn the pen tool AS; smoothing it out is not an improvement.
//
//   * CLICK PRECEDENCE IS AN ORDERED LIST, NOT A PILE OF `if`s. `resolvePenClick` is one
//     function returning one `PenAction`, and `cursorFor` reads THE SAME RESOLUTION, so the
//     badge can never promise something the click will not do. Scatter the rungs and users
//     delete the point they meant to close on — retract > close > join > continue > delete >
//     add > new, first match wins, distance never overrides rung.
//
//   * HIT RADII ARE SCREEN PIXELS. They are divided by `input.zoom` at the point of use and
//     never stored in document units, or grabbing an anchor gets impossible zoomed out and
//     absurdly sticky zoomed in.
//
//   * A SNAP MAY NUDGE, NEVER RELOCATE. `line-snap` already carries this guardrail with tests
//     (an ambiguous band moves a line at most ~2px and must state its refusal reason); the pen
//     must not be the hole in it. Snapping here is an INJECTED callback — the engine does no
//     edge detection — and the engine enforces `maxSnapMovePx` on whatever the callback
//     proposes rather than trusting it. A rogue snap function is a bug in one module; a rogue
//     snap function the engine obeys is a bug in the artifact.
//
// `PenState` is a plain serialisable value: no class instances, no closures, no functions. That
// is what lets undo snapshot it by clone, lets a test deep-compare two states, and lets the
// whole thing be logged when a user reports a gesture that went wrong.

import type { Vec } from './line-snap.ts';
import {
  arcGeometry,
  cubicAt,
  MASK_VECTOR_VERSION,
  type AnchorType,
  type ArcPrim,
  type CubicPrim,
  type MaskVector,
  type Prim,
  type VPath,
} from './vector-template.ts';
import { projectToPrim, splitCubic } from './pen-geometry.ts';

// ── The document model — Illustrator's DOM, mirrored ───────────────────────

export type PointType = 'smooth' | 'corner';

/**
 * One anchor and its two direction points.
 *
 * `leftDirection` is the handle the INCOMING segment arrives through; `rightDirection` is the
 * one the OUTGOING segment leaves through. Both are ABSOLUTE document coordinates. Segment
 * `i -> i+1` is the cubic `(pt[i].anchor, pt[i].rightDirection, pt[i+1].leftDirection,
 * pt[i+1].anchor)` — read that line twice, because every off-by-one in a bezier editor is a
 * `c1`/`c2` swapped with a `left`/`right`.
 */
export interface PathPoint {
  anchor: [number, number];
  leftDirection: [number, number];
  rightDirection: [number, number];
  pointType: PointType;
}

/** A subpath. A closed path has NO duplicate final point; the closing segment is `n-1 -> 0`. */
export interface PenPath {
  closed: boolean;
  points: PathPoint[];
}

export interface PenDoc {
  paths: PenPath[];
}

export type HandleSide = 'left' | 'right';
/** Which end of an open path the pen is extending from. */
export type PathEnd = 'first' | 'last';
export type ToolId = 'pen' | 'direct-select' | 'select' | 'anchor-point';

// ── Config: the tunables are DATA, not literals scattered through the logic ─

export interface SnapContext {
  doc: PenDoc;
  zoom: number;
  /** What the engine is doing, so a snap provider can offer different candidates per gesture. */
  phase: 'place' | 'close' | 'move-anchor' | 'move-handle';
  activePathIndex: number | null;
  /** The point being moved, when there is one. */
  ref: AnchorRef | null;
}

/** A hard displacement: `point` IS where the anchor goes, and `kind` is what caught it. */
export interface SnapProposal {
  point: { x: number; y: number };
  kind: string;
  reason?: string;
}

/**
 * "I looked, and I will not answer." A provider that can only return `null` cannot distinguish
 * a scan with no edges in it from a scan with two equally good ones — and the second is the case
 * this repository's guardrail is written about, so it has to be able to say so. The point does
 * not move and `state.snapRefusal` carries the sentence.
 */
export interface SnapRefusal {
  point?: undefined;
  refused: string;
}

export type SnapFn = (p: { x: number; y: number }, ctx: SnapContext) => SnapProposal | SnapRefusal | null;

export interface PenConfig {
  /** Screen px the cursor must travel before a click becomes a drag. Spec A.2, [U]. */
  dragThresholdPx: number;
  /** Hit radii, SCREEN PIXELS. Divided by `input.zoom` at the point of use, never stored. */
  anchorHitRadiusPx: number;
  handleHitRadiusPx: number;
  segmentHitRadiusPx: number;
  /** Arrow-key nudge, document units. Illustrator's default Keyboard Increment is 1. */
  keyboardIncrement: number;
  /** Shift+arrow. Hardcoded 10x in Illustrator — a multiplier, not a second preference. */
  shiftMultiplier: number;
  /** Degrees. Shift constrains to 45-degree multiples RELATIVE TO THIS, not to true horizontal. */
  constrainAngle: number;
  /** Spec A.9. The Illustrator preference is a *disable* checkbox, so the default is on. */
  autoAddDelete: boolean;
  /** Spec A.4. `Enable Rubber Band for: Pen Tool` is ON by default. */
  rubberBand: boolean;
  /**
   * THE GUARDRAIL. Maximum screen-pixel displacement the engine will accept from `snap`. A
   * proposal further than this is DROPPED and the anchor lands where the hand put it, with the
   * refusal recorded in `state.snapRefusal`. The engine enforces this itself rather than
   * trusting the callback, because a snap provider is exactly the kind of module that grows a
   * confident heuristic later.
   */
  maxSnapMovePx: number;
  /**
   * Angular construction snapping. EMPTY = OFF, which is Illustrator's factory default (I.104).
   *
   * Degrees, measured from the PREVIOUS anchor: `[0, 45, 90, 135]` gives the four rays Shift
   * already constrains to, except that the pointer captures them instead of being clamped to
   * them. Not routed through `snap`, and the distinction is not cosmetic — a construction angle
   * is not evidence read off a scan, it is a rule the user turned on about geometry they placed
   * themselves, so it is applied where Shift is applied and it is bounded by its own tolerance
   * rather than by the guardrail that exists to keep a heuristic from relocating an anchor.
   */
  constructionAngles: number[];
  /**
   * How near a construction ray the cursor must come before it captures, SCREEN px. Illustrator's
   * Smart Guides have a snapping tolerance for the same reason: a construction guide that
   * captures from anywhere is not a guide, it is Shift welded down.
   */
  constructionSnapPx: number;
  /** Preference F.4. ON: every selected anchor shows handles. OFF: only a lone one does. */
  showHandlesWhenMultipleSelected: boolean;
  /** Preference C.2 `Constrain Path Dragging on Segment Reshape`: hold endpoint handle ANGLES. */
  constrainSegmentReshape: boolean;
  /**
   * Illustrator quirk I.19: an arrow-key nudge breaks the Pen's connection to the active path,
   * which LucasFonts calls a probable bug. The spec says decide deliberately rather than
   * inherit it by accident — so it is a flag, and OUR DEFAULT IS `false` (we keep drawing).
   */
  arrowKeyBreaksActivePath: boolean;
  /** A handle within this of its anchor IS retracted. Document units. */
  retractEpsilon: number;
  /** Cross-product tolerance for calling two handles collinear, on unit vectors. */
  collinearEpsilon: number;
  /** How many snapshots the undo stack keeps. */
  undoDepth: number;
  /** Injected. The engine does NO edge detection of its own. */
  snap: SnapFn | null;
}

export const DEFAULT_PEN_CONFIG: PenConfig = {
  dragThresholdPx: 2,
  anchorHitRadiusPx: 6,
  handleHitRadiusPx: 5,
  segmentHitRadiusPx: 4,
  keyboardIncrement: 1,
  shiftMultiplier: 10,
  constrainAngle: 0,
  autoAddDelete: true,
  rubberBand: true,
  maxSnapMovePx: 2,
  constructionAngles: [],
  constructionSnapPx: 6,
  showHandlesWhenMultipleSelected: true,
  constrainSegmentReshape: false,
  arrowKeyBreaksActivePath: false,
  retractEpsilon: 1e-9,
  collinearEpsilon: 1e-6,
  undoDepth: 100,
  snap: null,
};

// ── Small vector helpers, local so nothing here depends on a Vec class ─────

const v = (x: number, y: number): Vec => ({ x, y });
const P = (p: [number, number]): Vec => ({ x: p[0], y: p[1] });
const A = (p: Vec): [number, number] => [p.x, p.y];
const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
const add = (a: Vec, b: Vec): Vec => v(a.x + b.x, a.y + b.y);
const sub = (a: Vec, b: Vec): Vec => v(a.x - b.x, a.y - b.y);
const scale = (a: Vec, k: number): Vec => v(a.x * k, a.y * k);
const len = (a: Vec): number => Math.hypot(a.x, a.y);
const DEG = Math.PI / 180;

/** Point-reflection of `c` through `q` — `2q - c`, the mirrored-handle rule, once. */
const reflect = (q: Vec, c: Vec): Vec => v(2 * q.x - c.x, 2 * q.y - c.y);

export const isRetracted = (handle: [number, number], anchor: [number, number], eps: number): boolean =>
  Math.hypot(handle[0] - anchor[0], handle[1] - anchor[1]) <= eps;

/** The side an outgoing segment leaves through, given which end of the path is active. */
export const outgoingSide = (end: PathEnd): HandleSide => (end === 'last' ? 'right' : 'left');
/** The side an incoming segment arrives through. The other one. */
export const incomingSide = (end: PathEnd): HandleSide => (end === 'last' ? 'left' : 'right');

const clonePoint = (p: PathPoint): PathPoint => ({
  anchor: [p.anchor[0], p.anchor[1]],
  leftDirection: [p.leftDirection[0], p.leftDirection[1]],
  rightDirection: [p.rightDirection[0], p.rightDirection[1]],
  pointType: p.pointType,
});
const clonePath = (p: PenPath): PenPath => ({ closed: p.closed, points: p.points.map(clonePoint) });
export const cloneDoc = (d: PenDoc): PenDoc => ({ paths: d.paths.map(clonePath) });

/** A corner anchor with both handles retracted onto it — the shape a plain click produces. */
export function cornerPoint(at: Vec): PathPoint {
  return { anchor: A(at), leftDirection: A(at), rightDirection: A(at), pointType: 'corner' };
}

/**
 * Reverse a subpath in place-safe fashion: the point order flips AND every point's handles
 * SWAP SIDES, because `leftDirection` means "the handle the incoming segment arrives through"
 * and walking the other way makes the old arrival handle the new departure handle. Reverse the
 * array alone and every curve reflects across its own chord — it still closes, still
 * rasterises, and is the wrong shape.
 */
export function reversePenPath(path: PenPath): PenPath {
  return {
    closed: path.closed,
    points: path.points
      .slice()
      .reverse()
      .map((p) => ({
        anchor: [p.anchor[0], p.anchor[1]] as [number, number],
        leftDirection: [p.rightDirection[0], p.rightDirection[1]] as [number, number],
        rightDirection: [p.leftDirection[0], p.leftDirection[1]] as [number, number],
        pointType: p.pointType,
      })),
  };
}

// ── The stored language, both directions ───────────────────────────────────

/** How many segments a path has: `n-1` open, `n` closed (the closing one is explicit). */
export const segmentCount = (path: PenPath): number =>
  path.points.length < 2 ? 0 : path.closed ? path.points.length : path.points.length - 1;

/** Segment `i` as a cubic, with the start point the language leaves implicit. */
export function segmentCubic(path: PenPath, i: number): { from: Vec; prim: CubicPrim } {
  const a = path.points[i];
  const b = path.points[(i + 1) % path.points.length];
  return {
    from: P(a.anchor),
    prim: { k: 'cubic', c1: [...a.rightDirection], c2: [...b.leftDirection], to: [...b.anchor] },
  };
}

/**
 * Editing model -> stored language.
 *
 * A segment whose two facing handles are BOTH retracted becomes a `line`, not a cubic that
 * merely looks straight. That is the whole reason the stored language kept `LinePrim` when the
 * pen arrived: a card's straight edge is two numbers in a committed diff, and a reviewer can
 * read it. Emit a degenerate cubic and every straight edge in the artifact turns into six
 * numbers that a human has to do arithmetic on to confirm are collinear.
 *
 * An OPEN pen path emits no closing primitive, so the resulting `VPath` is a chain rather than
 * a loop; `VPath` has no `closed` flag and never needed one, because everything the fitter
 * produced was closed. `fromVPath` reads the closure back off the geometry — see there.
 *
 * `pointType` IS EMITTED, as `t` on the primitive that lands on the anchor and as `startType`
 * for the first one. That is the second thing the stored form used not to carry, and until it
 * did, this function was lossy in a way no round trip of the GEOMETRY could reveal: a corner
 * whose two handles happen to be collinear — an ordinary shape, and exactly what an Alt-drag
 * leaves behind on a symmetric curve — came back out of `fromVPath` as a SMOOTH point, and the
 * next tug on either handle rotated its partner. Same anchors, same handles, same pixels;
 * different editing behaviour from then on, with nothing in the artifact to explain it.
 */
export function toVPath(path: PenPath, eps: number = DEFAULT_PEN_CONFIG.retractEpsilon): VPath {
  if (path.points.length === 0) return { start: [0, 0], prims: [] };
  const prims: Prim[] = [];
  const n = path.points.length;
  const segs = segmentCount(path);
  const flag = (pt: PathPoint): AnchorType => (pt.pointType === 'smooth' ? 's' : 'c');
  for (let i = 0; i < segs; i++) {
    const a = path.points[i];
    const b = path.points[(i + 1) % n];
    // The flag belongs to the anchor the primitive LANDS ON, which is `b`. On a closed path the
    // final primitive lands back on point 0, so its `t` and the path's `startType` describe the
    // same anchor and are written from the same value — they cannot drift apart.
    const t = flag(b);
    if (isRetracted(a.rightDirection, a.anchor, eps) && isRetracted(b.leftDirection, b.anchor, eps)) {
      prims.push({ k: 'line', to: [b.anchor[0], b.anchor[1]], t });
    } else {
      prims.push({
        k: 'cubic',
        c1: [a.rightDirection[0], a.rightDirection[1]],
        c2: [b.leftDirection[0], b.leftDirection[1]],
        to: [b.anchor[0], b.anchor[1]],
        t,
      });
    }
  }
  return {
    start: [path.points[0].anchor[0], path.points[0].anchor[1]],
    prims,
    startType: flag(path.points[0]),
  };
}

/**
 * Exact cubic segments for a circular arc, split so no piece sweeps more than 90 degrees.
 *
 * The stored language predates the pen: the FITTER emits lines and arcs, so an existing mask
 * loaded for editing will be full of `ArcPrim`s, and the pen's model has no arcs in it. The
 * standard `k = (4/3)tan(theta/4)` construction is exact at both endpoints and at the
 * midpoint, with a peak radial error under 3e-4 r at a 90-degree sweep — which is why the cap
 * is 90 and why the test measures the error rather than trusting this paragraph.
 */
export function arcToCubics(from: Vec, pr: ArcPrim): CubicPrim[] {
  const g = arcGeometry(from, pr);
  // A degenerate arc is the straight chord — the same fallback `flattenPath` and `evalPrim`
  // take. Disagreeing here would put an editable point where the rasteriser never drew one.
  if (!g) return [{ k: 'cubic', c1: A(from), c2: [pr.to[0], pr.to[1]], to: [pr.to[0], pr.to[1]] }];
  const pieces = Math.max(1, Math.ceil(Math.abs(g.sweepAng) / (Math.PI / 2) - 1e-9));
  const step = g.sweepAng / pieces;
  const k = (4 / 3) * Math.tan(step / 4);
  const out: CubicPrim[] = [];
  for (let i = 0; i < pieces; i++) {
    const a0 = g.a0 + step * i;
    const a1 = a0 + step;
    const p0 = v(g.cx + g.r * Math.cos(a0), g.cy + g.r * Math.sin(a0));
    const p1 = v(g.cx + g.r * Math.cos(a1), g.cy + g.r * Math.sin(a1));
    const t0 = v(-Math.sin(a0), Math.cos(a0));
    const t1 = v(-Math.sin(a1), Math.cos(a1));
    out.push({
      k: 'cubic',
      c1: A(add(p0, scale(t0, k * g.r))),
      c2: A(sub(p1, scale(t1, k * g.r))),
      // The last piece must land on the primitive's declared endpoint exactly, or a chain of
      // arcs accumulates a few ulps of drift and the path stops closing.
      to: i === pieces - 1 ? [pr.to[0], pr.to[1]] : A(p1),
    });
  }
  return out;
}

/**
 * Stored language -> editing model, so an existing mask loads back for editing.
 *
 * TWO THINGS ARE RECONSTRUCTED HERE THAT THE STORED FORM MAY NOT CARRY, and both are legal
 * exactly once, at import:
 *
 *   * `closed` — a `VPath` from the fitter always returns to `start`, so closure is read off
 *     the geometry: last primitive landing on `start` means closed, and its duplicate final
 *     anchor is dropped rather than kept as a coincident point.
 *   * `pointType` — inferred ONLY where the path does not state it. A point with two
 *     non-retracted collinear handles infers as SMOOTH, everything else as CORNER.
 *
 * THE STORED FLAG WINS, EVERY TIME, and that ordering is the whole reason `t`/`startType`
 * exist. Inference is a MEASUREMENT of the handles, and Illustrator's model — see this file's
 * header — is explicit that the type is a thing the user SAID, not a thing the geometry shows:
 * a corner is allowed to carry two collinear handles and must keep breaking them
 * independently. So a path that names its types is believed, and inference is left to do the
 * only job it can still do honestly, which is answer for a path that never said.
 *
 * That path is not hypothetical and never will be: `data/vector-templates.json` is fitted
 * geometry, the fitter emits lines and arcs and no types at all, and every one of those files
 * must keep loading exactly as it did. An absent `t` is therefore NOT a defect to be repaired
 * — it is a path whose author had no opinion, and inference is the honest answer for it.
 *
 * Anchors the fitter's ARCS expand into are a third case and get inference for the same reason:
 * `arcToCubics` invents them, so the human never typed them, and they lie on a circle where
 * smooth is both inferable and correct. Only the arc's own endpoint carries the arc's `t`.
 */
export function fromVPath(p: VPath, eps: number = DEFAULT_PEN_CONFIG.retractEpsilon, collinearEps = 1e-6): PenPath {
  // Flatten the primitive list into cubics-or-lines first, so arcs become editable anchors and
  // everything downstream sees one shape of segment. `t` rides along per SEGMENT rather than
  // per primitive, because an arc becomes several segments and only its last one lands on the
  // anchor the arc's own flag describes.
  interface Seg { c1: Vec; c2: Vec; to: Vec; t?: AnchorType }
  const segs: Seg[] = [];
  let cur = P(p.start);
  for (const pr of p.prims) {
    switch (pr.k) {
      case 'line': {
        const to = P(pr.to);
        segs.push({ c1: cur, c2: to, to, t: pr.t });
        cur = to;
        break;
      }
      case 'arc': {
        const cubics = arcToCubics(cur, pr);
        for (let i = 0; i < cubics.length; i++) {
          const c = cubics[i];
          segs.push({ c1: P(c.c1), c2: P(c.c2), to: P(c.to), t: i === cubics.length - 1 ? pr.t : undefined });
          cur = P(c.to);
        }
        break;
      }
      case 'cubic': {
        segs.push({ c1: P(pr.c1), c2: P(pr.c2), to: P(pr.to), t: pr.t });
        cur = P(pr.to);
        break;
      }
      default: {
        const unhandled: never = pr;
        throw new Error(`fromVPath: unknown primitive ${JSON.stringify(unhandled)}`);
      }
    }
  }

  const start = P(p.start);
  const closed = segs.length > 0 && dist(segs[segs.length - 1].to, start) <= Math.max(eps, 1e-9);

  const anchors: Vec[] = [start, ...segs.map((s) => s.to)];
  if (closed) anchors.pop();
  const n = anchors.length;
  const points: PathPoint[] = anchors.map((a) => ({
    anchor: A(a),
    leftDirection: A(a),
    rightDirection: A(a),
    pointType: 'corner' as PointType,
  }));
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    points[i % n].rightDirection = A(s.c1);
    points[(i + 1) % n].leftDirection = A(s.c2);
  }

  for (const pt of points) {
    const l = sub(P(pt.leftDirection), P(pt.anchor));
    const r = sub(P(pt.rightDirection), P(pt.anchor));
    if (len(l) <= eps || len(r) <= eps) continue;
    const ul = scale(l, 1 / len(l));
    const ur = scale(r, 1 / len(r));
    // Collinear AND opposed. Two handles on the SAME side of the anchor is a cusp folded back
    // on itself, not a smooth point, and `cross ~ 0` alone would call it smooth.
    if (Math.abs(ul.x * ur.y - ul.y * ur.x) <= collinearEps && ul.x * ur.x + ul.y * ur.y < 0) {
      pt.pointType = 'smooth';
    }
  }

  // ── …and now the STORED flags overwrite the guesses, wherever there are any ──
  //
  // Applied after the inference loop rather than instead of it, so a path that states SOME of
  // its types — which is exactly what a fitted template looks like after a human has edited a
  // few of its anchors with the pen — gets the stated ones stated and the rest inferred.
  //
  // Segment order first, `startType` second, and that order is deliberate: on a CLOSED path the
  // last segment lands back on anchor 0, so both would answer for it, and `startType` is the
  // field that names the anchor directly rather than by walking to it.
  const setType = (i: number, t: AnchorType | undefined): void => {
    if (t) points[i].pointType = t === 's' ? 'smooth' : 'corner';
  };
  for (let i = 0; i < segs.length; i++) setType((i + 1) % n, segs[i].t);
  setType(0, p.startType);

  return { closed, points };
}

/**
 * The whole document as the artifact a mask commits beside its pixels.
 *
 * The two-line function is the point: `MaskVector` is `VPath[]` plus the raster they are drawn
 * in, so "what the pen holds" and "what the repository stores" differ by a wrapper and not by a
 * translation. There is no second geometry format and no lossy step — which is what makes the
 * committed `.paths.json` reloadable into the exact editing state it was saved from.
 *
 * `null` when there is nothing to store. A path of fewer than two points has no primitives, and
 * a document of only those is a click on an empty canvas, not geometry: writing an empty
 * `paths` array would commit a file that says a human drew something when they did not.
 */
export function toMaskVector(
  doc: PenDoc,
  space: { width: number; height: number },
  eps: number = DEFAULT_PEN_CONFIG.retractEpsilon,
): MaskVector | null {
  const paths = doc.paths.filter((p) => p.points.length >= 2).map((p) => toVPath(p, eps));
  if (paths.length === 0) return null;
  return { version: MASK_VECTOR_VERSION, space: { ...space }, paths };
}

/** The other direction: a committed mask vector, back to something the pen can edit. */
export function fromMaskVector(
  v: MaskVector,
  eps: number = DEFAULT_PEN_CONFIG.retractEpsilon,
  collinearEps = 1e-6,
): PenDoc {
  return { paths: v.paths.map((p) => fromVPath(p, eps, collinearEps)) };
}

// ── Selection ──────────────────────────────────────────────────────────────

export interface AnchorRef { path: number; point: number }
export interface HandleRef { path: number; point: number; side: HandleSide }
export interface SegmentRef { path: number; segment: number }

export interface PenSelection {
  anchors: AnchorRef[];
  handles: HandleRef[];
  segments: SegmentRef[];
  /** Whole-object selection, what the Selection tool (V) produces. */
  paths: number[];
}

export const EMPTY_SELECTION: PenSelection = { anchors: [], handles: [], segments: [], paths: [] };

/**
 * Is this path selected, for the purpose auto add/delete cares about (spec A.9)?
 *
 * The ACTIVE path counts. Illustrator's auto add/delete scoping is the reason the pen does not
 * feel possessed — hover an unselected path and a click just starts a new anchor — and the
 * active path is by definition selected, so hovering the path you are drawing does show the
 * plus and minus badges.
 */
export function isPathSelected(state: PenState, i: number): boolean {
  if (state.activePathIndex === i) return true;
  if (state.selection.paths.includes(i)) return true;
  return state.selection.anchors.some((a) => a.path === i) || state.selection.segments.some((s) => s.path === i);
}

// ── State ──────────────────────────────────────────────────────────────────

export type DragKind =
  | 'place'              // an anchor is being placed (or an endpoint resumed) with the pen
  | 'close'              // the close-target anchor is being dragged as the path closes
  | 'move-anchor'
  | 'move-handle'
  | 'reshape-segment'
  | 'convert-anchor'     // the Anchor Point tool pulling mirrored handles out of a corner
  | 'move-path'
  | 'marquee';

export interface PenDrag {
  kind: DragKind;
  /**
   * The GEOMETRIC origin: the anchor Q the placement math reflects through, or the point a
   * rigid move measures its delta from.
   */
  origin: [number, number];
  /**
   * Where the button actually went down, before Shift projected it or a snap nudged it.
   *
   * These two are the same for most gestures and DIFFERENT for exactly the one that matters:
   * Shift+click places the anchor on a 45-degree ray somewhere other than the cursor, and
   * measuring the dead zone from there would report a stationary pointer as having travelled
   * the length of the projection — turning every constrained click into a handle drag.
   */
  rawOrigin: [number, number];
  current: [number, number];
  /** Has the pointer left the dead zone? Below it a drag is still a click. */
  past: boolean;
  path: number;
  point: number;
  side: HandleSide | null;
  segment: number | null;
  /** Parameter where a segment-reshape drag grabbed the curve. */
  t: number | null;
  /** True once Alt broke the symmetry during a placement. Once broken, stays broken (I.22). */
  broken: boolean;
  /** `leftDirection` frozen at the instant Alt was pressed (spec A.5). */
  frozen: [number, number] | null;
  /**
   * Where the spacebar translate last sampled the cursor, or null when space is not held.
   * Spec B.3 is written incrementally and it is worth implementing literally: because the
   * anchor and its handles translate by exactly the cursor's delta, `rightDirection == cursor`
   * survives the whole detour, which is what makes releasing space resume with no jump (I.63).
   */
  spaceFrom: [number, number] | null;
  /** Geometry as it stood when the gesture began — rigid moves recompute from it, never accumulate. */
  docAtStart: PenDoc;
  /** False when the drag resumed an EXISTING endpoint rather than creating an anchor (A.8). */
  fresh: boolean;
  /**
   * THE GESTURE'S OWN OPENING SNAPSHOT — the only state Escape or a blur is allowed to restore,
   * and `null` for a gesture that snapshotted nothing.
   *
   * `rollback` used to pop whatever was on top of `state.undo`, which is correct exactly as long
   * as every drag pushes a snapshot on pointerdown. `marquee` does not — a rubber-band selection
   * changes no geometry, so committing one would put an empty step in the undo stack — and the
   * result was that Escape (or alt-tabbing) mid-marquee restored the PREVIOUS gesture's snapshot
   * and silently destroyed the anchor the user had just placed. A cancel that deletes work is the
   * worst failure mode a cancel key has.
   *
   * Carrying the snapshot on the drag makes that structurally impossible rather than merely
   * fixed: a drag that has none cannot roll back to somebody else's, and `newDrag` takes this
   * POSITIONALLY AND REQUIRED so a future gesture cannot forget to say which it is.
   */
  snapshot: PenSnapshot | null;
}

export type PenTarget =
  | { kind: 'anchor'; path: number; point: number }
  | { kind: 'handle'; path: number; point: number; side: HandleSide }
  | { kind: 'segment'; path: number; segment: number; t: number; point: [number, number] };

/**
 * What a click right now would do. The rungs of spec A.8, as one closed set.
 *
 * `resolvePenClick` returns exactly one of these, and both the pointerdown handler and
 * `cursorFor` read it — the badge and the behaviour cannot drift apart because they are the
 * same computation.
 */
export type PenAction =
  | { kind: 'retract-outgoing'; path: number; point: number }
  | { kind: 'close'; path: number; point: number }
  | { kind: 'join'; path: number; point: number; end: PathEnd }
  | { kind: 'continue'; path: number; end: PathEnd }
  | { kind: 'delete-anchor'; path: number; point: number }
  | { kind: 'add-anchor'; path: number; segment: number; t: number }
  | { kind: 'new-anchor' };

export interface PenHover {
  /** From `resolvePenClick`. Drives the badge. */
  action: PenAction;
  /** The raw topology under the cursor, tool-independent. */
  target: PenTarget | null;
}

/** The live preview from the active endpoint to the cursor. Spec A.4. */
export interface RubberBand {
  from: [number, number];
  c1: [number, number];
  c2: [number, number];
  to: [number, number];
}

export interface Marquee { x0: number; y0: number; x1: number; y1: number }

/** The engine does not pan or scroll. It says when the UI should. Spec B.3. */
export type PenIntent = { kind: 'pan' };

export interface PenSnapshot {
  doc: PenDoc;
  activePathIndex: number | null;
  activeEndpoint: PathEnd | null;
  selection: PenSelection;
}

export interface PenState {
  doc: PenDoc;
  activeTool: ToolId;
  /**
   * Spec B.1: Ctrl gives the LAST-USED selection tool, not unconditionally Direct Selection.
   * A user who last pressed V gets the black arrow and is briefly confused (gotcha 14);
   * faithful clones reproduce the confusion.
   */
  lastSelectionTool: 'select' | 'direct-select';
  /** What to restore when a momentary modifier (Ctrl, Alt) is released. */
  toolBeforeModifier: ToolId | null;
  activePathIndex: number | null;
  activeEndpoint: PathEnd | null;
  selection: PenSelection;
  drag: PenDrag | null;
  hover: PenHover | null;
  rubberBand: RubberBand | null;
  marquee: Marquee | null;
  pointer: [number, number] | null;
  /** Caps Lock replaces every cursor with a bare crosshair (I.93) — the #1 cause of "my pen turned into an X". */
  capsLock: boolean;
  /** The last accepted snap. Spec F.2: the arrowhead flips hollow on a capture; this is that signal. */
  snapped: { point: [number, number]; kind: string } | null;
  /** Why the last snap proposal was refused. Never null-and-silent: a refusal states its reason. */
  snapRefusal: string | null;
  /**
   * Ctrl+U, Illustrator's Smart Guides (I.102) — the MASTER switch over every snap this engine
   * performs: the injected provider and the construction angles alike.
   *
   * State and not config, for the same reason `outline` and `hideEdges` are: it is a thing the
   * user flips mid-gesture from the keyboard, so it belongs where the key table can reach it and
   * where `node --test` can drive the flip. It ships ON, which is only visible when a provider
   * has actually been wired in — with `cfg.snap` null (the default) an engine with snapping on
   * and one with it off are the same engine.
   */
  snapEnabled: boolean;
  /** Stand-in for Illustrator's locked/hidden layer. A DIFFERENT cursor from continue (I.94). */
  locked: boolean;
  /**
   * `Ctrl+Y`, Outline mode (I.116). The FILL preview goes away and the paths stay — the pen must
   * remain fully functional in it, which gotcha 27 is emphatic about: people toggle it mid-draw
   * to see the artwork they are tracing under their own ink.
   *
   * A view flag, never an artifact flag. The rasteriser keeps writing the same bytes; only the
   * surface's opacity changes. An outline mode that stopped rasterising would let a user save a
   * mask they had not looked at.
   */
  outline: boolean;
  /**
   * `Ctrl+H`, Hide Edges (I.118) — the chrome disappears and the artwork stays. [U] — absent from
   * Adobe's own shortcut page, and gotcha 27 calls it the most-used key for "let me see what I am
   * tracing without my anchors all over it".
   */
  hideEdges: boolean;
  intent: PenIntent | null;
  undo: PenSnapshot[];
  redo: PenSnapshot[];
}

export function createPenState(doc: PenDoc = { paths: [] }): PenState {
  return {
    doc: cloneDoc(doc),
    activeTool: 'pen',
    lastSelectionTool: 'direct-select',
    toolBeforeModifier: null,
    activePathIndex: null,
    activeEndpoint: null,
    selection: { anchors: [], handles: [], segments: [], paths: [] },
    drag: null,
    hover: null,
    rubberBand: null,
    marquee: null,
    pointer: null,
    capsLock: false,
    snapped: null,
    snapRefusal: null,
    snapEnabled: true,
    locked: false,
    outline: false,
    hideEdges: false,
    intent: null,
    undo: [],
    redo: [],
  };
}

// ── Input ──────────────────────────────────────────────────────────────────

export interface PenMods {
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  space: boolean;
  capsLock: boolean;
}

export interface PenInput {
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'keydown' | 'keyup' | 'blur';
  /** DOCUMENT space, already un-zoomed by the DOM layer. */
  point?: { x: number; y: number };
  button?: number;
  /** Normalised key name — `KeyboardEvent.key`, with ' ' accepted for Space. */
  key?: string;
  /**
   * Modifier state AFTER the event. On `keyup` of Alt, `mods.alt` must be false — the engine
   * restores the momentary tool by reading these rather than by tracking which key came up,
   * so Ctrl+Alt held together does not restore the pen while one is still down.
   */
  mods: PenMods;
  /** Screen px per document unit. Hit radii are divided by it; snap displacement multiplied by it. */
  zoom: number;
}

// ── The keyboard binding table — DATA, in ONE place ────────────────────────

export type PenCommand =
  | 'tool-pen'
  | 'tool-direct-select'
  | 'tool-select'
  | 'tool-anchor-point'
  | 'add-anchor-at-selection'
  | 'delete-anchor-at-selection'
  | 'nudge-left'
  | 'nudge-right'
  | 'nudge-up'
  | 'nudge-down'
  | 'nudge-left-big'
  | 'nudge-right-big'
  | 'nudge-up-big'
  | 'nudge-down-big'
  | 'delete'
  | 'escape'
  | 'enter'
  | 'undo'
  | 'redo'
  | 'select-all'
  | 'deselect-all'
  | 'join'
  | 'toggle-outline'
  | 'toggle-edges'
  | 'toggle-snap';

export interface KeyBinding {
  /** Matched case-insensitively against `PenInput.key`. */
  key: string;
  /** Required modifier state. An omitted modifier must be UP — `A` is not `Ctrl+A`. */
  mods: { alt: boolean; ctrl: boolean; shift: boolean };
  command: PenCommand;
  label: string;
  /**
   * The host editor binds bare `0`, `+`, `-` and `Space` for zoom and pan
   * (`packages/three/src/react/ViewTransform.tsx`). `+` and `-` are Illustrator's anchor-tool
   * keys, so while the pen surface is active they belong to the pen. This flag is how the
   * wiring agent knows which keys to hand over, without either side editing the other's file.
   */
  claimsFromHost?: boolean;
}

/**
 * Every key the pen surface answers to, as one retunable structure.
 *
 * It is a table rather than a switch because a shortcut sheet, a preferences UI and a conflict
 * check all want to READ the bindings, and a switch statement can only be executed. The UI
 * reads this; nothing in the logic below hardcodes a key name.
 */
export const PEN_KEY_BINDINGS: readonly KeyBinding[] = Object.freeze([
  { key: 'p', mods: { alt: false, ctrl: false, shift: false }, command: 'tool-pen', label: 'Pen' },
  { key: 'a', mods: { alt: false, ctrl: false, shift: false }, command: 'tool-direct-select', label: 'Direct Selection' },
  { key: 'v', mods: { alt: false, ctrl: false, shift: false }, command: 'tool-select', label: 'Selection' },
  { key: 'c', mods: { alt: false, ctrl: false, shift: true }, command: 'tool-anchor-point', label: 'Anchor Point tool' },

  // Illustrator's Add / Delete Anchor Point tool keys. BARE `+` and `-` — the host's zoom
  // bindings must yield these while the pen surface is active.
  // Illustrator's `+` and `-` activate the Add / Delete Anchor Point TOOLS. There is no separate
  // tool slot for them here — the pen already does both, scoped to selected paths (A.9) — so
  // they act immediately on the current selection instead: `+` splits each selected segment at
  // its midpoint, `-` removes each selected anchor and rejoins its neighbours. A deliberate
  // deviation, written down so it is not mistaken for an oversight.
  //
  // THE SHIFT FLAGS ON `+` AND `_` ARE NOT DECORATION. `KeyboardEvent.key` is the CHARACTER, and
  // on a US layout `+` and `_` only exist with Shift down — so declaring them `shift: false` made
  // `lookupBinding` return null for both and the two entries were unreachable from any real
  // keyboard. `=` and `-` cover the same physical keys, so nothing was broken functionally; what
  // was broken is the table, and the table is what a shortcut sheet or a conflict check reads.
  { key: '=', mods: { alt: false, ctrl: false, shift: false }, command: 'add-anchor-at-selection', label: 'Add Anchor Point', claimsFromHost: true },
  { key: '+', mods: { alt: false, ctrl: false, shift: true }, command: 'add-anchor-at-selection', label: 'Add Anchor Point (Shift+=)', claimsFromHost: true },
  { key: '-', mods: { alt: false, ctrl: false, shift: false }, command: 'delete-anchor-at-selection', label: 'Delete Anchor Point', claimsFromHost: true },
  { key: '_', mods: { alt: false, ctrl: false, shift: true }, command: 'delete-anchor-at-selection', label: 'Delete Anchor Point (Shift+-)', claimsFromHost: true },

  { key: 'ArrowLeft', mods: { alt: false, ctrl: false, shift: false }, command: 'nudge-left', label: 'Nudge left' },
  { key: 'ArrowRight', mods: { alt: false, ctrl: false, shift: false }, command: 'nudge-right', label: 'Nudge right' },
  { key: 'ArrowUp', mods: { alt: false, ctrl: false, shift: false }, command: 'nudge-up', label: 'Nudge up' },
  { key: 'ArrowDown', mods: { alt: false, ctrl: false, shift: false }, command: 'nudge-down', label: 'Nudge down' },
  { key: 'ArrowLeft', mods: { alt: false, ctrl: false, shift: true }, command: 'nudge-left-big', label: 'Nudge left 10x' },
  { key: 'ArrowRight', mods: { alt: false, ctrl: false, shift: true }, command: 'nudge-right-big', label: 'Nudge right 10x' },
  { key: 'ArrowUp', mods: { alt: false, ctrl: false, shift: true }, command: 'nudge-up-big', label: 'Nudge up 10x' },
  { key: 'ArrowDown', mods: { alt: false, ctrl: false, shift: true }, command: 'nudge-down-big', label: 'Nudge down 10x' },

  { key: 'Delete', mods: { alt: false, ctrl: false, shift: false }, command: 'delete', label: 'Delete selection' },
  { key: 'Backspace', mods: { alt: false, ctrl: false, shift: false }, command: 'delete', label: 'Delete selection' },
  { key: 'Escape', mods: { alt: false, ctrl: false, shift: false }, command: 'escape', label: 'End path / abort' },
  { key: 'Enter', mods: { alt: false, ctrl: false, shift: false }, command: 'enter', label: 'End path' },

  { key: 'z', mods: { alt: false, ctrl: true, shift: false }, command: 'undo', label: 'Undo' },
  { key: 'z', mods: { alt: false, ctrl: true, shift: true }, command: 'redo', label: 'Redo' },
  { key: 'a', mods: { alt: false, ctrl: true, shift: false }, command: 'select-all', label: 'Select All' },
  { key: 'a', mods: { alt: false, ctrl: true, shift: true }, command: 'deselect-all', label: 'Deselect' },
  { key: 'j', mods: { alt: false, ctrl: true, shift: false }, command: 'join', label: 'Join' },

  // The two VIEW keys an Illustrator user reaches for while tracing, and the only two of spec
  // E's view set that mean anything on a single card face (see `ViewTransform.tsx` for what was
  // deliberately not cloned). Both are pure view state: they touch no geometry, take no undo
  // step, and cannot change the committed artifact.
  { key: 'y', mods: { alt: false, ctrl: true, shift: false }, command: 'toggle-outline', label: 'Outline / Preview' },
  { key: 'h', mods: { alt: false, ctrl: true, shift: false }, command: 'toggle-edges', label: 'Hide / Show Edges' },

  // I.102, Smart Guides. In Illustrator it governs alignment guides, anchor labels and
  // construction guides together; here it governs every snap the engine performs, which is the
  // same promise in a smaller tool. A view/preference toggle like the two above: no geometry
  // moves when it is pressed, and it takes no undo step — but unlike them it changes what the
  // NEXT gesture does, so the surface has to show its state rather than leave it invisible.
  { key: 'u', mods: { alt: false, ctrl: true, shift: false }, command: 'toggle-snap', label: 'Snap to printed edges' },
]);

/**
 * Keys the host binds that the pen claims UNCONDITIONALLY while its surface is active.
 * `ViewTransform` binds bare `+`/`-`/`=` for zoom; Illustrator gives them to the anchor tools.
 */
export const PEN_CLAIMED_HOST_KEYS: readonly string[] = Object.freeze(['+', '=', '-', '_']);

/**
 * Keys the pen claims only SOMETIMES, which is why they cannot simply be moved.
 *
 * Spacebar means two different things depending on mouse-button state (spec B.3, gotcha 11):
 * with a button DOWN it translates the anchor being placed and the engine consumes it; with the
 * button UP it is a pan and the engine emits `{ kind: 'pan' }` for the host to act on. The host
 * must therefore route Space through the engine and honour the intent, not keep its own
 * unconditional binding.
 */
export const PEN_CONDITIONAL_HOST_KEYS: readonly string[] = Object.freeze([' ', 'Space', '0']);

const isSpaceKey = (k: string | undefined): boolean => k === ' ' || k === 'Space' || k === 'Spacebar';

/** The binding for a key + modifier state, or null. Exact modifier match — `A` is not `Ctrl+A`. */
export function lookupBinding(key: string, mods: { alt: boolean; ctrl: boolean; shift: boolean }): KeyBinding | null {
  const k = key.length === 1 ? key.toLowerCase() : key;
  for (const b of PEN_KEY_BINDINGS) {
    const bk = b.key.length === 1 ? b.key.toLowerCase() : b.key;
    if (bk !== k) continue;
    if (b.mods.alt !== mods.alt || b.mods.ctrl !== mods.ctrl || b.mods.shift !== mods.shift) continue;
    return b;
  }
  return null;
}

// ── Hit testing ────────────────────────────────────────────────────────────
//
// TIERS, NOT DISTANCES, and the tier order is global across paths. An anchor SITS ON the
// segments that meet it, so by raw distance a segment is always tied with its anchor and often
// a floating-point hair closer; rank by distance and clicking an anchor sometimes inserts a new
// anchor next to the one the user meant to grab, which reads as the editor ignoring the click.
// `pen-geometry.hitTestPath` makes the same argument for a single `VPath`; this is the same
// rule over the editing model, where handles hang off POINTS rather than off primitives.

/**
 * What is under `p`, with radii given in SCREEN pixels and converted here — the one place the
 * conversion happens, so a hit that lands at 1x lands identically at 4x (spec 0.2, I.100).
 */
export function hitTest(doc: PenDoc, p: Vec, cfg: PenConfig, zoom: number): PenTarget | null {
  const ar = cfg.anchorHitRadiusPx / zoom;
  const hr = cfg.handleHitRadiusPx / zoom;
  const sr = cfg.segmentHitRadiusPx / zoom;

  let best: PenTarget | null = null;
  let bestD = Infinity;

  let anchor: PenTarget | null = null;
  let anchorD = Infinity;
  for (let pi = 0; pi < doc.paths.length; pi++) {
    const path = doc.paths[pi];
    for (let i = 0; i < path.points.length; i++) {
      const d = dist(P(path.points[i].anchor), p);
      if (d <= ar && d < anchorD) { anchorD = d; anchor = { kind: 'anchor', path: pi, point: i }; }
    }
  }

  let handle: PenTarget | null = null;
  let handleD = Infinity;
  for (let pi = 0; pi < doc.paths.length; pi++) {
    const path = doc.paths[pi];
    for (let i = 0; i < path.points.length; i++) {
      const pt = path.points[i];
      for (const side of ['left', 'right'] as const) {
        const h = side === 'left' ? pt.leftDirection : pt.rightDirection;
        // A retracted handle is AT its anchor; the anchor tier already answered for it, and a
        // handle you cannot see is not a handle you can grab.
        if (isRetracted(h, pt.anchor, cfg.retractEpsilon)) continue;
        const d = dist(P(h), p);
        if (d <= hr && d < handleD) { handleD = d; handle = { kind: 'handle', path: pi, point: i, side }; }
      }
    }
  }

  // THE ONE PAIR OF TIERS WHERE RANK ALONE IS WRONG, and it is wrong because of the radii:
  // `anchorHitRadiusPx` (6) is LARGER than `handleHitRadiusPx` (5), so a handle pulled less than
  // six screen px out of its anchor sits entirely inside the anchor's disc. Return on the first
  // non-empty tier and that handle can never be grabbed at all — click exactly on the dot and you
  // select the anchor behind it. Illustrator lets you grab a short handle, so between these two
  // the CLOSER one wins, with the tie going to the anchor.
  //
  // Deliberately NOT extended to the segment tier: an anchor SITS ON the segments that meet it,
  // so by raw distance a segment is tied with its anchor and a floating-point hair closer about
  // half the time. Ranking those by distance is how clicking an anchor starts inserting a new one
  // beside it (I.99 covers exactly that, and it is correct as it stands).
  if (anchor && handle) return handleD < anchorD ? handle : anchor;
  if (anchor) return anchor;
  if (handle) return handle;

  for (let pi = 0; pi < doc.paths.length; pi++) {
    const path = doc.paths[pi];
    for (let s = 0; s < segmentCount(path); s++) {
      const { from, prim } = segmentCubic(path, s);
      const proj = projectToPrim(from, prim, p);
      if (proj.dist <= sr && proj.dist < bestD) {
        bestD = proj.dist;
        best = { kind: 'segment', path: pi, segment: s, t: proj.t, point: A(proj.point) };
      }
    }
  }
  return best;
}

/** The point index at one end of a path. */
const endIndex = (path: PenPath, end: PathEnd): number => (end === 'last' ? path.points.length - 1 : 0);

/**
 * The anchor a close would land on: the endpoint that is NOT the one being drawn from.
 *
 * The spec writes this as `pathPoints[0]`, which is right whenever drawing runs forward. Resume
 * an open path from its FIRST point (spec A.8 works on either endpoint) and the far end is
 * `pathPoints[n-1]` instead; the stored closing segment is still `n-1 -> 0` either way.
 */
const closeTargetIndex = (path: PenPath, end: PathEnd): number => (end === 'last' ? 0 : path.points.length - 1);

// ── Click precedence: spec A.8, as ONE ordered resolution ──────────────────

/**
 * What a pen click at `p` would do. Rungs in order, FIRST MATCH WINS, distance never overrides
 * rung — a closer anchor on a lower rung does not beat a farther one on a higher rung.
 *
 * `cursorFor` calls this too. That is the point: get these apart and the tool promises a close
 * badge and performs a delete, which is exactly gotcha 7's failure mode.
 */
export function resolvePenClick(
  state: PenState,
  p: Vec,
  mods: PenMods,
  cfg: PenConfig,
  zoom: number,
): PenAction {
  const ar = cfg.anchorHitRadiusPx / zoom;
  const sr = cfg.segmentHitRadiusPx / zoom;
  const doc = state.doc;
  const ap = state.activePathIndex;
  const active = ap !== null ? doc.paths[ap] : null;
  const end = state.activeEndpoint;

  // 1. The ACTIVE ENDPOINT of the ACTIVE path -> retract the outgoing handle (A.6). This rung
  //    exists to shadow rung 5: the endpoint is not deletable even with auto-delete on (I.25).
  if (active && end && active.points.length > 0 && !active.closed) {
    const i = endIndex(active, end);
    if (dist(P(active.points[i].anchor), p) <= ar) return { kind: 'retract-outgoing', path: ap!, point: i };
  }

  // 2. The far endpoint of the active open path with >= 2 points -> close (A.7).
  if (active && end && !active.closed && active.points.length >= 2) {
    const i = closeTargetIndex(active, end);
    if (dist(P(active.points[i].anchor), p) <= ar) return { kind: 'close', path: ap!, point: i };
  }

  // 3 & 4. An endpoint of a DIFFERENT open path. With a path active that is a JOIN (merge
  //        badge); with nothing active it is a CONTINUE (slash badge). Never on a closed path —
  //        a closed path cannot be resumed (I.33, gotcha 22).
  for (let pi = 0; pi < doc.paths.length; pi++) {
    if (pi === ap) continue;
    const path = doc.paths[pi];
    if (path.closed || path.points.length === 0) continue;
    for (const e of ['first', 'last'] as const) {
      const i = endIndex(path, e);
      if (dist(P(path.points[i].anchor), p) > ar) continue;
      return ap !== null
        ? { kind: 'join', path: pi, point: i, end: e }
        : { kind: 'continue', path: pi, end: e };
    }
  }

  // 5 & 6. Auto add/delete, scoped to SELECTED paths only (A.9). Shift suppresses both — and
  //        Adobe's own instruction is to release Shift before the mouse button so the click
  //        does not also constrain, which is why the suppression reads `mods.shift` at click
  //        time rather than latching at pointerdown.
  if (cfg.autoAddDelete && !mods.shift) {
    let bestA: { pi: number; i: number; d: number } | null = null;
    for (let pi = 0; pi < doc.paths.length; pi++) {
      if (!isPathSelected(state, pi)) continue;
      const path = doc.paths[pi];
      for (let i = 0; i < path.points.length; i++) {
        const d = dist(P(path.points[i].anchor), p);
        if (d <= ar && (!bestA || d < bestA.d)) bestA = { pi, i, d };
      }
    }
    if (bestA) return { kind: 'delete-anchor', path: bestA.pi, point: bestA.i };

    let bestS: { pi: number; s: number; t: number; d: number } | null = null;
    for (let pi = 0; pi < doc.paths.length; pi++) {
      if (!isPathSelected(state, pi)) continue;
      const path = doc.paths[pi];
      for (let s = 0; s < segmentCount(path); s++) {
        const { from, prim } = segmentCubic(path, s);
        const proj = projectToPrim(from, prim, p);
        if (proj.dist <= sr && (!bestS || proj.dist < bestS.d)) bestS = { pi, s, t: proj.t, d: proj.dist };
      }
    }
    if (bestS) return { kind: 'add-anchor', path: bestS.pi, segment: bestS.s, t: bestS.t };
  }

  // 7. Empty canvas.
  return { kind: 'new-anchor' };
}

/**
 * The rungs Alt is NOT allowed to take away from the pen. Spec A.7, I.30.
 *
 * Alt borrows the Anchor Point tool while the Pen is up (spec B.2, I.61) — but it must borrow the
 * TOOL, not the CLICK. Hold Alt, hover the first anchor of a three-point active path, and the
 * whole close ladder was unreachable: the momentary switch had already happened on the Alt
 * KEYDOWN, so the press routed to the converter, the badge read `convert` instead of `close`, and
 * an Alt-click-drag pulled two mirrored handles out of the first anchor — the exact edit spec
 * A.7's Alt variant exists to avoid, on the exact gesture it exists for.
 *
 * So Alt yields on the three TOPOLOGY rungs, where the converter has no honest answer anyway:
 * there is no such thing as converting a path into being closed, joined or continued.
 *
 * Rung 1, `retract-outgoing`, deliberately stays with the converter. Alt-dragging the anchor you
 * just placed to pull a fresh direction line out of it is a real Illustrator gesture (spec A.5's
 * after-placement table), and it is the same anchor, so handing it to the pen would trade one
 * unreachable gesture for another.
 */
const ALT_YIELDS_TO_PEN: ReadonlySet<PenAction['kind']> = new Set<PenAction['kind']>(['close', 'join']);

/**
 * Is the converter under the cursor only because ALT borrowed it, on a rung the pen must keep?
 *
 * SCOPED TO A LIVE DRAWING SESSION, and that is what keeps the exception small. With no active
 * path there is nothing to close or join to, the ladder can only offer `continue`, and Alt over an
 * endpoint is an unambiguous request to convert it — which is also what I.86-I.90 pin down: the
 * `Shift+C` route and the Alt route must produce IDENTICAL documents for every converter gesture,
 * and they only can if the borrow is total whenever the pen is not mid-path.
 *
 * `toolBeforeModifier === 'pen'` separates the borrow from a deliberate `Shift+C`: the Anchor
 * Point tool chosen on purpose keeps every click, including these. Both `onPointerDown` and
 * `cursorFor` ask this, over the same resolution, so the badge cannot promise a conversion the
 * press will not perform.
 */
function altHoldsAPenClick(state: PenState, action: PenAction | null | undefined): boolean {
  return state.activeTool === 'anchor-point'
    && state.toolBeforeModifier === 'pen'
    && state.activePathIndex !== null
    && !!action
    && ALT_YIELDS_TO_PEN.has(action.kind);
}

// ── The cursor, derived — the UI renders what this returns and decides nothing ─

export type PenCursor =
  | 'start' | 'drawing' | 'continue' | 'close' | 'add' | 'delete'
  | 'convert' | 'merge' | 'blocked' | 'crosshair';

/**
 * The badge for the current state. Spec F.1.
 *
 * Caps Lock outranks everything — it replaces the glyph for every tool, and it is the number
 * one cause of "my pen cursor turned into an X" (I.93, gotcha 20). `blocked` is the slashed
 * circle for a locked or hidden layer and is a DIFFERENT SYMBOL from the `continue` slash;
 * conflating the two is a real fidelity bug (I.94), which is why they are separate members of
 * this enum rather than one "unavailable" state.
 *
 * This describes the PEN surface. While a selection tool is active the UI draws its own
 * arrowhead — filled normally, hollow on a snap capture, which it reads off `state.snapped`
 * (F.2) — and this returns `crosshair` as the neutral precise pointer.
 */
export function cursorFor(state: PenState): PenCursor {
  if (state.capsLock) return 'crosshair';
  if (state.locked) return 'blocked';
  if (state.activeTool === 'select' || state.activeTool === 'direct-select') return 'crosshair';

  const action = state.hover?.action;

  // The Alt borrow is scoped, and the badge reads the SAME scope the press does — see
  // `altHoldsAPenClick`. Over a close/join/continue target this falls through to the pen's own
  // badges below rather than promising a conversion that will not happen.
  if (state.activeTool === 'anchor-point' && !altHoldsAPenClick(state, action)) {
    const t = state.hover?.target;
    return t && (t.kind === 'anchor' || t.kind === 'handle') ? 'convert' : 'crosshair';
  }

  if (!action) return state.activePathIndex === null ? 'start' : 'drawing';
  switch (action.kind) {
    // The active endpoint gets the caret. Spec A.6 note (5) special-cases it away from the
    // minus badge precisely so it does not read as deletable.
    case 'retract-outgoing': return 'convert';
    case 'close': return 'close';
    case 'join': return 'merge';
    case 'continue': return 'continue';
    case 'delete-anchor': return 'delete';
    case 'add-anchor': return 'add';
    case 'new-anchor': return state.activePathIndex === null ? 'start' : 'drawing';
    default: {
      const unhandled: never = action;
      throw new Error(`cursorFor: unhandled action ${JSON.stringify(unhandled)}`);
    }
  }
}

// ── Which handles the UI must draw ─────────────────────────────────────────

export interface HandleStub { path: number; point: number; side: HandleSide }

/**
 * The handles a renderer should show. Spec F.4.
 *
 * THE RULE THAT IS INDEPENDENT OF THE PREFERENCE, and a big part of the feel: selecting
 * EXACTLY ONE anchor also shows the one FACING handle on each neighbour — the handles that
 * actually control the two touching segments. That is why selecting one point shows FOUR
 * handle stubs and not two (I.99, gotcha 23). Ship two and the editor looks like it forgot
 * half the curve.
 */
export function visibleHandles(state: PenState, cfg: PenConfig = DEFAULT_PEN_CONFIG): HandleStub[] {
  const out: HandleStub[] = [];
  const seen = new Set<string>();
  const push = (path: number, point: number, side: HandleSide): void => {
    const pth = state.doc.paths[path];
    if (!pth) return;
    const pt = pth.points[point];
    if (!pt) return;
    const h = side === 'left' ? pt.leftDirection : pt.rightDirection;
    if (isRetracted(h, pt.anchor, cfg.retractEpsilon)) return;   // nothing to draw
    const k = `${path}:${point}:${side}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ path, point, side });
  };

  const anchors = state.selection.anchors;
  const lone = anchors.length === 1 && state.selection.segments.length === 0;

  if (lone || cfg.showHandlesWhenMultipleSelected) {
    for (const a of anchors) { push(a.path, a.point, 'left'); push(a.path, a.point, 'right'); }
  }

  if (lone) {
    const a = anchors[0];
    const path = state.doc.paths[a.path];
    if (path) {
      const n = path.points.length;
      const prev = a.point > 0 ? a.point - 1 : path.closed ? n - 1 : -1;
      const next = a.point < n - 1 ? a.point + 1 : path.closed ? 0 : -1;
      // The neighbour's handle that FACES the selected anchor: the previous point's outgoing,
      // the next point's incoming.
      if (prev >= 0) push(a.path, prev, 'right');
      if (next >= 0) push(a.path, next, 'left');
    }
  }

  // A selected SEGMENT reveals its own two endpoints' facing handles (spec C.1) without making
  // the anchors movable — which is why segments contribute handles but not anchor selection.
  for (const s of state.selection.segments) {
    const path = state.doc.paths[s.path];
    if (!path) continue;
    const n = path.points.length;
    push(s.path, s.segment, 'right');
    push(s.path, (s.segment + 1) % n, 'left');
  }

  return out;
}

// ── Shift: PROJECT, do not clamp ───────────────────────────────────────────

/**
 * Project `p` onto the nearest 45-degree ray from `ref`, rotated by the Constrain Angle.
 *
 * Illustrator constrains relative to the Constrain Angle preference, not to true horizontal
 * (gotcha 9): set it to 15 and Shift snaps to 15/60/105. And it PRESERVES MAGNITUDE — the
 * point slides around the circle of radius |p - ref| rather than being clamped onto an axis,
 * which is the difference between a constrained line that keeps its length and one that
 * shortens every time you nudge off-axis.
 */
export function constrainToAngle(ref: Vec, p: Vec, constrainAngleDeg: number, stepDeg = 45): Vec {
  const d = sub(p, ref);
  const m = len(d);
  if (m < 1e-12) return v(p.x, p.y);
  const phi = constrainAngleDeg * DEG;
  const step = stepDeg * DEG;
  const theta = Math.round((Math.atan2(d.y, d.x) - phi) / step) * step + phi;
  return v(ref.x + m * Math.cos(theta), ref.y + m * Math.sin(theta));
}

/**
 * Capture `p` onto the nearest CONSTRUCTION ray from `ref` — Illustrator's construction guides
 * (I.104), which ship OFF and which `cfg.constructionAngles` turns on.
 *
 * Three things make this a guide rather than a Shift you cannot release. It only fires when the
 * cursor is already within `constructionSnapPx` SCREEN px of a ray, so a deliberately off-axis
 * anchor stays off-axis. Every listed angle is a ray in BOTH directions, because 0 means
 * "horizontal", not "to the right of the last anchor". And it preserves magnitude, sliding the
 * point around the circle exactly as `constrainToAngle` does, so a captured segment keeps the
 * length the hand gave it instead of being shortened onto an axis.
 *
 * Shift wins outright when it is held: the explicit constraint is not a suggestion competing
 * with an automatic one.
 */
export function constructionCapture(
  ref: Vec,
  p: Vec,
  cfg: PenConfig,
  zoom: number,
): { point: Vec; angleDeg: number } | null {
  if (cfg.constructionAngles.length === 0) return null;
  const d = sub(p, ref);
  const m = len(d);
  if (m < 1e-12) return null;
  let best: { point: Vec; angleDeg: number; movePx: number } | null = null;
  for (const a of cfg.constructionAngles) {
    const base = (a + cfg.constrainAngle) * DEG;
    for (const phi of [base, base + Math.PI]) {
      const q = v(ref.x + m * Math.cos(phi), ref.y + m * Math.sin(phi));
      const movePx = dist(q, p) * zoom;
      if (movePx > cfg.constructionSnapPx) continue;
      if (!best || movePx < best.movePx) best = { point: q, angleDeg: a, movePx };
    }
  }
  return best === null ? null : { point: best.point, angleDeg: best.angleDeg };
}

// ── Snapping: injected, and bounded by the engine ──────────────────────────

interface SnapOutcome { point: Vec; snapped: { point: [number, number]; kind: string } | null; refusal: string | null }

/**
 * Ask the injected snap provider, then CHECK ITS ANSWER.
 *
 * The repository's existing guardrail is not advisory: `line-snap` may nudge a hand-drawn line
 * by at most a couple of pixels and its tests assert the result stays within 1.5px of where the
 * hand put it, and `edge-trace` enforces a hard 5px corridor. A pen that obeyed an unbounded
 * snap callback would be the hole in that — one confident heuristic later and the anchor a user
 * placed lands somewhere they did not put it, in a committed artifact, with no record of why.
 *
 * So the engine enforces `maxSnapMovePx` itself rather than trusting the provider, the
 * comparison is in SCREEN pixels (a 2px allowance means 2px on the user's screen at any zoom),
 * and a refusal states its reason instead of failing silently.
 */
function applySnap(
  p: Vec,
  cfg: PenConfig,
  zoom: number,
  ctx: SnapContext,
  enabled: boolean,
): SnapOutcome {
  if (!enabled || !cfg.snap) return { point: p, snapped: null, refusal: null };
  const proposal = cfg.snap({ x: p.x, y: p.y }, ctx);
  if (!proposal) return { point: p, snapped: null, refusal: null };
  // A provider that declines with a REASON is the case the whole guardrail is written about, and
  // it is not the same as a provider that found nothing. It passes straight through: there is no
  // displacement to bound, only something the user should be able to see it chose not to do.
  if (proposal.point === undefined) return { point: p, snapped: null, refusal: proposal.refused };
  const target = v(proposal.point.x, proposal.point.y);
  const movePx = dist(target, p) * zoom;
  if (!(movePx <= cfg.maxSnapMovePx)) {
    return {
      point: p,
      snapped: null,
      refusal:
        `snap '${proposal.kind}' refused: it would move the point ${movePx.toFixed(2)} screen px, ` +
        `over the ${cfg.maxSnapMovePx}px limit — an ambiguous band may nudge a point, never relocate it`,
    };
  }
  return { point: target, snapped: { point: A(target), kind: proposal.kind }, refusal: proposal.reason ?? null };
}

// ── Editing primitives on the model ────────────────────────────────────────

/**
 * Demote a SMOOTH point that has just lost a side. Spec C.3, applied in place.
 *
 * A smooth point cannot have a retracted handle, because collinearity is undefined against a
 * zero-length vector — there is no direction for the other side to stay in line with. `dragHandle`
 * has always known this; the gestures that retract a handle DIRECTLY did not, and the flag reaches
 * the artifact: `toVPath` writes `t:'s'` on a handle-less anchor and `fromVPath` believes it (the
 * stored flag outranks inference, deliberately), so the point comes back smooth and the next tug
 * on its one live handle rotates a handle that is not there.
 *
 * Cheaper as a heal than as a rule every call site remembers: retracting a side is three or four
 * lines apart in three or four places, and each of them is one line away from being wrong again.
 */
export function healRetractedSmooth(pt: PathPoint, eps: number): void {
  if (pt.pointType !== 'smooth') return;
  if (isRetracted(pt.leftDirection, pt.anchor, eps) || isRetracted(pt.rightDirection, pt.anchor, eps)) {
    pt.pointType = 'corner';
  }
}

/**
 * Move one handle of a point, applying the LATER-EDIT smooth rule.
 *
 * Spec 0.1, and the single most-missed detail in the whole document: a smooth point is CREATED
 * mirrored (see the placement math in `reduce`) but EDITED collinear-keeping-length. Dragging
 * one handle rotates the opposite one to stay in line and leaves its own length alone. Clone
 * only the mirrored rule and every asymmetric curve a user builds snaps back symmetric the next
 * time they touch it — the editor feels like it is arguing with them.
 *
 * `breakPair` is Alt (spec A.5/C.2/D): the opposite handle is untouched and the point becomes a
 * CORNER. Dragging a handle back INTO its anchor retracts that side and also gives a CORNER,
 * because collinearity is undefined for a retracted side (spec C.3).
 */
export function dragHandle(pt: PathPoint, side: HandleSide, to: Vec, breakPair: boolean, cfg: PenConfig): PathPoint {
  const out = clonePoint(pt);
  const anchor = P(pt.anchor);
  if (side === 'left') out.leftDirection = A(to); else out.rightDirection = A(to);

  if (breakPair) { out.pointType = 'corner'; return out; }
  if (pt.pointType !== 'smooth') return out;

  const d = sub(to, anchor);
  if (len(d) <= cfg.retractEpsilon) {
    // Retracted side: a smooth point cannot have one, so this is now a one-handle CORNER.
    out.pointType = 'corner';
    return out;
  }
  const u = scale(d, 1 / len(d));
  const oppSide: HandleSide = side === 'left' ? 'right' : 'left';
  const opp = P(oppSide === 'left' ? pt.leftDirection : pt.rightDirection);
  const oppLen = len(sub(opp, anchor));
  if (oppLen <= cfg.retractEpsilon) { out.pointType = 'corner'; return out; }
  const moved = A(sub(anchor, scale(u, oppLen)));    // collinear, opposed, ITS OWN length kept
  if (oppSide === 'left') out.leftDirection = moved; else out.rightDirection = moved;
  return out;
}

/**
 * Insert an anchor on segment `s` at parameter `t`, leaving the rendered path GEOMETRICALLY
 * IDENTICAL. Spec A.9 / I.38.
 *
 * de Casteljau is not an approximation: the two halves trace the original curve exactly, so the
 * only error is the floating point in six averages. Anything that re-fits instead makes
 * clicking a path nudge its shape, which is the one thing a vector editor may never do.
 *
 * A STRAIGHT segment is split as a straight segment: both neighbours keep their retracted
 * handles and the new point is a retracted CORNER on the line. The de Casteljau split of a
 * degenerate cubic would be equally exact but would hand back four non-retracted collinear
 * handles, and `toVPath` would stop emitting a `LinePrim` — a straight card edge would quietly
 * become six numbers in the committed diff for no reason at all.
 */
export function insertAnchor(path: PenPath, s: number, t: number, cfg: PenConfig): PenPath {
  const out = clonePath(path);
  const n = path.points.length;
  const i = s;
  const j = (s + 1) % n;
  const a = out.points[i];
  const b = out.points[j];
  const straight =
    isRetracted(a.rightDirection, a.anchor, cfg.retractEpsilon) &&
    isRetracted(b.leftDirection, b.anchor, cfg.retractEpsilon);

  const { from, prim } = segmentCubic(path, s);
  const [first, second] = splitCubic(from, prim, t);
  const mid = P(first.to);

  const fresh: PathPoint = straight
    ? cornerPoint(mid)
    : {
        anchor: A(mid),
        leftDirection: [first.c2[0], first.c2[1]],
        rightDirection: [second.c1[0], second.c1[1]],
        // de Casteljau puts `c2 - mid - c1` on one line by construction, so SMOOTH is the
        // honest flag here and matches what Illustrator sets.
        pointType: 'smooth',
      };
  if (!straight) {
    a.rightDirection = [first.c1[0], first.c1[1]];
    b.leftDirection = [second.c2[0], second.c2[1]];
  }
  out.points.splice(i + 1, 0, fresh);
  return out;
}

/**
 * Delete an anchor and REJOIN its neighbours — the Delete Anchor Point tool / pen auto-delete.
 * Spec C.5, second kind.
 *
 * It preserves CONTINUITY, not shape: the path stays one path and stays closed if it was
 * closed, and the neighbours keep their own handles, so the curve visibly changes. Many
 * tutorials claim otherwise and the Shift-click-to-preserve-curve trick was removed from
 * current Illustrator; promising shape preservation here would be a promise the tool cannot
 * keep (gotcha 18).
 */
export function removeAnchorRejoin(path: PenPath, i: number): PenPath {
  const out = clonePath(path);
  out.points.splice(i, 1);
  // Closure survives all the way down to two anchors — a two-point closed path is two segments
  // between the same pair of anchors, which is a perfectly good lens shape and is what "stays
  // closed if it was closed" has to mean if it means anything. Only a single remaining point
  // has nothing left to close.
  if (out.points.length < 2) out.closed = false;
  return out;
}

/** Drop paths that no longer have a point in them, and remap the selection's indices. */
function pruneEmpty(doc: PenDoc, sel: PenSelection, activePathIndex: number | null): {
  doc: PenDoc; selection: PenSelection; activePathIndex: number | null;
} {
  const keep: number[] = [];
  for (let i = 0; i < doc.paths.length; i++) if (doc.paths[i].points.length > 0) keep.push(i);
  if (keep.length === doc.paths.length) return { doc, selection: sel, activePathIndex };
  const map = new Map<number, number>();
  keep.forEach((old, next) => map.set(old, next));
  return {
    doc: { paths: keep.map((i) => doc.paths[i]) },
    selection: {
      anchors: sel.anchors.filter((a) => map.has(a.path)).map((a) => ({ ...a, path: map.get(a.path)! })),
      handles: sel.handles.filter((h) => map.has(h.path)).map((h) => ({ ...h, path: map.get(h.path)! })),
      segments: sel.segments.filter((s) => map.has(s.path)).map((s) => ({ ...s, path: map.get(s.path)! })),
      paths: sel.paths.filter((p) => map.has(p)).map((p) => map.get(p)!),
    },
    activePathIndex: activePathIndex !== null && map.has(activePathIndex) ? map.get(activePathIndex)! : null,
  };
}

/**
 * The DELETE KEY, which is NOT the Delete Anchor Point tool. Spec C.5, first kind.
 *
 * It removes the selected anchors AND THEIR ADJOINING SEGMENTS, so the topology changes:
 * a closed path OPENS, and an interior anchor of an open path SPLITS it into two open paths.
 * Neither operation preserves shape and neither is meant to (I.80-82). Conflating this with the
 * rejoining delete is how an editor ends up with one "delete" that is wrong half the time.
 *
 * The fragments it leaves are returned OBJECT-SELECTED with no anchors selected, which is what
 * makes a second Delete remove the remaining object(s) (I.83) rather than doing nothing.
 */
export function deleteSelectedAnchors(doc: PenDoc, anchors: AnchorRef[]): { doc: PenDoc; paths: number[] } {
  const byPath = new Map<number, Set<number>>();
  for (const a of anchors) {
    if (!byPath.has(a.path)) byPath.set(a.path, new Set());
    byPath.get(a.path)!.add(a.point);
  }
  const out: PenPath[] = [];
  const selected: number[] = [];
  for (let pi = 0; pi < doc.paths.length; pi++) {
    const path = doc.paths[pi];
    const kill = byPath.get(pi);
    if (!kill || kill.size === 0) { out.push(clonePath(path)); continue; }
    const n = path.points.length;
    if (path.closed) {
      // Rotate so the walk starts just after a deleted anchor, then cut at every deletion.
      const first = [...kill].sort((a, b) => a - b)[0];
      const order: number[] = [];
      for (let k = 1; k <= n; k++) order.push((first + k) % n);
      let run: PathPoint[] = [];
      for (const idx of order) {
        if (kill.has(idx)) { if (run.length) { selected.push(out.length); out.push({ closed: false, points: run }); } run = []; continue; }
        run.push(clonePoint(path.points[idx]));
      }
      if (run.length) { selected.push(out.length); out.push({ closed: false, points: run }); }
    } else {
      let run: PathPoint[] = [];
      for (let idx = 0; idx < n; idx++) {
        if (kill.has(idx)) { if (run.length) { selected.push(out.length); out.push({ closed: false, points: run }); } run = []; continue; }
        run.push(clonePoint(path.points[idx]));
      }
      if (run.length) { selected.push(out.length); out.push({ closed: false, points: run }); }
    }
  }
  return { doc: { paths: out }, paths: selected };
}

/**
 * Merge two open subpaths into one, with `other`'s clicked endpoint adjacent to the active
 * endpoint. Spec A.8 — "appending, reversed if you clicked its last point".
 *
 * The connecting segment is shaped by the handles that are already there: the active endpoint's
 * outgoing handle and the clicked point's facing handle. Retracting them would be tidier and
 * would silently straighten a join the user made between two curves.
 */
export function joinPaths(
  doc: PenDoc,
  activeIdx: number,
  activeEnd: PathEnd,
  otherIdx: number,
  otherEnd: PathEnd,
): { doc: PenDoc; activePathIndex: number; activeEndpoint: PathEnd } {
  const active = doc.paths[activeIdx];
  const other = doc.paths[otherIdx];
  // Orient `other` so its clicked endpoint comes FIRST.
  const oriented = otherEnd === 'last' ? reversePenPath(other) : clonePath(other);
  const merged: PenPath =
    activeEnd === 'last'
      ? { closed: false, points: [...active.points.map(clonePoint), ...oriented.points] }
      : { closed: false, points: [...reversePenPath(oriented).points, ...active.points.map(clonePoint)] };

  const paths = doc.paths.map(clonePath);
  paths[activeIdx] = merged;
  paths.splice(otherIdx, 1);
  const newActive = otherIdx < activeIdx ? activeIdx - 1 : activeIdx;
  return { doc: { paths }, activePathIndex: newActive, activeEndpoint: activeEnd };
}

/**
 * Reshape a segment by dragging it directly, no anchor selection required (spec C.2, I.75).
 *
 * `delta` is where the grabbed point on the curve must move to. B(t) depends on the two
 * interior control points through the Bernstein weights b1 = 3(1-t)^2 t and b2 = 3(1-t) t^2, so
 * the requirement is `b1*dc1 + b2*dc2 = delta` — underdetermined, and the minimum-norm solution
 * distributes the move in proportion to each weight's influence. That is what makes the curve
 * follow the cursor at the grabbed parameter instead of somewhere near it.
 *
 * With `constrainSegmentReshape` the endpoint handle ANGLES are held and only their lengths
 * adapt, which turns the same requirement into a 2x2 solve along the two fixed directions.
 * Near-parallel handles make that singular, and there the honest answer is to fall back rather
 * than divide by a number the user cannot see.
 *
 * A STRAIGHT segment (both handles retracted) has no interior control points to move, so it
 * TRANSLATES, taking both endpoints with it. Spec C.2, marked [U].
 */
export function reshapeSegment(path: PenPath, s: number, t: number, delta: Vec, cfg: PenConfig): PenPath {
  const out = clonePath(path);
  const n = path.points.length;
  const i = s, j = (s + 1) % n;
  const a = out.points[i], b = out.points[j];
  const straight =
    isRetracted(a.rightDirection, a.anchor, cfg.retractEpsilon) &&
    isRetracted(b.leftDirection, b.anchor, cfg.retractEpsilon);

  if (straight) {
    for (const pt of [a, b]) {
      pt.anchor = A(add(P(pt.anchor), delta));
      pt.leftDirection = A(add(P(pt.leftDirection), delta));
      pt.rightDirection = A(add(P(pt.rightDirection), delta));
    }
    return out;
  }

  const mt = 1 - t;
  const b1 = 3 * mt * mt * t;
  const b2 = 3 * mt * t * t;
  if (b1 * b1 + b2 * b2 < 1e-12) return out;   // grabbed at an endpoint; nothing to distribute

  if (cfg.constrainSegmentReshape) {
    const u1 = sub(P(a.rightDirection), P(a.anchor));
    const u2 = sub(P(b.leftDirection), P(b.anchor));
    const n1 = len(u1), n2 = len(u2);
    if (n1 > 1e-9 && n2 > 1e-9) {
      const e1 = scale(u1, 1 / n1), e2 = scale(u2, 1 / n2);
      // [b1*e1  b2*e2] [s1 s2]^T = delta
      const det = b1 * e1.x * b2 * e2.y - b2 * e2.x * b1 * e1.y;
      if (Math.abs(det) > 1e-9) {
        const s1 = (delta.x * b2 * e2.y - b2 * e2.x * delta.y) / det;
        const s2 = (b1 * e1.x * delta.y - delta.x * b1 * e1.y) / det;
        a.rightDirection = A(add(P(a.rightDirection), scale(e1, s1)));
        b.leftDirection = A(add(P(b.leftDirection), scale(e2, s2)));
        return out;
      }
    }
  }

  const k = 1 / (b1 * b1 + b2 * b2);
  a.rightDirection = A(add(P(a.rightDirection), scale(delta, b1 * k)));
  b.leftDirection = A(add(P(b.leftDirection), scale(delta, b2 * k)));
  return out;
}

/** Translate an anchor and BOTH its handles rigidly. Spec C.2 — the curve must not tear. */
function translatePoint(pt: PathPoint, d: Vec): PathPoint {
  return {
    anchor: A(add(P(pt.anchor), d)),
    leftDirection: A(add(P(pt.leftDirection), d)),
    rightDirection: A(add(P(pt.rightDirection), d)),
    pointType: pt.pointType,
  };
}

// ── Undo: the granularity IS the design constraint ─────────────────────────
//
// "One anchor placement is exactly ONE undo step" (I.123) and "undo during an active path
// restores the previous anchor AND the active-path state so drawing can continue" (I.124) are
// not two nice-to-haves, they dictate the shape of everything above. Hence: a snapshot is
// pushed ONCE, on pointerdown, BEFORE the gesture mutates anything — the whole placement drag,
// every mousemove of handle dragging, the Alt break and the spacebar detour all land inside
// that single step. And the snapshot carries the active-path state alongside the geometry,
// because restoring the doc alone would undo the anchor and leave the pen with nothing to
// continue from, which is the version of this that every editor ships first.

const cloneSelection = (s: PenSelection): PenSelection => ({
  anchors: s.anchors.map((a) => ({ ...a })),
  handles: s.handles.map((h) => ({ ...h })),
  segments: s.segments.map((g) => ({ ...g })),
  paths: [...s.paths],
});

const snapshotOf = (s: PenState): PenSnapshot => ({
  doc: cloneDoc(s.doc),
  activePathIndex: s.activePathIndex,
  activeEndpoint: s.activeEndpoint,
  selection: cloneSelection(s.selection),
});

/** Begin an undoable gesture. Clears redo, because the timeline just forked. */
function commit(s: PenState, cfg: PenConfig): PenState {
  const undo = [...s.undo, snapshotOf(s)];
  if (undo.length > cfg.undoDepth) undo.splice(0, undo.length - cfg.undoDepth);
  return { ...s, undo, redo: [] };
}

/**
 * The snapshot `commit` has just pushed — the gesture's own, and the only one it may hand to
 * `newDrag`. Read it immediately after committing and nowhere else: read it without committing
 * and you get a PREVIOUS gesture's snapshot, which is the whole bug this shape exists to close.
 */
const openingSnapshot = (s: PenState): PenSnapshot | null => s.undo[s.undo.length - 1] ?? null;

/**
 * Discard the gesture in progress by restoring ITS OWN opening snapshot — Escape, blur.
 *
 * A rollback may only ever undo the gesture in the hand, so the snapshot comes off `state.drag`
 * rather than off the top of the undo stack. A drag that carries none (the marquee) rolls back to
 * nothing at all, which is right: it changed no geometry, so there is nothing to restore, and
 * popping the stack would delete a completed edit that has nothing to do with it.
 *
 * Snapshots taken DURING the gesture — a nudge with the button still down — go with it: the
 * stack is cut at the gesture's own entry, by identity, so nothing above it survives an abort.
 */
function rollback(s: PenState): PenState {
  const snap = s.drag?.snapshot;
  if (!snap) return s;
  const at = s.undo.lastIndexOf(snap);
  const undo = at >= 0 ? s.undo.slice(0, at) : s.undo;
  return { ...s, ...snap, doc: cloneDoc(snap.doc), selection: cloneSelection(snap.selection), undo };
}

// ── Derived state the UI reads ─────────────────────────────────────────────

function recomputeHover(s: PenState, cfg: PenConfig, zoom: number, mods: PenMods): PenHover | null {
  if (!s.pointer) return null;
  const p = P(s.pointer);
  return { action: resolvePenClick(s, p, mods, cfg, zoom), target: hitTest(s.doc, p, cfg, zoom) };
}

/**
 * The rubber band. Spec A.4 and gotchas 1-2, both of which an Illustrator native notices inside
 * ninety seconds.
 *
 * `P0 = L.anchor, P1 = L's REAL outgoing handle, P2 = P3 = cursor`. Using the last anchor's
 * actual handle is why the preview is a straight line after a corner and a CURVE out of the
 * handle after a smooth point — a preview that always drew a straight line to the cursor would
 * be lying about the segment it is previewing. And there is no rubber band at all before the
 * first anchor exists.
 */
function recomputeRubberBand(s: PenState, cfg: PenConfig): RubberBand | null {
  if (!cfg.rubberBand || s.activeTool !== 'pen' || s.drag) return null;
  if (s.activePathIndex === null || !s.activeEndpoint || !s.pointer) return null;
  const path = s.doc.paths[s.activePathIndex];
  if (!path || path.closed || path.points.length === 0) return null;
  const L = path.points[endIndex(path, s.activeEndpoint)];
  const out = outgoingSide(s.activeEndpoint);
  return {
    from: [L.anchor[0], L.anchor[1]],
    c1: out === 'right' ? [L.rightDirection[0], L.rightDirection[1]] : [L.leftDirection[0], L.leftDirection[1]],
    c2: [s.pointer[0], s.pointer[1]],
    to: [s.pointer[0], s.pointer[1]],
  };
}

const settle = (s: PenState, cfg: PenConfig, zoom: number, mods: PenMods): PenState => {
  const withHover = { ...s, hover: recomputeHover(s, cfg, zoom, mods) };
  return { ...withHover, rubberBand: recomputeRubberBand(withHover, cfg) };
};

// ── The live placement frame — spec A.3, the exact math ────────────────────

/**
 * Recompute the anchor being placed from the cursor, every frame.
 *
 * `rightDirection = C` and `leftDirection = 2Q - C`, which is why THE PREVIOUS, ALREADY
 * COMMITTED SEGMENT RE-RENDERS LIVE on every mousemove: its arrival handle is this point's
 * `leftDirection`. Users aim by watching that segment move, and the drag feels inverted — pull
 * toward where you are going and the curve behind you bulges away — which is the thing people
 * actually learn the pen tool as. Freeze the previous segment for "stability" and the tool
 * becomes unaimable.
 *
 * Sides are named by which END of the path is active, because resuming an open path from its
 * first point draws backwards and the outgoing handle is then `leftDirection`. Same math,
 * mirrored bookkeeping.
 */
function placementFrame(state: PenState, cfg: PenConfig, cursor: Vec, shift: boolean): PenDoc {
  const d = state.drag!;
  const doc = cloneDoc(state.doc);
  const path = doc.paths[d.path];
  if (!path) return doc;
  const pt = path.points[d.point];
  if (!pt) return doc;
  const Q = P(d.origin);

  if (d.kind === 'close') {
    // Spec A.7: dragging as you close pulls handles from the CLOSE TARGET, which reshapes the
    // first segment as well as the closing one. Alt sets only the handle the closing segment
    // arrives through, leaving the first segment alone — the professional
    // close-without-wrecking-the-start move.
    const facing: HandleSide = state.activeEndpoint === 'last' ? 'left' : 'right';
    const other: HandleSide = facing === 'left' ? 'right' : 'left';
    if (!d.past) return doc;
    const C = shift ? constrainToAngle(Q, cursor, cfg.constrainAngle) : cursor;
    if (d.broken) {
      if (facing === 'left') pt.leftDirection = A(C); else pt.rightDirection = A(C);
      pt.pointType = 'corner';
    } else {
      if (other === 'right') pt.rightDirection = A(C); else pt.leftDirection = A(C);
      const mirrored = A(reflect(Q, C));
      if (facing === 'left') pt.leftDirection = mirrored; else pt.rightDirection = mirrored;
      pt.pointType = 'smooth';
    }
    return doc;
  }

  const end = state.activeEndpoint ?? 'last';
  const out = d.kind === 'convert-anchor' ? 'right' : outgoingSide(end);
  const inc: HandleSide = out === 'right' ? 'left' : 'right';

  if (!d.past) {
    if (d.fresh) {
      pt.anchor = A(Q);
      pt.leftDirection = A(Q);
      pt.rightDirection = A(Q);
      pt.pointType = 'corner';
    }
    return doc;
  }

  const C = shift ? constrainToAngle(Q, cursor, cfg.constrainAngle) : cursor;
  if (out === 'right') pt.rightDirection = A(C); else pt.leftDirection = A(C);

  if (d.kind === 'place' && !d.fresh) {
    // Resuming an existing endpoint pulls a FRESH OUTGOING handle only (spec A.8); the incoming
    // one shapes a segment that is already drawn and is not ours to move. [U] — Illustrator's
    // exact point-type result here is not documented; CORNER is the honest flag for a point
    // whose two sides are now independent.
    //
    // `convert-anchor` deliberately does NOT take this branch even though it also acts on an
    // existing point: dragging a corner with the Anchor Point tool pulls out two MIRRORED
    // handles (spec D), which is the placement rule, not the resume rule.
    pt.pointType = 'corner';
    return doc;
  }

  if (d.broken) {
    // Alt froze the incoming handle at the instant it was pressed (spec A.5); the outgoing one
    // keeps following the cursor independently in length and direction. Release gives a cusp.
    if (d.frozen) { if (inc === 'left') pt.leftDirection = [...d.frozen]; else pt.rightDirection = [...d.frozen]; }
    pt.pointType = 'corner';
  } else {
    const mirrored = A(reflect(Q, C));
    if (inc === 'left') pt.leftDirection = mirrored; else pt.rightDirection = mirrored;
    pt.pointType = 'smooth';
  }
  return doc;
}

// ── pointerdown ────────────────────────────────────────────────────────────

/**
 * `snapshot` is positional and required on purpose — see `PenDrag.snapshot`. Pass
 * `openingSnapshot(s)` right after committing, or `null` for a gesture that commits nothing;
 * there is no default, because the default is what got a user's anchor deleted by Escape.
 */
const newDrag = (
  kind: DragKind,
  at: Vec,
  doc: PenDoc,
  snapshot: PenSnapshot | null,
  over: Partial<PenDrag> = {},
): PenDrag => ({
  kind,
  origin: A(at),
  rawOrigin: A(at),
  current: A(at),
  past: false,
  path: -1,
  point: -1,
  side: null,
  segment: null,
  t: null,
  broken: false,
  frozen: null,
  spaceFrom: null,
  docAtStart: cloneDoc(doc),
  fresh: true,
  snapshot,
  ...over,
});

function onPointerDown(state: PenState, input: PenInput, cfg: PenConfig): PenState {
  if (!input.point || (input.button ?? 0) !== 0) return state;
  const raw = v(input.point.x, input.point.y);
  const mods = input.mods;
  const zoom = input.zoom;
  let s: PenState = { ...state, pointer: A(raw), marquee: null, snapped: null, snapRefusal: null };

  if (s.locked) return settle(s, cfg, zoom, mods);           // spec F.1: cannot draw here

  if (s.activeTool === 'pen') return penPointerDown(s, raw, mods, cfg, zoom);
  if (s.activeTool === 'anchor-point') {
    // Resolve FIRST, route second. Alt hands the converter the tool but not the close ladder
    // (`altHoldsAPenClick`), and this is the one place that decision can be made — by the time
    // `convertPointerDown` has run a `hitTest` there is no rung left to consult.
    if (altHoldsAPenClick(s, resolvePenClick(s, raw, mods, cfg, zoom))) {
      return penPointerDown(s, raw, mods, cfg, zoom);
    }
    return convertPointerDown(s, raw, mods, cfg, zoom);
  }
  return selectPointerDown(s, raw, mods, cfg, zoom);
}

function penPointerDown(state: PenState, raw: Vec, mods: PenMods, cfg: PenConfig, zoom: number): PenState {
  const action = resolvePenClick(state, raw, mods, cfg, zoom);
  let s = state;

  switch (action.kind) {
    case 'retract-outgoing': {
      // Spec A.6. `leftDirection` is NOT touched — the segment already drawn keeps its shape —
      // and this is NOT a delete, even though hovering any other anchor would show the minus.
      const path = s.doc.paths[action.path];
      const pt = path.points[action.point];
      const side = outgoingSide(s.activeEndpoint ?? 'last');
      const cur = side === 'right' ? pt.rightDirection : pt.leftDirection;
      if (isRetracted(cur, pt.anchor, cfg.retractEpsilon)) return settle(s, cfg, zoom, mods);   // I.26
      s = commit(s, cfg);
      const doc = cloneDoc(s.doc);
      const p2 = doc.paths[action.path].points[action.point];
      if (side === 'right') p2.rightDirection = [...p2.anchor]; else p2.leftDirection = [...p2.anchor];
      p2.pointType = 'corner';
      return settle({ ...s, doc }, cfg, zoom, mods);
    }

    case 'close': {
      s = commit(s, cfg);
      const doc = cloneDoc(s.doc);
      const path = doc.paths[action.path];
      path.closed = true;
      const target = path.points[action.point];
      // The handle the CLOSING segment arrives through retracts, so the close is a straight run
      // home unless the user drags (spec A.7).
      const facing: HandleSide = (s.activeEndpoint ?? 'last') === 'last' ? 'left' : 'right';
      if (facing === 'left') target.leftDirection = [...target.anchor]; else target.rightDirection = [...target.anchor];
      healRetractedSmooth(target, cfg.retractEpsilon);
      const drag = newDrag('close', P(target.anchor), s.doc, openingSnapshot(s), {
        path: action.path,
        point: action.point,
        fresh: false,
        rawOrigin: A(raw),
        // ALT WAS ALREADY DOWN. Spec A.7's Alt variant (I.30) is a gesture whose modifier is held
        // BEFORE the press — nobody presses the button and then reaches for Alt — so there is no
        // Alt keydown mid-drag to set `broken`, and without seeding it here the close pulls
        // MIRRORED handles and reshapes the first segment, which is precisely what the Alt
        // variant exists to prevent. `frozen` is unused by the close branch of `placementFrame`;
        // `broken` is the whole switch.
        broken: mods.alt,
      });
      return settle({ ...s, doc, drag }, cfg, zoom, mods);
    }

    case 'join': {
      s = commit(s, cfg);
      const j = joinPaths(s.doc, s.activePathIndex!, s.activeEndpoint ?? 'last', action.path, action.end);
      return settle({
        ...s,
        doc: j.doc,
        activePathIndex: j.activePathIndex,
        activeEndpoint: j.activeEndpoint,
        selection: { ...EMPTY_SELECTION, paths: [j.activePathIndex] },
      }, cfg, zoom, mods);
    }

    case 'continue': {
      s = commit(s, cfg);
      const path = s.doc.paths[action.path];
      const i = endIndex(path, action.end);
      const drag = newDrag('place', P(path.points[i].anchor), s.doc, openingSnapshot(s), { path: action.path, point: i, fresh: false, rawOrigin: A(raw) });
      return settle({
        ...s,
        activePathIndex: action.path,
        activeEndpoint: action.end,
        selection: { ...EMPTY_SELECTION, paths: [action.path] },
        drag,
      }, cfg, zoom, mods);
    }

    case 'delete-anchor': {
      s = commit(s, cfg);
      const paths = s.doc.paths.map(clonePath);
      paths[action.path] = removeAnchorRejoin(paths[action.path], action.point);
      const pruned = pruneEmpty({ paths }, s.selection, s.activePathIndex);
      return settle({
        ...s,
        doc: pruned.doc,
        selection: pruned.selection,
        activePathIndex: pruned.activePathIndex,
        activeEndpoint: pruned.activePathIndex === null ? null : s.activeEndpoint,
      }, cfg, zoom, mods);
    }

    case 'add-anchor': {
      s = commit(s, cfg);
      const paths = s.doc.paths.map(clonePath);
      paths[action.path] = insertAnchor(paths[action.path], action.segment, action.t, cfg);
      return settle({
        ...s,
        doc: { paths },
        selection: { ...EMPTY_SELECTION, anchors: [{ path: action.path, point: action.segment + 1 }] },
      }, cfg, zoom, mods);
    }

    case 'new-anchor': {
      s = commit(s, cfg);
      const end = s.activeEndpoint ?? 'last';
      const active = s.activePathIndex !== null ? s.doc.paths[s.activePathIndex] : null;

      // Shift+click projects the NEW anchor's position onto the nearest 45-multiple ray from
      // the PREVIOUS anchor (spec A.10). With no previous anchor there is nothing to be
      // relative to, so the first point of a path lands where the cursor is.
      let at = raw;
      let construction: { angleDeg: number } | null = null;
      if (mods.shift && active && active.points.length > 0) {
        at = constrainToAngle(P(active.points[endIndex(active, end)].anchor), raw, cfg.constrainAngle);
      } else if (s.snapEnabled && active && active.points.length > 0) {
        const cap = constructionCapture(P(active.points[endIndex(active, end)].anchor), raw, cfg, zoom);
        if (cap) {
          at = cap.point;
          construction = cap;
        }
      }
      const snap = applySnap(at, cfg, zoom, {
        doc: s.doc, zoom, phase: 'place', activePathIndex: s.activePathIndex, ref: null,
      }, s.snapEnabled);
      at = snap.point;

      const doc = cloneDoc(s.doc);
      let pathIndex: number;
      let pointIndex: number;
      let endpoint: PathEnd = end;
      if (!active) {
        doc.paths.push({ closed: false, points: [cornerPoint(at)] });
        pathIndex = doc.paths.length - 1;
        pointIndex = 0;
        endpoint = 'last';
      } else {
        pathIndex = s.activePathIndex!;
        const path = doc.paths[pathIndex];
        if (end === 'last') { path.points.push(cornerPoint(at)); pointIndex = path.points.length - 1; }
        else { path.points.unshift(cornerPoint(at)); pointIndex = 0; }
      }
      const drag = newDrag('place', at, s.doc, openingSnapshot(s), { path: pathIndex, point: pointIndex, fresh: true, rawOrigin: A(raw) });
      return settle({
        ...s,
        doc,
        activePathIndex: pathIndex,
        activeEndpoint: endpoint,
        selection: { ...EMPTY_SELECTION, paths: [pathIndex] },
        drag,
        // A construction capture IS a capture and gets the same ring: the user moved the anchor
        // off the cursor on purpose, and feedback for one kind of snap but not the other is how
        // a tool teaches people that it moves things for reasons they cannot see.
        snapped: snap.snapped ?? (construction ? { point: A(at), kind: `construction ${construction.angleDeg}deg` } : null),
        snapRefusal: snap.refusal,
      }, cfg, zoom, mods);
    }

    default: {
      const unhandled: never = action;
      throw new Error(`penPointerDown: unhandled ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * The Anchor Point tool (Shift+C) — and, because Alt swaps the pen into it, spec A.5's
 * after-placement table as well. ONE ENGINE, EXPOSED TWICE, exactly as spec D requires; a
 * second copy of these rules under the pen is how the two drift apart.
 */
function convertPointerDown(state: PenState, raw: Vec, mods: PenMods, cfg: PenConfig, zoom: number): PenState {
  const target = hitTest(state.doc, raw, cfg, zoom);
  if (!target || target.kind === 'segment') return settle(state, cfg, zoom, mods);
  const s = commit(state, cfg);
  if (target.kind === 'handle') {
    // Dragging one handle of a smooth point BREAKS THE PAIR: it moves alone, the opposite is
    // untouched, the point becomes a CORNER.
    const drag = newDrag('move-handle', raw, s.doc, openingSnapshot(s), {
      path: target.path, point: target.point, side: target.side, fresh: false,
    });
    return settle({ ...s, drag }, cfg, zoom, mods);
  }
  const drag = newDrag('convert-anchor', P(s.doc.paths[target.path].points[target.point].anchor), s.doc, openingSnapshot(s), {
    path: target.path, point: target.point, fresh: false, rawOrigin: A(raw),
  });
  return settle({ ...s, drag, selection: { ...EMPTY_SELECTION, anchors: [{ path: target.path, point: target.point }] } }, cfg, zoom, mods);
}

function toggleAnchor(sel: PenSelection, ref: AnchorRef, additive: boolean): PenSelection {
  const has = sel.anchors.some((a) => a.path === ref.path && a.point === ref.point);
  if (!additive) return { ...EMPTY_SELECTION, anchors: [ref], paths: [ref.path] };
  // Shift+click a SELECTED anchor REMOVES it — the toggle, not an add-only (spec C.1).
  const anchors = has
    ? sel.anchors.filter((a) => !(a.path === ref.path && a.point === ref.point))
    : [...sel.anchors, ref];
  return { ...cloneSelection(sel), anchors };
}

function selectPointerDown(state: PenState, raw: Vec, mods: PenMods, cfg: PenConfig, zoom: number): PenState {
  const target = hitTest(state.doc, raw, cfg, zoom);

  if (!target) {
    if (state.activeTool === 'select' || state.activeTool === 'direct-select') {
      // Clicking nothing with a selection tool deselects — and deselecting is what ends an
      // active path. Ctrl+click "to finish" is not a special command; it is literally this
      // (spec A.11, gotcha 15).
      const selection = mods.shift ? cloneSelection(state.selection) : { ...EMPTY_SELECTION };
      // NO SNAPSHOT, and no `commit` above it: a rubber-band selection changes no geometry, so an
      // undo step for it would be an empty step, and — until `PenDrag.snapshot` existed — an
      // Escape that rolled back to somebody else's.
      const drag = newDrag('marquee', raw, state.doc, null);
      return settle({
        ...state,
        selection,
        activePathIndex: mods.shift ? state.activePathIndex : null,
        activeEndpoint: mods.shift ? state.activeEndpoint : null,
        drag,
        marquee: { x0: raw.x, y0: raw.y, x1: raw.x, y1: raw.y },
      }, cfg, zoom, mods);
    }
    return settle(state, cfg, zoom, mods);
  }

  const s = commit(state, cfg);

  if (state.activeTool === 'select') {
    const paths = mods.shift && !s.selection.paths.includes(target.path)
      ? [...s.selection.paths, target.path]
      : [target.path];
    const drag = newDrag('move-path', raw, s.doc, openingSnapshot(s), { path: target.path, fresh: false });
    return settle({ ...s, selection: { ...EMPTY_SELECTION, paths }, drag }, cfg, zoom, mods);
  }

  switch (target.kind) {
    case 'anchor': {
      const selection = toggleAnchor(s.selection, { path: target.path, point: target.point }, mods.shift);
      const drag = newDrag('move-anchor', raw, s.doc, openingSnapshot(s), { path: target.path, point: target.point, fresh: false });
      return settle({ ...s, selection, drag }, cfg, zoom, mods);
    }
    case 'handle': {
      const drag = newDrag('move-handle', raw, s.doc, openingSnapshot(s), {
        path: target.path, point: target.point, side: target.side, fresh: false,
      });
      return settle({
        ...s,
        selection: { ...cloneSelection(s.selection), handles: [{ path: target.path, point: target.point, side: target.side }] },
        drag,
      }, cfg, zoom, mods);
    }
    case 'segment': {
      // Selecting a segment reveals its endpoints' handles WITHOUT making the anchors movable,
      // and dragging it reshapes it with no anchor selection required (spec C.1/C.2, I.75).
      const drag = newDrag('reshape-segment', raw, s.doc, openingSnapshot(s), {
        path: target.path, segment: target.segment, t: target.t, fresh: false,
      });
      return settle({
        ...s,
        selection: { ...EMPTY_SELECTION, segments: [{ path: target.path, segment: target.segment }], paths: [target.path] },
        drag,
      }, cfg, zoom, mods);
    }
    default: {
      const unhandled: never = target;
      throw new Error(`selectPointerDown: unhandled ${JSON.stringify(unhandled)}`);
    }
  }
}

// ── pointermove ────────────────────────────────────────────────────────────

function onPointerMove(state: PenState, input: PenInput, cfg: PenConfig): PenState {
  if (!input.point) return state;
  const raw = v(input.point.x, input.point.y);
  const mods = input.mods;
  const zoom = input.zoom;
  let s: PenState = { ...state, pointer: A(raw) };
  const d = s.drag;
  if (!d) return settle(s, cfg, zoom, mods);

  const past = d.past || dist(raw, P(d.rawOrigin)) * zoom > cfg.dragThresholdPx;
  let drag: PenDrag = { ...d, current: A(raw), past };

  // Spacebar with the mouse DOWN moves the anchor being placed — it is not a pan (spec B.3,
  // gotcha 11). Written incrementally, as Adobe writes it: the anchor and BOTH handles take
  // exactly the cursor's delta, which is why `rightDirection == cursor` survives the detour and
  // releasing space resumes handle dragging with no jump (I.63).
  if (drag.spaceFrom && (drag.kind === 'place' || drag.kind === 'close' || drag.kind === 'convert-anchor')) {
    const delta = sub(raw, P(drag.spaceFrom));
    const doc = cloneDoc(s.doc);
    const path = doc.paths[drag.path];
    if (path) path.points[drag.point] = translatePoint(path.points[drag.point], delta);
    drag = { ...drag, spaceFrom: A(raw), origin: A(add(P(drag.origin), delta)), frozen: drag.frozen ? A(add(P(drag.frozen), delta)) : null };
    return settle({ ...s, doc, drag }, cfg, zoom, mods);
  }

  s = { ...s, drag };

  switch (drag.kind) {
    case 'place':
    case 'close':
    case 'convert-anchor':
      return settle({ ...s, doc: placementFrame(s, cfg, raw, mods.shift) }, cfg, zoom, mods);

    case 'move-anchor': {
      // Every SELECTED anchor moves, from the snapshot rather than by accumulation, so a
      // hundred mousemoves cannot drift the geometry a hundred roundings away from the truth.
      let to = raw;
      if (mods.shift) to = constrainToAngle(P(drag.origin), raw, cfg.constrainAngle);
      const snapTo = applySnap(to, cfg, zoom, {
        doc: s.doc, zoom, phase: 'move-anchor', activePathIndex: s.activePathIndex,
        ref: { path: drag.path, point: drag.point },
      }, s.snapEnabled);
      const delta = sub(snapTo.point, P(drag.origin));
      const doc = cloneDoc(drag.docAtStart);
      const refs = s.selection.anchors.length
        ? s.selection.anchors
        : [{ path: drag.path, point: drag.point }];
      for (const r of refs) {
        const path = doc.paths[r.path];
        if (path) path.points[r.point] = translatePoint(path.points[r.point], delta);
      }
      return settle({ ...s, doc, snapped: snapTo.snapped, snapRefusal: snapTo.refusal }, cfg, zoom, mods);
    }

    case 'move-handle': {
      const doc = cloneDoc(drag.docAtStart);
      const path = doc.paths[drag.path];
      if (!path) return settle(s, cfg, zoom, mods);
      const anchor = P(path.points[drag.point].anchor);
      let to = mods.shift ? constrainToAngle(anchor, raw, cfg.constrainAngle) : raw;
      const snapTo = applySnap(to, cfg, zoom, {
        doc: s.doc, zoom, phase: 'move-handle', activePathIndex: s.activePathIndex,
        ref: { path: drag.path, point: drag.point },
      }, s.snapEnabled);
      to = snapTo.point;
      // Alt breaks the pair. So does the Anchor Point tool, unconditionally — spec D row 3.
      const breakPair = mods.alt || state.activeTool === 'anchor-point';
      path.points[drag.point] = dragHandle(path.points[drag.point], drag.side!, to, breakPair, cfg);
      return settle({ ...s, doc, snapped: snapTo.snapped, snapRefusal: snapTo.refusal }, cfg, zoom, mods);
    }

    case 'reshape-segment': {
      const doc = cloneDoc(drag.docAtStart);
      const path = doc.paths[drag.path];
      if (!path) return settle(s, cfg, zoom, mods);
      const { from, prim } = segmentCubic(drag.docAtStart.paths[drag.path], drag.segment!);
      const grabbed = cubicAt(from, prim, drag.t!);
      const to = mods.shift ? constrainToAngle(P(drag.origin), raw, cfg.constrainAngle) : raw;
      doc.paths[drag.path] = reshapeSegment(path, drag.segment!, drag.t!, sub(to, grabbed), cfg);
      return settle({ ...s, doc }, cfg, zoom, mods);
    }

    case 'move-path': {
      const delta = sub(mods.shift ? constrainToAngle(P(drag.origin), raw, cfg.constrainAngle) : raw, P(drag.origin));
      const doc = cloneDoc(drag.docAtStart);
      for (const pi of s.selection.paths) {
        const path = doc.paths[pi];
        if (path) path.points = path.points.map((pt) => translatePoint(pt, delta));
      }
      return settle({ ...s, doc }, cfg, zoom, mods);
    }

    case 'marquee':
      return settle({
        ...s,
        marquee: { x0: Math.min(drag.origin[0], raw.x), y0: Math.min(drag.origin[1], raw.y), x1: Math.max(drag.origin[0], raw.x), y1: Math.max(drag.origin[1], raw.y) },
      }, cfg, zoom, mods);

    default: {
      const unhandled: never = drag.kind;
      throw new Error(`onPointerMove: unhandled drag ${JSON.stringify(unhandled)}`);
    }
  }
}

// ── pointerup ──────────────────────────────────────────────────────────────

/**
 * Finish the gesture in the hand as if the button had come up where it stands.
 *
 * Extracted from `onPointerUp` because a pointerup is not the only way a drag ends. Spec A.11:
 * switching tools COMMITS the in-progress drag — and `runCommand`'s tool cases used to call
 * `endPath` and leave `state.drag` set, so the next `onPointerMove` kept running `placementFrame`
 * for the OLD gesture under the NEW tool. The handle the user was pulling then flew to wherever
 * they moved the mouse next, with the pen no longer active and nothing on screen to explain it.
 *
 * Escape is the exception and takes `rollback` instead — it aborts rather than commits, which is
 * spec A.11's table and the one place the two differ.
 *
 * Returns UNSETTLED state: every caller settles once, with its own final mods.
 */
function concludeDrag(state: PenState, at: Vec, mods: PenMods, cfg: PenConfig, zoom: number): PenState {
  const d = state.drag;
  if (!d) return state;
  const raw = at;
  const s: PenState = { ...state, pointer: A(raw) };

  // I.9: a drag that RETURNS TO ITS ORIGIN is a click. Measured on the final position, not on
  // whether the pointer ever left the dead zone, so the tool never stores a zero-length-but-
  // nonzero handle for a gesture the user visibly undid.
  const moved = dist(raw, P(d.rawOrigin)) * zoom > cfg.dragThresholdPx;

  switch (d.kind) {
    case 'place': {
      const doc = cloneDoc(s.doc);
      const path = doc.paths[d.path];
      if (path && d.fresh && !moved) {
        // SHIFT IS DOUBLY LOADED and release order matters (spec A.9, gotcha 8). Adobe's own
        // instruction is to release Shift BEFORE the mouse button so the click does not also
        // constrain the path — which is only true if the position constraint is decided at
        // RELEASE rather than latched at pointerdown. So it is decided here.
        //
        // Only for a click. Once the pointer has left the dead zone the anchor is pinned and
        // Shift is constraining the HANDLE instead; moving the anchor out from under a handle
        // the user is aiming would be a different tool.
        let at = P(d.rawOrigin);
        const prev = d.point === 0
          ? (path.points.length > 1 ? path.points[1] : null)
          : path.points[d.point - 1];
        let construction: { angleDeg: number } | null = null;
        if (mods.shift && prev) at = constrainToAngle(P(prev.anchor), P(d.rawOrigin), cfg.constrainAngle);
        else if (s.snapEnabled && prev) {
          const cap = constructionCapture(P(prev.anchor), P(d.rawOrigin), cfg, zoom);
          if (cap) {
            at = cap.point;
            construction = cap;
          }
        }
        const snap = applySnap(at, cfg, zoom, {
          doc: s.doc, zoom, phase: 'place', activePathIndex: s.activePathIndex,
          ref: { path: d.path, point: d.point },
        }, s.snapEnabled);
        path.points[d.point] = cornerPoint(snap.point);
        return {
          ...s,
          doc,
          drag: null,
          snapped: snap.snapped ?? (construction ? { point: A(snap.point), kind: `construction ${construction.angleDeg}deg` } : null),
          snapRefusal: snap.refusal,
        };
      }
      return { ...s, doc, drag: null };
    }
    case 'convert-anchor': {
      const doc = cloneDoc(s.doc);
      const path = doc.paths[d.path];
      if (path && !moved) {
        // A CLICK with the Anchor Point tool retracts BOTH handles and gives a corner (spec D,
        // A.5). There is no gesture that retracts only the near handle, and adding one — it
        // seems nicer — would be wrong (spec A.5, "asymmetry to preserve").
        const pt = path.points[d.point];
        path.points[d.point] = cornerPoint(P(pt.anchor));
      }
      return { ...s, doc, drag: null };
    }
    case 'close': {
      const doc = cloneDoc(s.doc);
      const path = doc.paths[d.path];
      const before = d.docAtStart.paths[d.path]?.points[d.point];
      const pt = path?.points[d.point];
      if (pt && before && !moved) {
        // THE SAME DEAD ZONE `case 'place'` HAS, AND THIS CASE DID NOT (I.9). A three-pixel hand
        // tremor on the close click is entirely ordinary, and it is enough: the pointer leaves the
        // two-pixel threshold, `placementFrame` runs once, and when the hand comes back to where
        // it started the mirror writes `rightDirection = C = Q` and `leftDirection = 2Q - C = Q`
        // — both handles retracted — while stamping `pointType: 'smooth'` on the way past. That
        // point is ILLEGAL (spec C.3: collinearity is undefined for a retracted side) and it does
        // not stay in memory: `toVPath` emits `startType:'s'` for a handle-less anchor and
        // `fromVPath` reads it straight back as smooth, because the stored flag outranks
        // inference. So a click the user saw as a click writes a broken point into the artifact.
        //
        // Restored RIGIDLY off the drag's opening snapshot rather than by zeroing, because the
        // spacebar detour (B.3) may legitimately have moved the anchor mid-gesture and re-seating
        // the handles at their old absolute coordinates would tear the curve.
        const dx = pt.anchor[0] - before.anchor[0];
        const dy = pt.anchor[1] - before.anchor[1];
        pt.leftDirection = [before.leftDirection[0] + dx, before.leftDirection[1] + dy];
        pt.rightDirection = [before.rightDirection[0] + dx, before.rightDirection[1] + dy];
        pt.pointType = before.pointType;
        // …and then the click-close's own edit, which is all a click was ever supposed to do:
        // the handle the CLOSING segment arrives through retracts, the first segment is untouched.
        const facing: HandleSide = (s.activeEndpoint ?? 'last') === 'last' ? 'left' : 'right';
        if (facing === 'left') pt.leftDirection = [...pt.anchor]; else pt.rightDirection = [...pt.anchor];
        healRetractedSmooth(pt, cfg.retractEpsilon);
      }
      // The path is committed and stays selected; the pen returns to start-new-path. A closed
      // path cannot be resumed (gotcha 22).
      return {
        ...s,
        doc,
        drag: null,
        activePathIndex: null,
        activeEndpoint: null,
        selection: { ...EMPTY_SELECTION, paths: [d.path] },
      };
    }
    case 'marquee': {
      const m = s.marquee;
      let selection = s.selection;
      if (m) {
        // Marquee tests ANCHOR POSITIONS ONLY — not handles, not segment bounds (I.69). A path
        // whose curve bulges through the rubber band but whose anchors are outside is not
        // selected, which is what makes marqueeing predictable.
        const hits: AnchorRef[] = [];
        const paths = new Set<number>();
        for (let pi = 0; pi < s.doc.paths.length; pi++) {
          for (let i = 0; i < s.doc.paths[pi].points.length; i++) {
            const a = s.doc.paths[pi].points[i].anchor;
            if (a[0] >= m.x0 && a[0] <= m.x1 && a[1] >= m.y0 && a[1] <= m.y1) { hits.push({ path: pi, point: i }); paths.add(pi); }
          }
        }
        if (s.activeTool === 'select') {
          const merged = mods.shift ? new Set([...s.selection.paths, ...paths]) : paths;
          selection = { ...EMPTY_SELECTION, paths: [...merged] };
        } else {
          const base = mods.shift ? s.selection.anchors : [];
          const key = (a: AnchorRef): string => `${a.path}:${a.point}`;
          const seen = new Set(base.map(key));
          const anchors = [...base];
          for (const h of hits) if (!seen.has(key(h))) { seen.add(key(h)); anchors.push(h); }
          selection = { ...EMPTY_SELECTION, anchors, paths: [...new Set(anchors.map((a) => a.path))] };
        }
      }
      return { ...s, drag: null, marquee: null, selection };
    }
    default:
      return { ...s, drag: null };
  }
}

function onPointerUp(state: PenState, input: PenInput, cfg: PenConfig): PenState {
  const d = state.drag;
  const mods = input.mods;
  const zoom = input.zoom;
  if (!d) return settle(state, cfg, zoom, mods);
  // A pointerup that carries no position — pointercancel, a synthetic event — ends the gesture
  // where the last move left it rather than at the origin, which would read as a click.
  const raw = input.point ? v(input.point.x, input.point.y) : P(d.current);
  return settle(concludeDrag(state, raw, mods, cfg, zoom), cfg, zoom, mods);
}

// ── Keyboard ───────────────────────────────────────────────────────────────

/**
 * Every anchor the keyboard commands act on.
 *
 * ANCHOR SELECTION WINS OVER PATH SELECTION, and the order matters more than it looks. A path
 * appears in `selection.paths` whenever any of its anchors is selected — that is what scopes
 * auto add/delete (spec A.9) — so folding both sets together would make a Direct-Selection
 * marquee round two anchors nudge the whole path, which is precisely the difference between
 * the black arrow and the white one. Whole-path anchors are only in play when nothing finer
 * has been said.
 */
function selectedAnchorRefs(s: PenState): AnchorRef[] {
  if (s.selection.anchors.length > 0) {
    const key = (a: AnchorRef): string => `${a.path}:${a.point}`;
    const seen = new Set<string>();
    const out: AnchorRef[] = [];
    for (const a of s.selection.anchors) if (!seen.has(key(a))) { seen.add(key(a)); out.push(a); }
    return out;
  }
  const out: AnchorRef[] = [];
  for (const pi of s.selection.paths) {
    const path = s.doc.paths[pi];
    if (!path) continue;
    for (let i = 0; i < path.points.length; i++) out.push({ path: pi, point: i });
  }
  return out;
}

/** End the active path without closing it and without deleting anything. Spec A.11. */
const endPath = (s: PenState): PenState => ({ ...s, activePathIndex: null, activeEndpoint: null });

/**
 * The termination routes' shared preamble. Spec A.11: ending a drawing session COMMITS whatever
 * drag is in the hand — it does not abandon it and, above all, does not leave it running.
 *
 * Only Escape differs, and it differs on purpose: it aborts. Everything else — a tool key, Enter,
 * Ctrl+Shift+A — goes through here first, so `state.drag` is null by the time the tool changes and
 * `onPointerMove` has nothing left to keep dragging.
 */
const commitDrag = (s: PenState, mods: PenMods, cfg: PenConfig, zoom: number): PenState =>
  s.drag ? concludeDrag(s, P(s.drag.current), mods, cfg, zoom) : s;

function runCommand(state: PenState, cmd: PenCommand, mods: PenMods, cfg: PenConfig, zoom: number): PenState {
  let s = state;
  switch (cmd) {
    // Switching tools ENDS the drawing session — the path stays open and stays selected, and
    // nothing about its geometry changes (spec A.11, I.54/I.55). Deliberately NOT the path the
    // momentary Ctrl and Alt switches take: those keep the active path alive, which is the
    // entire point of a momentary modifier (I.57).
    case 'tool-pen':
    case 'tool-anchor-point':
    case 'tool-select':
    case 'tool-direct-select': {
      const tool: ToolId =
        cmd === 'tool-pen' ? 'pen'
          : cmd === 'tool-anchor-point' ? 'anchor-point'
            : cmd === 'tool-select' ? 'select' : 'direct-select';
      s = commitDrag(s, mods, cfg, zoom);
      const keep = s.activePathIndex;
      const selection = keep === null ? cloneSelection(s.selection) : { ...EMPTY_SELECTION, paths: [keep] };
      // Spec B.1: the Ctrl momentary switch gives whichever selection tool was used LAST, so
      // the slot is updated here and nowhere else.
      const lastSelectionTool = tool === 'select' || tool === 'direct-select' ? tool : s.lastSelectionTool;
      return settle({ ...endPath(s), activeTool: tool, lastSelectionTool, selection }, cfg, zoom, mods);
    }

    case 'add-anchor-at-selection': {
      if (s.selection.segments.length === 0) return s;
      s = commit(s, cfg);
      const paths = s.doc.paths.map(clonePath);
      // Descending, so inserting into one segment cannot renumber a segment still to be split.
      const targets = [...s.selection.segments].sort((a, b) => b.path - a.path || b.segment - a.segment);
      for (const g of targets) if (paths[g.path]) paths[g.path] = insertAnchor(paths[g.path], g.segment, 0.5, cfg);
      return settle({ ...s, doc: { paths }, selection: { ...EMPTY_SELECTION, paths: [...new Set(targets.map((t) => t.path))] } }, cfg, zoom, mods);
    }

    case 'delete-anchor-at-selection': {
      const refs = s.selection.anchors;
      if (refs.length === 0) return s;
      s = commit(s, cfg);
      const paths = s.doc.paths.map(clonePath);
      for (const r of [...refs].sort((a, b) => b.path - a.path || b.point - a.point)) {
        if (paths[r.path]) paths[r.path] = removeAnchorRejoin(paths[r.path], r.point);
      }
      const pruned = pruneEmpty({ paths }, EMPTY_SELECTION, s.activePathIndex);
      return settle({ ...s, doc: pruned.doc, selection: pruned.selection, activePathIndex: pruned.activePathIndex }, cfg, zoom, mods);
    }

    case 'nudge-left': case 'nudge-right': case 'nudge-up': case 'nudge-down':
    case 'nudge-left-big': case 'nudge-right-big': case 'nudge-up-big': case 'nudge-down-big': {
      const refs = selectedAnchorRefs(s);
      if (refs.length === 0) return s;
      const big = cmd.endsWith('-big');
      const step = cfg.keyboardIncrement * (big ? cfg.shiftMultiplier : 1);
      const axis = cmd.startsWith('nudge-left') ? v(-1, 0)
        : cmd.startsWith('nudge-right') ? v(1, 0)
        : cmd.startsWith('nudge-up') ? v(0, -1)
        : v(0, 1);
      // The nudge axes rotate with the Constrain Angle. [U] — Illustrator's behaviour here is
      // reported but not documented by Adobe; with the default angle of 0 this is the identity,
      // so the unverified part only bites a user who has changed the preference.
      const phi = cfg.constrainAngle * DEG;
      const d = v(
        (axis.x * Math.cos(phi) - axis.y * Math.sin(phi)) * step,
        (axis.x * Math.sin(phi) + axis.y * Math.cos(phi)) * step,
      );
      s = commit(s, cfg);
      const doc = cloneDoc(s.doc);
      for (const r of refs) {
        const path = doc.paths[r.path];
        if (path) path.points[r.point] = translatePoint(path.points[r.point], d);
      }
      // Illustrator quirk I.19 — an arrow key breaks the Pen's connection to the active path.
      // LucasFonts calls it a probable bug, the spec says decide deliberately, and OUR DEFAULT
      // IS TO KEEP DRAWING. The flag exists so the choice is visible rather than inherited.
      const broken = cfg.arrowKeyBreaksActivePath ? endPath({ ...s, doc }) : { ...s, doc };
      return settle(broken, cfg, zoom, mods);
    }

    case 'delete': {
      // I.83: with the fragments of a previous Delete object-selected and no anchors selected,
      // a second Delete removes the remaining object(s).
      if (s.selection.anchors.length === 0) {
        if (s.selection.paths.length === 0) return s;
        s = commit(s, cfg);
        const kill = new Set(s.selection.paths);
        const doc = { paths: s.doc.paths.filter((_, i) => !kill.has(i)).map(clonePath) };
        return settle({ ...endPath(s), doc, selection: { ...EMPTY_SELECTION } }, cfg, zoom, mods);
      }
      s = commit(s, cfg);
      const res = deleteSelectedAnchors(s.doc, s.selection.anchors);
      const pruned = pruneEmpty(res.doc, { ...EMPTY_SELECTION, paths: res.paths }, null);
      return settle({ ...endPath(s), doc: pruned.doc, selection: pruned.selection }, cfg, zoom, mods);
    }

    case 'escape': {
      // #1 aborts the anchor being dragged, or ends the active path; #2 clears the selection.
      // Adobe distinguishes Escape from the other termination routes: it does NOT leave the
      // path selected (spec A.11's table), which is why ending also deselects here.
      if (s.drag) return settle({ ...rollback(s), drag: null, marquee: null }, cfg, zoom, mods);
      if (s.activePathIndex !== null) {
        return settle({ ...endPath(s), selection: { ...EMPTY_SELECTION } }, cfg, zoom, mods);
      }
      return settle({ ...s, selection: { ...EMPTY_SELECTION } }, cfg, zoom, mods);
    }

    case 'enter': {
      // Ends the path, leaves it OPEN, leaves it SELECTED. [U] — whether Enter keeps the
      // selection where Escape drops it is the spec's highest-value manual check against real
      // Illustrator. One line to correct if it turns out otherwise.
      s = commitDrag(s, mods, cfg, zoom);
      if (s.activePathIndex === null) return settle(s, cfg, zoom, mods);
      const i = s.activePathIndex;
      return settle({ ...endPath(s), selection: { ...EMPTY_SELECTION, paths: [i] } }, cfg, zoom, mods);
    }

    case 'undo': {
      if (s.undo.length === 0) return s;
      const snap = s.undo[s.undo.length - 1];
      const redo = [...s.redo, snapshotOf(s)];
      // The active-path state travels WITH the geometry, so undoing an anchor mid-path leaves
      // the pen attached to the previous anchor and drawing can continue (I.124).
      return settle({
        ...s, ...snap,
        doc: cloneDoc(snap.doc),
        selection: cloneSelection(snap.selection),
        undo: s.undo.slice(0, -1),
        redo,
        drag: null,
      }, cfg, zoom, mods);
    }
    case 'redo': {
      if (s.redo.length === 0) return s;
      const snap = s.redo[s.redo.length - 1];
      return settle({
        ...s, ...snap,
        doc: cloneDoc(snap.doc),
        selection: cloneSelection(snap.selection),
        undo: [...s.undo, snapshotOf(s)],
        redo: s.redo.slice(0, -1),
        drag: null,
      }, cfg, zoom, mods);
    }

    case 'select-all': {
      const anchors: AnchorRef[] = [];
      for (let pi = 0; pi < s.doc.paths.length; pi++) {
        for (let i = 0; i < s.doc.paths[pi].points.length; i++) anchors.push({ path: pi, point: i });
      }
      return settle({ ...s, selection: { ...EMPTY_SELECTION, anchors, paths: s.doc.paths.map((_, i) => i) } }, cfg, zoom, mods);
    }

    case 'deselect-all':
      // Ends the path and deselects WITHOUT leaving the Pen tool (I.53).
      s = commitDrag(s, mods, cfg, zoom);
      return settle({ ...endPath(s), selection: { ...EMPTY_SELECTION } }, cfg, zoom, mods);

    case 'join': {
      // Ctrl+J, smart and dialog-free (spec E): two selected endpoints of ONE open path close
      // it; two endpoints of DIFFERENT open paths get a straight segment between them.
      const ends = s.selection.anchors.filter((a) => {
        const p = s.doc.paths[a.path];
        return p && !p.closed && p.points.length >= 2 && (a.point === 0 || a.point === p.points.length - 1);
      });
      if (ends.length !== 2) return s;
      const [x, y] = ends;
      s = commit(s, cfg);
      if (x.path === y.path) {
        const doc = cloneDoc(s.doc);
        const path = doc.paths[x.path];
        path.closed = true;
        // A straight closing segment: retract the two handles that would otherwise shape it.
        // Both points are then healed, because retracting a side of a SMOOTH endpoint leaves a
        // flag collinearity cannot be measured for (spec C.3) — the same trap the close click had.
        const last = path.points[path.points.length - 1];
        last.rightDirection = [...last.anchor];
        path.points[0].leftDirection = [...path.points[0].anchor];
        healRetractedSmooth(last, cfg.retractEpsilon);
        healRetractedSmooth(path.points[0], cfg.retractEpsilon);
        return settle({ ...s, doc, selection: { ...EMPTY_SELECTION, paths: [x.path] } }, cfg, zoom, mods);
      }
      const xEnd: PathEnd = x.point === 0 ? 'first' : 'last';
      const yEnd: PathEnd = y.point === 0 ? 'first' : 'last';
      const j = joinPaths(s.doc, x.path, xEnd, y.path, yEnd);
      const doc = cloneDoc(j.doc);
      const merged = doc.paths[j.activePathIndex];
      // The seam sits where the first path's clicked end used to be. Retract both facing
      // handles so the new segment is genuinely straight, per "joins with a straight segment".
      const seam = xEnd === 'last' ? s.doc.paths[x.path].points.length - 1 : merged.points.length - s.doc.paths[x.path].points.length;
      if (merged.points[seam] && merged.points[seam + 1]) {
        merged.points[seam].rightDirection = [...merged.points[seam].anchor];
        merged.points[seam + 1].leftDirection = [...merged.points[seam + 1].anchor];
        healRetractedSmooth(merged.points[seam], cfg.retractEpsilon);
        healRetractedSmooth(merged.points[seam + 1], cfg.retractEpsilon);
      }
      return settle({ ...s, doc, selection: { ...EMPTY_SELECTION, paths: [j.activePathIndex] } }, cfg, zoom, mods);
    }

    // ── View state. No geometry, no undo step, no effect on the artifact ────
    //
    // Both toggle a way of LOOKING at what is already there, so committing an undo snapshot for
    // them would put a step in the stack that Ctrl+Z cannot visibly perform — the geometry either
    // side of it is identical — and I.123's "one anchor placement is exactly ONE undo step" would
    // start depending on how often the user glanced at their artwork.
    case 'toggle-outline':
      return settle({ ...s, outline: !s.outline }, cfg, zoom, mods);

    case 'toggle-edges':
      return settle({ ...s, hideEdges: !s.hideEdges }, cfg, zoom, mods);

    // Smart Guides (I.102). Also no geometry and no undo step — but it changes what the NEXT
    // gesture does, so the stale `snapped` ring and refusal are cleared with it. Leaving them up
    // would have the surface reporting a capture from a snapper that is now switched off.
    case 'toggle-snap':
      return settle({ ...s, snapEnabled: !s.snapEnabled, snapped: null, snapRefusal: null }, cfg, zoom, mods);

    default: {
      const unhandled: never = cmd;
      throw new Error(`runCommand: unhandled ${JSON.stringify(unhandled)}`);
    }
  }
}

function onKeyDown(state: PenState, input: PenInput, cfg: PenConfig): PenState {
  const key = input.key ?? '';
  const mods = input.mods;
  const zoom = input.zoom;
  let s = state;

  // Ctrl -> the LAST-USED selection tool, momentary. It does NOT deselect and does NOT
  // terminate the active path — that is the whole point of the modifier (spec B.1, I.57).
  if (key === 'Control' || key === 'Ctrl') {
    if (s.activeTool === 'pen' && s.toolBeforeModifier === null) {
      s = { ...s, toolBeforeModifier: 'pen', activeTool: s.lastSelectionTool };
    }
    return settle(s, cfg, zoom, mods);
  }

  if (key === 'Alt' || key === 'Option') {
    const d = s.drag;
    if (d && (d.kind === 'place' || d.kind === 'close') && !d.broken) {
      // Mid-placement, Alt FREEZES the incoming handle where it stands and lets the outgoing one
      // go its own way; the point becomes a CORNER and stays one after release (I.16-18, I.22).
      const path = s.doc.paths[d.path];
      const pt = path?.points[d.point];
      if (pt) {
        const incSide: HandleSide = d.kind === 'close'
          ? ((s.activeEndpoint ?? 'last') === 'last' ? 'left' : 'right')
          : incomingSide(s.activeEndpoint ?? 'last');
        const frozen = incSide === 'left' ? pt.leftDirection : pt.rightDirection;
        s = { ...s, drag: { ...d, broken: true, frozen: [frozen[0], frozen[1]] } };
        s = { ...s, doc: placementFrame(s, cfg, P(d.current), mods.shift) };
      }
      return settle(s, cfg, zoom, mods);
    }
    // Alt with the Pen and no drag = the Anchor Point tool, for the duration (spec B.2, I.61).
    if (s.activeTool === 'pen' && s.toolBeforeModifier === null) {
      s = { ...s, toolBeforeModifier: 'pen', activeTool: 'anchor-point' };
    }
    return settle(s, cfg, zoom, mods);
  }

  if (isSpaceKey(key)) {
    const d = s.drag;
    if (d && (d.kind === 'place' || d.kind === 'close' || d.kind === 'convert-anchor')) {
      return settle({ ...s, drag: { ...d, spaceFrom: [...d.current] } }, cfg, zoom, mods);
    }
    // Mouse UP: this is the temporary Hand tool. The ENGINE DOES NOT PAN — it says the UI
    // should, and the UI owns the viewport. Same key, two meanings, decided by button state.
    return settle({ ...s, intent: { kind: 'pan' } }, cfg, zoom, mods);
  }

  const binding = lookupBinding(key, mods);
  if (!binding) return settle(s, cfg, zoom, mods);
  return runCommand(s, binding.command, mods, cfg, zoom);
}

function onKeyUp(state: PenState, input: PenInput, cfg: PenConfig): PenState {
  const key = input.key ?? '';
  const mods = input.mods;
  const zoom = input.zoom;
  let s = state;

  if (isSpaceKey(key)) {
    return settle(s.drag ? { ...s, drag: { ...s.drag, spaceFrom: null } } : s, cfg, zoom, mods);
  }

  if (key === 'Control' || key === 'Ctrl' || key === 'Alt' || key === 'Option') {
    // Restore only once BOTH are up: holding Ctrl and Alt together and releasing one must not
    // drop the pen back in while the other is still doing its job. `mods` describes the state
    // AFTER the event, which is the contract `PenInput` documents.
    if (!mods.alt && !mods.ctrl && s.toolBeforeModifier !== null) {
      s = { ...s, activeTool: s.toolBeforeModifier, toolBeforeModifier: null };
    }
    // I.58/I.59: the pen comes back with the same active path and endpoint, and if an anchor
    // moved while the modifier was held the rubber band recomputes from the new geometry —
    // which `settle` does unconditionally, so there is nothing to remember to call.
    return settle(s, cfg, zoom, mods);
  }
  return settle(s, cfg, zoom, mods);
}

// ── The reducer ────────────────────────────────────────────────────────────

/**
 * One step of the pen. Pure: `state` is never mutated, and the result is a plain value a test
 * can deep-compare and undo can snapshot by clone.
 *
 * `intent` is cleared on every input, so an intent in the returned state belongs to THIS input
 * and a UI that reads it once per reduce can never act on a stale pan request.
 */
export function reduce(state: PenState, input: PenInput, cfg: PenConfig = DEFAULT_PEN_CONFIG): PenState {
  const base: PenState = { ...state, capsLock: input.mods.capsLock, intent: null };
  switch (input.type) {
    case 'pointerdown': return onPointerDown(base, input, cfg);
    case 'pointermove': return onPointerMove(base, input, cfg);
    case 'pointerup': return onPointerUp(base, input, cfg);
    case 'keydown': return onKeyDown(base, input, cfg);
    case 'keyup': return onKeyUp(base, input, cfg);
    case 'blur': {
      // Losing focus must not leave half a gesture committed. Abort the drag the way Escape
      // does, and put back whatever tool a momentary modifier borrowed — a keyup that never
      // arrives because the window went away is the classic way an editor gets stuck holding
      // the wrong tool.
      let s = base.drag ? { ...rollback(base), drag: null } : base;
      if (s.toolBeforeModifier !== null) s = { ...s, activeTool: s.toolBeforeModifier, toolBeforeModifier: null };
      return { ...s, marquee: null, hover: null, rubberBand: null, snapped: null, snapRefusal: null };
    }
    default: {
      const unhandled: never = input.type;
      throw new Error(`reduce: unknown input ${JSON.stringify(unhandled)}`);
    }
  }
}
