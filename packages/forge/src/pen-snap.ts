// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// forge/pen-snap.ts — the pen's snap provider: where the PRINTED edge is, or an honest refusal.
//
// `pen-engine.ts` accepts an injected `SnapFn` and polices it; nothing was ever injected, so
// `DEFAULT_PEN_CONFIG.snap` shipped `null` and the pen drew wherever the hand went. This is the
// provider. It answers one question — "is there a printed edge under this point, and where
// exactly" — from the card's own scan, and it answers "I cannot tell" out loud when the scan
// holds more than one answer.
//
// WHAT IT MEASURES, AND ON WHAT. The evidence is `edge-trace`'s Di Zenzo colour structure
// tensor, non-maximum-suppressed and hysteresis-linked (`buildEdgeMap`), read on the card scan
// resampled to CANONICAL MASK SPACE — the same 504x704 grid the pen's document coordinates live
// in, so no point in this file ever converts between two spaces. A luminance Sobel is not used
// and the reason is `edge-trace`'s: the boundary that matters most on a modern card is a green
// printed field against a silver border, whose LUMINANCE is nearly equal and whose CHROMA is
// not. The tensor is built ONCE per scan by `preparePenSnap` and the query function closes over
// it, because a structure tensor per `pointermove` is a tenth of a second per event.
//
// THE TARGETS, in the spec's priority order (G.3, items 110-113):
//
//   1. an existing ANCHOR of the document being drawn   — geometry a human already placed
//   2. a printed-edge INTERSECTION, i.e. a corner       — two edges crossing inside the window
//   3. the nearest point on a detected printed EDGE     — the fallback, and the common case
//
// A corner outranks an edge because the gesture this exists for is tracing a rounded-rect foil
// window: four edges and four corners, and the corner is the point a human aims at and a
// projection-onto-the-nearest-line would slide away from along the edge it landed on.
//
// SNAPPING IS A DISPLACEMENT, NOT AN ANNOTATION (item 110). The returned point IS the anchor's
// position; nothing downstream re-reads the raw pointer. `kind` says what was caught so the
// surface can name it, and the engine — not this module — decides whether the displacement is
// allowed at all.
//
// WHEN IT REFUSES, AND WHY THAT IS THE POINT:
//
//   - Two comparable, PARALLEL ridges in the window (within `ambiguityRatio` of each other and
//     at least `ambiguityMinSepPx` apart) mean the scan says "you are near some edges", not
//     "you meant THAT edge". Moving the point then is a guess wearing a measurement's clothes,
//     so the proposal is withheld and the reason names the offsets. This is `line-snap`'s own
//     rule (`ambiguityRatio` 0.85, and its test asserts an ambiguous band may nudge a line and
//     never relocate it) applied one gesture earlier, at the anchor rather than at the run.
//   - A blank card produces no ridges above `minRidge`, so it produces no proposal. Nothing here
//     manufactures an edge out of paper texture: the linked map must agree that the pixel is
//     part of a connected edge, which is what keeps a lone speck from becoming geometry.
//   - Everything that survives all of that is STILL bounded by the engine's `maxSnapMovePx`, in
//     screen pixels, which this module cannot see and must not try to. Two layers, independent:
//     this one refuses on the evidence, that one refuses on the distance.
//
// The search radius is deliberately a little WIDER than the engine's 2px budget. A printed edge
// 3px from the click is not something to snap to — it is something to say out loud, because the
// engine's refusal ("it would move the point 3.1 screen px") is the honest reading of a hand
// that missed, and silence there is indistinguishable from a scan with no edges in it.
//
// MEASURED, NOT CLAIMED — `node --conditions source tools/measure-pen-snap.mts`, which drives
// synthetic cards whose edge coordinates are known exactly, because on a real scan the "true"
// edge position is itself an estimate and a residual against an estimate compares two opinions.
// What it reports today, and what it does NOT support:
//
//   EDGES, n=360 queries per condition, each 0.4-1.6px off a known edge:
//     crisp step            100% answered, residual mean 0.047px, p95 0.097, max 0.098
//     blur 1/2/3/4px        100% answered, residual unchanged to three decimals until 4px
//     crisp + noise +/-6    100% answered, residual mean 0.299px
//     blur 2px + noise 12    99% answered (1% refused), mean 0.474px, p95 1.265, max 1.513
//   CORNERS, n=64 queries per condition, each 0.7-1.3px diagonally off a known corner:
//     crisp step             52 answered `corner` (mean 0.435px, max 1.132), 8 answered `edge`,
//                            4 answered nothing
//     blur 2px               16 answered `corner` (1.138px), 24 `edge`, 24 nothing
//     blur 3px                0 answered `corner` — every one fell back to the edge it could see
//   A CARD WITH NO EDGES, n=360: zero proposals on flat grey, and zero on flat grey with +/-14
//   noise. It invents nothing out of paper.
//
// So: EDGE snapping is the robust half and survives a badly softened scan; CORNER detection is
// the fragile half and quietly disappears as the corner rounds off, degrading to an edge snap
// rather than to a wrong corner. The blur sweep is a stand-in for scan quality and nothing more
// — it says nothing about halftone rosettes, JPEG ringing, or foil blowing out under a flash,
// and no claim here should be read as covering those. It is a tracing aid for scans with printed
// edges in them, and it says nothing at all about scans without.
//
// Pure: pixels in, a point or a refusal out. No DOM, no `node:` builtin — it is reached from the
// browser through `@foilkit/forge/geometry`, and `tools/check-geometry-browser-safe.mjs` walks
// this file's imports on every push.

