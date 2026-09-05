// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// What a staged session IS.
//
// The single biggest architectural change in the project: `foil-lab.ts` used to
// write masks straight into a working tree, which is why the lab felt fast —
// saves were instant. A PR is not instant, and a contributor cannot write to
// the repository at all. So a session is the unit of deferred work, and this
// file is the shape of it.
//
// THE RULES ENCODED HERE, each of which cost a decision:
//
//  * A session is ONE CARD (or, for canon, one PATTERN). Ten cards worked in a
//    sitting is ten sessions and — once #9's pipeline exists — ten PRs.
//
//  * ONE CORRECTION PER SESSION. Today every Save rewrote `session` so the mask
//    just written became the parent of the next one: ten saves produced ten
//    correction records, ten parent PNGs, ten diffs. Batching collapses that to
//    one — staged-final versus what was upstream when the session was seeded —
//    which is the honest unit anyway: *this is what the human changed relative
//    to what they were given.* The intermediate states were scaffolding.
//
//  * THE CLIENT NEVER LABELS A MASK. `derivation_method`, `agreement` and the
//    diff artifacts are derived server-side by `writeMaskRecord`, which diffs
//    the saved pixels against what the declared seed actually rasterizes to. A
//    staged session therefore carries NO derivation method and NO agreement
//    number until it is submitted. That is correct behaviour, not a gap — see
//    `provisionalDiff.ts` for the honest client-side approximation, which is
//    labelled provisional everywhere it is shown.
//
//  * THE UNDO STACK IS NOT PERSISTED. `MaskEditor` keeps 12 ImageData
//    snapshots at canonical size, ~1.4 MB each — roughly 16 MB per card. Mask
//    PNGs average 7.7 KB. Persisting current pixels + seed + parent sha costs
//    kilobytes; persisting the history costs three orders of magnitude more to
//    preserve a 12-step undo through a tab close. Bad trade, declined.

import type { FoilMaskPrior } from '../api.ts'

export const SESSION_VERSION = 1 as const

/** The two session types. A canon file is per-PATTERN and global — it does not
 *  belong to any card, so it cannot ride the one-session-per-card rule. Same
 *  staging machinery, its own key, its own PR. */
export type SessionKind = 'mask' | 'canon'

/**
 * What the editing session was SEEDED with, captured once, at seed time, and
 * never rewritten by an intermediate save. This is the entire provenance claim
 * the client is allowed to make.
 */
export interface SessionSeed {
  /** The client's one allowed claim. Not a label — see the module header. */
  startedFrom: 'layout' | 'window-bake' | 'mask'
  /**
   * The upstream mask this session started from, as the client asked for it.
   * `null` for a layout or window-bake seed.
   */
  parent: { cardId: string; variantId: number } | null
  /**
   * Which mask ACTUALLY answered at seed time. Masks alias across variants by
   * `prior.scope` (`X-Foil-Mask-Alias-Of`), so the file that answered is often
   * not the file that was asked for — and upstream can grow a *sibling* mask
   * that changes which one answers without touching the file we seeded from.
   * Comparing this, not just the sha, is what catches that case.
   */
  resolvedFrom: { cardId: string; variantId: number } | null
  /** sha256 of the resolved parent PNG at seed time. The staleness pin. */
  parentSha256: string | null
  /** The deterministic era-rule prior in effect at seed time. */
  prior: FoilMaskPrior
  seededAt: string
}

export interface SessionCardContext {
  setId: string | null
  seriesSlug: string | null
  name: string | null
  number: string | null
}

/** Adjusted window geometry — the `WindowEditor` state, staged rather than PUT. */
export interface SessionWindow {
  scope: string
  eraId: string
  rect: [number, number, number, number]
  radius: number
  invert: boolean
  base: { rect: [number, number, number, number]; radius: number; resolverVersion: number }
}

export interface MaskSession {
  version: typeof SESSION_VERSION
  kind: 'mask'
  /** `mask:<cardId>:<variantId>` — the primary key, and the IndexedDB key. */
  id: string
  cardId: string
  variantId: number
  card: SessionCardContext | null
  artworkUrl: string | null
  seed: SessionSeed
  /**
   * Current mask state. A PNG data URL today — the exact thing `putMask` takes.
   * Vector paths land here as a second representation once the pen tool ships;
   * that changes what a session HOLDS and nothing about how it is staged.
   */
  png: string | null
  width: number
  height: number
  /** Adjusted window geometry, or null when the era rule was left alone. */
  window: SessionWindow | null
  /** Per-card uniform overrides — sparse, against the canon baseline. */
  uniforms: Record<string, number>
  /** Explicit pattern override at stage time; null = the resolver's answer. */
  patternOverride: string | null
  /** The effective pattern, recorded so a stale resolver is detectable. */
  patternId: string | null
  /**
   * The contributor's note about their own change. This BECOMES THE PULL
   * REQUEST BODY — a stranger's note about their own work belongs in the
   * review, not committed into the tree as `issues/foil/<id>/report.md`. It is
   * stored here, included in the export, and sent to `/api/contribute` at
   * submit; it is deliberately NOT committed anywhere.
   */
  comment: string
  createdAt: string
  updatedAt: string
}

export interface CanonSession {
  version: typeof SESSION_VERSION
  kind: 'canon'
  /** `canon:<patternId>`. */
  id: string
  patternId: string
  seed: {
    /** The canon uniforms in effect at seed time — the full snapshot. */
    uniforms: Record<string, number>
    savedAt: string | null
    /** sha256 over the canonicalised seed uniforms. The staleness pin. */
    sha256: string | null
    /** The composite contract the seed was tuned against. */
    contract: number | null
    seededAt: string
  }
  /** Current uniforms — a FULL snapshot, as a canon file always is. */
  uniforms: Record<string, number>
  note: string
  comment: string
  createdAt: string
  updatedAt: string
}

export type StagedSession = MaskSession | CanonSession

export function maskSessionId(cardId: string, variantId: number): string {
  return `mask:${cardId}:${variantId}`
}

export function canonSessionId(patternId: string): string {
  return `canon:${patternId}`
}

/**
 * DELETIONS ARE NOT STAGEABLE IN v1.
 *
 * `deleteMask` / `deleteWindow` / `deleteCanon` are live affordances in the
 * owner's direct-write path and stay there. They are absent from the staging
 * layer on purpose: a contributor's first available action should not be
 * removing ground truth, and a deletion has no diff to review — the PR would
 * be an empty file and a claim. Re-open it when there is a reviewer flow that
 * can weigh one.
 */
export const DELETIONS_STAGEABLE = false
