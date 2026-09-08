// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// THE GATE, tested on the things that would otherwise reach a reviewer.
//
// Every case below is a pull request somebody would have had to open, read,
// diagnose and close. That is the value being asserted — not "the function
// returns false", but "this specific wrong thing is caught with a sentence a
// contributor can act on", which is why each assertion checks the DETAIL text
// as well as the boolean.
//
// The PNGs are built here with forge's own encoder rather than fixtured, so a
// change to the codec breaks this suite instead of quietly changing what it is
// testing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CANONICAL_H, CANONICAL_W, GLOBAL_DEFAULTS } from '@foilkit/core'
import { decodePng, encodePng, rasterizeMaskVector, type MaskVector } from '@foilkit/forge'
import { PATTERNS, patternById } from '@foilkit/patterns'

const {
  validateMask,
  validateCanon,
  checkAssembledGlsl,
  checkNoClaimedProvenance,
  checkVectorAgreesWithPixels,
  claimedProvenanceKeys,
  CLIENT_MAY_NOT_CLAIM,
  MAX_COVERAGE,
  VECTOR_AGREEMENT_MIN_IOU,
  VECTOR_AGREEMENT_MAX_BOUNDARY_P95_PX,
  VECTOR_AGREEMENT_MAX_BOUNDARY_MAX_PX,
  VECTOR_MAX_FLATTENED_POINTS,
} = await import('./validate.ts')

/** A mask PNG at the given size with `coverage` of the pixels drawn. */
function maskPng(width: number, height: number, coverage: number): Buffer {
  const rgba = new Uint8Array(width * height * 4)
  const drawn = Math.round(width * height * coverage)
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    rgba[o] = 255
    rgba[o + 1] = 45
    rgba[o + 2] = 100
    rgba[o + 3] = i < drawn ? 255 : 0
  }
  return Buffer.from(encodePng({ width, height, rgba }))
}

const PRIOR = {
  scope: 'window',
  eraId: 'wotc',
  rect: [0.06, 0.44, 0.88, 0.42],
  radius: 0.01,
  invert: false,
  feather: 0.008,
  resolverVersion: 3,
}

const FRESH = { kind: 'none', acknowledged: false }

function maskInput(over: Record<string, unknown> = {}) {
  return {
    png: maskPng(CANONICAL_W, CANONICAL_H, 0.25),
    width: CANONICAL_W,
    height: CANONICAL_H,
    prior: PRIOR,
    derivation: { startedFrom: 'layout', parent: null },
    seed: { parentSha256: null, resolvedFrom: null },
    conflict: FRESH,
    ...over,
  } as Parameters<typeof validateMask>[0]
}

function check(result: { checks: readonly { name: string; ok: boolean; detail: string }[] }, name: string) {
  const c = result.checks.find((x) => x.name === name)
  assert.ok(c !== undefined, `no check named ${name}`)
  return c!
}

// ── Masks ──────────────────────────────────────────────────────────────────

test('a clean mask session passes every check', () => {
  const r = validateMask(maskInput())
  assert.equal(r.ok, true, r.failures.join(' / '))
  assert.equal(r.failures.length, 0)
  assert.ok(r.coverage > 0.2 && r.coverage < 0.3)
  assert.equal(r.supersede, false)
})

test('a PNG at the wrong dimensions is refused, and the message names both sizes', () => {
  const r = validateMask(maskInput({ png: maskPng(512, 512, 0.25), width: 512, height: 512 }))
  assert.equal(r.ok, false)
  const c = check(r, 'canonical-raster')
  assert.equal(c.ok, false)
  assert.ok(c.detail.includes('512×512'))
  assert.ok(c.detail.includes(`${CANONICAL_W}×${CANONICAL_H}`))
})

test('declared dimensions that disagree with the pixels are refused', () => {
  // The dangerous shape: the raster IS canonical, so the size check passes and
  // only the cross-check catches it. A sidecar claiming a raster its pixels
  // deny is exactly the corruption a file copy introduces.
  const r = validateMask(maskInput({ width: 600, height: 825 }))
  assert.equal(r.ok, false)
  assert.equal(check(r, 'canonical-raster').ok, true)
  assert.equal(check(r, 'declared-raster-matches').ok, false)
})

test('bytes that are not a PNG are refused before anything else looks at them', () => {
  const r = validateMask(maskInput({ png: Buffer.from('this is not a png at all') }))
  assert.equal(r.ok, false)
  assert.equal(check(r, 'png-decodes').ok, false)
})

test('a mask with nothing drawn is refused — there is no measurement in it', () => {
  const r = validateMask(maskInput({ png: maskPng(CANONICAL_W, CANONICAL_H, 0) }))
  assert.equal(r.ok, false)
  assert.equal(check(r, 'alpha-has-content').ok, false)
  assert.ok(check(r, 'alpha-has-content').detail.includes('entirely transparent'))
})

test('a mask covering the whole card is refused — that is what no mask already does', () => {
  const r = validateMask(maskInput({ png: maskPng(CANONICAL_W, CANONICAL_H, 1) }))
  assert.equal(r.ok, false)
  assert.equal(check(r, 'alpha-not-the-whole-card').ok, false)
})

test('the coverage ceiling sits far outside anything the real corpus contains', () => {
  // The committed corpus runs 0.157 to 0.537. A ceiling anywhere near that
  // would reject real work; this asserts the margin rather than the constant.
  assert.ok(MAX_COVERAGE > 0.6, 'the ceiling must not be reachable by a real hand mask')
  assert.equal(validateMask(maskInput({ png: maskPng(CANONICAL_W, CANONICAL_H, 0.54) })).ok, true)
})