import type { RgbaImage } from './png.ts';
import {
  DEFAULT_EDGE_TRACE_PARAMS,
  buildEdgeMap,
  edgeAlong,
  type EdgeMap,
  type EdgeTraceParams,
} from './edge-trace.ts';
import { intersectLines, robustFit, type Line, type Vec } from './line-snap.ts';
import type { SnapContext, SnapFn, SnapProposal, SnapRefusal } from './pen-engine.ts';

// ── Params ─────────────────────────────────────────────────────────────────

export interface PenSnapParams {
  /**
   * How far from the query point to look for a printed edge, DOCUMENT px.
   *
   * Wider than the engine's screen-px budget on purpose — see the header. Widen it much further
   * and the window starts holding edges the user was never near, which is how a snap becomes a
   * relocation with a confident explanation attached.
   */
  searchRadiusPx: number;
  /** How far an existing anchor may be from the query point and still capture it, document px. */
  anchorSnapPx: number;
  /** Ridge magnitude a pixel needs before it counts as evidence at all. */
  minRidge: number;
  /** Two ridge normals within this of each other belong to the same edge, degrees. */
  orientationTolDeg: number;
  /** Two edges must cross at least this steeply to be read as a corner, degrees. */
  cornerMinAngleDeg: number;
  /** The weaker arm of a corner must carry at least this fraction of the stronger arm's weight. */
  cornerMinWeightRatio: number;
  /** How far the intersection may be from the query point and still be the thing meant, px. */
  cornerRadiusPx: number;
  /** Two ridges within this ratio of each other are indistinguishable evidence (line-snap's 0.85). */
  ambiguityRatio: number;
  /** Ridges closer together than this are one ridge, px (line-snap's ridge census spacing). */
  ambiguityMinSepPx: number;
  /** Pixels within this of the winning ridge's offset are the ones the line is fitted to, px. */
  peakBandPx: number;
  /** Fewest pixels a cluster needs before it is an edge rather than an accident. */
  minClusterPixels: number;
  /** Half-range of the sub-pixel refinement along the fitted normal, px. */
  refineRadiusPx: number;
  /** Pre-smoothing passes before the tensor — the scan's own JPEG speckle, not the card's edges. */
  presmoothPasses: number;
}

