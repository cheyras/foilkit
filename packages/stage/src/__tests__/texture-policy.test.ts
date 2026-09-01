// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_FACE_TEXTURE_PX,
  MIN_FACE_TEXTURE_PX,
  faceTextureWidth,
  needsLargerDecode,
} from '../texture-policy.ts'

test('a 300px tile has no use for a 600w scan', () => {
  assert.equal(faceTextureWidth(300, { pixelRatio: 1 }), 512)
  assert.ok(faceTextureWidth(300, { pixelRatio: 1 }) < 1024)
})

test('the decode is bucketed, so a resize of a few px is not a re-upload', () => {
  const a = faceTextureWidth(300, { pixelRatio: 1 })
  const b = faceTextureWidth(311, { pixelRatio: 1 })
  assert.equal(a, b, 'a scrollbar appearing must not re-decode the screen')
})

test('device pixel ratio counts, and the ceiling holds', () => {
  assert.ok(faceTextureWidth(400, { pixelRatio: 2 }) >= faceTextureWidth(400, { pixelRatio: 1 }))
  assert.equal(faceTextureWidth(4000, { pixelRatio: 3 }), MAX_FACE_TEXTURE_PX)
})

test('a thumbnail still gets a usable texture', () => {
  assert.equal(faceTextureWidth(1, { pixelRatio: 1 }), MIN_FACE_TEXTURE_PX)
  assert.equal(faceTextureWidth(0, { pixelRatio: 1 }), MIN_FACE_TEXTURE_PX)
})

test('decodes only ever grow', () => {
  assert.equal(needsLargerDecode(256, 512), true)
  assert.equal(needsLargerDecode(512, 256), false, 'a card that shrinks keeps what it has')
  assert.equal(needsLargerDecode(512, 512), false)
})
