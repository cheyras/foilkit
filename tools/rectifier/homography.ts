// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Pure-math projective geometry: 4-point correspondence → 3×3 homography,
// matrix inverse/product, corner orientation, and a bilinear-resampling warp
// into canonical space.
//
// No OpenCV, no npm dependencies, no `node:` builtins. This file is the half
// DeckPal's `dev/scan-harness` never had: the detector there
// (`apps/web/src/routes/dev/scan-harness.html`) finds the quad and returns
// corner lists `[[x,y],[x,y],[x,y],[x,y]]`, scored against `CARD_ASPECT =
// 63/88`, but nothing warps the detected quad flat. The cyclic-corner
// convention (C0→C1 is one edge, C0→C3 the adjacent one) is taken from that
// harness's `bl()` helper so detector output drops in unchanged. Same sole
// author, so the adaptation is clean under AGENTS.md F2.

import { CANONICAL_H, CANONICAL_W, CARD_ASPECT, canonicalCorners } from './constants.ts';

/** A 3×3 matrix in ROW-MAJOR order: [m00 m01 m02 m10 m11 m12 m20 m21 m22]. */
export type Mat3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

export type Point = readonly [number, number];
export type Quad = readonly [Point, Point, Point, Point];

/** RGBA8 image. `rgba.length === width * height * 4`. */
export interface RgbaImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

// ── Matrix primitives ──────────────────────────────────────────────────────

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function multiplyMat3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
    }
  }
  return out as unknown as Mat3;
}

export function determinantMat3(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

export function invertMat3(m: Mat3): Mat3 {
  const det = determinantMat3(m);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) {
    throw new Error('matrix is singular; cannot invert');
  }
  const inv = 1 / det;
  return [
    (m[4] * m[8] - m[5] * m[7]) * inv,
    (m[2] * m[7] - m[1] * m[8]) * inv,
    (m[1] * m[5] - m[2] * m[4]) * inv,
    (m[5] * m[6] - m[3] * m[8]) * inv,
    (m[0] * m[8] - m[2] * m[6]) * inv,
    (m[2] * m[3] - m[0] * m[5]) * inv,
    (m[3] * m[7] - m[4] * m[6]) * inv,
    (m[1] * m[6] - m[0] * m[7]) * inv,
    (m[0] * m[4] - m[1] * m[3]) * inv,
  ];
}

/**
 * Scale a homography so its bottom-right entry is 1. A homography is only
 * defined up to scale, so two matrices that differ by a constant factor are
 * the same transform — normalising makes them comparable, and makes the
 * serialised form in the frame registry stable.
 */
export function normalizeMat3(m: Mat3): Mat3 {
  const s = m[8];
  if (!Number.isFinite(s) || Math.abs(s) < 1e-14) return m;
  return m.map((v) => v / s) as unknown as Mat3;
}

/** Apply a homography to a point, dividing through by w. */
export function applyHomography(m: Mat3, p: Point): Point {
  const x = p[0];
  const y = p[1];
  const w = m[6] * x + m[7] * y + m[8];
  if (Math.abs(w) < 1e-14) return [Number.NaN, Number.NaN];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

// ── Serialisation (the frame-registry form) ────────────────────────────────
//
// Task 4b's `data/frames.json` records `toCanonical` as a 3×3 row-major
// homography. Nested rows read better in a hand-inspected JSON file than a
// flat nine, and the flat form is what the maths wants, so both exist and the
// pair round-trips.

export function serializeHomography(m: Mat3): [number[], number[], number[]] {
  const n = normalizeMat3(m);
  return [
    [n[0], n[1], n[2]],
    [n[3], n[4], n[5]],
    [n[6], n[7], n[8]],
  ];
}

export function deserializeHomography(rows: readonly (readonly number[])[]): Mat3 {
  if (rows.length !== 3 || rows.some((r) => r.length !== 3)) {
    throw new Error('homography must be a 3×3 row-major array');
  }
  const flat = rows.flat();
  if (flat.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new Error('homography entries must be finite numbers');
  }
  return flat as unknown as Mat3;
}

// ── DLT: four correspondences → one homography ─────────────────────────────

interface Normalization {
  transform: Mat3;
  points: Point[];
}

/**
 * Hartley normalisation: translate the centroid to the origin and scale so the
 * mean distance from it is √2. Without this the DLT's 8×8 system is badly
 * conditioned whenever the coordinates are large (a 4000 px phone photo is
 * exactly that case) and the recovered matrix loses several digits.
 */
function normalizePoints(pts: readonly Point[]): Normalization {
  const n = pts.length;
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p[0];
    cy += p[1];
  }
  cx /= n;
  cy /= n;
  let mean = 0;
  for (const p of pts) mean += Math.hypot(p[0] - cx, p[1] - cy);
  mean /= n;
  const s = mean > 1e-12 ? Math.SQRT2 / mean : 1;
  const transform: Mat3 = [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
  return { transform, points: pts.map((p) => [(p[0] - cx) * s, (p[1] - cy) * s]) };
}

/** Gaussian elimination with partial pivoting. Solves A·x = b in place. */
function solveLinearSystem(a: number[][], b: number[]): number[] {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(a[pivot]![col]!) < 1e-12) {
      throw new Error('degenerate correspondence: no unique homography (are three points collinear?)');
    }
    if (pivot !== col) {
      [a[col], a[pivot]] = [a[pivot]!, a[col]!];
      [b[col], b[pivot]] = [b[pivot]!, b[col]!];
    }
    const d = a[col]![col]!;
    for (let r = col + 1; r < n; r++) {
      const f = a[r]![col]! / d;
      if (f === 0) continue;
      for (let c = col; c < n; c++) a[r]![c] = a[r]![c]! - f * a[col]![c]!;
      b[r] = b[r]! - f * b[col]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = b[r]!;
    for (let c = r + 1; c < n; c++) sum -= a[r]![c]! * x[c]!;
    x[r] = sum / a[r]![r]!;
  }
  return x;
}