export const DEFAULT_PEN_SNAP_PARAMS: PenSnapParams = {
  searchRadiusPx: 4,
  anchorSnapPx: 4,
  // edge-trace calls 12 the strength an anchor needs before the scan is said to SUPPORT it
  // (`anchorMinStrength`). The same question is being asked here, so it is the same number.
  minRidge: 12,
  orientationTolDeg: 25,
  cornerMinAngleDeg: 30,
  cornerMinWeightRatio: 0.35,
  cornerRadiusPx: 5,
  ambiguityRatio: 0.85,
  ambiguityMinSepPx: 2,
  peakBandPx: 1.5,
  minClusterPixels: 3,
  refineRadiusPx: 1.5,
  presmoothPasses: 1,
};

// ── The prepared scan ──────────────────────────────────────────────────────

/**
 * What `preparePenSnap` builds and a query closes over. Opaque by intent: the fields are here to
 * be inspected in a test or a report, never to be assembled by hand — an edge map that did not
 * come from `buildEdgeMap` is a different measurement wearing this one's name.
 */
export interface PenSnapSource {
  readonly width: number;
  readonly height: number;
  readonly params: PenSnapParams;
  readonly edges: EdgeMap;
  /**
   * What this particular scan actually offered, measured at prepare time. `edgeFraction` near
   * zero is the honest signature of a card the snapper will decline to help with, and the UI is
   * entitled to say so before the user wonders why nothing is catching.
   */
  readonly evidence: {
    /** Pixels whose ridge survived NMS at or above `minRidge` AND were hysteresis-linked. */
    edgePixels: number;
    edgeFraction: number;
    /** The adaptive thresholds `buildEdgeMap` chose for this card. */
    high: number;
    low: number;
  };
}

/**
 * Build the edge evidence for one card scan. EXPENSIVE and deliberately explicit: a structure
 * tensor over 504x704x3 is tens of milliseconds, which is nothing once per card and everything
 * once per pointermove. Call it off the interaction path and hand the result to
 * `penSnapProvider`.
 */
export function preparePenSnap(img: RgbaImage, params: Partial<PenSnapParams> = {}): PenSnapSource {
  const p: PenSnapParams = { ...DEFAULT_PEN_SNAP_PARAMS, ...params };
  const tp: EdgeTraceParams = { ...DEFAULT_EDGE_TRACE_PARAMS, presmoothPasses: p.presmoothPasses };
  const edges = buildEdgeMap(img, tp);
  let count = 0;
  for (let i = 0; i < edges.ridge.length; i++) {
    if (edges.linked[i] === 1 && edges.ridge[i]! >= p.minRidge) count++;
  }
  return {
    width: img.width,
    height: img.height,
    params: p,
    edges,
    evidence: {
      edgePixels: count,
      edgeFraction: Number((count / (img.width * img.height)).toFixed(5)),
      high: Number(edges.high.toFixed(2)),
      low: Number(edges.low.toFixed(2)),
    },
  };
}

// ── Small local geometry ───────────────────────────────────────────────────

const DEG = Math.PI / 180;
const dot = (ax: number, ay: number, bx: number, by: number): number => ax * bx + ay * by;
/** Perpendicular foot of `p` on `l`. */
const footOf = (l: Line, p: Vec): Vec => {
  const d = l.nx * p.x + l.ny * p.y - l.c;
  return { x: p.x - l.nx * d, y: p.y - l.ny * d };
};

interface Ridge {
  /** Mask-space centre of the pixel (x+0.5, y+0.5). */
  x: number;
  y: number;
  ridge: number;
  /** Unit normal of the edge through this pixel, from the tensor's own orientation. */
  nx: number;
  ny: number;
}

interface Cluster {
  /** Seed normal — the strongest member's, not an average: averaging axes needs angle doubling. */
  nx: number;
  ny: number;
  members: Ridge[];
  weight: number;
}

