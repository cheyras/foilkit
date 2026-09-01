// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Seeding a session, updating one, and turning one into the SINGLE write it
// becomes.
//
// Everything in this file is pure. No storage, no fetch, no `Date.now()` — the
// clock is an argument. That is what lets the interesting rules (one correction
// per session, the seed is captured once and never rewritten, the client never
// labels a mask) be asserted by a test rather than hoped for.

import type { FoilMaskDerivation, FoilMaskPrior } from '../api.ts'
import {
  SESSION_VERSION,
  canonSessionId,
  maskSessionId,
  type CanonSession,
  type MaskSession,
  type SessionCardContext,
  type SessionSeed,
  type SessionWindow,
  type StagedSession,
} from './types.ts'

export interface SeedMaskInput {
  cardId: string
  variantId: number
  card: SessionCardContext | null
  artworkUrl: string | null
  /** What the canvas was seeded with. The client's one allowed claim. */
  startedFrom: SessionSeed['startedFrom']
  /** The upstream mask asked for — null for a layout or window-bake seed. */
  parent: { cardId: string; variantId: number } | null
  /** Which record actually answered (X-Foil-Mask-Alias-Of), and its sha. */
  resolvedFrom: { cardId: string; variantId: number } | null
  parentSha256: string | null
  prior: FoilMaskPrior
  width: number
  height: number
  png: string | null
  patternId: string | null
  now: string
}

export function seedMaskSession(input: SeedMaskInput): MaskSession {
  return {
    version: SESSION_VERSION,
    kind: 'mask',
    id: maskSessionId(input.cardId, input.variantId),
    cardId: input.cardId,
    variantId: input.variantId,
    card: input.card,
    artworkUrl: input.artworkUrl,
    seed: {
      startedFrom: input.startedFrom,
      parent: input.parent,
      resolvedFrom: input.resolvedFrom,
      parentSha256: input.parentSha256,
      prior: input.prior,
      seededAt: input.now,
    },
    png: input.png,
    width: input.width,
    height: input.height,
    window: null,
    uniforms: {},
    patternOverride: null,
    patternId: input.patternId,
    comment: '',
    createdAt: input.now,
    updatedAt: input.now,
  }
}

export interface MaskSessionPatch {
  png?: string | null
  window?: SessionWindow | null
  uniforms?: Record<string, number>
  patternOverride?: string | null
  patternId?: string | null
  comment?: string
}

/**
 * Update a staged mask. The SEED IS IMMUTABLE HERE, and that is the point:
 * today every Save rewrote the session so the mask just written became the
 * parent of the next one, producing ten correction records for ten saves. This
 * function has no path to `seed` at all, so the collapse to one correction is
 * structural rather than a discipline somebody has to keep.
 */
export function updateMaskSession(session: MaskSession, patch: MaskSessionPatch, now: string): MaskSession {
  return {
    ...session,
    png: patch.png !== undefined ? patch.png : session.png,
    window: patch.window !== undefined ? patch.window : session.window,
    uniforms: patch.uniforms !== undefined ? { ...patch.uniforms } : session.uniforms,
    patternOverride: patch.patternOverride !== undefined ? patch.patternOverride : session.patternOverride,
    patternId: patch.patternId !== undefined ? patch.patternId : session.patternId,
    comment: patch.comment !== undefined ? patch.comment : session.comment,
    updatedAt: now,
  }
}

export interface SeedCanonInput {
  patternId: string
  /** The canon uniforms in effect at seed time — a full snapshot. */
  uniforms: Record<string, number>
  savedAt: string | null
  sha256: string | null
  contract: number | null
  now: string
}

export function seedCanonSession(input: SeedCanonInput): CanonSession {
  return {
    version: SESSION_VERSION,
    kind: 'canon',
    id: canonSessionId(input.patternId),
    patternId: input.patternId,
    seed: {
      uniforms: { ...input.uniforms },
      savedAt: input.savedAt,
      sha256: input.sha256,
      contract: input.contract,
      seededAt: input.now,
    },
    uniforms: { ...input.uniforms },
    note: '',
    comment: '',
    createdAt: input.now,
    updatedAt: input.now,
  }
}

