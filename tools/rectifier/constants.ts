// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Canonical card space — now a re-export.
//
// This file used to BE the definition: it predates the extraction, and its own
// header said "it moves into @foilkit/core when the extraction lands". It has.
// The datum (63 × 88 mm, a 3 mm corner, 8 px/mm) and its provenance now live in
// `packages/core/src/card-space.json`, and the arithmetic derived from it lives
// in `packages/core/src/canonical-space.ts` — one definition, imported by the
// browser renderer, the node authoring stack and this tool alike.
//
// Two names differ and the difference matters, so they are mapped explicitly
// rather than star-exported:
//
//   rectifier CARD_ASPECT          = width / height  (0.7159…)
//   core      CARD_ASPECT (shader) = height / width  (1.3968…)
//
// The shader's is the isotropy denominator baked into 51 `vec2(1.0,
// CARD_ASPECT)` uses in the recipes; the rectifier's is the quad-scoring
// constraint. Core exports both under unambiguous names — `CARD_ASPECT_WH` and
// `CARD_ASPECT_HW` — and this shim keeps the rectifier's local vocabulary.

export {
  CANONICAL_CORNER_RADIUS_PX,
  CANONICAL_H,
  CANONICAL_PX_PER_MM,
  CANONICAL_W,
  CARD_CORNER_RADIUS_FRACTION,
  CARD_CORNER_RADIUS_MM,
  CARD_HEIGHT_MM,
  CARD_WIDTH_MM,
  canonicalCorners,
  canonicalPxToMm,
  mmToCanonicalPx,
} from '@foilkit/core';

export {
  /** width / height = 63/88 = 0.7159… — the detector's quad-scoring constraint. */
  CARD_ASPECT_WH as CARD_ASPECT,
  /** height / width = 88/63 = 1.3968… — the shader's isotropy denominator. */
  CARD_ASPECT_HW as CARD_ASPECT_INVERSE,
} from '@foilkit/core';