/** Ridge pixels inside the window, strongest first. */
function gather(src: PenSnapSource, p: Vec): Ridge[] {
  const { edges, params, width, height } = src;
  const t = edges.tensor;
  const R = params.searchRadiusPx;
  const out: Ridge[] = [];
  const x0 = Math.max(0, Math.floor(p.x - 0.5 - R));
  const x1 = Math.min(width - 1, Math.ceil(p.x - 0.5 + R));
  const y0 = Math.max(0, Math.floor(p.y - 0.5 - R));
  const y1 = Math.min(height - 1, Math.ceil(p.y - 0.5 + R));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * width + x;
      const r = edges.ridge[i]!;
      // BOTH tests, and the second one is the one that matters on a noisy scan: `ridge` alone
      // promotes an isolated speck of film grain that happened to peak, while `linked` is
      // hysteresis's answer to "is this pixel part of an edge that goes somewhere".
      if (r < params.minRidge || edges.linked[i] !== 1) continue;
      const cx = x + 0.5;
      const cy = y + 0.5;
      if (Math.hypot(cx - p.x, cy - p.y) > R) continue;
      const th = 0.5 * Math.atan2(2 * t.jxy[i]!, t.jxx[i]! - t.jyy[i]!);
      out.push({ x: cx, y: cy, ridge: r, nx: Math.cos(th), ny: Math.sin(th) });
    }
  }
  out.sort((a, b) => b.ridge - a.ridge);
  return out;
}

/**
 * Group ridge pixels by ORIENTATION, strongest first.
 *
 * Orientation and not position, because the two structures that matter here are told apart by
 * exactly this: a corner is two clusters at an angle to each other, and an ambiguous band is ONE
 * cluster holding two parallel ridges. Cluster by position instead and a corner arrives as one
 * blob with a meaningless best-fit line through it.
 */
function clusterByOrientation(ridges: Ridge[], tolDeg: number): Cluster[] {
  const cos = Math.cos(tolDeg * DEG);
  const out: Cluster[] = [];
  for (const r of ridges) {
    let home: Cluster | null = null;
    for (const c of out) {
      // Normals are AXES, not directions: n and -n are the same edge seen from either side.
      if (Math.abs(dot(r.nx, r.ny, c.nx, c.ny)) >= cos) {
        home = c;
        break;
      }
    }
    if (home) {
      home.members.push(r);
      home.weight += r.ridge;
    } else {
      out.push({ nx: r.nx, ny: r.ny, members: [r], weight: r.ridge });
    }
  }
  out.sort((a, b) => b.weight - a.weight);
  return out;
}

interface Peak {
  /** Signed offset from the query point along the cluster normal, px. */
  offset: number;
  /** Summed ridge magnitude in the peak — what the ambiguity comparison is made on. */
  score: number;
  /** Strongest single ridge pixel in the peak, which is the number worth reporting to a human. */
  max: number;
}

/**
 * The ridge census, on one cluster's own normal — `line-snap`'s move, at a point instead of
 * along a run.
 *
 * The profile is raw summed ridge strength per half-pixel of offset; peaks closer together than
 * `ambiguityMinSepPx` are one peak. Ambiguity is decided on those RAW scores, before any
 * proximity preference is applied, for `line-snap`'s reason: a prior that pulls the answer
 * toward the hand must never be able to flatter a tie into a decision.
 */
function census(cluster: Cluster, p: Vec, params: PenSnapParams): Peak[] {
  const bin = 0.5;
  const R = params.searchRadiusPx;
  const n = Math.ceil((2 * R) / bin) + 1;
  const prof = new Float64Array(n);
  const peak = new Float64Array(n);
  for (const m of cluster.members) {
    const t = dot(m.x - p.x, m.y - p.y, cluster.nx, cluster.ny);
    const k = Math.round((t + R) / bin);
    if (k < 0 || k >= n) continue;
    prof[k] = prof[k]! + m.ridge;
    if (m.ridge > peak[k]!) peak[k] = m.ridge;
  }
  const peaks: Peak[] = [];
  for (let i = 0; i < n; i++) {
    const s = prof[i]!;
    if (s <= 0) continue;
    if (i > 0 && prof[i - 1]! > s) continue;
    if (i < n - 1 && prof[i + 1]! > s) continue;
    const offset = i * bin - R;
    const near = peaks.find((q) => Math.abs(q.offset - offset) < params.ambiguityMinSepPx);
    if (near) {
      if (s > near.score) {
        near.offset = offset;
        near.score = s;
        near.max = peak[i]!;
      }
      continue;
    }
    peaks.push({ offset, score: s, max: peak[i]! });
  }
  peaks.sort((a, b) => b.score - a.score);
  return peaks;
}