test('a junk era-rule prior is refused with forge’s own reason', () => {
  const r = validateMask(maskInput({ prior: { ...PRIOR, scope: 'nonsense' } }))
  assert.equal(r.ok, false)
  assert.ok(check(r, 'prior-valid').detail.includes('scope'))
})

test('a startedFrom the contract does not define is refused', () => {
  const r = validateMask(maskInput({ derivation: { startedFrom: 'vibes', parent: null } }))
  assert.equal(r.ok, false)
  assert.equal(check(r, 'derivation-startedFrom').ok, false)
})

test('a session that claims a mask parent but pinned no sha is refused', () => {
  const r = validateMask(
    maskInput({
      derivation: { startedFrom: 'mask', parent: { cardId: 'base1-4', variantId: 15 } },
      seed: { parentSha256: null, resolvedFrom: { cardId: 'base1-4', variantId: 15 } },
    }),
  )
  assert.equal(r.ok, false)
  const c = check(r, 'parent-sha-recorded')
  assert.equal(c.ok, false)
  assert.ok(c.detail.includes('stale'), 'the message should say what the pin is for')
})

test('a session seeded from a mask WITH a pinned sha passes', () => {
  const sha = 'a'.repeat(64)
  const r = validateMask(
    maskInput({
      derivation: { startedFrom: 'mask', parent: { cardId: 'base1-4', variantId: 15 } },
      seed: { parentSha256: sha, resolvedFrom: { cardId: 'base1-4', variantId: 15 } },
    }),
  )
  assert.equal(r.ok, true, r.failures.join(' / '))
  assert.equal(check(r, 'parent-sha-recorded').ok, true)
})

test('a stale session that was never shown its conflict is refused', () => {
  const r = validateMask(maskInput({ conflict: { kind: 'parent-changed', acknowledged: false } }))
  assert.equal(r.ok, false)
  const c = check(r, 'not-stale-unacknowledged')
  assert.equal(c.ok, false)
  assert.ok(c.detail.includes('keep-mine'), 'the message should name the three choices')
})

test('a stale session the contributor acknowledged passes AND is flagged as a supersede', () => {
  const r = validateMask(maskInput({ conflict: { kind: 'parent-changed', acknowledged: true } }))
  assert.equal(r.ok, true, r.failures.join(' / '))
  assert.equal(r.supersede, true)
  assert.ok(check(r, 'not-stale-unacknowledged').detail.includes('supersede'))
})

test('alias-moved is a conflict too — same bytes, different parent, still needs acknowledging', () => {
  const r = validateMask(maskInput({ conflict: { kind: 'alias-moved', acknowledged: false } }))
  assert.equal(r.ok, false)
  assert.equal(check(r, 'not-stale-unacknowledged').ok, false)
})

test('every failure reason reaches `failures` in order', () => {
  const r = validateMask(maskInput({ png: maskPng(512, 512, 0), width: 512, height: 512 }))
  assert.equal(r.ok, false)
  assert.equal(
    r.failures.length,
    r.checks.filter((c) => !c.ok).length,
    'failures must be exactly the failed checks',
  )
})

// ── Canon ──────────────────────────────────────────────────────────────────

/** A full snapshot for a pattern: every core uniform, every declared param. */
function fullCanon(patternId: string): Record<string, number> {
  const p = patternById(patternId)
  const u: Record<string, number> = { ...(GLOBAL_DEFAULTS as Record<string, number>) }
  for (const [k, v] of Object.entries(p.defaults)) u[k] = v as number
  for (const param of p.params) u[param.key] = param.default
  return u
}

test('a full snapshot of a real recipe passes', () => {
  const r = validateCanon({ patternId: 'cosmos', uniforms: fullCanon('cosmos'), seedContract: 2, conflict: FRESH })
  assert.equal(r.ok, true, r.failures.join(' / '))
  assert.ok(r.glslBytes > 1000, 'the assembled shader should be substantial')
})

test('a canon file for a pattern that does not exist is refused', () => {
  const r = validateCanon({
    patternId: 'not-a-real-recipe',
    uniforms: fullCanon('cosmos'),
    seedContract: 2,
    conflict: FRESH,
  })
  assert.equal(r.ok, false)
  assert.equal(check(r, 'pattern-exists').ok, false)
})

test('an empty canon is refused — the file is a full snapshot by definition', () => {
  const r = validateCanon({ patternId: 'cosmos', uniforms: {}, seedContract: 2, conflict: FRESH })
  assert.equal(r.ok, false)
  assert.equal(check(r, 'canon-not-empty').ok, false)
})

test('a non-finite uniform is refused and named', () => {
  const r = validateCanon({
    patternId: 'cosmos',
    uniforms: { ...fullCanon('cosmos'), uScale: Number.NaN },
    seedContract: 2,
    conflict: FRESH,
  })
  assert.equal(r.ok, false)
  assert.ok(check(r, 'canon-numbers-finite').detail.includes('uScale'))
})

test('a uniform the composite contract does not declare is refused', () => {
  const r = validateCanon({
    patternId: 'cosmos',
    uniforms: { ...fullCanon('cosmos'), uInventedByTheClient: 1 },
    seedContract: 2,
    conflict: FRESH,
  })
  assert.equal(r.ok, false)
  assert.ok(check(r, 'canon-contract-uniforms').detail.includes('uInventedByTheClient'))
})

test('a uP* the recipe never declared is refused — the value would be dropped, not applied', () => {
  const declared = new Set<string>(patternById('cosmos').params.map((p) => p.key))
  const spare = ['uP0', 'uP1', 'uP2', 'uP3', 'uP4', 'uP5'].find((k) => !declared.has(k))
  assert.ok(spare !== undefined, 'cosmos should not declare all six params')
  const r = validateCanon({
    patternId: 'cosmos',
    uniforms: { ...fullCanon('cosmos'), [spare!]: 0.5 },
    seedContract: 2,
    conflict: FRESH,
  })
  assert.equal(r.ok, false)
  assert.ok(check(r, 'canon-params-declared').detail.includes(spare!))
})

