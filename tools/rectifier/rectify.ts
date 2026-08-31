// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The rectifier's public API: a detected quad plus the image it was detected
// in, out comes a canonical 504×704 raster and the homography that produced it.
//
// This is the half DeckPal's `dev/scan-harness` never had. That page finds the
// card; this turns the finding into a corpus-grade image. Task 3b diffs pairs
// through it, task 4's frame registry stores the matrices it emits, and task
// 14's community capture pipeline calls `rectify()` directly — one code path,
// so no pair is ever hand-aligned.

import {
  CANONICAL_H,
  CANONICAL_W,
  CARD_ASPECT,
  canonicalCorners,
} from './constants.ts';
import {
  type Mat3,
  type Orientation,
  type OutsidePolicy,
  type Point,
  type Quad,
  type RgbaImage,
  homographyFromCorrespondences,
  invertMat3,
  orientCorners,
  serializeHomography,
  warp,
} from './homography.ts';

export type { Mat3, Orientation, Point, Quad, RgbaImage };

export interface RectifyOptions {
  /** How to read the four corners. Default `auto`. See `Orientation`. */
  orientation?: Orientation;
  /** Output raster. Defaults to canonical 504×704; override only deliberately. */
  width?: number;
  height?: number;
  /** What a sample landing outside the source image reads. Default `clamp`. */
  outside?: OutsidePolicy;
}

export interface RectifyResult {
  /** The canonical raster. */
  image: RgbaImage;
  /** SOURCE pixels → CANONICAL pixels. This is the frame registry's `toCanonical`. */
  toCanonical: Mat3;
  /** CANONICAL pixels → SOURCE pixels. The map the warp actually walks. */
  fromCanonical: Mat3;
  /** The resolved corners in source space, ordered [TL, TR, BR, BL]. */
  corners: Quad;
  /** What the orientation resolver decided, so a caller can record it. */
  orientation: {
    requested: Orientation;
    /** Cyclic shifts applied to the input corner list. */
    steps: number;
    /** Whether the input quad was wound counter-clockwise and got reversed. */
    reversed: boolean;
  };
  width: number;
  height: number;
}

/**
 * Rectify a detected quad into canonical card space.
 *
 * `corners` is the detector's output shape: four `[x, y]` pairs in cyclic
 * order around the quad, either winding. With the default `orientation: 'auto'`
 * the winding is normalised and the top-left corner is resolved from the card
 * aspect plus the assumption that the photograph is roughly upright; pass an
 * explicit orientation when that assumption is wrong.
 */
export function rectify(
  image: RgbaImage,
  corners: readonly Point[],
  {
    orientation = 'auto',
    width = CANONICAL_W,
    height = CANONICAL_H,
    outside = 'clamp',
  }: RectifyOptions = {},
): RectifyResult {
  if (image.rgba.length !== image.width * image.height * 4) {
    throw new Error('image rgba length does not match its dimensions');
  }

  const resolved = orientCorners(corners, orientation);
  const dst = canonicalCorners(width, height);

  const toCanonical = homographyFromCorrespondences(resolved.quad, dst);
  const fromCanonical = invertMat3(toCanonical);

  return {
    image: warp(image, fromCanonical, { width, height, outside }),
    toCanonical,
    fromCanonical,
    corners: resolved.quad,
    orientation: { requested: orientation, steps: resolved.steps, reversed: resolved.reversed },
    width,
    height,
  };
}

/**
 * The record task 4b's `data/frames.json` stores per image source. A rectified
 * photo is `toCanonical` from `rectify()` above; a catalog raster that is a
 * pure resample is an affine, expressed in the same 3×3 form so the two are
 * interchangeable at the point of use.
 */
export interface FrameRecord {
  id: string;
  raster: [number, number];
  /** 3×3 row-major, source pixels → canonical pixels. */
  toCanonical: [number[], number[], number[]];
  measuredOn?: string;
  n?: number;
}

/**
 * The frame record for a source whose whole card fills a `w × h` raster with no
 * bleed and no margin — a pure resample. This is the common catalog case
 * (TCGdex's 600×825 and 245×337 both claim to be it) and it is an anisotropic
 * scale, not a similarity: 600×825 is 0.7273 against canonical's 0.7159, so the
 * vertical scale and the horizontal scale genuinely differ by 1.55%.
 *
 * `n` and `measuredOn` are the caller's to fill in. AGENTS.md F5: a transform
 * asserted without a measurement behind it is an opinion.
 */
export function resampleFrame(
  id: string,
  rasterW: number,
  rasterH: number,
  canonW: number = CANONICAL_W,
  canonH: number = CANONICAL_H,
): FrameRecord {
  const src: Point[] = [
    [0, 0],
    [rasterW, 0],
    [rasterW, rasterH],
    [0, rasterH],
  ];
  return {
    id,
    raster: [rasterW, rasterH],
    toCanonical: serializeHomography(
      homographyFromCorrespondences(src, canonicalCorners(canonW, canonH)),
    ),
  };
}

/**
 * How far a raster's aspect is from the physical card's, as a signed fraction.
 * Positive means the raster is wider than the card. TCGdex's 600×825 returns
 * +0.0159 — the 1.55% that task 4 is about.
 */
export function aspectError(rasterW: number, rasterH: number): number {
  return rasterW / rasterH / CARD_ASPECT - 1;
}