interface Edge {
  /** The fitted line, BEFORE sub-pixel refinement — the caller chooses where to measure it. */
  line: Line;
  /** The ridge pixels it was fitted to. */
  members: Ridge[];
}

/**
 * The line through one peak of a cluster.
 *
 * The fit is over the pixels belonging to THAT peak only — fitting the whole cluster when it
 * holds two parallel ridges puts the line in the gap between them, which is a place the scan has
 * no edge at all. A cluster too curved or too short to fit falls back to its strongest pixel's
 * own tensor normal, which is the local tangent: the right answer on a rounded corner, where a
 * line fit has nothing to offer and a straight-line assumption would cut the fillet.
 */
function lineForPeak(src: PenSnapSource, cluster: Cluster, p: Vec, peak: Peak): Edge | null {
  const params = src.params;
  const near = cluster.members.filter(
    (m) => Math.abs(dot(m.x - p.x, m.y - p.y, cluster.nx, cluster.ny) - peak.offset) <= params.peakBandPx,
  );
  return fitEdge(near, cluster, params);
}

function fitEdge(members: Ridge[], cluster: Cluster, params: PenSnapParams): Edge | null {
  if (members.length < params.minClusterPixels) return null;
  const fit = members.length >= 4 ? robustFit(members.map((m) => ({ x: m.x, y: m.y }))) : null;
  if (fit && fit.residRms <= 1) return { line: fit.line, members };
  const seed = members[0]!;
  return { line: { nx: cluster.nx, ny: cluster.ny, c: dot(cluster.nx, cluster.ny, seed.x, seed.y) }, members };
}

const centroid = (ms: Ridge[]): Vec => {
  let x = 0;
  let y = 0;
  for (const m of ms) {
    x += m.x;
    y += m.y;
  }
  return { x: x / ms.length, y: y / ms.length };
};

/**
 * Re-measure one arm of a corner with the CROSSING ITSELF thrown away.
 *
 * Within a couple of pixels of a corner neither arm is only itself: the pre-smoothing and the
 * Scharr support both reach across, the ridge orientation there is the average of two edges, and
 * a line fitted through that blur comes out slightly rotated. Rotation is the expensive error —
 * refining such a line further along its own length walks the intersection further off the corner
 * rather than closer, which is measurable and was measured. So the arm is fitted and refined
 * OUTSIDE `cornerBlurPx`, and if too little of it survives that cut, the unfiltered fit is used
 * as it stands rather than refined into a confident wrong answer.
 */
const CORNER_BLUR_PX = 2;

function armLine(src: PenSnapSource, arm: Edge, rough: Vec): Line {
  const outside = arm.members.filter((m) => Math.hypot(m.x - rough.x, m.y - rough.y) >= CORNER_BLUR_PX);
  // THE DIRECTION STAYS, THE OFFSET MOVES. Cutting the crossing out of a window this small leaves
  // a point cloud a couple of pixels long and one wide, and a direction fitted to that has almost
  // no baseline; the whole arm has the window's worth. Re-fitting the survivors as well was tried
  // and measured — mean corner residual 0.40px against 0.44px over the same 52 crisp-step
  // queries, same worst case — which is inside the noise of this measurement and does not buy the
  // second fit. So only the offset is re-measured, and it is re-measured where the arm is only
  // itself.
  return refine(src, arm.line, centroid(outside.length >= src.params.minClusterPixels ? outside : arm.members));
}

