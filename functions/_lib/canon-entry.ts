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
