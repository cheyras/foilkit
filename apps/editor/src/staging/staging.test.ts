// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The staging layer's invariants. These are the rules the whole contribution
// flow rests on, so they are asserted rather than described:
//
//   * the seed is captured once and no update path can rewrite it
//   * one submission carries seed-time provenance, whatever happened in between
//   * a conflict is detected by BOTH the sha and the resolved answer
//   * nothing here ever merges two masks
//   * an imported bundle cannot smuggle in a session the editor would submit

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { FoilMaskPrior } from '../api.ts'
import {
  buildCanonSubmission,
  buildMaskSubmission,
  isDirty,
  NotSubmittable,
  reseedMaskSession,
  seedCanonSession,
  seedMaskSession,
  updateCanonSession,
  updateMaskSession,
} from './session.ts'
import { buildMaskContribution } from './submit.ts'
import { detectCanonConflict, detectMaskConflict } from './conflict.ts'
import { canonicalUniforms, dataUrlToBytes, sha256Bytes, sha256Text, sha256Uniforms } from './sha.ts'
import { memorySessionStore } from './store.ts'
import { BadBundle, buildBundle, bundleFilename, parseBundle, planImport } from './portable.ts'
import { maskSessionId, canonSessionId } from './types.ts'
import type { MaskSession } from './types.ts'

const T0 = '2026-09-01T10:00:00.000Z'
const T1 = '2026-09-01T10:05:00.000Z'
const T2 = '2026-09-01T10:30:00.000Z'

const PRIOR: FoilMaskPrior = {
  source: 'layout',
  eraId: 'wotc',
  scope: 'window',
  rect: [0.0714, 0.5, 0.857, 0.34],
  radius: 0.02,
  invert: false,
  feather: 0.008,
  resolverVersion: 5,
}

/** A 1×1 transparent PNG, base64. Enough to be a real data URL in a test. */
const PNG_A =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG_B =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z/C/HgAGgwJ/lK3Q6wAAAABJRU5ErkJggg=='

function seed(over: Partial<Parameters<typeof seedMaskSession>[0]> = {}): MaskSession {
  return seedMaskSession({
    cardId: 'base1-4',
    variantId: 1,
    card: { setId: 'base1', seriesSlug: 'base', name: 'Fixture Alpha', number: '4' },
    artworkUrl: 'https://fixture.invalid/base1/4/high.webp',
    startedFrom: 'mask',
    parent: { cardId: 'base1-4', variantId: 1 },
    resolvedFrom: { cardId: 'base1-4', variantId: 1 },
    parentSha256: 'aaaa',
    prior: PRIOR,
    width: 504,
    height: 704,
    png: null,
    patternId: 'cosmos',
    now: T0,
    ...over,
  })
}

// ── The seed is immutable, and one save is one correction ──────────────────

test('the seed survives every intermediate save — ten saves are one correction', () => {
  let s = seed()
  // Ten saves, the way the old lab worked: each one used to rewrite `session`
  // so the mask just written became the parent of the next.
  for (let i = 0; i < 10; i++) {
    s = updateMaskSession(s, { png: i % 2 === 0 ? PNG_A : PNG_B }, T1)
  }
  assert.equal(s.seed.parentSha256, 'aaaa', 'seed sha was rewritten by a save')
  assert.deepEqual(s.seed.parent, { cardId: 'base1-4', variantId: 1 })
  assert.equal(s.seed.seededAt, T0)

  const sub = buildMaskSubmission(s)
  assert.deepEqual(
    sub.derivation,
    { startedFrom: 'mask', parent: { cardId: 'base1-4', variantId: 1 } },
    'the single PUT must carry SEED-TIME provenance, not the latest save',
  )
  assert.equal(sub.png, PNG_B)
})

