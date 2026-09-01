// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Conflicts: git's EXPERIENCE, not git's merge.
//
// Git auto-merges text because it can reason about lines. Two people painting
// the same alpha channel have no lines to reason about, and any automatic
// result is plausible-looking garbage that nobody drew and nobody can review.
// So this module DETECTS and DESCRIBES. It never merges, and there is no code
// path here that produces pixels.
//
// TWO COMPARISONS, BOTH REQUIRED.
//
//   1. The sha. `correction.parent.sha256` already pins exact parent bytes;
//      stashing the same number at seed time makes staleness a byte comparison.
//
//   2. The RESOLVED ANSWER. Masks alias across variants by `prior.scope`
//      (`X-Foil-Mask-Alias-Of`): a GET for a variant with no mask of its own
//      resolves to a sibling's. So upstream can grow a *sibling* mask that
//      changes which mask now answers for the staged variant WITHOUT touching
//      the file that was seeded from. A sha comparison against the seeded file
//      misses that entirely. Compare the answer, not the file.
//
// Both comparisons are against the probe's RESOLVED values, which is why the
// probe carries an identity as well as a hash.

import type { MaskSession, CanonSession } from './types.ts'

/** What upstream says right now, resolved through the same aliasing the seed used. */
export interface UpstreamMaskProbe {
  /** sha256 of the mask PNG that answers for this (cardId, variantId, scope) NOW. */
  sha256: string | null
  /** Which record answered. Null when nothing upstream answers. */
  resolvedFrom: { cardId: string; variantId: number } | null
  savedAt: string | null
  /** The server's label for the answering mask — display only, never a claim. */
  method: string | null
}

export interface UpstreamCanonProbe {
  sha256: string | null
  savedAt: string | null
  contract: number | null
}

export type ConflictKind =
  /** Upstream is exactly what it was at seed time. */
  | 'none'
  /** The bytes that answer changed. Somebody saved over it, or a different sibling now answers with different pixels. */
  | 'parent-changed'
  /** Same bytes, different record answering — the alias moved. Pixels agree; provenance does not. */
  | 'alias-moved'
  /** There was a mask at seed time and there is none now. */
  | 'parent-vanished'
  /** There was none at seed time and there is one now — this session was drawn from the layout rule under someone else's mask. */
  | 'parent-appeared'

/** The three choices, and only these three. Never a fourth that merges. */
export type ConflictChoice =
  /**
   * Submit as-is. `writeMaskRecord` reads the parent from disk at write time,
   * so the correction is recorded against CURRENT upstream automatically —
   * "reparented onto current upstream" needs no change to the payload, which
   * is precisely why the staging layer defers the write rather than
   * reinterpreting it. The PR flags it as a supersede.
   */
  | 'keep-mine'
  /** Discard the local session and re-seed from upstream. Destructive; confirmed. */
  | 'take-theirs'
  /** Re-seed from upstream with the local mask ghosted underneath, so the
   *  specific thing the human cared about can be redrawn deliberately. */
  | 're-trace'

export interface ConflictReport {
  kind: ConflictKind
  conflicted: boolean
  /** One sentence, written for the human who is about to choose. */
  detail: string
  choices: ConflictChoice[]
  seed: { sha256: string | null; resolvedFrom: { cardId: string; variantId: number } | null }
  upstream: { sha256: string | null; resolvedFrom: { cardId: string; variantId: number } | null }
}

function sameRef(
  a: { cardId: string; variantId: number } | null,
  b: { cardId: string; variantId: number } | null,
): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return a.cardId === b.cardId && a.variantId === b.variantId
}

function refLabel(r: { cardId: string; variantId: number } | null): string {
  return r === null ? 'nothing' : `${r.cardId}/${r.variantId}`
}

const ALL_CHOICES: ConflictChoice[] = ['keep-mine', 'take-theirs', 're-trace']

/**
 * Compare a staged mask session's seed against what upstream answers now.
 *
 * Pure: no fetch, no clock, no storage. The caller does the probe.
 */
