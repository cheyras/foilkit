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
  checkVectorAgreesWithPixels,
  claimedProvenanceKeys,
  CLIENT_MAY_NOT_CLAIM,
  MAX_COVERAGE,
  VECTOR_AGREEMENT_MIN_IOU,
  VECTOR_AGREEMENT_MAX_BOUNDARY_P95_PX,
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
    assert.deepEqual(found, [key], `${key} must be caught`)
  }
  assert.deepEqual(
    claimedProvenanceKeys({ a: { verification: 1 }, b: [{ author: 2 }] }).sort(),
    ['a.verification', 'b[0].author'],
  )
  assert.deepEqual(claimedProvenanceKeys({ cardId: 'x', prior: { eraId: 'wotc' } }), [])
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

/** The PNG a contributor's canvas would produce for that geometry. */
function pngOf(v: MaskVector): Buffer {
  const alpha = rasterizeMaskVector(v, CANONICAL_W, CANONICAL_H)
  const rgba = new Uint8Array(CANONICAL_W * CANONICAL_H * 4)
  for (let i = 0; i < alpha.length; i++) {
    rgba[i * 4] = 255
    rgba[i * 4 + 1] = 45
    rgba[i * 4 + 2] = 100
    rgba[i * 4 + 3] = alpha[i]!
  }
  return Buffer.from(encodePng({ width: CANONICAL_W, height: CANONICAL_H, rgba }))
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
  // Two numbers, and each is doing a job the other cannot.
  //
  // IoU is the AREA measure, and what it has to tolerate is two honest rasterisers disagreeing
  // along the antialiasing band. A whole-boundary sub-pixel offset — the shape a pixel-centre
  // vs pixel-corner convention difference takes — is the worst realistic version of that, so
  // the floor is placed just outside it.
  //
  // Boundary p95 is the LOCALITY measure, and it is there because IoU dilutes: dragging one
  // anchor of a ~2000px boundary costs a fraction of a percent of area, which a floor loose
  // enough for antialiasing would never see.
  const base = decodePng(pngOf(maskVector()))
  const measure = (v: MaskVector): { iou: number; p95: number } => {
    const { agreement } = checkVectorAgreesWithPixels(base, v)
    return { iou: agreement!.iou, p95: agreement!.boundaryP95 }
  }

  // A whole boundary offset of 0.9px — a full pixel of rasteriser disagreement everywhere —
  // still PASSES. Anything tighter would refuse honest submissions from a browser canvas.
  const nearMiss = measure(maskVector(0, 0.9))
  assert.ok(nearMiss.iou >= VECTOR_AGREEMENT_MIN_IOU, `0.9px offset measured IoU ${nearMiss.iou}`)
  assert.ok(nearMiss.p95 <= VECTOR_AGREEMENT_MAX_BOUNDARY_P95_PX, `0.9px offset measured p95 ${nearMiss.p95}px`)

  // At 2.5px it is refused: that is no longer antialiasing, it is different geometry.
  const tooFar = measure(maskVector(0, 2.5))
  assert.ok(
    tooFar.iou < VECTOR_AGREEMENT_MIN_IOU || tooFar.p95 > VECTOR_AGREEMENT_MAX_BOUNDARY_P95_PX,
    `2.5px offset measured IoU ${tooFar.iou}, p95 ${tooFar.p95}px — the tolerance has drifted`,
  )

  // A LOCAL edit crosses the boundary ceiling long before it costs enough area to move IoU,
  // which is the whole reason there are two numbers rather than one.
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
