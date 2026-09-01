// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// @foilkit/patterns — alias-aware lookups over stored, pattern-keyed data.
//
// These two functions were part of DeckPal's `foil/canon.ts`. They moved here
// in the extraction because both resolve an id through `PATTERN_ALIASES`, which
// is this package's data — and @foilkit/core deliberately does not depend on
// this package at runtime, so that the recipe corpus stays separately
// versioned and individually importable. The layering arithmetic
// (`seedUniforms`, `canonBaseline`, `sparseDiff`) stayed in core, where it
// belongs: it takes a pattern object and never looks an id up.
//
// MIGRATION DISCIPLINE: canon files and overrides are keyed by CANONICAL
// pattern ids — resolve through `canonicalPatternId()` on read so an alias
// entry (e.g. `sv-holo`) can never orphan a saved file.

import type { FoilCanonEntry } from '@foilkit/core'
import { canonicalPatternId } from './patterns.ts'

/** Canon entry for a (possibly aliased) pattern id out of a canon map. */
export function canonFor(
  canonMap: Record<string, FoilCanonEntry> | undefined,
  patternId: string,
): FoilCanonEntry | undefined {
  return canonMap?.[canonicalPatternId(patternId)]
}

// ── Reference corpus mapping ────────────────────────────────────────────────
// Pattern ids match `reference/<slug>/` dirs 1:1 except:
//   none          — no physical foil, no reference
//   reverse-sheet — models the stamped emblem sheet ≈ video #30 (patterns.ts
//                   taxonomy note), so it borrows that chapter's clip.
const REFERENCE_ALIAS: Record<string, string | null> = {
  none: null,
  'reverse-sheet': 'pokeball-masterball',
}

/** Reference-corpus dir slug for a pattern id, or null when none exists. */
export function referenceSlug(patternId: string): string | null {
  const canonical = canonicalPatternId(patternId)
  return canonical in REFERENCE_ALIAS ? (REFERENCE_ALIAS[canonical] ?? null) : canonical
}