/**
 * The homography H with dst ≅ H · src for four point correspondences.
 *
 * Exactly four points give exactly eight equations for the eight free
 * parameters, so this is a solve rather than a fit — there is no residual to
 * report and no RANSAC to run. Points are Hartley-normalised first; h22 is
 * pinned to 1 in the normalised frame, which is safe there because the
 * normalised points straddle the origin at unit scale and h22 = 0 would put
 * the line at infinity through the middle of them.
 */
export function homographyFromCorrespondences(
  src: readonly Point[],
  dst: readonly Point[],
): Mat3 {
  if (src.length !== 4 || dst.length !== 4) {
    throw new Error('homographyFromCorrespondences needs exactly 4 points on each side');
  }
  for (const p of [...src, ...dst]) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      throw new Error('correspondence contains a non-finite coordinate');
    }
  }

  const ns = normalizePoints(src);
  const nd = normalizePoints(dst);

  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = ns.points[i]!;
    const [u, v] = nd.points[i]!;
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solveLinearSystem(a, b);
  const hn: Mat3 = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];

  // H = T_dst⁻¹ · Hn · T_src
  return normalizeMat3(
    multiplyMat3(invertMat3(nd.transform), multiplyMat3(hn, ns.transform)),
  );
}

// ── Orientation ────────────────────────────────────────────────────────────

/**
 * How to read the four detected corners.
 *
 * - `auto` (default) — resolve which corner is top-left from the card's aspect
 *   and the assumption that the photograph is roughly upright. Winding is
 *   normalised to clockwise first, so a counter-clockwise detection is handled.
 * - `as-given` — the corners are already [TL, TR, BR, BL]. Nothing is reordered
 *   and nothing is re-wound; use this when an upstream step already decided.
 * - `rotate90` / `rotate180` / `rotate270` — `as-given`, then cyclically shifted
 *   by one/two/three positions. The escape hatch for a card photographed on its
 *   side, where `auto`'s upright assumption is the wrong assumption.
 */
export type Orientation = 'auto' | 'as-given' | 'rotate90' | 'rotate180' | 'rotate270';

const ROTATION_STEPS: Record<Orientation, number> = {
  auto: 0,
  'as-given': 0,
  rotate90: 1,
  rotate180: 2,
  rotate270: 3,
};

function rotateQuad(q: Quad, steps: number): Quad {
  const s = ((steps % 4) + 4) % 4;
  return [q[s % 4]!, q[(s + 1) % 4]!, q[(s + 2) % 4]!, q[(s + 3) % 4]!] as Quad;
}

/** Signed area ×2. Positive means clockwise in image coordinates (y down). */
function signedArea2(q: Quad): number {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s;
}

/**
 * Cost of reading `q` as [TL, TR, BR, BL], lower is better. Two terms, and both
 * are load-bearing:
 *
 *  - the ASPECT term separates upright from sideways. 63/88 = 0.716 against
 *    88/63 = 1.397 is a wide gap, so this is decisive whenever the detection is
 *    a card at all.
 *  - the UPRIGHT term separates a card from the same card turned 180°, which
 *    the aspect term cannot see. It asks that the top-edge-to-bottom-edge
 *    vector point down the image.
 */
function orientationCost(q: Quad): number {
  const edge = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const w = (edge(q[0]!, q[1]!) + edge(q[3]!, q[2]!)) / 2;
  const h = (edge(q[0]!, q[3]!) + edge(q[1]!, q[2]!)) / 2;
  if (w < 1e-9 || h < 1e-9) return Number.POSITIVE_INFINITY;
  const aspectCost = Math.abs(Math.log(w / h / CARD_ASPECT));

  const topMid: Point = [(q[0]![0] + q[1]![0]) / 2, (q[0]![1] + q[1]![1]) / 2];
  const botMid: Point = [(q[3]![0] + q[2]![0]) / 2, (q[3]![1] + q[2]![1]) / 2];
  const dy = botMid[1] - topMid[1];
  const dx = botMid[0] - topMid[0];
  const len = Math.hypot(dx, dy) || 1;
  // 0 when the down-vector points straight down, 1 when it points straight up.
  const uprightCost = (1 - dy / len) / 2;

  return aspectCost + 2 * uprightCost;
}

