// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// TWO FIELDS THAT MUST SURVIVE A REWRITE.
//
// Both of these were being dropped on every direct canon write until the two
// write paths (`functions/canon.ts` and `functions/contribute.ts`) started
// sharing one composer, and both failures were silent:
//
//   * `tunedUnderContract` — `tools/parity/data-receipt.mjs` FAILS on a canon
//     file without it. A save that dropped it succeeded, and CI broke on the
//     next push with no obvious connection to the save.
//   * `frozen` — a human's "these numbers are settled". AGENTS.md F4: a machine
//     write may never roll back a human decision. Dropping it is exactly that
//     rollback, performed by a save that looked like it only touched uniforms.
//
// The last test compares the two paths' output byte for byte, because "they
// agree" is the property, not "each one is individually reasonable".

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COMPOSITE_CONTRACT } from '@foilkit/core'

const { composeCanonEntry, normalizeUniforms, parseExisting, sameCanon, serializeCanonEntry } =
  await import('./canon-entry.ts')

const NOW = '2026-09-05T12:00:00.000Z'

test('uniforms are sorted, so two key orderings are the same canon', () => {
  assert.deepEqual(Object.keys(normalizeUniforms({ uScale: 1, uIntensity: 2, uHueShift: 3 })), [
    'uHueShift',
    'uIntensity',
    'uScale',
  ])
})

test('a name that is not a uniform is refused', () => {
  assert.throws(() => normalizeUniforms({ 'rm -rf': 1 }), /is not a uniform/)
})

test('a non-finite value is refused and named', () => {
  assert.throws(() => normalizeUniforms({ uScale: 'banana' }), /uScale/)
})

test('an empty snapshot is refused — a canon file is a full snapshot by definition', () => {
  assert.throws(() => normalizeUniforms({}), /full snapshot/)
})

test('tunedUnderContract is stamped with the current law for a live tuning session', () => {
  const entry = composeCanonEntry({
    patternId: 'cosmos',
    uniforms: { uScale: 1 },
    note: null,
    savedAt: NOW,
    previous: null,
    tunedNow: true,
  })
  assert.equal(entry.tunedUnderContract, COMPOSITE_CONTRACT)
  assert.equal(entry.contract, COMPOSITE_CONTRACT)
})

test('the contract stamp the file already carried is preserved', () => {
  const entry = composeCanonEntry({
    patternId: 'cosmos',
    uniforms: { uScale: 1 },
    note: null,
    savedAt: NOW,
    previous: { contract: 1, tunedUnderContract: 1 },
    tunedNow: false,
  })
  assert.equal(entry.contract, 1)
  assert.equal(entry.tunedUnderContract, 1, 'a mechanical rewrite must not claim a fresh tuning')
})

test('a live re-tune under a newer law bumps tunedUnderContract and says so', () => {
  const entry = composeCanonEntry({
    patternId: 'cosmos',
    uniforms: { uScale: 1 },
    note: null,
    savedAt: NOW,
    previous: { contract: 1, tunedUnderContract: 1 },
    tunedNow: true,
  })
  assert.equal(entry.contract, 1, 'the stamp the file carried is what it is read under')
  assert.equal(entry.tunedUnderContract, COMPOSITE_CONTRACT, 'a human just chose these numbers under the current law')
})

test('FROZEN SURVIVES — a machine write may not roll back a human decision (F4)', () => {
  const entry = composeCanonEntry({
    patternId: 'cosmos',
    uniforms: { uScale: 2 },
    note: null,
    savedAt: NOW,
    previous: { frozen: { at: '2026-08-02', by: 'cheyras' }, contract: 2 },
    tunedNow: true,
  })
  assert.deepEqual(entry.frozen, { at: '2026-08-02', by: 'cheyras' })
})

test('a file with no freeze record does not grow one', () => {
  const entry = composeCanonEntry({
    patternId: 'cosmos',
    uniforms: { uScale: 1 },
    note: null,
    savedAt: NOW,
    previous: { contract: 2 },
    tunedNow: true,
  })
  assert.ok(!('frozen' in entry))
})

test('an unparseable existing file is replaced rather than refused', () => {
  assert.equal(parseExisting(Buffer.from('{ not json', 'utf8')), null)
  assert.equal(parseExisting(null), null)
})

test('a no-op save is detected by meaning, not by bytes — savedAt moves every time', () => {
  const previous = { uniforms: { uScale: 1 }, note: 'a note', contract: 2, tunedUnderContract: 2, savedAt: 'ages ago' }
  const entry = composeCanonEntry({
    patternId: 'cosmos',
    uniforms: { uScale: 1 },
    note: 'a note',
    savedAt: NOW,
    previous,
    tunedNow: true,
  })
  assert.equal(sameCanon(previous, entry), true, 'otherwise every no-op save is a commit')
})

test('a changed uniform is not a no-op', () => {
  const previous = { uniforms: { uScale: 1 }, contract: 2, tunedUnderContract: 2 }
  const entry = composeCanonEntry({
    patternId: 'cosmos',
    uniforms: { uScale: 1.5 },
    note: null,
    savedAt: NOW,
    previous,
    tunedNow: true,
  })
  assert.equal(sameCanon(previous, entry), false)
})

test('the serialised file is two-space JSON with a trailing newline, like the committed corpus', () => {
  const bytes = serializeCanonEntry(
    composeCanonEntry({ patternId: 'cosmos', uniforms: { uScale: 1 }, note: null, savedAt: NOW, previous: null, tunedNow: true }),
  ).toString('utf8')
  assert.ok(bytes.endsWith('}\n'))
  assert.ok(bytes.includes('\n  "patternId": "cosmos"'))
})

