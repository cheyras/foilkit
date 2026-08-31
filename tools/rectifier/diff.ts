// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Pair diff and the three-way delta classifier for task 3b — "is a reverse-holo
// printing the normal printing plus a predictable overlay, or is it separate
// authored work?"
//
// Both rasters must already be canonical (`rectify.ts`), because the whole
// point of the measurement is that no pair is ever hand-aligned. The alignment
// check here is a guard against a bad detection, not an alignment step: if the
// two rectifications disagree, the honest answer is to re-detect, not to nudge.
//
// EVERY THRESHOLD IN THIS FILE IS PROVISIONAL. They are set to values that
// separate the synthetic cases in `diff.test.ts` with room to spare, and they
// have never seen a photographed pair — the pairs do not exist yet, because
// shooting them is the human half of 3b. When the first real pairs land, refit
// these against them and record the corpus size (AGENTS.md F5).

import { CANONICAL_H, CANONICAL_W } from './constants.ts';
import type { RgbaImage } from './homography.ts';

// ── Regions ────────────────────────────────────────────────────────────────

/** A rectangle in fractional card coordinates: 0..1 on each axis. */
export interface FracRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A placeholder art window, NOT a measurement.
 *
 * The real windows are per-era and live in `era-layouts.json` (the modern-sv
 * entry sits at y 0.0981, h 0.3749 after the 2026-08 correction). Callers
 * measuring a real pair must pass the window for that card's era; this default
 * exists so the harness runs end-to-end before the layouts are extracted, and
 * a result computed against it should say so.
 */
export const PLACEHOLDER_ART_WINDOW: FracRect = { x: 0.075, y: 0.098, w: 0.85, h: 0.375 };

// ── Provisional thresholds ─────────────────────────────────────────────────

/**
 * Per-pixel delta, 0..255, above which a pixel counts as CHANGED. Below this is
 * scanner noise, JPEG ringing and resample error. Measured on max-abs across
 * R/G/B, which is the sensitive metric: a white keyline against a coloured
 * frame moves one channel hard and the mean barely at all.
 * PROVISIONAL.
 */
export const CHANGED_PIXEL_DELTA = 24;

/**
 * Changed fraction of the whole card below which the pair is `null` — the two
 * printings carry the same ink and differ only in foil pattern assignment.
 * PROVISIONAL: a real pair carries registration slop and per-scan colour drift
 * that a synthetic pair does not, so expect to raise this.
 */
export const NULL_MAX_CHANGED_FRACTION = 0.005;

/**
 * Changed fraction INSIDE the art window below which a non-null pair is
 * `frame` — the differences are confined to the frame, which is the hypothesis
 * 3b is testing. Above it the design crosses the window and the pair is `full`.
 * PROVISIONAL.
 */
export const FRAME_MAX_INSIDE_CHANGED_FRACTION = 0.02;

/**
 * Pixels this close to the raster edge are excluded from every statistic. The
 * rectified card's outermost pixels are a blend of card and background wherever
 * the corner detection is off by a fraction of a pixel, and a rounded corner
 * guarantees SOME background lands there — that is geometry, not ink.
 * PROVISIONAL.
 */
export const EDGE_MARGIN_PX = 4;

/**
 * Residual shift, in canonical pixels, above which two rectifications are
 * called misaligned rather than diffed. Two independent detections of the same
 * card should land within a pixel or two; four is slack, not tolerance.
 * PROVISIONAL.
 */
export const MAX_RESIDUAL_SHIFT_PX = 4;

/** Downsample factor for the alignment search. Keeps the search cheap. */
const ALIGN_DOWNSAMPLE = 4;
/** Search radius, in DOWNSAMPLED pixels: ±3 → ±12 canonical px. */
const ALIGN_SEARCH_RADIUS = 3;

// ── Alignment ──────────────────────────────────────────────────────────────

export interface AlignmentReport {
  /** Best integer shift, in canonical pixels, taking `b` onto `a`. */
  dx: number;
  dy: number;
  /** Mean absolute luma difference at the best shift, 0..255. */
  residual: number;
  /** Mean absolute luma difference at zero shift, for comparison. */
  residualAtZero: number;
  aligned: boolean;
}