export function updateCanonSession(
  session: CanonSession,
  patch: { uniforms?: Record<string, number>; note?: string; comment?: string },
  now: string,
): CanonSession {
  return {
    ...session,
    uniforms: patch.uniforms !== undefined ? { ...patch.uniforms } : session.uniforms,
    note: patch.note !== undefined ? patch.note : session.note,
    comment: patch.comment !== undefined ? patch.comment : session.comment,
    updatedAt: now,
  }
}

/**
 * Re-seed after a conflict.
 *
 * `take-theirs` and `re-trace` are the same operation with a different answer
 * to "what happens to the pixels": take-theirs drops them, re-trace keeps them
 * as a GHOST — a layer drawn underneath the fresh upstream mask so the specific
 * thing the human cared about can be redrawn deliberately, rather than
 * blended in by a machine that cannot see what it was for.
 *
 * The ghost is never submitted. It is not part of the payload; it exists to be
 * looked at.
 */
export interface ReseedResult {
  session: MaskSession
  /** The old pixels, for the ghost layer. Null for take-theirs. */
  ghostPng: string | null
}

export function reseedMaskSession(
  session: MaskSession,
  fresh: Omit<SeedMaskInput, 'card' | 'artworkUrl' | 'patternId'>,
  mode: 'take-theirs' | 're-trace',
): ReseedResult {
  const next = seedMaskSession({
    ...fresh,
    card: session.card,
    artworkUrl: session.artworkUrl,
    patternId: session.patternId,
  })
  return {
    session: {
      ...next,
      // The human's words about their own work survive a re-seed. Their pixels
      // may not; their reasoning always does.
      comment: session.comment,
      window: session.window,
      uniforms: session.uniforms,
      patternOverride: session.patternOverride,
      createdAt: session.createdAt,
    },
    ghostPng: mode === 're-trace' ? session.png : null,
  }
}

// ── Submission ─────────────────────────────────────────────────────────────

export interface MaskSubmission {
  cardId: string
  variantId: number
  png: string
  width: number
  height: number
  prior: FoilMaskPrior
  /**
   * `{ startedFrom, parent }` — the SEED-TIME values, not the latest save.
   *
   * This is the whole one-correction-per-session mechanism, and the valuable
   * part is that it needs no change to the provenance contract at all:
   * `writeMaskRecord` reads the parent from disk at write time and derives
   * `derivation_method` by diffing the saved pixels against what this seed
   * actually rasterizes to. The staging layer DEFERS the write. It does not
   * reinterpret it.
   */
  derivation: FoilMaskDerivation
  artworkUrl: string | null
  card: SessionCardContext | null
  /** Not written to the tree — carried so #9 can put it in the PR body. */
  comment: string
}

export class NotSubmittable extends Error {}

export function buildMaskSubmission(session: MaskSession): MaskSubmission {
  if (session.png === null) {
    throw new NotSubmittable('this session has no mask pixels yet')
  }
  if (!Number.isFinite(session.width) || !Number.isFinite(session.height) || session.width <= 0 || session.height <= 0) {
    throw new NotSubmittable(`bad raster ${session.width}×${session.height}`)
  }
  return {
    cardId: session.cardId,
    variantId: session.variantId,
    png: session.png,
    width: session.width,
    height: session.height,
    prior: session.seed.prior,
    derivation: { startedFrom: session.seed.startedFrom, parent: session.seed.parent },
    artworkUrl: session.artworkUrl,
    card: session.card,
    comment: session.comment,
  }
}

export interface CanonSubmission {
  patternId: string
  uniforms: Record<string, number>
  note: string
  comment: string
}

export function buildCanonSubmission(session: CanonSession): CanonSubmission {
  if (Object.keys(session.uniforms).length === 0) {
    throw new NotSubmittable('a canon file is a full uniform snapshot; this one is empty')
  }
  return {
    patternId: session.patternId,
    uniforms: session.uniforms,
    note: session.note,
    comment: session.comment,
  }
}

/**
 * Has anything actually been changed? A session that was opened and closed is
 * not a contribution, and offering to submit one wastes a reviewer's time.
 */
export function isDirty(session: StagedSession): boolean {
  if (session.kind === 'canon') {
    const a = session.seed.uniforms
    const b = session.uniforms
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of keys) if (a[k] !== b[k]) return true
    return session.note.trim().length > 0 || session.comment.trim().length > 0
  }
  return (
    session.png !== null ||
    session.window !== null ||
    Object.keys(session.uniforms).length > 0 ||
    session.patternOverride !== null ||
    session.comment.trim().length > 0
  )
}