test('a partial snapshot is refused, and the message names what it would inherit', () => {
  const full = fullCanon('cosmos')
  delete full.uScale
  const r = validateCanon({ patternId: 'cosmos', uniforms: full, seedContract: 2, conflict: FRESH })
  assert.equal(r.ok, false)
  assert.ok(check(r, 'canon-full-snapshot').detail.includes('uScale'))
})

test('a stale canon session that was never shown its conflict is refused', () => {
  const r = validateCanon({
    patternId: 'cosmos',
    uniforms: fullCanon('cosmos'),
    seedContract: 2,
    conflict: { kind: 'parent-changed', acknowledged: false },
  })
  assert.equal(r.ok, false)
  assert.equal(check(r, 'not-stale-unacknowledged').ok, false)
})

test('an acknowledged stale canon session passes and is flagged as a supersede', () => {
  const r = validateCanon({
    patternId: 'cosmos',
    uniforms: fullCanon('cosmos'),
    seedContract: 2,
    conflict: { kind: 'parent-changed', acknowledged: true },
  })
  assert.equal(r.ok, true, r.failures.join(' / '))
  assert.equal(r.supersede, true)
})

// ── The assembled shader ───────────────────────────────────────────────────

test('every implemented recipe assembles into a structurally sound shader', () => {
  // THE BROAD ONE. It is the closest thing to a compile that runs without a GL
  // driver, and it runs over the whole corpus rather than one recipe — so a
  // recipe added with unbalanced braces fails here rather than in a browser.
  let seen = 0
  for (const p of PATTERNS) {
    for (const c of checkAssembledGlsl(p.id, [])) assert.ok(c.ok, `${p.id}: ${c.detail}`)
    seen++
  }
  assert.ok(seen > 40, `expected the full recipe corpus, saw ${seen}`)
})

test('a uniform the assembled shader never declares is caught', () => {
  const checks = checkAssembledGlsl('cosmos', ['uScale', 'uNotAUniformAnywhere'])
  const c = checks.find((x) => x.name === 'glsl-uniforms-declared')!
  assert.equal(c.ok, false)
  assert.ok(c.detail.includes('uNotAUniformAnywhere'))
  assert.ok(c.detail.includes('dropped'), 'the message should say what actually happens')
})

test('the composite is GLSL ES 1.00 — no #version directive anywhere in it', () => {
  const c = checkAssembledGlsl('cosmos', []).find((x) => x.name === 'glsl-no-version-directive')!
  assert.equal(c.ok, true)
})

// ── #10: nothing claims its own provenance ─────────────────────────────────
//
// The scenario each of these is standing in for: somebody reads sidecar v5,
// notices that `provenanceTier: 'owner-verified'` is what buys exemplar weight,
// and puts it in the submission. What must happen is a NAMED REFUSAL before a
// branch exists — not a silent drop, which opens a pull request that looks
// perfectly fine and teaches the contributor that the field worked.

test('a clean submission passes the provenance gate', () => {
  const c = check(validateMask(maskInput({ body: { cardId: 'base1-8', variantId: 32, comment: 'traced it' } })), 'no-claimed-provenance')
  assert.equal(c.ok, true)
  assert.match(c.detail, /claims no provenance/)
})

test('a submission carrying a verification block is REFUSED, and the message says why', () => {
  const r = validateMask(
    maskInput({
      body: {
        cardId: 'base1-8',
        verification: { verifiedBy: 'cheyras', via: 'writer-direct', verifiedAt: '2026-09-06T00:00:00.000Z' },
      },
    }),
  )
  assert.equal(r.ok, false)
  const c = check(r, 'no-claimed-provenance')
  assert.equal(c.ok, false)
  assert.match(c.detail, /verification/)
  assert.match(c.detail, /writer capability/)
  // It is the FIRST failure reported. A contributor who tried to verify their
  // own work should be told that, not told about their alpha channel.
  assert.equal(r.failures[0], c.detail)
})

test('a submission carrying an author block is REFUSED — the App records who, from the session', () => {
  const r = validateMask(maskInput({ body: { author: { login: 'somebody-else', id: 1, via: 'writer-direct' } } }))
  assert.equal(r.ok, false)
  assert.match(check(r, 'no-claimed-provenance').detail, /author/)
})

test('a claim NESTED inside another field is found — the gate is deep, not top-level', () => {
  // Nobody who wanted to lie would put it at the root; they would put it where
  // it looks like it belongs.
  const r = validateMask(maskInput({ body: { prior: { ...PRIOR, author: { login: 'x', id: 1, via: 'writer-direct' } } } }))
  assert.equal(r.ok, false)
  assert.match(check(r, 'no-claimed-provenance').detail, /prior\.author/)
})

test('every derived label is in the forbidden list, and the paths are reported', () => {
  // The older ones were already unforgeable — forge re-derives them — so this
  // changes the FEEDBACK rather than the outcome, from "quietly discarded" to
  // "this pipeline does not accept claims, here is the one you sent".
  for (const key of CLIENT_MAY_NOT_CLAIM) {
    const found = claimedProvenanceKeys({ [key]: 'anything' })
    assert.deepEqual(found.keys, [key], `${key} must be caught`)
    assert.equal(found.truncated, false)
  }
  assert.deepEqual(
    claimedProvenanceKeys({ a: { verification: 1 }, b: [{ author: 2 }] }).keys.sort(),
    ['a.verification', 'b[0].author'],
  )
  assert.deepEqual(claimedProvenanceKeys({ cardId: 'x', prior: { eraId: 'wotc' } }).keys, [])
})

