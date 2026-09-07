// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The recipe half of the ink layer's no-op proof.
//
// It lives here rather than in @foilkit/core because core imports nothing — the
// contract tools/check-independence.mjs proves on every push — and a test file
// is still an import. Patterns may depend on core; the arrow points that way.
//
// What is pinned: a recipe carrying a procedural stand-in for a printed design
// YIELDS to the data tier when the tier is on, and only then. The fallback chain
// must stay reachable, because the shipping state of the ink registry is that
// most keys have no tile and every one of those printings renders the fallback.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildFoilShader } from '@foilkit/core'
import { PATTERNS, patternById } from '../patterns.ts'

test('reverse-sheet yields its procedural stamps ONLY when the ink tier is on', () => {
  const glsl = patternById('reverse-sheet').glsl
  assert.match(glsl, /if \(uInkOn > 0\.5\) \{/, 'the yield branch is gone')
  // Order matters: data first, then the glyph slot, then the procedural
  // ring+dot. Losing the `else` would make the stand-in unreachable even with no
  // ink at all, which is a silent render change on every reverse in the catalog.
  assert.match(glsl, /\} else if \(uGlyphOn > 0\.5\) \{/)
  assert.match(glsl, /float ring = smoothstep\(/, 'the procedural fallback itself is gone')
  // And the yield sets the stamp field to nothing rather than dimming it — a
  // partial yield would still be drawing a guess on top of an authored design.
  assert.match(glsl, /if \(uInkOn > 0\.5\) \{\s*(\/\/[^\n]*\n\s*)*emb = 0\.0;/)
})

test('no recipe declares a uniform of its own, ink or otherwise', () => {
  // The ABI is PREAMBLE + recipe + MAIN, so a recipe-declared uniform is a
  // redeclaration error on some drivers and a shadowed value on others. This has
  // been true since the workbench split; the ink uniforms just made the surface
  // eight names wider, which is eight more chances to get it wrong.
  for (const p of PATTERNS) {
    assert.ok(!/^\s*uniform\s/m.test(p.glsl), `${p.id}: a recipe may not declare uniforms`)
  }
})

test('every recipe assembles with the ink layer present and inert', () => {
  for (const p of PATTERNS) {
    const src = buildFoilShader(p)
    assert.equal(
      [...src.fragmentShader.matchAll(/uniform sampler2D uInkTex;/g)].length,
      1,
      `${p.id}: uInkTex is declared more or less than once`,
    )
    assert.equal(src.structural.uInkOn, 0, `${p.id}: the ink gate does not default off`)
    assert.ok(!('uInkOn' in src.uniforms), `${p.id}: uInkOn leaked into the scalar table`)
  }
})