/**
 * Resolve a detected quad into [TL, TR, BR, BL].
 *
 * Returns the reordered quad plus the number of cyclic steps applied and
 * whether the winding was reversed, so a caller can record what was decided
 * rather than re-deriving it.
 */
export function orientCorners(
  corners: readonly Point[],
  orientation: Orientation = 'auto',
): { quad: Quad; steps: number; reversed: boolean } {
  if (corners.length !== 4) throw new Error('a quad needs exactly 4 corners');
  const q0 = [corners[0]!, corners[1]!, corners[2]!, corners[3]!] as Quad;

  if (orientation !== 'auto') {
    return { quad: rotateQuad(q0, ROTATION_STEPS[orientation]), steps: ROTATION_STEPS[orientation], reversed: false };
  }

  const reversed = signedArea2(q0) < 0;
  const wound: Quad = reversed ? ([q0[3]!, q0[2]!, q0[1]!, q0[0]!] as Quad) : q0;

  let best = 0;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let s = 0; s < 4; s++) {
    const cost = orientationCost(rotateQuad(wound, s));
    if (cost < bestCost) {
      bestCost = cost;
      best = s;
    }
  }
  return { quad: rotateQuad(wound, best), steps: best, reversed };
}

// ── Warp ───────────────────────────────────────────────────────────────────

export type OutsidePolicy = 'clamp' | 'transparent';

/**
 * Bilinear sample of an RGBA image at continuous coordinates, where (0.5, 0.5)
 * is the centre of pixel (0, 0).
 *
 * Channels are interpolated straight rather than premultiplied. Every image
 * this pipeline handles — a catalog scan, a phone photo — is fully opaque, and
 * premultiplying would make the round-trip test's error budget depend on a
 * conversion that never fires. If a source with a real alpha channel ever
 * arrives, this is the line to revisit.
 */
export function sampleBilinear(
  img: RgbaImage,
  x: number,
  y: number,
  out: Uint8Array,
  outOff: number,
  outside: OutsidePolicy = 'clamp',
): void {
  const { width: W, height: H, rgba } = img;
  const fx = x - 0.5;
  const fy = y - 0.5;

  if (outside === 'transparent' && (x < 0 || y < 0 || x > W || y > H)) {
    out[outOff] = 0;
    out[outOff + 1] = 0;
    out[outOff + 2] = 0;
    out[outOff + 3] = 0;
    return;
  }

  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const cx0 = x0 < 0 ? 0 : x0 >= W ? W - 1 : x0;
  const cx1 = x0 + 1 < 0 ? 0 : x0 + 1 >= W ? W - 1 : x0 + 1;
  const cy0 = y0 < 0 ? 0 : y0 >= H ? H - 1 : y0;
  const cy1 = y0 + 1 < 0 ? 0 : y0 + 1 >= H ? H - 1 : y0 + 1;

  const i00 = (cy0 * W + cx0) * 4;
  const i10 = (cy0 * W + cx1) * 4;
  const i01 = (cy1 * W + cx0) * 4;
  const i11 = (cy1 * W + cx1) * 4;

  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;

  for (let c = 0; c < 4; c++) {
    const v =
      rgba[i00 + c]! * w00 +
      rgba[i10 + c]! * w10 +
      rgba[i01 + c]! * w01 +
      rgba[i11 + c]! * w11;
    out[outOff + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
}

export interface WarpOptions {
  width?: number;
  height?: number;
  outside?: OutsidePolicy;
}

/**
 * Resample `src` into a `width × height` raster using the INVERSE map — i.e.
 * `fromCanonical` takes a destination pixel to the source pixel it came from.
 * Backward mapping is what guarantees every destination pixel gets written
 * exactly once, with no holes; a forward scatter cannot promise that.
 */
export function warp(
  src: RgbaImage,
  fromDestination: Mat3,
  { width = CANONICAL_W, height = CANONICAL_H, outside = 'clamp' }: WarpOptions = {},
): RgbaImage {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`bad output raster ${width}×${height}`);
  }
  if (src.rgba.length !== src.width * src.height * 4) {
    throw new Error('source rgba length does not match its dimensions');
  }
  const m = fromDestination;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const dy = y + 0.5;
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5;
      const w = m[6] * dx + m[7] * dy + m[8];
      const sx = (m[0] * dx + m[1] * dy + m[2]) / w;
      const sy = (m[3] * dx + m[4] * dy + m[5]) / w;
      sampleBilinear(src, sx, sy, out, (y * width + x) * 4, outside);
    }
  }
  return { width, height, rgba: out };
}

/**
 * The homography taking SOURCE pixel coordinates into canonical pixel
 * coordinates, for a quad already ordered [TL, TR, BR, BL].
 */
export function homographyToCanonical(
  quad: Quad,
  width: number = CANONICAL_W,
  height: number = CANONICAL_H,
): Mat3 {
  return homographyFromCorrespondences(quad, canonicalCorners(width, height));
}