test('THE PROPERTY: both write paths produce identical bytes for identical input', () => {
  // `functions/canon.ts` (direct write) and `functions/contribute.ts` (pull
  // request) both call this composer with the same arguments. Two composers
  // would grow two dialects of the same file, and the corpus would carry both.
  const args = {
    patternId: 'cosmos',
    uniforms: { uScale: 1.25, uIntensity: 0.8 },
    note: 'loosened the stagger',
    savedAt: NOW,
    previous: { contract: 2, tunedUnderContract: 2, frozen: true },
    tunedNow: true,
  } as const
  assert.equal(
    serializeCanonEntry(composeCanonEntry({ ...args })).toString('utf8'),
    serializeCanonEntry(composeCanonEntry({ ...args })).toString('utf8'),
  )
})

// ── #10: canon provenance ──────────────────────────────────────────────────
//
// The other corpus a stranger can contribute to. It grows the same four facts a
// sidecar carries — what it started from, what moved, who tuned it, who
// verified it — because a reviewer reading a canon pull request and a mask pull
// request should not have to hold two different models in their head.

const OWNER = { login: 'cheyras', id: 1, via: 'writer-direct' } as const
const STRANGER = { login: 'a-stranger', id: 424242, via: 'contribution-pr' } as const

test('a canon save records WHO tuned it, and the tier follows the capability', () => {
  const byOwner = composeCanonEntry({
    patternId: 'cosmos', uniforms: { uScale: 1 }, note: null, savedAt: NOW, previous: null,
    tunedNow: true, author: OWNER,
  })
  assert.equal(byOwner.provenance?.author?.login, 'cheyras')
  assert.equal(byOwner.provenance?.tier, 'owner-verified')

  const byStranger = composeCanonEntry({
    patternId: 'cosmos', uniforms: { uScale: 1 }, note: null, savedAt: NOW, previous: null,
    tunedNow: true, author: STRANGER,
  })
  assert.equal(byStranger.provenance?.author?.login, 'a-stranger')
  assert.equal(byStranger.provenance?.tier, 'contributor')
})

test('a canon save with no author at all is UNATTRIBUTED, never the owner by default', () => {
  // The conservative direction, and the same one sidecar v5 takes: a block that
  // exists and names nobody was written by something that is not a write path,
  // and "I do not know who" must not read as "the owner".
  const entry = composeCanonEntry({
    patternId: 'cosmos', uniforms: { uScale: 1 }, note: null, savedAt: NOW, previous: null, tunedNow: true,
  })
  assert.equal(entry.provenance?.tier, 'unattributed')
  assert.equal(entry.provenance?.author, null)
})

test('the provenance block says what it started from and what moved', () => {
  const previous = {
    savedAt: '2026-08-01T00:00:00.000Z',
    contract: 2,
    tunedUnderContract: 2,
    uniforms: { uScale: 1, uIntensity: 0.5, uGone: 3 },
  }
  const entry = composeCanonEntry({
    patternId: 'cosmos',
    uniforms: { uScale: 1.25, uIntensity: 0.5, uNew: 9 },
    note: null, savedAt: NOW, previous, tunedNow: true, author: OWNER,
  })
  const p = entry.provenance!
  assert.equal(p.startedFrom?.savedAt, '2026-08-01T00:00:00.000Z')
  assert.equal(p.startedFrom?.uniforms, 3)
  // uScale moved, uNew is new, uIntensity did not move and must not be listed.
  assert.deepEqual(p.changed.keys, ['uNew', 'uScale'])
  assert.deepEqual(p.changed.dropped, ['uGone'])
  assert.equal(p.changed.n, 3)
})

test('a first canon for a pattern says startedFrom: null — different from "nothing moved"', () => {
  const entry = composeCanonEntry({
    patternId: 'cosmos', uniforms: { uScale: 1 }, note: null, savedAt: NOW, previous: null,
    tunedNow: true, author: OWNER,
  })
  assert.equal(entry.provenance?.startedFrom, null)
  assert.deepEqual(entry.provenance?.changed.keys, ['uScale'])
})

test('A VERIFICATION DOES NOT RIDE FORWARD — a canon save is a full replacement', () => {
  // The trap this closes: a canon file is a whole snapshot, so whatever a
  // writer signed off on is not what is in the new file. Carrying the block
  // over would mean the numbers now in the corpus are marked as verified by
  // somebody who has never seen them.
  const previous = {
    savedAt: '2026-08-01T00:00:00.000Z',
    contract: 2,
    uniforms: { uScale: 1 },
    provenance: {
      version: 1 as const,
      startedFrom: null,
      changed: { keys: ['uScale'], dropped: [], n: 1 },
      author: OWNER,
      verification: {
        verifiedBy: 'cheyras', verifiedById: 1, verifiedAt: '2026-08-02T00:00:00.000Z',
        via: 'writer-direct' as const, note: null,
      },
      tier: 'owner-verified' as const,
    },
  }
  const entry = composeCanonEntry({
    patternId: 'cosmos', uniforms: { uScale: 99 }, note: null, savedAt: NOW, previous,
    tunedNow: true, author: STRANGER,
  })
  assert.equal(entry.provenance?.verification, null)
  assert.equal(entry.provenance?.tier, 'contributor')
  // And `frozen` still behaves the way it always did — a different, stronger
  // statement that a machine may not roll back (AGENTS.md F4).
  assert.equal(entry.frozen, undefined)
})