export function detectMaskConflict(session: MaskSession, probe: UpstreamMaskProbe): ConflictReport {
  const seed = { sha256: session.seed.parentSha256, resolvedFrom: session.seed.resolvedFrom }
  const upstream = { sha256: probe.sha256, resolvedFrom: probe.resolvedFrom }
  const base = { seed, upstream }

  if (seed.sha256 === null && upstream.sha256 === null) {
    return {
      ...base,
      kind: 'none',
      conflicted: false,
      detail: 'Nothing upstream when you started, nothing upstream now. Your save creates the first mask here.',
      choices: [],
    }
  }

  if (seed.sha256 === null && upstream.sha256 !== null) {
    return {
      ...base,
      kind: 'parent-appeared',
      conflicted: true,
      detail:
        `You started from the layout rule, but ${refLabel(upstream.resolvedFrom)} now answers for this printing ` +
        `(saved ${probe.savedAt ?? 'at an unrecorded time'}${probe.method ? `, ${probe.method}` : ''}). ` +
        'Submitting will record your mask as a correction of theirs rather than as a first mask.',
      choices: ALL_CHOICES,
    }
  }

  if (seed.sha256 !== null && upstream.sha256 === null) {
    return {
      ...base,
      kind: 'parent-vanished',
      conflicted: true,
      detail:
        `The mask you started from (${refLabel(seed.resolvedFrom)}) is no longer upstream. ` +
        'Your work is intact; it will be recorded as a first mask rather than as a correction.',
      // Take-theirs would re-seed from nothing, which is the layout rule — a
      // real choice, and the only way to start clean from what is there now.
      choices: ALL_CHOICES,
    }
  }

  if (seed.sha256 !== upstream.sha256) {
    return {
      ...base,
      kind: 'parent-changed',
      conflicted: true,
      detail:
        `Upstream changed while you were working: ${refLabel(upstream.resolvedFrom)} now answers with different ` +
        `pixels (saved ${probe.savedAt ?? 'at an unrecorded time'}). Nothing is merged automatically — two people ` +
        'painting the same alpha channel have no lines to merge.',
      choices: ALL_CHOICES,
    }
  }

  if (!sameRef(seed.resolvedFrom, upstream.resolvedFrom)) {
    // THE SUBTLE CASE. Identical bytes, different record. The pixels are not in
    // conflict; the provenance parent is, and a correction recorded against the
    // wrong parent is a lie in the training signal.
    return {
      ...base,
      kind: 'alias-moved',
      conflicted: true,
      detail:
        `The pixels upstream are unchanged, but a different record answers for this printing now — ` +
        `${refLabel(seed.resolvedFrom)} at seed time, ${refLabel(upstream.resolvedFrom)} now. Your mask would be ` +
        'recorded as a correction of a different parent than the one you were shown.',
      choices: ALL_CHOICES,
    }
  }

  return {
    ...base,
    kind: 'none',
    conflicted: false,
    detail: 'Upstream is exactly what it was when you started.',
    choices: [],
  }
}

/**
 * Canon sessions conflict on the same principle with a smaller surface: a canon
 * file is a full uniform snapshot, per pattern, global. There is no aliasing, so
 * the sha alone is the whole comparison.
 */
export function detectCanonConflict(session: CanonSession, probe: UpstreamCanonProbe): ConflictReport {
  const seed = { sha256: session.seed.sha256, resolvedFrom: null }
  const upstream = { sha256: probe.sha256, resolvedFrom: null }
  const base = { seed, upstream }

  if (seed.sha256 === probe.sha256) {
    return { ...base, kind: 'none', conflicted: false, detail: 'Upstream canon is unchanged.', choices: [] }
  }
  if (seed.sha256 === null) {
    return {
      ...base,
      kind: 'parent-appeared',
      conflicted: true,
      detail: `${session.patternId} had no canon file when you started; one exists now.`,
      choices: ['keep-mine', 'take-theirs'],
    }
  }
  if (probe.sha256 === null) {
    return {
      ...base,
      kind: 'parent-vanished',
      conflicted: true,
      detail: `${session.patternId}'s canon file is no longer upstream. Your snapshot would create it again.`,
      choices: ['keep-mine', 'take-theirs'],
    }
  }
  return {
    ...base,
    kind: 'parent-changed',
    conflicted: true,
    detail:
      `${session.patternId}'s canon changed upstream while you were tuning` +
      `${probe.contract !== null && probe.contract !== session.seed.contract ? ` (contract ${session.seed.contract} → ${probe.contract})` : ''}. ` +
      'A canon file is a full snapshot, so keeping yours replaces theirs wholesale.',
    // Re-trace is a pixel gesture; there is nothing to ghost under a slider.
    choices: ['keep-mine', 'take-theirs'],
  }
}
