// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen

import assert from 'node:assert/strict'
import test from 'node:test'
import type { FoilPattern } from '../types.ts'
import { PREAMBLE, MAIN, VERTEX_SHADER, VERTEX_SHADER_THREE, STRUCTURAL_DEFAULTS, buildFoilShader } from '../shader.ts'

const pattern: FoilPattern = {
  id: 'view-test', label: 'View test', taxonomy: 'test', family: 'field', usedOn: 'test', implemented: true,
  defaults: {}, params: [], glsl: 'vec3 foilPattern(vec2 uv, vec2 tilt) { return vec3(uv + tilt, 0.0); }\n',
}

test('default assembly remains the exact historical concatenation and seeds', () => {
  const source = buildFoilShader(pattern)
  assert.equal(source.vertexShader, VERTEX_SHADER)
  assert.equal(source.vertexShaderThree, VERTEX_SHADER_THREE)
  assert.equal(source.fragmentShader, PREAMBLE + pattern.glsl + MAIN)
  assert.equal(source.structural, STRUCTURAL_DEFAULTS)
  assert.ok(!source.fragmentShader.includes('uViewDirection'))
})

test('opt-in preserves recipe ABI and uses a bounded perspective divide', () => {
  const source = buildFoilShader(pattern, { viewDirection: true })
  assert.match(source.fragmentShader, /uniform vec3 uViewDirection;/)
  assert.match(source.fragmentShader, /max\(abs\(uViewDirection.z\), 0\.05\)/)
  assert.match(source.fragmentShader, /clamp\(uViewDirection.xy \/ divisor/)
  assert.match(source.fragmentShader, /#define uTilt foilViewTilt\(\)/)
  assert.ok(source.fragmentShader.includes(pattern.glsl))
  assert.deepEqual(source.uniforms, buildFoilShader(pattern).uniforms)
})
