// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The clip loop, driven against a MOCK player.
//
// There is no YouTube here and there must not be: the thing under test is a
// state machine over a number that a cross-origin iframe reports, and every
// interesting case — a `getCurrentTime` that throws, a seek that is dropped,
// a player torn out mid-tick — is one a real embed produces rarely and a fake
// one produces on demand. The E2E run proves the pane wires this up; this
// proves the wiring is worth having.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClipLoop, type YtPlayerLike } from './clipLoop.ts'

/** A player whose clock the test moves by hand. */
function mockPlayer(at = 0) {
  const seeks: number[] = []
  let now = at
  let throwOnGet: unknown = null
  let refuseSeek = false
  const player: YtPlayerLike = {
    getCurrentTime() {
      if (throwOnGet !== null) throw throwOnGet
      return now
    },
    seekTo(seconds) {
      if (refuseSeek) throw new Error('player is not ready')
      seeks.push(seconds)
      now = seconds
    },
  }
  return {
    player,
    seeks,
    at: (t: number) => {
      now = t
    },
    /** A seek the player ACCEPTS but never actually performs. */
    dropSeeks: () => {
      const real = player.seekTo
      player.seekTo = (s) => {
        seeks.push(s)
        void real
      }
    },
    throwOnGet: (err: unknown) => {
      throwOnGet = err
    },
    refuseSeek: (v: boolean) => {
      refuseSeek = v
    },
    get now() {
      return now
    },
  }
}

/** A scheduler the test owns, so nothing here depends on a real clock. */
function fakeTimers() {
  const scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  return {
    scheduled,
    schedule: (fn: () => void, ms: number) => {
      const entry = { fn, ms, cancelled: false }
      scheduled.push(entry)
      return entry
    },
    cancel: (h: unknown) => {
      ;(h as { cancelled: boolean }).cancelled = true
    },
  }
}

/** The corpus's fractional case, which is the one the integer params cannot serve. */
const START = 1257.5
const END = 1261

function loopUnderTest(startAt = START) {
  const m = mockPlayer(startAt)
  const timers = fakeTimers()
  const loop = createClipLoop(m.player, { start: START, end: END, schedule: timers.schedule, cancel: timers.cancel })
  return { ...m, timers, loop }
}

test('inside the window, nothing happens', () => {
  const h = loopUnderTest()
  h.at(1259)
  h.loop.tick()
  h.at(1260.9)
  h.loop.tick()
  assert.deepEqual(h.seeks, [])
  assert.equal(h.loop.loops, 0)
})

test('passing the end seeks back to the FRACTIONAL start, not a rounded one', () => {
  const h = loopUnderTest()
  h.at(1261.2)
  h.loop.tick()
  assert.deepEqual(h.seeks, [1257.5])
  assert.equal(h.loop.loops, 1)
})

test('the seek is issued once, not on every tick while it settles', () => {
  const h = loopUnderTest()
  h.dropSeeks()
  h.at(1262)
  h.loop.tick()
  h.loop.tick()
  h.loop.tick()
  assert.deepEqual(h.seeks, [1257.5], 'one seek, then disarmed')
  assert.equal(h.loop.armed, false)
})

test('and it re-arms once playback is genuinely back inside the window', () => {
  const h = loopUnderTest()
  h.at(1262)
  h.loop.tick()
  assert.equal(h.loop.armed, false)
  h.at(1258)
  h.loop.tick()
  assert.equal(h.loop.armed, true)
  h.at(1261.5)
  h.loop.tick()
  assert.equal(h.loop.loops, 2, 'the second pass loops too')
})

test('a seek the player accepts and never performs re-arms itself rather than dying quietly', () => {
  // The silent failure this guards: the loop disarms waiting for a seek that
  // will never land, playback runs on past the end, and the pane stops looping
  // with nothing on screen saying why.
  const h = loopUnderTest()
  h.dropSeeks()
  h.at(1262)
  h.loop.tick()
  assert.equal(h.seeks.length, 1)
  for (let i = 0; i < 8; i++) h.loop.tick()
  assert.equal(h.loop.armed, true, 'eight ticks with no landing is a dropped seek')
  h.loop.tick()
  assert.equal(h.seeks.length, 2, 'and it tries again')
})

test('drifting BEFORE the start pulls playback back — but only past the slack', () => {
  const h = loopUnderTest()
  // The integer `start` param can land a fraction early; that is not an escape.
  h.at(1257.0)
  h.loop.tick()
  assert.deepEqual(h.seeks, [], 'within a second of the start is where the iframe legitimately lands')
  // A whole-video restart is.
  h.at(0)
  h.loop.tick()
  assert.deepEqual(h.seeks, [1257.5])
})

test('a getCurrentTime that throws is survived, and the next tick still works', () => {
  const h = loopUnderTest()
  h.throwOnGet(new Error('The player is not ready'))
  assert.doesNotThrow(() => h.loop.tick())
  assert.deepEqual(h.seeks, [])
  h.throwOnGet(null)
  h.at(1262)
  h.loop.tick()
  assert.deepEqual(h.seeks, [1257.5])
})

test('a getCurrentTime that answers with nonsense is ignored rather than acted on', () => {
  const h = loopUnderTest()
  for (const bad of [NaN, Infinity, undefined, null, 'ten']) {
    h.player.getCurrentTime = () => bad as number
    h.loop.tick()
  }
  assert.deepEqual(h.seeks, [], 'NaN is not "past the end"')
})

test('a seekTo that throws leaves the loop armed, so the next tick retries', () => {
  const h = loopUnderTest()
  h.refuseSeek(true)
  h.at(1262)
  h.loop.tick()
  assert.equal(h.loop.armed, true)
  assert.equal(h.loop.loops, 0, 'a refused seek is not a loop')
  h.refuseSeek(false)
  h.loop.tick()
  assert.deepEqual(h.seeks, [1257.5])
})

// ── Lifetime ───────────────────────────────────────────────────────────────

test('the loop schedules itself at the interval it was given', () => {
  const h = loopUnderTest()
  assert.equal(h.timers.scheduled.length, 1)
  assert.equal(h.timers.scheduled[0]!.ms, 250)
})

test('stop() cancels the timer, and is idempotent', () => {
  const h = loopUnderTest()
  h.loop.stop()
  assert.equal(h.timers.scheduled[0]!.cancelled, true)
  assert.doesNotThrow(() => h.loop.stop())
})

test('a tick after stop() does nothing — an in-flight timer cannot resurrect a torn-down pane', () => {
  // React fires the effect cleanup before the iframe is removed, but a timer
  // callback already queued still runs. It must not touch the player.
  const h = loopUnderTest()
  h.loop.stop()
  h.at(1262)
  h.loop.tick()
  assert.deepEqual(h.seeks, [])
})

test('the scheduled callback IS the tick — the timer path is the tested path', () => {
  const h = loopUnderTest()
  h.at(1262)
  h.timers.scheduled[0]!.fn()
  assert.deepEqual(h.seeks, [1257.5])
})
