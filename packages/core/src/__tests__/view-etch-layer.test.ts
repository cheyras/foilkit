// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The card-space view + etch plate layer (R9-PLATES): the NO-OP PROOF at the
// source level, and the geometry of the view vector.
//
// The pixel proof is the parity harness: 45 recipes rendered on main and on the
// R9 branch, 45/45 byte-identical (2026-10-17, after a 45/45 control pair).
// These tests pin the structural reasons that came out that way, so a change
// that would break it fails here in seconds. If one regresses, run the parity
// harness; do not relax the test.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CARD_ASPECT, GLOBAL_DEFAULTS, MAIN, PREAMBLE, SAMPLER_UNIFORMS, STRUCTURAL_DEFAULTS } from '../shader.ts'

test('the etch gate defaults to off, so the plate costs nothing until a card supplies one', () => {
  assert.equal(STRUCTURAL_DEFAULTS.uEtchOn, 0)
  assert.equal(STRUCTURAL_DEFAULTS.uEtchRelief, 1)
  assert.ok(STRUCTURAL_DEFAULTS.uEtchBump > 0)
  // Matches STAGE_DEFAULTS.maxTiltDeg (16 deg); the three stage overwrites it every frame.
  assert.ok(Math.abs(STRUCTURAL_DEFAULTS.uTiltMax - (16 * Math.PI) / 180) < 1e-12)
})

test('no R9 uniform is a CORE uniform, so no canon file can carry a plate or the camera', () => {
  for (const key of ['uEtchOn', 'uEtchTexel', 'uEtchRelief', 'uEtchBump', 'uTiltMax', 'uCamDist']) {
    assert.ok(!(key in GLOBAL_DEFAULTS), `${key} must not be a core uniform`)
  }
})

test('the etch sampler is declared, so every renderer binds a valid texture', () => {
  assert.ok(SAMPLER_UNIFORMS.includes('uEtchTex'))
  assert.match(PREAMBLE, /uniform sampler2D uEtchTex;/)
})

test('every etch read and the relief term sit inside the uEtchOn gate', () => {
  const reads = [...MAIN.matchAll(/texture2D\(uEtchTex/g)]
  assert.equal(reads.length, 3, 'the plate is sampled exactly three times (value + two neighbours)')
  const gate = MAIN.indexOf('if (uEtchOn > 0.5) {')
  assert.ok(gate > 0, 'the sampling gate is gone or was rewritten')
  const guarded = MAIN.slice(gate, MAIN.indexOf('\n  }', gate))
  assert.equal([...guarded.matchAll(/texture2D\(uEtchTex/g)].length, 3, 'an etch read escaped its gate')
  const relief = MAIN.indexOf('if (uEtchOn > 0.5 && uEtchRelief > 0.0) {')
  assert.ok(relief > MAIN.indexOf('vec3 foil = foilPattern('), 'the relief must modulate the foil, after it exists')
  // Outside the gates, the only etch state is the zeroed globals the recipe may read.
  assert.match(MAIN, /gEtch = 0\.0;/)
  assert.match(MAIN, /gEtchSlope = vec2\(0\.0\);/)
})

test('the card-space globals are filled before the recipe runs', () => {
  const fill = MAIN.indexOf('gViewTS = cardViewTS(uv);')
  assert.ok(fill > 0)
  assert.ok(fill < MAIN.indexOf('foilPattern('), 'a recipe would read gViewTS before it is set')
})

// The GLSL eye transform, mirrored in TypeScript, checked against three's own
// convention: world = Rx(rotation.x) * Ry(rotation.y) * object, camera on +z.
function cardViewTS(uv: [number, number], tilt: [number, number], tiltMax: number, camDist: number): [number, number, number] {
  const pitch = -tilt[1] * tiltMax
  const yaw = tilt[0] * tiltMax
  let c: [number, number, number] = [0, 0, camDist]
  c = [c[0], Math.cos(pitch) * c[1] + Math.sin(pitch) * c[2], -Math.sin(pitch) * c[1] + Math.cos(pitch) * c[2]]
  c = [Math.cos(yaw) * c[0] - Math.sin(yaw) * c[2], c[1], Math.sin(yaw) * c[0] + Math.cos(yaw) * c[2]]
  const p = [uv[0] - 0.5, (uv[1] - 0.5) * CARD_ASPECT, 0]
  const d = [c[0] - p[0]!, c[1] - p[1]!, c[2] - p[2]!]
  const n = Math.hypot(...d)
  return [d[0]! / n, d[1]! / n, d[2]! / n]
}
function worldFromObject(v: [number, number, number], rx: number, ry: number): [number, number, number] {
  const a: [number, number, number] = [Math.cos(ry) * v[0] + Math.sin(ry) * v[2], v[1], -Math.sin(ry) * v[0] + Math.cos(ry) * v[2]]
  return [a[0], Math.cos(rx) * a[1] - Math.sin(rx) * a[2], Math.sin(rx) * a[1] + Math.cos(rx) * a[2]]
}

test('at rest the card centre sees the eye head-on', () => {
  const v = cardViewTS([0.5, 0.5], [0, 0], 0.28, 2.8)
  assert.deepEqual(v.map((x) => Math.round(x * 1e9) / 1e9), [0, 0, 1])
})

test('the eye vector, rotated back to world space, points at the camera for any tilt', () => {
  const tiltMax = (16 * Math.PI) / 180
  const D = 2.8
  for (const tilt of [[1, 0], [0, 1], [-0.6, 0.8], [0.3, -1]] as [number, number][]) {
    for (const uv of [[0.5, 0.5], [0.1, 0.9], [0.95, 0.05]] as [number, number][]) {
      const rx = -tilt[1] * tiltMax
      const ry = tilt[0] * tiltMax
      const vObj = cardViewTS(uv, tilt, tiltMax, D)
      const pObj: [number, number, number] = [uv[0] - 0.5, (uv[1] - 0.5) * CARD_ASPECT, 0]
      const pW = worldFromObject(pObj, rx, ry)
      const vW = worldFromObject(vObj, rx, ry)
      const toCam = [0 - pW[0], 0 - pW[1], D - pW[2]]
      const n = Math.hypot(...toCam)
      for (let i = 0; i < 3; i++) assert.ok(Math.abs(vW[i]! - toCam[i]! / n) < 1e-9, `tilt ${tilt} uv ${uv} axis ${i}`)
    }
  }
})

test('tilting right swings the eye toward the card’s left in card space', () => {
  // rotation.y > 0 turns the face toward +x, so the camera appears on the card's -x side.
  const v = cardViewTS([0.5, 0.5], [1, 0], (16 * Math.PI) / 180, 2.8)
  assert.ok(v[0] < 0)
})
