// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// What a canon file IS on disk, composed in one place.
//
// Two write paths reach a canon file now — the maintainer's direct PUT
// (`functions/canon.ts`) and a contributor's pull request
// (`functions/contribute.ts`) — and they must produce the same bytes for the
// same uniforms or the corpus grows two dialects of the same file.
//
// TWO FIELDS THAT MUST SURVIVE A REWRITE, both learned from the committed
// corpus rather than invented here:
//
//   * `tunedUnderContract`. `tools/parity/data-receipt.mjs` FAILS on a canon
//     file that does not carry it, and all 32 committed files do. A save that
//     dropped it would land a file that breaks CI on the next push — quietly,
//     because the write itself would succeed.
//
//   * `frozen`. That is a human decision — "these numbers are settled, stop
//     re-tuning them" — and AGENTS.md F4 says a machine write may never
//     overwrite one. Dropping it on a rewrite is exactly the silent rollback
//     that contract exists to forbid.
//
// Neither was preserved before this module existed. Both are now, for both
// paths, because the composition is one function.

import { COMPOSITE_CONTRACT } from '@foilkit/core'
import {
  FIRST_ATTRIBUTED_VERSION,
  deriveTier,
  type AuthorIdentity,
  type ProvenanceTier,
  type VerificationRecord,
} from '@foilkit/forge'

/**
 * A THIRD FIELD THAT MUST SURVIVE A REWRITE (#10): `provenance`.
 *
 * A canon file is the other thing a stranger can contribute, and until now it
 * recorded WHAT was tuned and under which contract but never WHO tuned it or
 * whether anybody with the capability had looked. The mask corpus grew that
 * distinction in sidecar v5 and the two corpora should not answer the same
 * question differently — a reviewer reading a canon PR and a mask PR should be
 * reading the same four facts.
 *
 * ── WEIGHT SEMANTICS, WHICH DIFFER FROM A MASK'S AND SAY SO ────────────────
 *
 * A mask's tier gates an EXEMPLAR WEIGHT, because masks are training input:
 * `selectExemplars` reads the tier and an unverified one carries 0. A canon
 * file is not training input for anything. It is a full uniform snapshot that
 * is either the recorded canon for its pattern or it is not, so there is no
 * weight to discount and this block carries NO numeric weight at all — it
 * carries attribution and a review state.
 *
 * What the tier means here is therefore narrower and worth stating plainly:
 *
 *   `owner-verified`  a writer tuned these numbers, or verified them. This is
 *                     the state every committed canon file is in today.
 *   `contributor`     a merged contribution. The numbers ARE the canon — they
 *                     render, they are served, `hasCanon` is true — and no
 *                     writer has separately signed them off.
 *   `unattributed`    no author recorded on a block that should carry one.
 *
 * `frozen` remains the STRONGER statement and is unaffected: verification says
 * "I have looked and this is right", `frozen` says "stop re-tuning this". A
 * writer can verify a file without freezing it, and every frozen file was
 * necessarily verified by the person who froze it.
 */
export interface CanonProvenance {
  version: 1
  /**
   * The file this snapshot replaced, summarised. Null when the pattern had no
   * canon — which is a real and different answer from "it had one and nothing
   * moved", and the reviewer needs to be able to tell them apart.
   */
  startedFrom: {
    savedAt: string | null
    contract: number | null
    tunedUnderContract: number | null
    uniforms: number
  } | null
  /** WHAT CHANGED, as keys rather than prose. The reviewer's first question. */
  changed: {
    /** Keys whose value moved, or that are new. Sorted. */
    keys: string[]
    /** Keys the previous file had and this one does not. Sorted. */
    dropped: string[]
    n: number
  }
  /** Recorded server-side from a verified identity. Never from a body. */
  author: AuthorIdentity | null
  /** Only ever written by a writer-gated route. Honoured only for a writer. */
  verification: VerificationRecord | null
  /** DERIVED from the two above; recomputed rather than read. */
  tier: ProvenanceTier
}

export interface CanonEntry {
  version: 1
  patternId: string
  savedAt: string
  uniforms: Record<string, number>
  contract?: number
  /** The law the numbers were CHOSEN under. Differs from `contract` when the
   *  ground moved and nobody has rechecked the file since. */
  tunedUnderContract?: number
  /** A human's "settled". Carried through untouched; never set by a machine. */
  frozen?: unknown
  /** #10: who tuned it, what it started from, what moved, who verified it. */
  provenance?: CanonProvenance
  note?: string
}

/** Sorted keys, finite numbers only. Two orderings are the same canon. */
export function normalizeUniforms(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null) throw new Error('uniforms must be an object')
  const out: Record<string, number> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (!/^u[A-Za-z0-9]{1,32}$/.test(key)) throw new Error(`uniform name ${JSON.stringify(key)} is not a uniform`)
    const n = Number((value as Record<string, unknown>)[key])
    if (!Number.isFinite(n)) throw new Error(`uniform ${key} is not a finite number`)
    out[key] = n
  }
  if (Object.keys(out).length === 0) throw new Error('a canon file is a full snapshot; this one is empty')
  return out
}