/**
 * Push a fitted line onto the peak of |dI/dn| at the point nearest the query.
 *
 * The fit is over pixel CENTRES, so a step edge that falls between two centres comes out up to
 * half a pixel off — for every card, in a direction that depends on which way the edge faces,
 * invisibly. `edge-trace` refines every traced vertex for the same reason; this is that pass,
 * applied to the line rather than to a polyline.
 *
 * PLATEAUX ARE CENTRED, NOT READ AT THEIR FIRST SAMPLE — `measureAdherence` learned this the
 * expensive way and it is the same trap here. A step edge landing exactly between two pixel
 * centres gives a symmetric response with a flat top; taking its first maximum reports every
 * such edge as a quarter-pixel to one side, systematically, in a direction that depends on which
 * way the edge faces. So a flat top is averaged, and the parabola is only used for a genuine
 * single-sample maximum, where it is the right estimator.
 */
function refine(src: PenSnapSource, line: Line, p: Vec): Line {
  const { refineRadiusPx: R } = src.params;
  const f = footOf(line, p);
  const step = 0.25;
  const probe = (t: number): number =>
    edgeAlong(src.edges.tensor, f.x + line.nx * t, f.y + line.ny * t, line.nx, line.ny);
  const prof: number[] = [];
  for (let t = -R; t <= R + 1e-9; t += step) prof.push(probe(t));
  let bestV = -1;
  let bestI = 0;
  for (const [i, v] of prof.entries()) {
    if (v > bestV) {
      bestV = v;
      bestI = i;
    }
  }
  if (bestV < src.params.minRidge) return line;
  const eps = Math.max(1e-6, bestV * 1e-6);
  let lo = bestI;
  let hi = bestI;
  while (lo > 0 && Math.abs(prof[lo - 1]! - bestV) <= eps) lo--;
  while (hi < prof.length - 1 && Math.abs(prof[hi + 1]! - bestV) <= eps) hi++;
  let t = -R + ((lo + hi) / 2) * step;
  if (lo === hi && lo > 0 && hi < prof.length - 1) {
    const vm = prof[lo - 1]!;
    const vp = prof[hi + 1]!;
    const denom = vm - 2 * bestV + vp;
    const sub = Math.abs(denom) > 1e-6 ? (0.5 * (vm - vp)) / denom : 0;
    t += Math.max(-1, Math.min(1, sub)) * step;
  }
  return { nx: line.nx, ny: line.ny, c: line.c + t };
}

/** The nearest anchor a human already placed, excluding the one currently in the hand. */
function nearestAnchor(ctx: SnapContext, p: Vec, radius: number): { at: Vec; path: number; point: number } | null {
  let best: { at: Vec; path: number; point: number; d: number } | null = null;
  for (const [pi, path] of ctx.doc.paths.entries()) {
    for (const [qi, pt] of path.points.entries()) {
      if (ctx.ref && ctx.ref.path === pi && ctx.ref.point === qi) continue;
      const d = Math.hypot(pt.anchor[0] - p.x, pt.anchor[1] - p.y);
      if (d > radius) continue;
      // The active path wins a tie: while a path is being drawn, its own anchors are the
      // geometry the hand is working against.
      const mine = pi === ctx.activePathIndex;
      const better =
        best === null || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && mine && best.path !== ctx.activePathIndex);
      if (better) best = { at: { x: pt.anchor[0], y: pt.anchor[1] }, path: pi, point: qi, d };
    }
  }
  return best === null ? null : { at: best.at, path: best.path, point: best.point };
}

// ── The query ──────────────────────────────────────────────────────────────

/**
 * One point query against a prepared scan, exported so a test can drive it without an engine.
 *
 * Returns a PROPOSAL (a hard displacement plus what was caught), a REFUSAL (a stated reason and
 * no movement), or null when there is simply nothing here — and the difference between the last
 * two is the whole ethic of this module. "Nothing to snap to" and "several things to snap to and
 * no way to tell which you meant" are different facts about the scan, and only one of them is
 * worth interrupting someone about.
 */