/** A `verification` claim buried `depth` objects down. */
function nested(depth: number): unknown {
  let node: unknown = { verification: { verifiedBy: 'cheyras' } }
  for (let i = 0; i < depth; i++) node = { a: node }
  return node
}

test('a walk that ran out of budget REFUSES, rather than affirming an absence it never finished looking for', () => {
  // The walk stops at `maxNodes` and used to return an empty list, which the caller rendered
  // as "the submission claims no provenance" — an affirmative sentence about a body it had
  // not read to the end. Wide and array shapes were already caught; DEPTH was not, and 5,000
  // levels is one `while` loop away for anybody who wants them.
  const deep = nested(5000)
  const walk = claimedProvenanceKeys(deep)
  assert.equal(walk.keys.length, 0, 'the budget really does run out before the claim — that is the premise')
  assert.equal(walk.truncated, true, 'and the walk now SAYS so')

  const c = checkNoClaimedProvenance(deep)
  assert.equal(c.ok, false, 'a body the server could not finish checking must not pass the provenance gate')
  assert.match(c.detail, /nested too deeply/)
  assert.doesNotMatch(c.detail, /claims no provenance/, 'and must not state the opposite of what it knows')

  const r = validateMask(maskInput({ body: deep }))
  assert.equal(r.ok, false)
  assert.ok(r.failures.some((f) => /nested too deeply/.test(f)))

  // …and an ordinary body still passes, so this bounds pathology rather than taxing nesting.
  // A staged session is a handful of levels deep.
  const ordinary = checkNoClaimedProvenance({
    cardId: 'base1-4',
    prior: { ...PRIOR, window: { rect: [1, 2, 3, 4], radius: 0.01 } },
  })
  assert.equal(ordinary.ok, true)
  assert.match(ordinary.detail, /claims no provenance/)
})

// ── The vector must describe the pixels ────────────────────────────────────
//
// THE CHECK THAT MAKES A READABLE DIFF HONEST. A pen contribution commits paths beside its
// pixels so a reviewer can argue with the geometry instead of squinting at two thumbnails — and
// the instant a reviewer can read a diff, they believe it. So the server rasterises the
// submitted paths and looks, rather than taking the pair on the client's word (AGENTS.md F3).
//
// Every test below is a submission somebody could actually send. The last one is the
// CALIBRATION RECORD: the tolerance is a pair of numbers, and numbers chosen without measuring
// either reject honest work or accept a lie, so what was measured is written down here where it
// fails if it stops being true.

/** A mask-shaped vector in canonical space, with one handle movable. */
function maskVector(handleDx = 0, offset = 0): MaskVector {
  const p = (x: number, y: number): [number, number] => [x + offset, y + offset]
  return {
    version: 1,
    space: { width: CANONICAL_W, height: CANONICAL_H },
    paths: [
      {
        start: p(36, 40),
        startType: 'c',
        prims: [
          { k: 'line', to: p(468, 40), t: 'c' },
          { k: 'cubic', c1: p(468 + handleDx, 300), c2: p(468, 420), to: p(468, 560), t: 's' },
          { k: 'line', to: p(36, 560), t: 'c' },
          { k: 'line', to: p(36, 40), t: 'c' },
        ],
      },
      {
        // A hole, wound the other way, so this exercises nonzero winding too.
        start: p(120, 150),
        prims: [
          { k: 'line', to: p(120, 320) },
          { k: 'line', to: p(380, 320) },
          { k: 'line', to: p(380, 150) },
          { k: 'line', to: p(120, 150) },
        ],
      },
    ],
  }
}

/** A canonical mask PNG from a coverage plane — the tint the editor writes, alpha as given. */
function pngOfAlpha(alpha: Uint8Array): Buffer {
  const rgba = new Uint8Array(CANONICAL_W * CANONICAL_H * 4)
  for (let i = 0; i < alpha.length; i++) {
    rgba[i * 4] = 255
    rgba[i * 4 + 1] = 45
    rgba[i * 4 + 2] = 100
    rgba[i * 4 + 3] = alpha[i]!
  }
  return Buffer.from(encodePng({ width: CANONICAL_W, height: CANONICAL_H, rgba }))
}

/** The PNG a contributor's canvas would produce for that geometry. */
function pngOf(v: MaskVector): Buffer {
  return pngOfAlpha(rasterizeMaskVector(v, CANONICAL_W, CANONICAL_H))
}

test('a submission with NO vector behaves exactly as it did before the field existed', () => {
  // The brush is not going anywhere and must not pay for the pen. A contribution with no paths
  // gets a passing, honest check and an otherwise untouched result.
  const r = validateMask(maskInput())
  assert.equal(r.ok, true, r.failures.join(' / '))
  assert.equal(r.vectorAgreement, null)
  const c = check(r, 'vector-agrees-with-pixels')
  assert.equal(c.ok, true)
  assert.match(c.detail, /no vector paths were submitted/)
  // …and explicit nulls are the same thing as absent, because that is what the editor sends
  // when a brush stroke has just invalidated a pen-authored mask's paths.
  assert.equal(validateMask(maskInput({ vector: null })).ok, true)
})

test('paths that DO make the submitted pixels pass, and the measurement is reported', () => {
  const v = maskVector()
  const r = validateMask(maskInput({ png: pngOf(v), vector: v }))
  assert.equal(r.ok, true, r.failures.join(' / '))
  const c = check(r, 'vector-agrees-with-pixels')
  assert.equal(c.ok, true)
  assert.match(c.detail, /rasterise to the submitted pixels/)
  assert.ok(r.vectorAgreement !== null)
  assert.equal(r.vectorAgreement!.iou, 1, 'the same geometry through the same rasteriser is exact')
  assert.equal(r.vectorAgreement!.boundaryP95, 0)
})

