// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// A staged session, as the contribution endpoint wants it.
//
// Pure. No fetch, no clock, no storage — `api.ts` owns the request and this
// file owns the SHAPE, which is what lets the interesting rules be asserted by
// a test rather than hoped for. The interesting rules are all about what the
// client is and is not allowed to say:
//
//   * IT SENDS ITS SEED, NOT A LABEL. `derivation` carries the seed-time
//     `startedFrom` and parent, and the server derives `derivation_method` by
//     diffing the saved pixels against what that seed actually rasterizes to.
//     Same contract as the direct-write path; the staging layer defers the
//     write, it does not reinterpret it.
//
//   * IT SENDS ITS CONFLICT STATE AND WHETHER THE HUMAN SAW IT. The server
//     refuses a stale session that was never acknowledged, and flags an
//     acknowledged one as a supersede in the pull request. The client cannot
//     grant itself the acknowledgement — it can only report the one the human
//     actually gave by pressing Submit with the conflict on screen.
//
//   * ITS DIFF NUMBERS ARE LABELLED PROVISIONAL, EVERY TIME. They ride in their
//     own field, the pull request prints them beside the measured ones and says
//     which is which, and they never enter a sidecar. A provisional number that
//     got written down would eventually be read as a measured one.

import type { ConflictReport } from './conflict.ts'
import type { ProvisionalStats } from './provisionalDiff.ts'
import type { CanonSession, MaskSession } from './types.ts'
import { NotSubmittable } from './session.ts'

/** What the contributor was shown, and whether they acted on it. */
export interface SubmittedConflict {
  kind: string
  /**
   * True only when the report said `conflicted` AND the human pressed Submit
   * with it on screen. A fresh session is `false` because there was nothing to
   * acknowledge, which the server reads correctly — it only requires an
   * acknowledgement when `kind` is not `none`.
   */
  acknowledged: boolean
  detail: string
}

export function submittedConflict(report: ConflictReport | undefined | null): SubmittedConflict {
  if (report === undefined || report === null || !report.conflicted) {
    return { kind: 'none', acknowledged: false, detail: '' }
  }
  // Pressing Submit on a session whose conflict banner is on screen IS the
  // keep-mine choice. The other two choices (take-theirs, re-trace) re-seed the
  // session, which produces a fresh seed and therefore a `none` report — so
  // there is no path that reaches here having silently discarded a conflict.
  return { kind: report.kind, acknowledged: true, detail: report.detail }
}

export interface MaskContribution {
  kind: 'mask'
  cardId: string
  variantId: number
  png: string
  width: number
  height: number
  prior: MaskSession['seed']['prior']
  derivation: { startedFrom: string; parent: { cardId: string; variantId: number } | null }
  seed: {
    parentSha256: string | null
    resolvedFrom: { cardId: string; variantId: number } | null
    seededAt: string
  }
  conflict: SubmittedConflict
  artworkUrl: string | null
  card: MaskSession['card']
  comment: string
  provisional: ProvisionalStats | null
}

export function buildMaskContribution(
  session: MaskSession,
  conflict: ConflictReport | null | undefined,
  provisional: ProvisionalStats | null,
): MaskContribution {
  if (session.png === null) throw new NotSubmittable('this session has no mask pixels yet')
  if (
    !Number.isFinite(session.width) ||
    !Number.isFinite(session.height) ||
    session.width <= 0 ||
    session.height <= 0
  ) {
    throw new NotSubmittable(`bad raster ${session.width}×${session.height}`)
  }
  return {
    kind: 'mask',
    cardId: session.cardId,
    variantId: session.variantId,
    png: session.png,
    width: session.width,
    height: session.height,
    prior: session.seed.prior,
    // THE SEED-TIME VALUES, not the latest save. This is the whole
    // one-correction-per-session mechanism.
    derivation: { startedFrom: session.seed.startedFrom, parent: session.seed.parent },
    seed: {
      parentSha256: session.seed.parentSha256,
      resolvedFrom: session.seed.resolvedFrom,
      seededAt: session.seed.seededAt,
    },
    conflict: submittedConflict(conflict),
    artworkUrl: session.artworkUrl,
    card: session.card,
    comment: session.comment,
    provisional: provisional === null ? null : { ...provisional },
  }
}

export interface CanonContribution {
  kind: 'canon'
  patternId: string
  uniforms: Record<string, number>
  note: string
  comment: string
  conflict: SubmittedConflict
  seedContract: number | null
  seedSha256: string | null
}

export function buildCanonContribution(
  session: CanonSession,
  conflict: ConflictReport | null | undefined,
): CanonContribution {
  if (Object.keys(session.uniforms).length === 0) {
    throw new NotSubmittable('a canon file is a full uniform snapshot; this one is empty')
  }
  return {
    kind: 'canon',
    patternId: session.patternId,
    uniforms: session.uniforms,
    note: session.note,
    comment: session.comment,
    conflict: submittedConflict(conflict),
    seedContract: session.seed.contract,
    seedSha256: session.seed.sha256,
  }
}

// ── What comes back ────────────────────────────────────────────────────────

export interface SubmissionCheck {
  name: string
  ok: boolean
  detail: string
}

export interface SubmissionSuccess {
  ok: true
  /** Null when the session turned out to be byte-identical to upstream. */
  pr: { url: string; number: number; updated: boolean } | null
  branch?: string
  checks: SubmissionCheck[]
  message?: string
}

/**
 * A refusal, in the shape the UI shows it.
 *
 * `kind` exists so the surface can say the right sentence without parsing a
 * message. The three are genuinely different situations for the contributor:
 * `sign-in` is one click away, `not-configured` is nothing they can do and
 * nothing they lost, and `invalid` is a list of things to fix.
 */
export interface SubmissionRefusal {
  ok: false
  kind: 'sign-in' | 'not-configured' | 'invalid' | 'failed'
  message: string
  checks: SubmissionCheck[]
  failures: string[]
  /** For `not-configured`: the variables the deployment is missing. */
  missing: string[]
}

export type SubmissionResult = SubmissionSuccess | SubmissionRefusal
