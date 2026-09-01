// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The y-flip is the bug this file exists to prevent.
//
// CSS rects grow down from the top-left; a scissor box grows up from the
// bottom-left, in device pixels. Every underlay draw crosses that boundary,
// once, and a stage that gets it wrong renders every card mirrored about the
// viewport's horizontal centre line — which looks plausible for the row that
// happens to be centred and wrong for every other one.

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cardFitRect,
  cardGlBox,
  distanceFromCentre,
  intersectsViewport,
  scissorBox,
  shortEdge,
} from '../geometry.ts'

const viewport = { width: 1000, height: 800 }

test('a card at the top of the page scissors at the top of the buffer', () => {
  const box = scissorBox({ x: 100, y: 0, width: 200, height: 280 }, viewport, 1)
  assert.deepEqual(box, { x: 100, y: 800 - 280, width: 200, height: 280 })
})

test('a card at the bottom of the page scissors at y = 0', () => {
  const box = scissorBox({ x: 0, y: 520, width: 200, height: 280 }, viewport, 1)
  assert.deepEqual(box, { x: 0, y: 0, width: 200, height: 280 })
})

test('device pixel ratio scales the box, not the flip', () => {
  const box = scissorBox({ x: 10, y: 20, width: 100, height: 140 }, viewport, 2)
  assert.deepEqual(box, { x: 20, y: 1600 - 40 - 280, width: 200, height: 280 })
})

test('boxes are whole device pixels', () => {
  const box = scissorBox({ x: 10.4, y: 20.6, width: 99.5, height: 139.2 }, viewport, 1.5)
  for (const v of Object.values(box)) assert.equal(v, Math.round(v))
})

test('the drawn box is in CSS pixels, because the renderer applies the ratio', () => {
  // three multiplies every setViewport/setScissor by its own pixel ratio on the
  // way to GL. A device-pixel box therefore applies the ratio TWICE — invisible
  // at ratio 1, and at ratio 0.5 it draws every card into the wrong quarter of
  // the screen. This test is the regression, and it cost a CI run to learn.
  const rect = { x: 100, y: 40, width: 200, height: 280 }
  assert.deepEqual(cardGlBox(rect, viewport), scissorBox(rect, viewport, 1))
  assert.deepEqual(cardGlBox(rect, viewport), { x: 100, y: 800 - 40 - 280, width: 200, height: 280 })
})

test('a scaled-down render stays inside its own rect, anchored to the top edge', () => {
  const rect = { x: 100, y: 40, width: 200, height: 280 }
  const full = cardGlBox(rect, viewport, 1)
  const half = cardGlBox(rect, viewport, 0.5)
  assert.equal(half.width, 100)
  assert.equal(half.height, 140)
  assert.equal(half.x, full.x)
  // GL y grows up, so the card's top edge is the box's HIGHEST y — a scaled
  // box shares it, and never bleeds into the neighbour above.
  assert.equal(half.y + half.height, full.y + full.height)
  assert.ok(half.y >= full.y)
})

test('a render scale at or above 1 is not a resize', () => {
  const rect = { x: 10, y: 10, width: 176, height: 246 }
  assert.deepEqual(cardGlBox(rect, viewport, 1), cardGlBox(rect, viewport))
  assert.deepEqual(cardGlBox(rect, viewport, 2), cardGlBox(rect, viewport))
})

test('intersection is inclusive of partly-visible cards and margins', () => {
  assert.equal(intersectsViewport({ x: -50, y: 10, width: 100, height: 140 }, viewport), true)
  assert.equal(intersectsViewport({ x: -150, y: 10, width: 100, height: 140 }, viewport), false)
  assert.equal(
    intersectsViewport({ x: -150, y: 10, width: 100, height: 140 }, viewport, 128),
    true,
    'the root margin is what makes a card ready before it arrives',
  )
  assert.equal(intersectsViewport({ x: 10, y: 900, width: 100, height: 140 }, viewport), false)
})

test('distance from centre orders rung 4', () => {
  const centre = { x: 450, y: 330, width: 100, height: 140 }
  const corner = { x: 0, y: 0, width: 100, height: 140 }
  assert.ok(distanceFromCentre(centre, viewport) < 1)
  assert.ok(distanceFromCentre(corner, viewport) > distanceFromCentre(centre, viewport))
})

test('the short edge of a portrait card is its width', () => {
  assert.equal(shortEdge({ x: 0, y: 0, width: 150, height: 209 }), 150)
})

test('the fit rect is the inverse of the 1.16-margin projection', () => {
  const aspect = 88 / 63
  // Tall host: width-limited.
  const wide = cardFitRect(400, 1000, aspect)
  assert.ok(Math.abs(wide.height / wide.width - aspect) < 1e-9)
  assert.ok(wide.width < 400, 'the margin is what stops a tilted card clipping')
  // Wide host: height-limited, and centred.
  const tall = cardFitRect(1000, 400, aspect)
  assert.ok(Math.abs(tall.height - 400 / 1.16) < 1e-9)
  assert.ok(Math.abs(tall.x + tall.width / 2 - 500) < 1e-9)
  assert.ok(Math.abs(tall.y + tall.height / 2 - 200) < 1e-9)
})
