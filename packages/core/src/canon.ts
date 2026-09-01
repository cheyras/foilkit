// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// @foilkit/core — the canon-vs-override layering model (2026-08-02 workbench
// split, issues/foil/…_4aq756).
//
// Uniform baseline layering, lowest to highest:
//   1. GLOBAL_DEFAULTS + pattern.defaults + pattern.params  (code — patterns.ts,
//      the R0 re-tune lane)
//   2. canon file  data/foil-canon/<patternId>.json         (surface A saves a
//      FULL snapshot; when present it replaces the code defaults as the
//      baseline — "locked down")
//   3. per-card override  data/foil-overrides/<card>/<variant>.json (surface B
//      saves a SPARSE diff vs the canon baseline; untouched uniforms keep
//      tracking canon as it evolves)
//   4. live sliders (ephemeral)
//
// MIGRATION DISCIPLINE: canon files and overrides are keyed by canonical
// pattern ids — resolve through canonicalPatternId() on read so PATTERN_ALIASES
// entries (e.g. sv-holo) never orphan a saved file.

import { GLOBAL_DEFAULTS } from './shader.ts'
import type { FoilCanonEntry, FoilPattern } from './types.ts'

/** Code-default uniform seed for a pattern (layer 1). */
export function seedUniforms(pattern: FoilPattern): Record<string, number> {
  const u: Record<string, number> = { ...GLOBAL_DEFAULTS }
  for (const [k, v] of Object.entries(pattern.defaults)) u[k] = v as number
  for (const p of pattern.params) u[p.key] = p.default
  return u
}

/** Canon-effective baseline (layers 1+2): code seed overlaid with the canon snapshot. */
export function canonBaseline(pattern: FoilPattern, canon: FoilCanonEntry | undefined): Record<string, number> {
  const u = seedUniforms(pattern)
  if (canon) for (const [k, v] of Object.entries(canon.uniforms)) u[k] = v
  return u
}

/** Sparse diff: uniforms in `current` that differ from `baseline` (slider epsilon). */
export function sparseDiff(
  current: Record<string, number>,
  baseline: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(current)) {
    if (Math.abs(v - (baseline[k] ?? 0)) > 1e-6) out[k] = v
  }
  return out
}

// canonFor() and referenceSlug() used to live here. Both resolve a pattern id
// through PATTERN_ALIASES, which is @foilkit/patterns' data — and `core` does
// not depend on `patterns` at runtime, so that the recipe corpus stays
// separately versioned and individually importable. They moved to
// @foilkit/patterns (`canon-lookup.ts`) and are re-exported from its index.