test('paths that DO NOT make the submitted pixels are REFUSED — one anchor is enough', () => {
  // THE ONE THAT MATTERS. The pixels are the honest mask; the paths have had one handle dragged
  // 40px. Every other check passes — it is a perfectly good PNG at the canonical raster with a
  // valid prior — so this refusal is the only thing standing between a reviewer and a path diff
  // that does not describe the mask being committed.
  const honest = maskVector()
  const lying = maskVector(40)
  const r = validateMask(maskInput({ png: pngOf(honest), vector: lying }))

  assert.equal(r.ok, false, 'a vector that disagrees with its own pixels must not open a pull request')
  const c = check(r, 'vector-agrees-with-pixels')
  assert.equal(c.ok, false)
  assert.match(c.detail, /do not describe the submitted pixels/)
  assert.match(c.detail, /IoU 0\./, 'the message carries the measurement, not just a verdict')
  assert.match(c.detail, /reviewer could read/, 'and says what the consequence would have been')
  assert.ok(r.failures.includes(c.detail))

  // Both halves of the tolerance fire on this one, which is what makes the test robust rather
  // than a lucky brush against one threshold.
  assert.ok(r.vectorAgreement!.iou < VECTOR_AGREEMENT_MIN_IOU, `IoU was ${r.vectorAgreement!.iou}`)
  assert.ok(
    r.vectorAgreement!.boundaryP95 > VECTOR_AGREEMENT_MAX_BOUNDARY_P95_PX,
    `boundary p95 was ${r.vectorAgreement!.boundaryP95}px`,
  )

  // And nothing else in the submission was blamed for it.
  assert.equal(check(r, 'png-decodes').ok, true)
  assert.equal(check(r, 'canonical-raster').ok, true)
  assert.equal(check(r, 'alpha-has-content').ok, true)
})

// ── EACH GATE, ON ITS OWN ──────────────────────────────────────────────────
//
// The disagreement case above trips every gate at once, which is a fine test of the refusal
// and NO test of the gates: with `areaOk`, `edgeOk` and `worstOk` all false, deleting any
// one of them — or turning the `&&` into an `||` — leaves it passing. Four mutations lived
// in that gap for a release. So each of the three tests below is a pair that fails EXACTLY
// ONE gate and passes the other two, and each asserts on `check.ok` rather than on the raw
// measurement, because a verdict is what the pipeline acts on.

/** Interleaved vertical bars, `shift` px apart. Same boundaries, almost no shared area. */
function comb(shift: number): MaskVector {
  const paths = []
  for (let k = 0; k < 40; k++) {
    const x = 100 + k * 8 + shift
    paths.push({
      start: [x, 150] as [number, number],
      prims: [
        { k: 'line' as const, to: [x + 4, 150] as [number, number] },
        { k: 'line' as const, to: [x + 4, 550] as [number, number] },
        { k: 'line' as const, to: [x, 550] as [number, number] },
        { k: 'line' as const, to: [x, 150] as [number, number] },
      ],
    })
  }
  return { version: 1, space: { width: CANONICAL_W, height: CANONICAL_H }, paths }
}

test('the IoU gate alone refuses — boundaries a pixel apart everywhere, and the wrong region', () => {
  // Forty 4px bars against forty 4px bars in the GAPS between them. Every boundary pixel of
  // each sits within a pixel or two of a boundary pixel of the other, so both boundary
  // ceilings pass comfortably — and the two masks share no area at all. This is the shape
  // IoU exists for: "is this the same region", asked where locality cannot tell.
  const r = validateMask(maskInput({ png: pngOf(comb(0)), vector: comb(4) }))
  const c = check(r, 'vector-agrees-with-pixels')
  assert.equal(c.ok, false, 'a vector describing the gaps between the drawn bars is not describing them')
  const a = r.vectorAgreement!
  assert.ok(a.iou < VECTOR_AGREEMENT_MIN_IOU, `IoU ${a.iou} — the failing gate`)
  assert.ok(a.boundaryP95 <= VECTOR_AGREEMENT_MAX_BOUNDARY_P95_PX, `p95 ${a.boundaryP95}px must PASS here`)
  assert.ok(a.boundaryMax <= VECTOR_AGREEMENT_MAX_BOUNDARY_MAX_PX, `max ${a.boundaryMax}px must PASS here`)
})

test('the boundary-p95 gate alone refuses — a 10px handle move costs almost no area', () => {
  // IoU 0.9928: dragging one handle of a ~2,000px boundary by 10px changes the region by
  // well under a percent, which a floor loose enough for antialiasing cannot see. p95 is
  // 3.00px, past the 2px ceiling, while the worst point stays inside the 5px one — so this
  // pair is refused by the percentile and by nothing else.
  const r = validateMask(maskInput({ png: pngOf(maskVector()), vector: maskVector(10) }))
  const c = check(r, 'vector-agrees-with-pixels')
  assert.equal(c.ok, false)
  const a = r.vectorAgreement!
  assert.ok(a.iou >= VECTOR_AGREEMENT_MIN_IOU, `IoU ${a.iou} must PASS here`)
  assert.ok(a.boundaryP95 > VECTOR_AGREEMENT_MAX_BOUNDARY_P95_PX, `p95 ${a.boundaryP95}px — the failing gate`)
  assert.ok(a.boundaryMax <= VECTOR_AGREEMENT_MAX_BOUNDARY_MAX_PX, `max ${a.boundaryMax}px must PASS here`)
})