test('updateMaskSession has no path to the seed at all', () => {
  const s = seed()
  // The patch type does not admit a `seed` key; passing one anyway must not
  // reach the result. This is the structural half of the guarantee above.
  const sneaky = updateMaskSession(s, { seed: { parentSha256: 'zzzz' } } as never, T1)
  assert.equal(sneaky.seed.parentSha256, 'aaaa')
})

test('a session with no pixels is not submittable', () => {
  assert.throws(() => buildMaskSubmission(seed()), NotSubmittable)
  assert.throws(() => buildMaskSubmission(seed({ png: PNG_A, width: 0 })), NotSubmittable)
})

test('the client never labels a mask — no derivation_method anywhere in a session or a payload', () => {
  const s = updateMaskSession(seed(), { png: PNG_A, comment: 'traced the window bevel' }, T1)
  const json = JSON.stringify({ session: s, submission: buildMaskSubmission(s) })
  for (const forbidden of ['derivation_method', 'reviewStatus', 'agreement', 'authorship']) {
    assert.ok(!json.includes(forbidden), `a staged session must not carry ${forbidden}`)
  }
})

test('isDirty distinguishes an opened session from a worked one', () => {
  assert.equal(isDirty(seed()), false)
  assert.equal(isDirty(updateMaskSession(seed(), { png: PNG_A }, T1)), true)
  assert.equal(isDirty(updateMaskSession(seed(), { comment: 'note' }, T1)), true)
  assert.equal(isDirty(updateMaskSession(seed(), { comment: '   ' }, T1)), false)
})

// ── Conflicts ──────────────────────────────────────────────────────────────

test('no conflict when the resolved answer is byte- and identity-identical', () => {
  const r = detectMaskConflict(seed(), {
    sha256: 'aaaa',
    resolvedFrom: { cardId: 'base1-4', variantId: 1 },
    savedAt: T0,
    method: 'hand',
  })
  assert.equal(r.kind, 'none')
  assert.equal(r.conflicted, false)
  assert.deepEqual(r.choices, [])
})

test('parent-changed: the bytes that answer moved', () => {
  const r = detectMaskConflict(seed(), {
    sha256: 'bbbb',
    resolvedFrom: { cardId: 'base1-4', variantId: 1 },
    savedAt: T2,
    method: 'hand',
  })
  assert.equal(r.kind, 'parent-changed')
  assert.deepEqual(r.choices, ['keep-mine', 'take-theirs', 're-trace'])
})

test('THE SUBTLE CASE — alias-moved: same bytes, a different record now answers', () => {
  // Upstream grew a SIBLING mask. The file we seeded from is untouched, so a
  // sha comparison against it sees nothing. The resolved answer is what moved.
  const r = detectMaskConflict(seed(), {
    sha256: 'aaaa',
    resolvedFrom: { cardId: 'base1-4', variantId: 7 },
    savedAt: T2,
    method: 'hand',
  })
  assert.equal(r.kind, 'alias-moved')
  assert.equal(r.conflicted, true)
  assert.match(r.detail, /different record answers/)
})

test('parent-appeared and parent-vanished are both conflicts, in opposite directions', () => {
  const fromLayout = seed({ startedFrom: 'layout', parent: null, resolvedFrom: null, parentSha256: null })
  assert.equal(
    detectMaskConflict(fromLayout, { sha256: null, resolvedFrom: null, savedAt: null, method: null }).kind,
    'none',
  )
  assert.equal(
    detectMaskConflict(fromLayout, {
      sha256: 'cccc',
      resolvedFrom: { cardId: 'base1-4', variantId: 1 },
      savedAt: T2,
      method: 'ai',
    }).kind,
    'parent-appeared',
  )
  assert.equal(
    detectMaskConflict(seed(), { sha256: null, resolvedFrom: null, savedAt: null, method: null }).kind,
    'parent-vanished',
  )
})

