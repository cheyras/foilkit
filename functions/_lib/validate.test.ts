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
import { encodePng } from '@foilkit/forge'
import { PATTERNS, patternById } from '@foilkit/patterns'

const { validateMask, validateCanon, checkAssembledGlsl, MAX_COVERAGE } = await import('./validate.ts')

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