/** The file that was there before, parsed leniently. */
export function parseExisting(bytes: Buffer | null): Partial<CanonEntry> | null {
  if (bytes === null) return null
  try {
    return JSON.parse(bytes.toString('utf8')) as Partial<CanonEntry>
  } catch {
    // An unparseable existing file is replaced, not preserved. There is nothing
    // in it to carry forward and refusing would strand the pattern.
    return null
  }
}

export interface ComposeInput {
  patternId: string
  uniforms: unknown
  note: string | null
  savedAt: string
  /** The parsed previous file, when there was one. */
  previous: Partial<CanonEntry> | null
  /** Explicit contract stamp from the caller; usually absent. */
  contract?: number | undefined
  /**
   * True when the numbers were chosen against the CURRENT law — which is what a
   * live editing session always is. False would mean a mechanical rewrite, and
   * nothing here does one.
   */
  tunedNow: boolean
  /**
   * WHO IS SAVING, from an identity the caller has already verified. Same trust
   * model as the mask path's `author`: the route knows, the client does not get
   * to say, and `validate.ts` refuses a body that tries. Omitted only by
   * callers that have no session at all (a mechanical rewrite), which then
   * compose an `unattributed` block rather than a silently owner-shaped one.
   */
  author?: AuthorIdentity | null
}

/** The uniform keys that moved, and the ones that went away. Both sorted. */
function diffUniforms(
  previous: Record<string, number> | null,
  next: Record<string, number>,
): CanonProvenance['changed'] {
  const keys = Object.keys(next)
    .filter((k) => previous === null || previous[k] !== next[k])
    .sort()
  const dropped = previous === null ? [] : Object.keys(previous).filter((k) => !(k in next)).sort()
  return { keys, dropped, n: keys.length + dropped.length }
}

export function composeCanonEntry(input: ComposeInput): CanonEntry {
  const previous = input.previous
  const entry: CanonEntry = {
    version: 1,
    patternId: input.patternId,
    savedAt: input.savedAt,
    uniforms: normalizeUniforms(input.uniforms),
  }
  // The contract stamp the file already carried is preserved when the caller
  // does not supply one. Dropping it would turn a file that names its `main()`
  // into one that does not, which is the exact silence the stamp exists to end.
  const contract =
    typeof input.contract === 'number'
      ? input.contract
      : typeof previous?.contract === 'number'
        ? previous.contract
        : COMPOSITE_CONTRACT
  entry.contract = contract
  entry.tunedUnderContract = input.tunedNow
    ? COMPOSITE_CONTRACT
    : typeof previous?.tunedUnderContract === 'number'
      ? previous.tunedUnderContract
      : contract
  if (previous?.frozen !== undefined) entry.frozen = previous.frozen

  // ── The provenance block (#10) ───────────────────────────────────────────
  //
  // A canon save is a REPLACEMENT — the file is a full snapshot, so there is
  // nothing to merge — and that is exactly why the verification does NOT ride
  // forward: whatever a writer signed off on is not what is in this file any
  // more. A new snapshot is unverified, whoever wrote it, and it is
  // `owner-verified` only when its author holds the capability, which
  // `deriveTier` decides from the author rather than from a block anybody
  // could have carried over.
  const author = input.author ?? null
  const previousUniforms =
    previous?.uniforms && typeof previous.uniforms === 'object'
      ? (previous.uniforms as Record<string, number>)
      : null
  entry.provenance = {
    version: 1,
    startedFrom:
      previous === null
        ? null
        : {
            savedAt: typeof previous.savedAt === 'string' ? previous.savedAt : null,
            contract: typeof previous.contract === 'number' ? previous.contract : null,
            tunedUnderContract:
              typeof previous.tunedUnderContract === 'number' ? previous.tunedUnderContract : null,
            uniforms: previousUniforms === null ? 0 : Object.keys(previousUniforms).length,
          },
    changed: diffUniforms(previousUniforms, entry.uniforms),
    author,
    verification: null,
    // `FIRST_ATTRIBUTED_VERSION` puts this on the CONSERVATIVE side of
    // `deriveTier`'s version test, which is where it belongs: the historical
    // branch exists for records that predate authorship being recorded at all,
    // and a canon provenance block only exists from #10 on. So a block naming
    // no author is `unattributed` here, never the owner by default.
    tier: deriveTier(FIRST_ATTRIBUTED_VERSION, author, null),
  }

  if (input.note !== null) entry.note = input.note
  return entry
}

/** The bytes. Two spaces and a trailing newline, matching the committed files. */
export function serializeCanonEntry(entry: CanonEntry): Buffer {
  return Buffer.from(JSON.stringify(entry, null, 2) + '\n', 'utf8')
}

/**
 * Is this write a no-op?
 *
 * `savedAt` moves on every write, so the comparison is over the parts that
 * carry meaning. Otherwise every save is a commit and the history stops being
 * a record of changes.
 */
export function sameCanon(previous: Partial<CanonEntry> | null, entry: CanonEntry): boolean {
  if (previous === null) return false
  return (
    JSON.stringify(previous.uniforms ?? {}) === JSON.stringify(entry.uniforms) &&
    (previous.note ?? null) === (entry.note ?? null) &&
    (previous.contract ?? null) === (entry.contract ?? null) &&
    (previous.tunedUnderContract ?? null) === (entry.tunedUnderContract ?? null)
  )
}