function lumaDownsample(img: RgbaImage, factor: number): { w: number; h: number; l: Float32Array } {
  const w = Math.floor(img.width / factor);
  const h = Math.floor(img.height / factor);
  const l = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const i = ((y * factor + sy) * img.width + (x * factor + sx)) * 4;
          sum += 0.2126 * img.rgba[i]! + 0.7152 * img.rgba[i + 1]! + 0.0722 * img.rgba[i + 2]!;
        }
      }
      l[y * w + x] = sum / (factor * factor);
    }
  }
  return { w, h, l };
}

/**
 * Is `b` registered to `a`? An exhaustive integer-shift search on a 4×
 * downsampled luma — no gradient descent, no subpixel, because the answer this
 * needs is a yes/no rather than a correction. Anything that needs correcting
 * gets re-detected.
 */
export function checkAlignment(a: RgbaImage, b: RgbaImage): AlignmentReport {
  assertSameShape(a, b);
  const da = lumaDownsample(a, ALIGN_DOWNSAMPLE);
  const db = lumaDownsample(b, ALIGN_DOWNSAMPLE);
  const R = ALIGN_SEARCH_RADIUS;

  let best = { dx: 0, dy: 0, residual: Number.POSITIVE_INFINITY };
  let atZero = Number.POSITIVE_INFINITY;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      let sum = 0;
      let n = 0;
      for (let y = R; y < da.h - R; y++) {
        for (let x = R; x < da.w - R; x++) {
          sum += Math.abs(da.l[y * da.w + x]! - db.l[(y + dy) * db.w + (x + dx)]!);
          n++;
        }
      }
      const residual = n ? sum / n : Number.POSITIVE_INFINITY;
      if (dx === 0 && dy === 0) atZero = residual;
      if (residual < best.residual) best = { dx, dy, residual };
    }
  }

  const dxPx = best.dx * ALIGN_DOWNSAMPLE;
  const dyPx = best.dy * ALIGN_DOWNSAMPLE;
  return {
    dx: dxPx,
    dy: dyPx,
    residual: best.residual,
    residualAtZero: atZero,
    aligned: Math.abs(dxPx) <= MAX_RESIDUAL_SHIFT_PX && Math.abs(dyPx) <= MAX_RESIDUAL_SHIFT_PX,
  };
}

function assertSameShape(a: RgbaImage, b: RgbaImage): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `pair rasters differ: ${a.width}×${a.height} vs ${b.width}×${b.height}. ` +
        'Both sides must be rectified to canonical space first.',
    );
  }
  if (a.rgba.length !== a.width * a.height * 4 || b.rgba.length !== b.width * b.height * 4) {
    throw new Error('rgba length does not match dimensions');
  }
}

// ── Diff ───────────────────────────────────────────────────────────────────

export interface RegionStats {
  /** Pixels considered (after the edge margin and the region mask). */
  pixels: number;
  /** Pixels whose delta exceeded `CHANGED_PIXEL_DELTA`. */
  changed: number;
  changedFraction: number;
  meanDelta: number;
  maxDelta: number;
  /** 99th percentile delta — the tail without the single worst pixel. */
  p99Delta: number;
}

export interface DiffOptions {
  /**
   * The art window, in fractional card coordinates. Pass `null` to skip the
   * inside/outside split, which also means the classifier cannot tell `frame`
   * from `full` and will say so.
   */
  artWindow?: FracRect | null;
  edgeMarginPx?: number;
  changedPixelDelta?: number;
}

export interface DiffResult {
  width: number;
  height: number;
  alignment: AlignmentReport;
  overall: RegionStats;
  /** Inside the art window. `null` when no window was supplied. */
  inside: RegionStats | null;
  /** Outside the art window (the frame). `null` when no window was supplied. */
  outside: RegionStats | null;
  artWindow: FracRect | null;
  changedPixelDelta: number;
  edgeMarginPx: number;
  /** Greyscale delta map, for the evidence image every pair has to carry. */
  delta: RgbaImage;
}

