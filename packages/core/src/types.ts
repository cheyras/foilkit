// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// @foilkit/core — the pattern ABI and the stored-form types.
//
// These declarations were extracted from `patterns.ts` when the recipes became
// their own package: `core` owns the CONTRACT (what a recipe is, what a canon
// file is), `@foilkit/patterns` owns the 45 instances of it. @foilkit/patterns
// re-exports every type in this file, so `import type { FoilPattern } from
// '@foilkit/patterns'` keeps working exactly as it did.

export interface PatternParam {
  /** Which uniform this slider drives: 'uP0' … 'uP5'. */
  key: 'uP0' | 'uP1' | 'uP2' | 'uP3' | 'uP4' | 'uP5'
  label: string
  min: number
  max: number
  step: number
  default: number
}

export type CoreDefaults = Partial<
  Record<
    | 'uIntensity' | 'uScale' | 'uHueShift' | 'uHueSpread' | 'uSat' | 'uArtGate' | 'uSpecular' | 'uDarken' | 'uTint' | 'uInkGuard' | 'uInkPop'
    | 'uMetal' | 'uSheen' | 'uSheenTint' | 'uDepth' | 'uGrain',
    number
  >
>

/**
 * Which COMPOSITE family a recipe belongs to — how its light lands on a real
 * card scan (R6 2026-08-07). This is the axis "apply composite to family"
 * propagates along, and the reason a recipe's scan defaults look the way they
 * do. It is deliberately NOT the taxonomy axis: two recipes can model quite
 * different physical processes and still distribute light the same way.
 */
export type FoilFamily = 'flash' | 'line' | 'stamp' | 'field' | 'pearl' | 'metal' | 'none'

export interface FoilPattern {
  id: string
  label: string
  /** Canonical taxonomy name (video + Bulbapedia) this entry models. */
  taxonomy: string
  /** Composite family — see FoilFamily. Must match the constant its
   *  `defaults` spreads; that pairing is the whole contract. */
  family: FoilFamily
  /** Human note: which physical printings use this process. */
  usedOn: string
  /** GLSL body defining `vec3 foilPattern(vec2 uv, vec2 tilt)`. */
  glsl: string
  /** Core-uniform defaults this recipe tunes away from the global defaults. */
  defaults: CoreDefaults
  params: PatternParam[]
  /** True when the recipe faithfully models this physical process. */
  implemented: boolean
  /** For unimplemented types: label of the implemented recipe standing in. */
  approxVia?: string
}

// ── Stored forms ───────────────────────────────────────────────────────────

/**
 * A canon file — `data/foil-canon/<patternId>.json`.
 *
 * A FULL uniform snapshot, not a delta: "this is what the pattern looks like,
 * period." When present it replaces the recipe's code defaults as the baseline.
 *
 * `contract` / `tunedUnderContract` (see composite-contract.json) record which
 * version of the composite law the file is read under and which one its numbers
 * were actually chosen under. When they differ, the file has not been rechecked
 * against the current law — a fact, not an error.
 */
export interface FoilCanonEntry {
  version: 1
  patternId: string
  savedAt: string
  /** FULL uniform snapshot — replaces recipe code defaults as the baseline. */
  uniforms: Record<string, number>
  note?: string
  /** The composite-contract version this file is read under. */
  contract?: number
  /** The composite-contract version its numbers were tuned under. */
  tunedUnderContract?: number
}

/**
 * A per-card override — `data/foil-overrides/<cardId>/<variantId>.json`.
 *
 * SPARSE: only the uniforms that differ from the canon baseline, so untouched
 * uniforms keep tracking canon as it evolves. No override has ever been
 * written; the layer exists, the corpus does not.
 */
export interface FoilOverrideEntry {
  version: 1
  cardId: string
  variantId: number
  /** The effective pattern these overrides tune (canonical id). */
  patternId: string
  /** Explicit dropdown override at save time; null = the resolver chose. */
  patternOverride: string | null
  savedAt: string
  /** SPARSE — only uniforms that differ from the canon baseline. */
  uniforms: Record<string, number>
  baseline: { canonSavedAt: string | null }
}