test('no conflict path produces pixels — the report is description only', () => {
  const r = detectMaskConflict(seed(), {
    sha256: 'bbbb',
    resolvedFrom: { cardId: 'base1-4', variantId: 1 },
    savedAt: T2,
    method: 'hand',
  })
  const keys = new Set(Object.keys(r))
  for (const forbidden of ['png', 'merged', 'pixels', 'result']) assert.ok(!keys.has(forbidden))
})

test('re-trace keeps the old pixels as a ghost; take-theirs drops them', () => {
  const worked = updateMaskSession(seed(), { png: PNG_A, comment: 'the bevel is 3px in' }, T1)
  const fresh = {
    cardId: 'base1-4',
    variantId: 1,
    startedFrom: 'mask' as const,
    parent: { cardId: 'base1-4', variantId: 1 },
    resolvedFrom: { cardId: 'base1-4', variantId: 7 },
    parentSha256: 'bbbb',
    prior: PRIOR,
    width: 504,
    height: 704,
    png: PNG_B,
    now: T2,
  }
  const retrace = reseedMaskSession(worked, fresh, 're-trace')
  assert.equal(retrace.ghostPng, PNG_A)
  assert.equal(retrace.session.png, PNG_B, 'the canvas is upstream after a re-seed')
  assert.equal(retrace.session.seed.parentSha256, 'bbbb', 'the seed is now the fresh upstream')
  assert.equal(retrace.session.comment, 'the bevel is 3px in', 'the human words survive a re-seed')
  assert.equal(retrace.session.createdAt, T0, 'it is the same session, re-seeded')

  const theirs = reseedMaskSession(worked, fresh, 'take-theirs')
  assert.equal(theirs.ghostPng, null)
})

test('canon conflicts are sha-only and offer no re-trace — there is nothing to ghost under a slider', () => {
  const c = seedCanonSession({ patternId: 'cosmos', uniforms: { uMetal: 0.5 }, savedAt: T0, sha256: 'aaaa', contract: 4, now: T0 })
  assert.equal(detectCanonConflict(c, { sha256: 'aaaa', savedAt: T0, contract: 4 }).kind, 'none')
  const changed = detectCanonConflict(c, { sha256: 'bbbb', savedAt: T2, contract: 5 })
  assert.equal(changed.kind, 'parent-changed')
  assert.deepEqual(changed.choices, ['keep-mine', 'take-theirs'])
  assert.match(changed.detail, /contract 4 → 5/)
})

test('a canon session is keyed by patternId, not by any card', () => {
  const c = seedCanonSession({ patternId: 'cosmos', uniforms: { a: 1 }, savedAt: null, sha256: null, contract: 4, now: T0 })
  assert.equal(c.id, canonSessionId('cosmos'))
  assert.equal(c.id, 'canon:cosmos')
  assert.notEqual(c.id, maskSessionId('base1-4', 1))
  assert.throws(() => buildCanonSubmission({ ...c, uniforms: {} }), NotSubmittable)
  const dirty = updateCanonSession(c, { uniforms: { a: 2 } }, T1)
  assert.equal(isDirty(dirty), true)
  assert.equal(isDirty(c), false)
})

// ── sha ────────────────────────────────────────────────────────────────────