/** Per-pixel delta metric: the largest absolute difference across R, G and B. */
function pixelDelta(a: Uint8Array, b: Uint8Array, i: number): number {
  const dr = Math.abs(a[i]! - b[i]!);
  const dg = Math.abs(a[i + 1]! - b[i + 1]!);
  const db = Math.abs(a[i + 2]! - b[i + 2]!);
  return dr > dg ? (dr > db ? dr : db) : dg > db ? dg : db;
}

function statsFrom(values: number[], threshold: number): RegionStats {
  const pixels = values.length;
  if (pixels === 0) {
    return { pixels: 0, changed: 0, changedFraction: 0, meanDelta: 0, maxDelta: 0, p99Delta: 0 };
  }
  let sum = 0;
  let max = 0;
  let changed = 0;
  for (const v of values) {
    sum += v;
    if (v > max) max = v;
    if (v > threshold) changed++;
  }
  const sorted = Float64Array.from(values).sort();
  const p99 = sorted[Math.min(pixels - 1, Math.floor(pixels * 0.99))]!;
  return {
    pixels,
    changed,
    changedFraction: changed / pixels,
    meanDelta: sum / pixels,
    maxDelta: max,
    p99Delta: p99,
  };
}

function inRect(x: number, y: number, w: number, h: number, r: FracRect): boolean {
  const u = (x + 0.5) / w;
  const v = (y + 0.5) / h;
  return u >= r.x && u < r.x + r.w && v >= r.y && v < r.y + r.h;
}

/**
 * Diff two canonical rasters. `a` is conventionally the normal printing and `b`
 * the reverse, but the metric is symmetric.
 */
export function diffPair(a: RgbaImage, b: RgbaImage, opts: DiffOptions = {}): DiffResult {
  assertSameShape(a, b);
  const {
    artWindow = PLACEHOLDER_ART_WINDOW,
    edgeMarginPx = EDGE_MARGIN_PX,
    changedPixelDelta = CHANGED_PIXEL_DELTA,
  } = opts;

  const { width: W, height: H } = a;
  const alignment = checkAlignment(a, b);

  const deltaRgba = new Uint8Array(W * H * 4);
  const all: number[] = [];
  const inside: number[] = [];
  const outside: number[] = [];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const d = pixelDelta(a.rgba, b.rgba, i);
      deltaRgba[i] = d;
      deltaRgba[i + 1] = d;
      deltaRgba[i + 2] = d;
      deltaRgba[i + 3] = 255;

      const onEdge =
        x < edgeMarginPx || y < edgeMarginPx || x >= W - edgeMarginPx || y >= H - edgeMarginPx;
      if (onEdge) continue;

      all.push(d);
      if (artWindow) {
        if (inRect(x, y, W, H, artWindow)) inside.push(d);
        else outside.push(d);
      }
    }
  }

  return {
    width: W,
    height: H,
    alignment,
    overall: statsFrom(all, changedPixelDelta),
    inside: artWindow ? statsFrom(inside, changedPixelDelta) : null,
    outside: artWindow ? statsFrom(outside, changedPixelDelta) : null,
    artWindow: artWindow ?? null,
    changedPixelDelta,
    edgeMarginPx,
    delta: { width: W, height: H, rgba: deltaRgba },
  };
}

// ── Classification ─────────────────────────────────────────────────────────

/**
 * The three cases subtask 13's asset model keys against:
 *
 * - `null`  — the scans are equivalent; only the pattern assignment differs. A
 *             Rare reprinted as a Rare Holo carries a different foil with no
 *             ink change.
 * - `frame` — differences confined outside the art window: reverse-holo body
 *             design, the white keyline round the lower-left tag block, set
 *             stamps. Expected for everything modern.
 * - `full`  — the design crosses the art window. Expected to dominate the EX
 *             era (2003–2007) and every full-face rarity, where the window IS
 *             the card.
 */
export type DeltaClass = 'null' | 'frame' | 'full';