test('the boundary-MAX gate alone refuses — an 8x8 region in the pixels that the paths omit', () => {
  // THE ONE THAT WAS SHIPPING ACCEPTED. Sixty-four pixels of foil present in the PNG and
  // absent from the paths: IoU 0.9997, p95 0.00px. Both of the gates that existed pass it
  // with room to spare, and the max — computed, reported in the receipt, never gated on —
  // is 98.67px.
  //
  // It is also the test that fails if the measurement goes back to being one-directional:
  // a region MISSING from the paths never touches the paths' own boundary, so the whole
  // agreement reads `p95 0.00px (mean 0.00px, max 0.00px)` and the receipt certifies a lie.
  const v = maskVector()
  const alpha = rasterizeMaskVector(v, CANONICAL_W, CANONICAL_H)
  // Below the shape, which ends at y=560 — a block inside it would change nothing.
  for (let y = 620; y < 628; y++) for (let x = 60; x < 68; x++) alpha[y * CANONICAL_W + x] = 255
  const r = validateMask(maskInput({ png: pngOfAlpha(alpha), vector: v }))
  const c = check(r, 'vector-agrees-with-pixels')
  assert.equal(c.ok, false, 'paths that omit a region of the mask do not describe the mask')
  const a = r.vectorAgreement!
  assert.ok(a.iou >= VECTOR_AGREEMENT_MIN_IOU, `IoU ${a.iou} must PASS here`)
  assert.ok(a.boundaryP95 <= VECTOR_AGREEMENT_MAX_BOUNDARY_P95_PX, `p95 ${a.boundaryP95}px must PASS here`)
  assert.ok(a.boundaryMax > VECTOR_AGREEMENT_MAX_BOUNDARY_MAX_PX, `max ${a.boundaryMax}px — the failing gate`)
  assert.match(c.detail, /at the worst point/, 'and the refusal names the ceiling it broke')
})

test('the measurement is SYMMETRIC — which side is called "drawn" cannot change the verdict', () => {
  // With a one-directional metric, swapping the arguments moved the numbers by 74px on the
  // pair above and nobody could tell from the receipt which direction had been measured.
  // Symmetry makes that swap a no-op by construction rather than by convention.
  const v = maskVector()
  const alpha = rasterizeMaskVector(v, CANONICAL_W, CANONICAL_H)
  for (let y = 620; y < 680; y++) for (let x = 60; x < 120; x++) alpha[y * CANONICAL_W + x] = 255
  const withBlock = pngOfAlpha(alpha)

  // The block in the PIXELS and missing from the paths…
  const a = checkVectorAgreesWithPixels(decodePng(withBlock), v).agreement!
  // …and the same block in the PATHS and missing from the pixels.
  const vPlus: MaskVector = {
    ...v,
    paths: [
      ...v.paths,
      { start: [60, 620], prims: [
        { k: 'line', to: [120, 620] }, { k: 'line', to: [120, 680] },
        { k: 'line', to: [60, 680] }, { k: 'line', to: [60, 620] },
      ] },
    ],
  }
  const b = checkVectorAgreesWithPixels(decodePng(pngOf(v)), vPlus).agreement!
  assert.deepEqual(a, b, 'the same disagreement measured from either side reports the same numbers')
  assert.ok(a.boundaryMax > VECTOR_AGREEMENT_MAX_BOUNDARY_MAX_PX)
})

// ── The work is bounded, not just the input ────────────────────────────────

test('a 185-byte vector cannot burn a minute and a gigabyte — the flattener is budgeted', () => {
  // MEASURED BEFORE THE BOUND EXISTED: `c1: [1e11, 0], c2: [0, 1e11]` on the canonical raster
  // emitted 3.67M points and took 85.9 s and 1,065 MB inside this call, from 185 bytes of
  // request body — all of it before any GitHub call, so it cost the sender one cheap request.
  // The handles are ORTHOGONAL, which is why the huge numbers do not cancel in floating point
  // the way collinear ones do.
  //
  // The wall clock is asserted deliberately: without it a regression comes back as a hung
  // function rather than as a red test, and a hang in CI is diagnosed as flakiness.
  const evil = {
    version: 1,
    space: { width: CANONICAL_W, height: CANONICAL_H },
    paths: [{ start: [10, 10], prims: [
      { k: 'cubic', c1: [1e13, 0], c2: [0, 1e13], to: [400, 400] },
      { k: 'line', to: [10, 10] },
    ] }],
  }
  assert.ok(JSON.stringify(evil).length < 250, 'the whole attack is a couple of hundred bytes')
  const t0 = performance.now()
  const r = validateMask(maskInput({ png: pngOf(maskVector()), vector: evil }))
  const ms = performance.now() - t0
  assert.equal(r.ok, false)
  assert.ok(ms < 2000, `refusing it took ${ms.toFixed(0)}ms — the bound has stopped bounding`)
  // Refused at the PARSE, by magnitude: a control point 1e13 from the origin of a 504x704
  // raster is not a point on a card, and the cheapest refusal is the one that never rasterises.
  assert.match(check(r, 'vector-agrees-with-pixels').detail, /not a point on a card/)

  // A length is bounded the same way a position is. Not because one arc is expensive — the
  // flattener's step floor caps that at ~62,832 points however large `r` gets — but because
  // an arc of radius 1e13 across a 504px card is a straight line wearing a number nobody
  // chose, and the committed artifact is what a reviewer argues with.
  const evilArc = {
    version: 1,
    space: { width: CANONICAL_W, height: CANONICAL_H },
    paths: [{ start: [10, 10], prims: [
      { k: 'arc', to: [400, 400], r: 1e13, sweep: 1 },
      { k: 'line', to: [10, 10] },
    ] }],
  }
  const t1 = performance.now()
  const ra = validateMask(maskInput({ png: pngOf(maskVector()), vector: evilArc }))
  const msArc = performance.now() - t1
  assert.equal(ra.ok, false)
  assert.ok(msArc < 2000, `refusing the arc took ${msArc.toFixed(0)}ms`)
  assert.match(check(ra, 'vector-agrees-with-pixels').detail, /an arc that flat is a line/)
})

