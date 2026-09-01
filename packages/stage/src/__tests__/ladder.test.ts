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

test('the dead band holds the rung rather than flapping', () => {
  // 14ms of work: inside the 16.6ms budget (so no drop) but above the 60%
  // headroom gate (so no fast climb). A ladder without a dead band flaps here.
  const ladder = createLadder({
    dropAfterMs: 100,
    climbAfterMs: 200,
    warmupFrames: 2,
    probeAfterMs: 100000,
  })
  let now = run(ladder, 120, 1200)
  const settled = ladder.step
  now = run(ladder, 14, 4000, now)
  assert.equal(ladder.step, settled, 'the dead band must be stable inside the probe window')
})

test('a transient does not degrade the page until it reloads', () => {
  // The failure this exists to prevent, and it was a real CI run: a machine
  // whose resting work lands in the dead band is stable WHEREVER it happens to
  // be, so one transient knocks it down a rung it can never climb out of. The
  // ladder must probe its way back up.
  const ladder = createLadder({
    dropAfterMs: 100,
    climbAfterMs: 1500,
    warmupFrames: 2,
    probeAfterMs: 1000,
  })
  let now = run(ladder, 120, 3000) // the transient
  assert.ok(ladder.step >= 8, `precondition: knocked well down, got ${ladder.step}`)
  // 14ms is the dead band at every 60fps step: never over budget, never clear
  // headroom. The old ladder sat here forever.
  now = run(ladder, 14, 40000, now)
  assert.equal(ladder.step, 0, 'a probing ladder finds its way back to full quality')
})

test('probing is slower than climbing on clear headroom', () => {
  const opts = { dropAfterMs: 100, climbAfterMs: 300, warmupFrames: 2, probeAfterMs: 3000 }
  const stepsToClimb = (workMs: number) => {
    const ladder = createLadder(opts)
    let now = run(ladder, 120, 3000)
    const from = ladder.step
    let elapsed = 0
    while (ladder.step > 0 && elapsed < 200000) {
      now = run(ladder, workMs, 500, now)
      elapsed += 500
    }
    return { from, elapsed }
  }
  const fast = stepsToClimb(2)
  const probed = stepsToClimb(14)
  assert.equal(fast.from, probed.from)
  assert.ok(
    probed.elapsed > fast.elapsed * 3,
    `probe path ${probed.elapsed}ms should be much slower than headroom path ${fast.elapsed}ms`,
  )
})

test('a refused probe backs off instead of flapping forever', () => {
  // Work that depends on the rung: expensive at high resolution, affordable
  // once the ratio is down. The step above genuinely does not hold, so every
  // probe is refused — and the ladder must stop asking so often.
  const ladder = createLadder({
    dropAfterMs: 100,
    climbAfterMs: 100000,
    warmupFrames: 2,
    probeAfterMs: 500,
    probeGraceMs: 1000,
  })
  let now = 0
  let last = ladder.step
  let transitions = 0
  for (let i = 0; i < 20000; i++) {
    now += 16
    const plan = ladder.observe(plan0(ladder), now)
    if (plan.step !== last) {
      transitions += 1
      last = plan.step
    }
  }
  function plan0(l: ReturnType<typeof createLadder>): number {
    return l.plan.pixelRatioScale > 0.5 ? 40 : 12
  }
  assert.ok(ladder.step >= 3, `it should settle where the work fits, got ${ladder.step}`)
  // The interval doubles from 500ms to the 60s ceiling — 500, 1000, 2000, 4000,
  // 8000, 16000, 32000, then 60000 — so 320 seconds buys about eleven probes and
  // twice that many rung changes. Without the backoff it would be six hundred
  // probes, which is a visibly pulsing page.
  assert.ok(
    transitions < 30,
    `${transitions} rung changes over 320s is flapping, not backing off`,
  )
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