export interface Classification {
  deltaClass: DeltaClass;
  /** False when the alignment guard tripped — the class is then unreliable. */
  trustworthy: boolean;
  /** One line naming the number that decided it. Goes in the evidence record. */
  reason: string;
  thresholds: {
    changedPixelDelta: number;
    nullMaxChangedFraction: number;
    frameMaxInsideChangedFraction: number;
  };
}

export interface ClassifyOptions {
  nullMaxChangedFraction?: number;
  frameMaxInsideChangedFraction?: number;
}

export function classifyDelta(diff: DiffResult, opts: ClassifyOptions = {}): Classification {
  const {
    nullMaxChangedFraction = NULL_MAX_CHANGED_FRACTION,
    frameMaxInsideChangedFraction = FRAME_MAX_INSIDE_CHANGED_FRACTION,
  } = opts;

  const thresholds = {
    changedPixelDelta: diff.changedPixelDelta,
    nullMaxChangedFraction,
    frameMaxInsideChangedFraction,
  };
  const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

  if (diff.overall.changedFraction < nullMaxChangedFraction) {
    return {
      deltaClass: 'null',
      trustworthy: diff.alignment.aligned,
      reason: `${pct(diff.overall.changedFraction)} of the card changed, under the ${pct(nullMaxChangedFraction)} null ceiling`,
      thresholds,
    };
  }

  if (!diff.inside) {
    return {
      deltaClass: 'full',
      trustworthy: false,
      reason:
        `${pct(diff.overall.changedFraction)} of the card changed, but no art window was supplied — ` +
        'frame and full cannot be separated without one, so this defaults to the conservative class',
      thresholds,
    };
  }

  if (diff.inside.changedFraction < frameMaxInsideChangedFraction) {
    return {
      deltaClass: 'frame',
      trustworthy: diff.alignment.aligned,
      reason:
        `${pct(diff.inside.changedFraction)} of the art window changed (under the ${pct(frameMaxInsideChangedFraction)} frame ceiling) ` +
        `against ${pct(diff.outside?.changedFraction ?? 0)} of the frame`,
      thresholds,
    };
  }

  return {
    deltaClass: 'full',
    trustworthy: diff.alignment.aligned,
    reason: `${pct(diff.inside.changedFraction)} of the art window changed, over the ${pct(frameMaxInsideChangedFraction)} frame ceiling`,
    thresholds,
  };
}

// ── The per-pair record ────────────────────────────────────────────────────

/**
 * What one measured pair contributes to 3b's output. The `evidence` fields are
 * not decoration: the verification list requires that each pair carry a delta
 * class AND the diff image that justifies it, and that the exception rate be
 * stated as a fraction of pairs tested with n on the front.
 */
export interface PairRecord {
  cardId: string;
  normalVariantId: string;
  reverseVariantId: string;
  /** ISO date the pair was shot and measured. */
  measuredOn: string;
  deltaClass: DeltaClass;
  trustworthy: boolean;
  reason: string;
  artWindow: FracRect | null;
  stats: { overall: RegionStats; inside: RegionStats | null; outside: RegionStats | null };
  alignment: AlignmentReport;
  /** Repo-relative path to the written delta PNG. */
  deltaImagePath?: string;
}

export function pairRecord(
  ids: { cardId: string; normalVariantId: string; reverseVariantId: string; measuredOn: string },
  diff: DiffResult,
  classification: Classification,
  deltaImagePath?: string,
): PairRecord {
  return {
    ...ids,
    deltaClass: classification.deltaClass,
    trustworthy: classification.trustworthy,
    reason: classification.reason,
    artWindow: diff.artWindow,
    stats: { overall: diff.overall, inside: diff.inside, outside: diff.outside },
    alignment: diff.alignment,
    deltaImagePath,
  };
}

/** A blank canonical raster, opaque black. Test scaffolding and a diff floor. */
export function blankCanonical(
  width: number = CANONICAL_W,
  height: number = CANONICAL_H,
): RgbaImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return { width, height, rgba };
}