export function penSnapAt(src: PenSnapSource, p: Vec, ctx: SnapContext): SnapProposal | SnapRefusal | null {
  const params = src.params;

  // 1. An anchor a human already placed outranks anything measured off the scan (item 111).
  const anchor = nearestAnchor(ctx, p, params.anchorSnapPx);
  if (anchor) {
    return {
      point: { x: anchor.at.x, y: anchor.at.y },
      kind: 'anchor',
      reason: `landed on the anchor at ${anchor.at.x.toFixed(1)},${anchor.at.y.toFixed(1)} — geometry already placed by hand`,
    };
  }

  const ridges = gather(src, p);
  if (ridges.length < params.minClusterPixels) return null;
  const clusters = clusterByOrientation(ridges, params.orientationTolDeg);
  const dominant = clusters[0];
  if (!dominant || dominant.members.length < params.minClusterPixels) return null;

  // 2. THE GUARDRAIL, and it comes before any proposal: two comparable parallel ridges mean the
  //    scan cannot say which one was meant.
  const peaks = census(dominant, p, params);
  if (peaks.length === 0) return null;
  const top = peaks[0]!;
  const rivals = peaks.filter((q) => q.score >= params.ambiguityRatio * top.score);
  if (rivals.length > 1) {
    const offsets = rivals.map((q) => q.offset.toFixed(1)).join('/');
    return {
      refused:
        `the scan holds ${rivals.length} comparable edges here (offsets ${offsets}px along the same normal) — ` +
        'it says you are near some edges, not which one you meant, so the point stays where you put it',
    };
  }

  // The proximity preference is applied only AFTER ambiguity has been settled on raw scores.
  const sigma = Math.max(1, params.searchRadiusPx / 2);
  const prefer = peaks.reduce((a, b) =>
    b.score * Math.exp(-0.5 * (b.offset / sigma) ** 2) > a.score * Math.exp(-0.5 * (a.offset / sigma) ** 2) ? b : a,
  );
  const primary = lineForPeak(src, dominant, p, prefer);
  if (!primary) return null;

  // 3. A corner: a second cluster crossing the first steeply enough, meeting near the hand.
  const minCos = Math.cos((90 - params.cornerMinAngleDeg) * DEG);
  for (const other of clusters.slice(1)) {
    if (other.members.length < params.minClusterPixels) continue;
    if (other.weight < dominant.weight * params.cornerMinWeightRatio) continue;
    if (Math.abs(dot(other.nx, other.ny, dominant.nx, dominant.ny)) > minCos) continue;
    const opeaks = census(other, p, params);
    const opeak = opeaks[0];
    if (!opeak) continue;
    const second = lineForPeak(src, other, p, opeak);
    if (!second) continue;
    const rough = intersectLines(primary.line, second.line);
    if (!rough) continue;
    // Re-cross the two arms once each has been measured clear of the crossing.
    const X = intersectLines(armLine(src, primary, rough), armLine(src, second, rough)) ?? rough;
    const d = Math.hypot(X.x - p.x, X.y - p.y);
    if (d > params.cornerRadiusPx) continue;
    return {
      point: { x: X.x, y: X.y },
      kind: 'corner',
      reason: `two printed edges cross ${d.toFixed(2)}px away — snapped to the corner they make`,
    };
  }

  // 4. The nearest point on the edge itself.
  const foot = footOf(refine(src, primary.line, p), p);
  const moved = Math.hypot(foot.x - p.x, foot.y - p.y);
  return {
    point: { x: foot.x, y: foot.y },
    kind: 'edge',
    reason: `a printed edge runs ${moved.toFixed(2)}px away (ridge ${prefer.max.toFixed(0)}) — snapped onto it`,
  };
}

/**
 * The provider, as the engine wants it.
 *
 * A closure over the prepared scan and nothing else: no state accumulates between queries, so
 * the hundredth pointermove of a drag gets exactly the answer the first one would have.
 */
export function penSnapProvider(src: PenSnapSource): SnapFn {
  return (p, ctx) => penSnapAt(src, { x: p.x, y: p.y }, ctx);
}
