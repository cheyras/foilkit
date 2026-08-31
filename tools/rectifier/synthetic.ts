// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Synthetic imagery for validating the rectifier without a photograph.
//
// The physical pairs 3b needs are a human step — somebody has to sit down with
// the binder — but the geometry does not have to wait for them. Rendering a
// known canonical raster THROUGH a known homography produces a "photo" whose
// correct rectification is known exactly, so the round trip is a measurement
// rather than an eyeball.
//
// The patterns here are deliberately smooth. A hard-edged test chart would
// measure the resampler's ringing rather than the homography's accuracy, and
// the homography is what is under test. Real cards are not smooth, which is
// exactly why the round-trip tolerance in `rectify.test.ts` is a floor on the
// geometry and not a claim about scan quality.

import {
  type Mat3,
  type Point,
  type Quad,
  type RgbaImage,
  applyHomography,
  homographyFromCorrespondences,
  sampleBilinear,
} from './homography.ts';
import { canonicalCorners } from './constants.ts';

/**
 * A smooth, non-symmetric test card. Non-symmetric matters: a pattern with a
 * mirror symmetry would let a 180° orientation error round-trip perfectly and
 * the test would pass on a broken orientation resolver.
 */
export function syntheticCard(width: number, height: number): RgbaImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const i = (y * width + x) * 4;
      const r = 128 + 70 * Math.sin(2 * Math.PI * (1.5 * u + 0.35)) * Math.cos(2 * Math.PI * 1.1 * v);
      const g = 128 + 60 * Math.sin(2 * Math.PI * (0.9 * v + 0.2)) + 25 * u;
      const b = 128 + 55 * Math.cos(2 * Math.PI * (1.3 * u * v + 0.1)) - 30 * v;
      rgba[i] = clamp8(r);
      rgba[i + 1] = clamp8(g);
      rgba[i + 2] = clamp8(b);
      rgba[i + 3] = 255;
    }
  }
  return { width, height, rgba };
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

export interface PhotoOptions {
  frameWidth: number;
  frameHeight: number;
  /** Background outside the card. Default a mid grey that is nothing like the card. */
  background?: [number, number, number];
}

export interface SyntheticPhoto {
  image: RgbaImage;
  /** The quad the card occupies, [TL, TR, BR, BL] in photo pixels. */
  quad: Quad;
  /** PHOTO pixels → CANONICAL pixels. The answer `rectify()` has to recover. */
  truthToCanonical: Mat3;
}

/**
 * Render `card` into a larger frame through `quad`, as a camera would.
 *
 * The frame is deliberately larger than the card so the rectifier's samples
 * never leave the image and the clamp policy is not silently doing the work.
 */
export function renderPhoto(
  card: RgbaImage,
  quad: Quad,
  { frameWidth, frameHeight, background = [40, 44, 52] }: PhotoOptions,
): SyntheticPhoto {
  const toCanonical = homographyFromCorrespondences(
    quad,
    canonicalCorners(card.width, card.height),
  );

  const rgba = new Uint8Array(frameWidth * frameHeight * 4);
  for (let y = 0; y < frameHeight; y++) {
    for (let x = 0; x < frameWidth; x++) {
      const i = (y * frameWidth + x) * 4;
      const [cx, cy] = applyHomography(toCanonical, [x + 0.5, y + 0.5]);
      if (Number.isFinite(cx) && Number.isFinite(cy) && cx >= 0 && cy >= 0 && cx <= card.width && cy <= card.height) {
        sampleBilinear(card, cx, cy, rgba, i, 'clamp');
      } else {
        rgba[i] = background[0];
        rgba[i + 1] = background[1];
        rgba[i + 2] = background[2];
        rgba[i + 3] = 255;
      }
    }
  }

  return { image: { width: frameWidth, height: frameHeight, rgba }, quad, truthToCanonical: toCanonical };
}

// ── Error reporting ────────────────────────────────────────────────────────

export interface ImageError {
  /** Mean absolute per-channel error, 0..255. */
  mean: number;
  /** Largest absolute per-channel error, 0..255. */
  max: number;
  /** Pixels compared, after the margin. */
  pixels: number;
}

/**
 * Compare two same-sized rasters, ignoring `margin` pixels at each edge.
 *
 * The margin is not slack, it is the honest exclusion: a rectified card's
 * outermost row is a blend of card and background wherever the corner estimate
 * is off by a fraction of a pixel, and every rounded corner puts background
 * there by construction. What is measured here is the interior.
 */
export function compareImages(a: RgbaImage, b: RgbaImage, margin = 0): ImageError {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`size mismatch: ${a.width}×${a.height} vs ${b.width}×${b.height}`);
  }
  let sum = 0;
  let max = 0;
  let n = 0;
  for (let y = margin; y < a.height - margin; y++) {
    for (let x = margin; x < a.width - margin; x++) {
      const i = (y * a.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a.rgba[i + c]! - b.rgba[i + c]!);
        sum += d;
        if (d > max) max = d;
        n++;
      }
    }
  }
  return { mean: n ? sum / n : 0, max, pixels: n / 3 };
}

/** A representative hand-held perspective: keystoned, rotated a few degrees. */
export function tiltedQuad(): Quad {
  const q: Point[] = [
    [420, 250],
    [1060, 300],
    [1120, 1300],
    [300, 1230],
  ];
  return q as unknown as Quad;
}
