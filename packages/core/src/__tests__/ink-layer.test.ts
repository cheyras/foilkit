// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The ink-design layer's NO-OP PROOF, at the source level.
//
// The pixel proof is the parity harness — 45 recipes on a blank base, rendered
// before and after, byte-identical or not. That proof is real and it was run
// (45/45), but it is an instrument that needs Playwright, a GPU stand-in and
// ten minutes, so it cannot be the thing CI runs on every push.
//
// These tests pin the STRUCTURAL reasons the pixel proof came out that way, so
// a future change that would break it fails here first and fails in seconds:
//   * the gates default to off, and live in STRUCTURAL_DEFAULTS where a canon
//     file can never reach them;
//   * every instruction the layer adds sits inside the `uInkOn` branch;
//   * the recipe that yields to the tier yields only when the tier is on.
// If one of these regresses, run the parity harness — do not relax the test.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { GLOBAL_DEFAULTS, MAIN, PREAMBLE, SAMPLER_UNIFORMS, STRUCTURAL_DEFAULTS, buildFoilShader } from '../shader.ts'

// NOT `import { PATTERNS } from '@foilkit/patterns'`. Core imports nothing —
// that is the contract tools/check-independence.mjs proves on every push — and
// a test is still an import. The recipe half of this proof lives next door in
// @foilkit/patterns, which may depend on core because the arrow points that way.
// A synthetic recipe is enough to assemble a shader here.
const STUB = {
  id: 'stub',
  label: 'Stub',
  taxonomy: 'test fixture',
  family: 'none' as const,
  usedOn: 'nothing',
  glsl: 'vec3 foilPattern(vec2 uv, vec2 tilt) { return vec3(0.0); }',
  defaults: {},
  params: [],
  implemented: true,
}

test('the ink gates default to off, so the layer costs nothing until asked for', () => {
  assert.equal(STRUCTURAL_DEFAULTS.uInkOn, 0)
  assert.equal(STRUCTURAL_DEFAULTS.uInkDraw, 0)
  // Strength and tone are meaningless while the gates are 0; they are seeded so
  // a surface that flips uInkOn without setting them gets the registry's own
  // default behaviour (ink blocks foil fully, and does not paint itself).
  assert.equal(STRUCTURAL_DEFAULTS.uInkStrength, 1)
  assert.equal(STRUCTURAL_DEFAULTS.uInkTone, 0)
})

test('no ink uniform is a CORE uniform, so no canon file can ever carry one', () => {
  // GLOBAL_DEFAULTS is the set a canon snapshot may contain, and
  // tools/parity/data-receipt.mjs fails CI on a canon file carrying anything
  // else. The ink layer is a resolved fact about one printing, not a dial a
  // human moves while tuning a recipe — if it leaked in here, a canon file
  // could pin an ink design onto every card that shares its pattern, which is
  // the exact conflation this tier exists to undo.
  for (const key of Object.keys(GLOBAL_DEFAULTS)) {
    assert.ok(!key.startsWith('uInk') || key === 'uInkGuard' || key === 'uInkPop', `${key} must not be a core uniform`)
  }
  assert.ok(!('uInkOn' in GLOBAL_DEFAULTS))
  assert.ok(!('uInkTile' in GLOBAL_DEFAULTS))
})

test('the tile sampler is declared, so every renderer binds a valid texture', () => {
  assert.ok(SAMPLER_UNIFORMS.includes('uInkTex'))
  assert.match(PREAMBLE, /uniform sampler2D uInkTex;/)
})

test('every added instruction sits inside the uInkOn branch — the no-op is structural', () => {
  // The coverage sampler is declared in the preamble (a function body, never
  // executed on its own) and CALLED exactly once, inside the gate.
  const calls = [...MAIN.matchAll(/inkCoverage\(/g)]
  assert.equal(calls.length, 1, 'inkCoverage must be called exactly once, from inside the gate')

  const gate = MAIN.indexOf('if (uInkOn > 0.5 && uInkDraw > 0.5) {')
  assert.ok(gate > 0, 'the coverage gate is gone or was rewritten')
  const gateEnd = MAIN.indexOf('\n  }', gate)
  const guarded = MAIN.slice(gate, gateEnd)
  assert.ok(guarded.includes('inkCoverage(uv)'), 'the sample moved out of its gate')
  assert.ok(guarded.includes('m *= 1.0 - inkDesign;'), 'the coverage multiply moved out of its gate')

  // SCOPED BY THE SHEET, and this is a real bug that shipped for one render.
  // The ink is printed ON the foil sheet, so it exists only where the sheet
  // does. Without the `* m` the design paints straight across the art window on
  // a reverse — sheet scope is the era rect INVERTED, so m is 0 over the
  // illustration — and the first render of this layer did exactly that.
  // Measured after the fix on a real SV reverse: art-window meanAE 0.091
  // against 8.82 over the sheet.
  assert.match(
    guarded,
    /inkDesign = clamp\(inkCoverage\(uv\) \* uInkStrength, 0\.0, 1\.0\) \* m;/,
    'the ink coverage lost its mask term — it will paint over the art window',
  )

  // The tone term has its own gate, and it is doubly guarded: `inkDesign` is
  // still exactly 0.0 when the first gate did not run, so even a future edit
  // that widened this one could not paint anything.
  assert.match(MAIN, /if \(uInkOn > 0\.5 && inkDesign > 0\.0\) \{/)
  assert.match(MAIN, /float inkDesign = 0\.0;/)
})

test('the assembled shader declares the layer exactly once, and keeps it structural', () => {
  const src = buildFoilShader(STUB)
  assert.equal([...src.fragmentShader.matchAll(/uniform float uInkOn;/g)].length, 1)
  // The uniform table a renderer seeds from is scalars only; the ink state comes
  // from `structural`, which is where surface-owned values belong and where a
  // canon snapshot cannot reach.
  assert.ok(!('uInkOn' in src.uniforms), 'uInkOn leaked into the scalar table')
  assert.equal(src.structural.uInkOn, 0)
  assert.equal(src.structural.uInkDraw, 0)
})

test('shader assembly is deterministic — the same recipe builds the same string', () => {
  // The tile and its placement are UNIFORMS, not source, so a placement change
  // never recompiles and two builds of one recipe are byte-identical. That is
  // what makes a slider on `across` cheap enough to be a slider.
  assert.equal(buildFoilShader(STUB).fragmentShader, buildFoilShader(STUB).fragmentShader)
})
