// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen

import assert from 'node:assert/strict'
import test from 'node:test'
import { LADDER_STEPS } from '../ladder.ts'
import { scheduleFrame } from '../schedule.ts'
import type { CardState, StagePlan } from '../types.ts'

const viewport = { width: 1000, height: 800 }

/** A row of cards across the viewport, left to right. */
function grid(n: number, over: Partial<CardState> = {}): CardState[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    index: i,
    rect: { x: (i * 1000) / n, y: 300, width: 1000 / n, height: (1000 / n) * 1.4 },
    intersecting: true,
    largeEnough: true,
    ...over,
  }))
}

const stepWithRung = (rung: number): StagePlan => LADDER_STEPS.find((s) => s.rung === rung)!

test('offscreen cards are neither drawn nor updated', () => {
  const cards = grid(4)
  cards[2]!.intersecting = false
  const out = scheduleFrame(cards, LADDER_STEPS[0]!, viewport)
  assert.equal(out[2]!.draw, false)
  assert.equal(out[2]!.animate, false)
  assert.equal(out[0]!.draw, true)
  assert.equal(out[0]!.animate, true)
})

test('a card below minAnimateWidth draws but does not animate', () => {
  const cards = grid(2)
  cards[1]!.largeEnough = false
  const out = scheduleFrame(cards, LADDER_STEPS[0]!, viewport)
  assert.deepEqual(
    out.map((o) => [o.draw, o.animate]),
    [
      [true, true],
      [true, false],
    ],
  )
})

test('rung 3 freezes the excess in registration order, stably', () => {
  const cards = grid(8)
  const out = scheduleFrame(cards, stepWithRung(3), viewport)
  const animating = out.filter((o) => o.animate).map((o) => o.id)
  assert.deepEqual(animating, ['c0', 'c1', 'c2', 'c3'], 'half of eight, the first four')
  // Same input, same answer: nothing may flicker between frozen and live.
  const again = scheduleFrame(cards, stepWithRung(3), viewport)
  assert.deepEqual(again, out)
  assert.ok(out.every((o) => o.draw), 'a frozen card is still on the page')
  assert.ok(out.every((o) => !o.park), 'rung 3 holds tilt; it does not park it')
})

test('rung 4 keeps the centre and stops the farthest, parked', () => {
  const cards = grid(8)
  const out = scheduleFrame(cards, stepWithRung(4), viewport)
  const animating = out.filter((o) => o.animate).map((o) => o.id)
  assert.equal(animating.length, 1)
  assert.ok(
    animating[0] === 'c3' || animating[0] === 'c4',
    `expected a centre card, got ${animating[0]}`,
  )
  assert.ok(out.filter((o) => !o.animate).every((o) => o.park && o.draw))
})

test('the animating budget counts visible cards, not registered ones', () => {
  const cards = grid(8)
  for (const c of cards.slice(4)) c.intersecting = false
  const out = scheduleFrame(cards, stepWithRung(3), viewport)
  // Four visible, half of them animate — the offscreen four must not spend
  // budget they were never going to use.
  assert.equal(out.filter((o) => o.animate).length, 2)
})

test('a card too small to animate does not consume the budget either', () => {
  const cards = grid(8)
  for (const c of cards.slice(0, 4)) c.largeEnough = false
  const out = scheduleFrame(cards, stepWithRung(3), viewport)
  const animating = out.filter((o) => o.animate).map((o) => o.id)
  assert.deepEqual(animating, ['c4', 'c5', 'c6', 'c7'])
})