test('ORDINARY numbers, too — 19,999 legal cubics is a legal body and still too much work', () => {
  // The quiet variant, and the reason a magnitude bound alone is not enough: nothing here is
  // exotic. Every coordinate is on the card, the primitive count is exactly `parseMaskVector`'s
  // own 20,000 ceiling, and the body is under the 8 MiB cap. It flattens to ~240,000 points
  // and took 5.5 s to rasterise, measured — so the budget is on the POINTS, which is the
  // quantity the work is actually proportional to.
  const prims = []
  const at = (i: number): [number, number] => [
    CANONICAL_W / 2 + 200 * Math.cos((i / 19999) * 2 * Math.PI),
    CANONICAL_H / 2 + 300 * Math.sin((i / 19999) * 2 * Math.PI),
  ]
  for (let i = 1; i <= 19999; i++) {
    const a = at(i - 1)
    const b = at(i)
    prims.push({ k: 'cubic', c1: [a[0] + 30, a[1] + 30], c2: [b[0] - 30, b[1] - 30], to: b })
  }
  const heavy = { version: 1, space: { width: CANONICAL_W, height: CANONICAL_H }, paths: [{ start: at(0), prims }] }
  const t0 = performance.now()
  const r = validateMask(maskInput({ png: pngOf(maskVector()), vector: heavy }))
  const ms = performance.now() - t0
  assert.equal(r.ok, false)
  assert.ok(ms < 2000, `refusing it took ${ms.toFixed(0)}ms`)
  assert.match(check(r, 'vector-agrees-with-pixels').detail, /too complex to check/)
  assert.match(check(r, 'vector-agrees-with-pixels').detail, /hundreds of points, not tens of thousands/)
})

test('…and a legitimately complex mask still passes, well inside the budget', () => {
  // The bound is worthless if it refuses real work. 512 cubics is far more than any hand-drawn
  // mask carries — the fixture above flattens to 10 points — and it flattens to ~10,100,
  // roughly a sixth of the budget.
  const prims = []
  const at = (i: number): [number, number] => [
    CANONICAL_W / 2 + 180 * Math.cos((i / 512) * 2 * Math.PI),
    CANONICAL_H / 2 + 280 * Math.sin((i / 512) * 2 * Math.PI),
  ]
  for (let i = 1; i <= 512; i++) {
    const a = at(i - 1)
    const b = at(i)
    prims.push({ k: 'cubic', c1: [a[0] + 20, a[1] + 20], c2: [b[0] - 20, b[1] - 20], to: b })
  }
  const rich = { version: 1, space: { width: CANONICAL_W, height: CANONICAL_H }, paths: [{ start: at(0), prims }] } as MaskVector
  const r = validateMask(maskInput({ png: pngOf(rich), vector: rich }))
  assert.equal(r.ok, true, r.failures.join(' / '))
  assert.equal(check(r, 'vector-agrees-with-pixels').ok, true)
  assert.ok(VECTOR_MAX_FLATTENED_POINTS > 50_000, 'the budget is stated in points, not primitives')
})

test('a vector drawn in a different raster is refused rather than silently rescaled', () => {
  const v = maskVector()
  const r = validateMask(maskInput({ png: pngOf(v), vector: { ...v, space: { width: 490, height: 674 } } }))
  assert.equal(r.ok, false)
  const c = check(r, 'vector-agrees-with-pixels')
  assert.match(c.detail, /490×674/)
  assert.match(c.detail, /not rescaled into it/, 'the committed numbers must be the ones somebody chose')
})

test('a malformed vector is named as malformed, not as a disagreement', () => {
  // A cubic with one handle rasterises to nothing rather than throwing, so without the parse
  // this would be refused for "IoU 0" — a true statement that tells the contributor nothing.
  const v = maskVector()
  const broken = { ...v, paths: [{ start: [0, 0], prims: [{ k: 'cubic', c1: [1, 1], to: [2, 2] }] }] }
  const r = validateMask(maskInput({ png: pngOf(v), vector: broken }))
  assert.equal(r.ok, false)
  assert.match(check(r, 'vector-agrees-with-pixels').detail, /not a readable path list/)
  assert.match(check(r, 'vector-agrees-with-pixels').detail, /both handles/)
})

test('a vector cannot be checked against pixels that did not decode, and fails closed', () => {
  const r = validateMask(maskInput({ png: Buffer.from('not a png'), vector: maskVector() }))
  assert.equal(r.ok, false)
  const c = check(r, 'vector-agrees-with-pixels')
  assert.equal(c.ok, false, 'an "ok" beside an undecodable mask would be an answer to no question')
  assert.match(c.detail, /did not decode/)
})

