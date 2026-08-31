// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Canonical card space — the millimetre constants and everything derived from
// them.
//
// PROVENANCE. A standard Pokémon TCG card measures 63 × 88 mm. That footprint
// is well attested: it is the nominal 2.5″ × 3.5″ poker/trading-card size,
// reported unchanged from the game's 1996 launch through current standard-size
// cards, and it is the trim an officially licensed accessory (Ultra Pro
// standard deck protectors) is sized to fit.
//
// The 3 mm corner radius is TRIANGULATED, NOT OFFICIAL. It is inferred from a
// Japanese trading-card die-cutting specification that documents a 63 × 88 mm
// trim with "R3" (3 mm) corners for that poker-size card, plus a Pokémon-
// specific size guide. A second manufacturing source quotes 2.5 mm for
// "standard card corners", and a Pokémon-specific source notes the radius
// varies slightly between print runs and eras. The credible range is therefore
// 2.5–3.0 mm; NO TPCi factory die specification is published, so 3 mm is the
// best-supported point estimate rather than an authoritative figure. Treat it
// as "the corner the box should round to" and not as a claim about any
// individual physical card.
//
// The three millimetre constants and this provenance note are carried across
// from DeckPal's `apps/web/src/lib/cardGeometry.ts` (same sole author, so the
// copy is clean under the standing ownership rule — see AGENTS.md F2).
//
// Everything below is DERIVED from the four constants at the top, so the file
// cannot drift from itself. `constants.test.ts` reads this source back and
// fails if a derived value is ever typed in as a literal.
//
// This module has no imports on purpose. It moves into `@foilkit/core` when the
// extraction lands, and a constants module with a dependency is a constants
// module that can be broken by something else.

// ── The physical card ──────────────────────────────────────────────────────

export const CARD_WIDTH_MM = 63;
export const CARD_HEIGHT_MM = 88;
export const CARD_CORNER_RADIUS_MM = 3;

/**
 * Canonical sampling density. 8 px/mm is chosen so the canonical raster comes
 * out integral in both axes (63 × 8 = 504, 88 × 8 = 704) and strictly larger
 * than every framing the corpus was authored in — the migration resamples up,
 * never down.
 */
export const CANONICAL_PX_PER_MM = 8;

// ── Derived: the canonical raster ──────────────────────────────────────────

/** 504. */
export const CANONICAL_W = CARD_WIDTH_MM * CANONICAL_PX_PER_MM;
/** 704. */
export const CANONICAL_H = CARD_HEIGHT_MM * CANONICAL_PX_PER_MM;

/** width / height = 63 / 88 = 0.7159090909… */
export const CARD_ASPECT = CARD_WIDTH_MM / CARD_HEIGHT_MM;
/** height / width — the reciprocal, for row-height arithmetic. */
export const CARD_ASPECT_INVERSE = CARD_HEIGHT_MM / CARD_WIDTH_MM;

/**
 * Corner radius as a fraction of the card WIDTH: 3/63 = 0.047619…
 * This is the number `era-layouts.json` records as `cornerRadius`.
 */
export const CARD_CORNER_RADIUS_FRACTION = CARD_CORNER_RADIUS_MM / CARD_WIDTH_MM;

/** The corner radius in canonical pixels: 24. */
export const CANONICAL_CORNER_RADIUS_PX =
  CARD_CORNER_RADIUS_MM * CANONICAL_PX_PER_MM;

// ── Derived: conversions ───────────────────────────────────────────────────

export function mmToCanonicalPx(mm: number): number {
  return mm * CANONICAL_PX_PER_MM;
}

export function canonicalPxToMm(px: number): number {
  return px / CANONICAL_PX_PER_MM;
}

/**
 * The canonical rectangle's four corners, in the order this codebase uses
 * everywhere: top-left, top-right, bottom-right, bottom-left — clockwise with
 * y pointing down, matching the detector's cyclic quad convention.
 *
 * These are the OUTER corners of the raster, not pixel centres: the canonical
 * image covers [0, CANONICAL_W] × [0, CANONICAL_H] in continuous coordinates,
 * and pixel (x, y) is sampled at (x + 0.5, y + 0.5).
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
  ];
}

// ── Self-check ─────────────────────────────────────────────────────────────
//
// A non-integral canonical raster would silently half-pixel every mask in the
// corpus, so it fails at import rather than at use.

if (!Number.isInteger(CANONICAL_W) || !Number.isInteger(CANONICAL_H)) {
  throw new Error(
    `canonical raster must be integral; ${CARD_WIDTH_MM}×${CARD_HEIGHT_MM} mm at ` +
      `${CANONICAL_PX_PER_MM} px/mm gives ${CANONICAL_W}×${CANONICAL_H}`,
  );
}
