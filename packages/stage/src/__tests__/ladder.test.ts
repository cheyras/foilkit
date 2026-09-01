// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The ladder is ORDERED, and the order is the deliverable.
//
// "Correct behaviour under load is the deliverable; a specific frame number on
// a specific phone is not." So none of these tests name a device or a frame
// rate that a real machine has to hit. They feed synthetic work times and
// assert the SHAPE of the response: resolution before cadence, cadence before
// freezing, freezing before stopping, and every rung given up in reverse as
// headroom returns.

import assert from 'node:assert/strict'
import test from 'node:test'
import { LADDER_STEPS, createLadder, resolveAnimateCap } from '../ladder.ts'

/** Drive the ladder for `ms` of wall clock at `workMs` of work per frame. */
function run(
  ladder: ReturnType<typeof createLadder>,
  workMs: number,
  ms: number,
  from = 0,
): number {
  let now = from
  const end = from + ms
  while (now < end) {
    now += 16
    ladder.observe(workMs, now)
  }
  return now
}

test('the step table degrades in exactly the specified order', () => {
  const rungs = LADDER_STEPS.map((s) => s.rung)
  for (let i = 1; i < rungs.length; i++) {
    assert.ok(rungs[i]! >= rungs[i - 1]!, `step ${i} goes back up a rung`)
  }
  // Rung 1 is resolution, and pixel ratio is spent before render scale.
  const rung1 = LADDER_STEPS.filter((s) => s.rung === 1)
  const floorRatio = Math.min(...rung1.map((s) => s.pixelRatioScale))
  const firstScaleCut = rung1.findIndex((s) => s.renderScale < 1)
  assert.ok(firstScaleCut > 0, 'render scale must not be the first thing given')
  assert.equal(
    rung1[firstScaleCut]!.pixelRatioScale,
    floorRatio,
    'pixel ratio is spent to its floor before render scale is touched',
  )
  for (let i = 1; i < LADDER_STEPS.length; i++) {
    assert.ok(LADDER_STEPS[i]!.pixelRatioScale <= LADDER_STEPS[i - 1]!.pixelRatioScale)
    assert.ok(LADDER_STEPS[i]!.renderScale <= LADDER_STEPS[i - 1]!.renderScale)
    assert.ok(LADDER_STEPS[i]!.fpsCap <= LADDER_STEPS[i - 1]!.fpsCap)
  }
  // Nothing above rung 2 touches the frame rate again, and nothing below it
  // touches the animating set.
  for (const s of LADDER_STEPS) {
    if (s.rung < 2) assert.equal(s.fpsCap, 60)
    if (s.rung < 3) assert.equal(s.animateCap, Number.POSITIVE_INFINITY)
    if (s.rung < 4) assert.equal(s.order, 'registration')
    if (s.rung < 4) assert.equal(s.park, false)
  }
  // Rung 4 stops by distance from centre, which is the whole difference
  // between "freeze the excess" and "stop the farthest".
  for (const s of LADDER_STEPS.filter((x) => x.rung === 4)) {
    assert.equal(s.order, 'distance')
    assert.equal(s.park, true)
  }
})

test('warmup frames are not a load signal', () => {
  const ladder = createLadder({ warmupFrames: 10, dropAfterMs: 0 })
  for (let i = 0; i < 10; i++) ladder.observe(400, i * 16)
  assert.equal(ladder.step, 0, 'shader compilation must not move the ladder')
  assert.ok(Number.isNaN(ladder.workMs))
})

test('sustained overload descends one rung at a time, in order', () => {
  const ladder = createLadder({ dropAfterMs: 100, warmupFrames: 2 })
  const seen: number[] = []
  let now = 0
  for (let i = 0; i < 400; i++) {
    now += 16
    const plan = ladder.observe(120, now)
    if (seen[seen.length - 1] !== plan.step) seen.push(plan.step)
  }
  assert.deepEqual(
    seen,
    Array.from({ length: LADDER_STEPS.length }, (_, i) => i),
    'the ladder must visit every step, in order, and skip none',
  )
  assert.equal(ladder.plan.rung, 4)
})

test('headroom climbs back, and only after it is sustained', () => {
  const ladder = createLadder({ dropAfterMs: 100, climbAfterMs: 500, warmupFrames: 2 })
  let now = run(ladder, 120, 3000)
  const loaded = ladder.step
  assert.ok(loaded > 3, 'precondition: the ladder is well down')

  // A brief lull must not move it — that is the hysteresis.
  now = run(ladder, 2, 200, now)
  assert.equal(ladder.step, loaded, 'a 200ms lull is not evidence of headroom')

  // One climb per sustained-headroom window, and the ladder starts well down —
  // so returning to full quality is deliberately slower than falling from it.
  now = run(ladder, 2, 500 * (LADDER_STEPS.length + 2), now)
  assert.equal(ladder.step, 0, 'sustained headroom returns full quality')
})

test('the dead band holds the rung instead of oscillating', () => {
  // 14ms of work: inside the 16.6ms budget (so no drop) but above the 60%
  // headroom gate (so no climb). A ladder without a dead band flaps here.
  const ladder = createLadder({ dropAfterMs: 100, climbAfterMs: 200, warmupFrames: 2 })
  let now = run(ladder, 120, 1200)
  const settled = ladder.step
  now = run(ladder, 14, 4000, now)
  assert.equal(ladder.step, settled, 'the dead band must be stable')
})

test('a lower cadence is judged against its own budget', () => {
  // 25ms of work is over budget at 60fps and comfortably inside it at 30.
  const ladder = createLadder({ dropAfterMs: 100, climbAfterMs: 100000, warmupFrames: 2 })
  run(ladder, 25, 20000)
  assert.ok(ladder.plan.fpsCap <= 45, 'it should have dropped cadence')
  assert.ok(
    ladder.plan.rung <= 2,
    'and stopped there: 25ms fits the reduced cadence, so nothing freezes',
  )
})

test('animate caps are fractions of the live visible count', () => {
  const half = LADDER_STEPS.find((s) => s.animateCap === 0.5)!
  assert.equal(resolveAnimateCap(half, 300), 150)
  assert.equal(resolveAnimateCap(half, 3), 2)
  assert.equal(resolveAnimateCap(LADDER_STEPS[0]!, 300), Number.POSITIVE_INFINITY)
  const last = LADDER_STEPS[LADDER_STEPS.length - 1]!
  assert.equal(resolveAnimateCap(last, 300), 1, 'the last rung keeps one card alive')
  assert.equal(resolveAnimateCap(last, 0), 0)
})

test('setStep clamps rather than throwing', () => {
  const ladder = createLadder()
  assert.equal(ladder.setStep(999).step, LADDER_STEPS.length - 1)
  assert.equal(ladder.setStep(-4).step, 0)
})
