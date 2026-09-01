// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// @foilkit/core — canonical card space, derived.
//
// Canonical space is THE PHYSICAL CARD: 63 x 88 mm with a 3 mm corner. Not a
// raster size. Every number below is computed from `card-space.json`, which
// holds the four constants and their provenance; nothing here is typed in.
//
// Read that file for the provenance note (the 63x88 footprint is well attested;
// the 3 mm corner is TRIANGULATED, NOT OFFICIAL, credible range 2.5-3.0 mm).
// The honesty travels with the number.
//
// WHY THIS EXISTS. Every mask and every era rect used to be measured against
// TCGdex's 600x825 raster, which is 245:337 — 1.55% short of the physical card
// (63:88 at 600 wide is 838 tall, not 825). The object store already holds more
// than one framing, so a rect measured in one was being applied in another. A
// mask is a stencil, and a stencil only fits if the picture underneath is the
// shape it was cut for. So the space is defined by the card, and every image
// source declares a transform INTO it (`data/frames.json`).
//
// ONE MODULE, both sides. DeckPal carried two copies of this arithmetic — one
// importing the JSON, one reading it off disk — because apps/api/tsconfig.json
// pinned rootDir to src and could not import apps/web. That seam is gone: the
// extraction collapsed both into this file, and @foilkit/forge (node) and
// @foilkit/three (browser) now derive from the same expressions. A copy of an
// arithmetic expression cannot drift the way a copy of `504` can — and now
// there is not even a copy.

import space from './card-space.json' with { type: 'json' }

// ── The datum ──────────────────────────────────────────────────────────────

/** 63 mm. */
export const CARD_WIDTH_MM = space.widthMm
/** 88 mm. */
export const CARD_HEIGHT_MM = space.heightMm
/** 3 mm — triangulated, not official. See card-space.json. */
export const CARD_CORNER_RADIUS_MM = space.cornerRadiusMm
/** 8 px/mm — the canonical sampling density. */
export const CANONICAL_PX_PER_MM = space.pxPerMm

// ── Derived: the canonical raster ──────────────────────────────────────────

/** 504. The canonical mask/rectified-scan width. */
export const CANONICAL_W = CARD_WIDTH_MM * CANONICAL_PX_PER_MM
/** 704. */
export const CANONICAL_H = CARD_HEIGHT_MM * CANONICAL_PX_PER_MM

/** width / height = 63/88 = 0.715909… */
export const CARD_ASPECT_WH = CARD_WIDTH_MM / CARD_HEIGHT_MM
/** height / width = 88/63 = 1.396825… — the shader's isotropy denominator. */
export const CARD_ASPECT_HW = CARD_HEIGHT_MM / CARD_WIDTH_MM

/**
 * Corner radius as a fraction of the card WIDTH: 3/63 = 0.0476190…
 * This is the number `era-layouts.json` records as `cornerRadius`; the layout
 * contract test proves the file agrees with this expression.
 */
export const CARD_CORNER_RADIUS_FRACTION = CARD_CORNER_RADIUS_MM / CARD_WIDTH_MM

/** The corner radius in canonical pixels: 24. */
export const CANONICAL_CORNER_RADIUS_PX = CARD_CORNER_RADIUS_MM * CANONICAL_PX_PER_MM

// ── Conversions ────────────────────────────────────────────────────────────

export function mmToCanonicalPx(mm: number): number {
  return mm * CANONICAL_PX_PER_MM
}

export function canonicalPxToMm(px: number): number {
  return px / CANONICAL_PX_PER_MM
}

/**
 * The canonical rectangle's four corners: top-left, top-right, bottom-right,
 * bottom-left — clockwise with y pointing down, matching the scan detector's
 * cyclic quad convention, so 3b's rectifier plugs in unchanged.
 *
 * OUTER corners of the raster, not pixel centres: the canonical image covers
 * [0, CANONICAL_W] x [0, CANONICAL_H] in continuous coordinates, and pixel
 * (x, y) is sampled at (x + 0.5, y + 0.5).
 */
export function canonicalCorners(
  width: number = CANONICAL_W,
  height: number = CANONICAL_H,
): [[number, number], [number, number], [number, number], [number, number]] {
  return [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ]
}

// ── Self-check ─────────────────────────────────────────────────────────────
//
// A non-integral canonical raster would silently half-pixel every mask in the
// corpus, so it fails at import rather than at use.

if (!Number.isInteger(CANONICAL_W) || !Number.isInteger(CANONICAL_H)) {
  throw new Error(
    `canonical raster must be integral; ${CARD_WIDTH_MM}x${CARD_HEIGHT_MM} mm at ` +
      `${CANONICAL_PX_PER_MM} px/mm gives ${CANONICAL_W}x${CANONICAL_H}`,
  )
}