test('sha256 matches the known vector, and a data URL round-trips to its bytes', async () => {
  assert.equal(
    await sha256Text('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
  const bytes = dataUrlToBytes(PNG_A)
  assert.equal(bytes[0], 0x89)
  assert.equal(String.fromCharCode(bytes[1]!, bytes[2]!, bytes[3]!), 'PNG')
  assert.equal((await sha256Bytes(bytes)).length, 64)
  assert.throws(() => dataUrlToBytes('https://example.invalid/x.png'), /data: URL/)
})

test('canon uniform hashing ignores key order — two orderings are the same canon', async () => {
  assert.equal(canonicalUniforms({ b: 2, a: 1 }), canonicalUniforms({ a: 1, b: 2 }))
  assert.equal(await sha256Uniforms({ b: 2, a: 1 }), await sha256Uniforms({ a: 1, b: 2 }))
  assert.notEqual(await sha256Uniforms({ a: 1 }), await sha256Uniforms({ a: 1.0001 }))
})

// ── Persistence + export/import ────────────────────────────────────────────

test('the store round-trips a session and lists newest-updated first', async () => {
  const store = memorySessionStore()
  const a = updateMaskSession(seed(), { png: PNG_A }, T1)
  const b = updateMaskSession(seed({ cardId: 'base1-15' }), { png: PNG_B }, T2)
  await store.put(a)
  await store.put(b)
  assert.deepEqual((await store.list()).map((s) => s.id), [b.id, a.id])
  assert.equal(((await store.get(a.id)) as MaskSession | null)?.png, PNG_A)
  await store.delete(a.id)
  assert.equal(await store.get(a.id), null)
  await store.clear()
  assert.deepEqual(await store.list(), [])
})

test('export → import round-trips a worked session exactly', () => {
  const s = updateMaskSession(seed(), { png: PNG_A, comment: 'window edge is 3px in from the bevel' }, T1)
  const text = JSON.stringify(buildBundle([s], { now: T2, resolverVersion: 5, buildId: 'test' }))
  const back = parseBundle(text)
  assert.equal(back.sessions.length, 1)
  assert.deepEqual(back.sessions[0], s)
  assert.match(bundleFilename(T2), /^foilkit-sessions-2026-09-01T10-30-00-000Z\.json$/)
})

test('import refuses anything it cannot vouch for', () => {
  const good = updateMaskSession(seed(), { png: PNG_A }, T1)
  const bundle = (sessions: unknown[]): string =>
    JSON.stringify({ kind: 'foilkit.staged-sessions', bundleVersion: 1, exportedAt: T2, editor: {}, sessions })

  assert.throws(() => parseBundle('not json'), BadBundle)
  assert.throws(() => parseBundle(JSON.stringify({ kind: 'something-else' })), BadBundle)
  assert.throws(() => parseBundle(JSON.stringify({ kind: 'foilkit.staged-sessions', bundleVersion: 99 })), BadBundle)
  // A remote URL where the pixels should be would make submit fetch something.
  assert.throws(() => parseBundle(bundle([{ ...good, png: 'https://evil.invalid/x.png' }])), BadBundle)
  // An id that disagrees with its own card ref would stage under the wrong card.
  assert.throws(() => parseBundle(bundle([{ ...good, id: 'mask:base1-99:1' }])), BadBundle)
  // A seed with no prior cannot produce an honest correction record.
  assert.throws(() => parseBundle(bundle([{ ...good, seed: { ...good.seed, prior: null } }])), BadBundle)
  assert.throws(() => parseBundle(bundle([{ ...good, seed: { ...good.seed, startedFrom: 'vibes' } }])), BadBundle)
  assert.throws(() => parseBundle(bundle([{ ...good, kind: 'something' }])), BadBundle)
  // And the good one still passes, so the guards are not just rejecting everything.
  assert.equal(parseBundle(bundle([good])).sessions.length, 1)
})

// ── The pen's geometry, staged ─────────────────────────────────────────────
//
// A pen-authored mask carries its PATHS as well as its pixels, so the pull request it opens
// has a diff a reviewer can read. What these lock down is that carrying them changed nothing
// else: the seed is still immutable, the client still labels nothing, pixels are still the
// comparison form, and a brush session is byte-for-byte what it always was.

const VECTOR = {
  version: 1 as const,
  space: { width: 504, height: 704 },
  paths: [
    {
      start: [36, 40] as [number, number],
      startType: 'c' as const,
      prims: [
        { k: 'line' as const, to: [468, 40] as [number, number], t: 'c' as const },
        { k: 'cubic' as const, c1: [468, 300] as [number, number], c2: [468, 420] as [number, number], to: [468, 560] as [number, number], t: 's' as const },
        { k: 'line' as const, to: [36, 560] as [number, number], t: 'c' as const },
        { k: 'line' as const, to: [36, 40] as [number, number], t: 'c' as const },
      ],
    },
  ],
}

test('a BRUSH session is exactly what it always was — the pen costs it nothing', () => {
  // The regression test for everybody who is not using the pen, and it checks the SHAPE rather
  // than the behaviour: an optional field implemented as `vector: undefined` would add a key
  // that JSON drops and `deepStrictEqual` does not, which is how an "optional" field quietly
  // breaks an export round trip for the sessions that never asked for it.
  const s = updateMaskSession(seed(), { png: PNG_A }, T1)
  assert.equal('vector' in s, false, 'a session that never met the pen must not mention it')
  assert.equal('vector' in buildMaskSubmission(s), false)
  assert.equal('vector' in buildMaskContribution(s, null, null), false)
  assert.deepEqual(parseBundle(JSON.stringify(buildBundle([s], { now: T2, resolverVersion: 5, buildId: 't' }))).sessions[0], s)
})

test('the vector rides seed → save → submission, and the seed stays immutable underneath it', () => {
  const s0 = seed({ vector: null })
  assert.equal(s0.vector, null, 'a mask reopened with no committed paths says so explicitly')

  const s = updateMaskSession(s0, { png: PNG_A, vector: VECTOR }, T1)
  assert.deepEqual(s.vector, VECTOR)
  // Ten more saves, the way the old lab worked. The seed is still the seed.
  let n = s
  for (let i = 0; i < 10; i++) n = updateMaskSession(n, { png: i % 2 === 0 ? PNG_B : PNG_A }, T1)
  assert.deepEqual(n.vector, VECTOR, 'a save that does not mention the vector leaves it alone')
  assert.equal(n.seed.parentSha256, 'aaaa')

  const sub = buildMaskSubmission(n)
  assert.deepEqual(sub.vector, VECTOR)
  assert.deepEqual(sub.derivation, { startedFrom: 'mask', parent: { cardId: 'base1-4', variantId: 1 } })
  assert.deepEqual(buildMaskContribution(n, null, null).vector, VECTOR)

  // …and `updateMaskSession` still has no path to the seed, vector or not.
  assert.equal(updateMaskSession(n, { seed: { parentSha256: 'zzzz' } } as never, T2).seed.parentSha256, 'aaaa')
})

test('a brush stroke over a pen mask CLEARS the paths — they no longer describe these pixels', () => {
  // The client half of the rule the server enforces. Painting over pen-authored pixels makes
  // the old geometry a confident, readable, wrong description of the mask, so the session drops
  // it and the write path then removes the committed `.paths.json`.
  const pen = updateMaskSession(seed(), { png: PNG_A, vector: VECTOR }, T1)
  const painted = updateMaskSession(pen, { png: PNG_B, vector: null }, T2)
  assert.equal(painted.vector, null)
  assert.equal(painted.png, PNG_B)
  assert.equal(buildMaskContribution(painted, null, null).vector, null)
})

test('the client still labels nothing — a vector smuggles in no provenance claim', () => {
  // Same assertion as the brush case above, run over a session that carries geometry. The
  // vector is paths and a raster; if it ever grew a field naming how the mask was made, this is
  // where it would be caught.
  const s = updateMaskSession(seed(), { png: PNG_A, vector: VECTOR, comment: 'traced the bevel' }, T1)
  const json = JSON.stringify({
    session: s,
    submission: buildMaskSubmission(s),
    contribution: buildMaskContribution(s, null, null),
  })
  for (const forbidden of ['derivation_method', 'reviewStatus', 'agreement', 'authorship', 'provenanceTier', 'verification']) {
    assert.ok(!json.includes(forbidden), `a staged session must not carry ${forbidden}`)
  }
})

test('the vector survives export → import, and a bundle cannot smuggle in one the editor cannot read', () => {
  const s = updateMaskSession(seed(), { png: PNG_A, vector: VECTOR }, T1)
  const back = parseBundle(JSON.stringify(buildBundle([s], { now: T2, resolverVersion: 5, buildId: 'test' })))
  assert.deepEqual(back.sessions[0], s, 'a bundle is the only bridge between two devices; it must be lossless')

  const bundle = (session: unknown): string =>
    JSON.stringify({ kind: 'foilkit.staged-sessions', bundleVersion: 1, exportedAt: T2, editor: {}, sessions: [session] })
  // A vector from a future build would load as an empty document and then be SUBMITTED — the
  // geometry silently discarded, the pixels committed with no diff to read.
  assert.throws(() => parseBundle(bundle({ ...s, vector: { ...VECTOR, version: 2 } })), BadBundle)
  assert.throws(() => parseBundle(bundle({ ...s, vector: { ...VECTOR, space: { width: 0, height: 0 } } })), BadBundle)
  assert.throws(() => parseBundle(bundle({ ...s, vector: { ...VECTOR, paths: [] } })), BadBundle)
  assert.throws(() => parseBundle(bundle({ ...s, vector: { ...VECTOR, paths: [{ start: [0, 0], prims: [] }] } })), BadBundle)
  assert.throws(() => parseBundle(bundle({ ...s, vector: 'a picture of a path' })), BadBundle)
  // `null` is legal and means "this mask has no paths", which is what the brush says out loud.
  assert.equal(parseBundle(bundle({ ...s, vector: null })).sessions[0]!.id, s.id)
})

test('a staged pen session survives a stage → reload', async () => {
  // The browser is the database until Submit, so "my work is trapped / lost" is a real fear and
  // the store is the answer to it. Geometry has to come back too, or a reopened session would
  // silently downgrade to a raster.
  const store = memorySessionStore()
  const s = updateMaskSession(seed(), { png: PNG_A, vector: VECTOR }, T1)
  await store.put(s)
  const back = (await store.get(s.id)) as MaskSession | null
  assert.deepEqual(back?.vector, VECTOR)
  assert.deepEqual(back, s)
})

test('re-seeding after a conflict takes upstream’s geometry, not the contributor’s', () => {
  // `take-theirs` and `re-trace` both mean "the canvas is upstream now". Carrying the old paths
  // across would leave the session holding geometry for pixels it just discarded.
  const worked = updateMaskSession(seed(), { png: PNG_A, vector: VECTOR, comment: 'the bevel is 3px in' }, T1)
  const fresh = {
    cardId: 'base1-4',
    variantId: 1,
    startedFrom: 'mask' as const,
    parent: { cardId: 'base1-4', variantId: 1 },
    resolvedFrom: { cardId: 'base1-4', variantId: 1 },
    parentSha256: 'bbbb',
    prior: PRIOR,
    width: 504,
    height: 704,
    png: PNG_B,
    vector: null,
    now: T2,
  }
  const r = reseedMaskSession(worked, fresh, 're-trace')
  assert.equal(r.session.vector, null, 'the seed decides the geometry, as it decides the pixels')
  assert.equal(r.ghostPng, PNG_A, 'and the old pixels are still the ghost to redraw against')
  assert.equal(r.session.comment, 'the bevel is 3px in')
})

test('an import collision is presented, never merged', () => {
  const mine = updateMaskSession(seed(), { png: PNG_A }, T1)
  const theirs = updateMaskSession(seed(), { png: PNG_B }, T2)
  const other = updateMaskSession(seed({ cardId: 'base1-15' }), { png: PNG_B }, T2)
  const plan = planImport([theirs, other], [mine])
  assert.equal(plan.add.length, 1)
  assert.equal(plan.collide.length, 1)
  assert.equal((plan.collide[0]!.existing as MaskSession).png, PNG_A)
  assert.equal((plan.collide[0]!.incoming as MaskSession).png, PNG_B)
})