test('THE CALIBRATION RECORD — where the tolerance sits, measured on both sides of it', () => {
  // Three numbers, and each is doing a job the other two cannot. Re-stated when the boundary
  // measurement became SYMMETRIC and the max became a gate; the p95 and IoU thresholds did not
  // move, because for every honest case in this table the two directions agree exactly — the
  // second direction only ever finds something when one side carries a region the other omits,
  // which is a forgery rather than a rasteriser disagreement.
  //
  //   | pair                              | IoU    |  p95  |  max  | verdict  |
  //   |---|---|---|---|---|
  //   | identical geometry                | 1.0000 |  0.00 |  0.00 | accept   |
  //   | whole boundary offset 0.4px       | 0.9962 |  1.00 |  1.00 | accept   |
  //   | whole boundary offset 0.9px       | 0.9848 |  1.00 |  1.33 | accept   |
  //   | whole boundary offset 1.5px       | 0.9774 |  2.00 |  2.67 | REFUSE (IoU) |
  //   | whole boundary offset 2.5px       | 0.9627 |  3.00 |  4.00 | REFUSE   |
  //   | one handle moved 5px              | 0.9964 |  1.00 |  2.00 | accept   |
  //   | one handle moved 10px             | 0.9928 |  3.00 |  4.00 | REFUSE   |
  //   | one handle moved 20px             | 0.9852 |  7.00 |  9.00 | REFUSE   |
  //   | one handle moved 40px             | 0.9709 | 15.00 | 18.00 | REFUSE   |
  //   | 3,600px block only in the pixels  | 0.9804 | 74.00 |120.00 | REFUSE   |
  //   |    …the same pair, one-directional| 0.9804 |  0.00 |  0.00 | (accepted before) |
  //   |    64px block only in the pixels  | 0.9997 |  0.00 | 98.67 | REFUSE   |
  //   | 40 bars vs the gaps between them  | 0.0000 |  0.00 |  4.00 | REFUSE   |
  //
  // IoU is the AREA measure, and what it has to tolerate is two honest rasterisers disagreeing
  // along the antialiasing band. A whole-boundary sub-pixel offset — the shape a pixel-centre
  // vs pixel-corner convention difference takes — is the worst realistic version of that, so
  // the floor is placed just outside it.
  //
  // Boundary p95 is the LOCALITY measure, and it is there because IoU dilutes: dragging one
  // anchor of a ~2000px boundary costs a fraction of a percent of area, which a floor loose
  // enough for antialiasing would never see.
  //
  // Boundary max is the EXISTENCE measure — "is there anywhere at all these two disagree" —
  // and it is the only one of the three that sees a small omitted region. The honest worst
  // case sets its ceiling: 1.33px at 0.9px of whole-boundary offset, 2.67px at 1.5px.
  const base = decodePng(pngOf(maskVector()))
  const measure = (v: MaskVector): { iou: number; p95: number; max: number } => {
    const { agreement } = checkVectorAgreesWithPixels(base, v)
    return { iou: agreement!.iou, p95: agreement!.boundaryP95, max: agreement!.boundaryMax }
  }

  // A whole boundary offset of 0.9px — a full pixel of rasteriser disagreement everywhere —
  // still PASSES. Anything tighter would refuse honest submissions from a browser canvas.
  const nearMiss = measure(maskVector(0, 0.9))
  assert.ok(nearMiss.iou >= VECTOR_AGREEMENT_MIN_IOU, `0.9px offset measured IoU ${nearMiss.iou}`)
  assert.ok(nearMiss.p95 <= VECTOR_AGREEMENT_MAX_BOUNDARY_P95_PX, `0.9px offset measured p95 ${nearMiss.p95}px`)
  assert.ok(nearMiss.max <= VECTOR_AGREEMENT_MAX_BOUNDARY_MAX_PX, `0.9px offset measured max ${nearMiss.max}px`)

  // THE MAX CEILING TIGHTENED NOTHING. Every pair the two older gates accept, it also accepts:
  // the worst of them is that 0.9px offset at max 1.33px, which is 3.8x inside the 5px ceiling.
  // The next case out, a 1.5px offset, reaches max 2.67px — and is refused by the IoU floor at
  // 0.9774, exactly as it was before this gate existed. So no honest submission changed side.
  assert.equal(checkVectorAgreesWithPixels(base, maskVector(0, 0.9)).check.ok, true)
  const edgeOfHonest = measure(maskVector(0, 1.5))
  assert.ok(
    edgeOfHonest.iou < VECTOR_AGREEMENT_MIN_IOU,
    `1.5px offset measured IoU ${edgeOfHonest.iou}, p95 ${edgeOfHonest.p95}px, max ${edgeOfHonest.max}px — ` +
      'if IoU no longer refuses this, the max ceiling has become the gate that does and needs re-measuring',
  )
  assert.ok(edgeOfHonest.max < VECTOR_AGREEMENT_MAX_BOUNDARY_MAX_PX, `and its max ${edgeOfHonest.max}px is inside the ceiling`)

  // At 2.5px it is refused: that is no longer antialiasing, it is different geometry.
  const tooFar = measure(maskVector(0, 2.5))
  assert.ok(
    tooFar.iou < VECTOR_AGREEMENT_MIN_IOU ||
      tooFar.p95 > VECTOR_AGREEMENT_MAX_BOUNDARY_P95_PX ||
      tooFar.max > VECTOR_AGREEMENT_MAX_BOUNDARY_MAX_PX,
    `2.5px offset measured IoU ${tooFar.iou}, p95 ${tooFar.p95}px, max ${tooFar.max}px — the tolerance has drifted`,
  )

  // A LOCAL edit crosses the boundary ceiling long before it costs enough area to move IoU,
  // which is the whole reason there is more than one number.
  const local = measure(maskVector(20))
  assert.ok(local.p95 > VECTOR_AGREEMENT_MAX_BOUNDARY_P95_PX, `a 20px handle move measured p95 ${local.p95}px`)
  assert.ok(local.iou > 0.98 - 0.01, `and cost only ${(1 - local.iou).toFixed(4)} of IoU — hence the second measure`)
})

test('a canon submission is gated the same way — the rule is about the pipeline, not about masks', () => {
  const clean = validateCanon({
    patternId: 'cosmos',
    uniforms: fullCanon('cosmos'),
    seedContract: 2,
    conflict: FRESH,
    body: { patternId: 'cosmos', uniforms: fullCanon('cosmos') },
  })
  assert.equal(clean.ok, true, clean.failures.join(' / '))

  const forged = validateCanon({
    patternId: 'cosmos',
    uniforms: fullCanon('cosmos'),
    seedContract: 2,
    conflict: FRESH,
    body: { patternId: 'cosmos', provenance: { verification: { verifiedBy: 'cheyras' } } },
  })
  assert.equal(forged.ok, false)
  assert.match(check(forged, 'no-claimed-provenance').detail, /provenance\.verification/)
})
