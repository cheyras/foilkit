// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Tilt sources, with no browser.
//
// Every source takes an injectable listen target, which is the only reason
// these are unit tests rather than a Playwright run. The pointer and gyro
// cases below are the mappings `useTilt` shipped with — same -1..1 range, same
// inverted y (screen y grows down, tilt y grows up), same first-reading gyro
// baseline — re-asserted after the move so the extraction cannot quietly
// change how a card leans.

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createTiltSource,
  gyroSource,
  manualSource,
  noneSource,
  pointerSource,
  scrollSource,
  sweepSource,
} from '../tilt.ts'
import type { TiltQuery } from '../types.ts'

/** A tiny stand-in for `window` that records what is listening. */
function fakeTarget() {
  const listeners = new Map<string, Set<(e: unknown) => void>>()
  return {
    listeners,
    addEventListener(type: string, fn: (e: never) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn as (e: unknown) => void)
    },
    removeEventListener(type: string, fn: (e: never) => void) {
      listeners.get(type)?.delete(fn as (e: unknown) => void)
    },
    emit(type: string, e: unknown) {
      for (const fn of listeners.get(type) ?? []) fn(e)
    },
    count() {
      let n = 0
      for (const s of listeners.values()) n += s.size
      return n
    },
  }
}

const query = (over: Partial<TiltQuery> = {}): TiltQuery => ({
  id: 'c0',
  index: 0,
  rect: { x: 100, y: 100, width: 200, height: 280 },
  viewport: { width: 1000, height: 800 },
  time: 0,
  ...over,
})

test('pointer tilt is per-card, and that is the point', () => {
  const target = fakeTarget()
  const src = pointerSource({ target })
  src.attach!()
  // A pointer at the centre of the FIRST card.
  target.emit('pointermove', { clientX: 200, clientY: 240 })

  const left = src.tiltFor(query({ rect: { x: 100, y: 100, width: 200, height: 280 } }))
  const right = src.tiltFor(
    query({ id: 'c1', rect: { x: 500, y: 100, width: 200, height: 280 } }),
  )
  assert.ok(Math.abs(left.x) < 1e-9 && Math.abs(left.y) < 1e-9, 'centred card is at rest')
  assert.equal(right.x, -1, 'a card to the right of the cursor leans the other way')
  assert.notDeepEqual(left, right, 'one shared vector could never express this')
})

test('pointer y is inverted, because screen y grows downward', () => {
  const target = fakeTarget()
  const src = pointerSource({ target })
  src.attach!()
  target.emit('pointermove', { clientX: 200, clientY: 100 }) // top edge of the card
  assert.equal(src.tiltFor(query()).y, 1)
  target.emit('pointermove', { clientX: 200, clientY: 380 }) // bottom edge
  assert.equal(src.tiltFor(query()).y, -1)
})

test('pointer leaving the window returns every card to rest', () => {
  const target = fakeTarget()
  const src = pointerSource({ target })
  src.attach!()
  target.emit('pointermove', { clientX: 300, clientY: 100 })
  assert.notDeepEqual(src.tiltFor(query()), { x: 0, y: 0 })
  target.emit('pointerleave', {})
  assert.deepEqual(src.tiltFor(query()), { x: 0, y: 0 })
})

test('detaching removes every listener it added', () => {
  const target = fakeTarget()
  const src = pointerSource({ target })
  src.attach!()
  assert.ok(target.count() > 0)
  src.detach!()
  assert.equal(target.count(), 0)
})

test('gyro baselines to the first reading, so how you hold it is neutral', () => {
  const target = fakeTarget()
  const src = gyroSource({ target })
  src.attach!()
  target.emit('deviceorientation', { beta: 40, gamma: -12 })
  const first = src.tiltFor(query())
  assert.ok(Math.abs(first.x) < 1e-9 && Math.abs(first.y) < 1e-9)

  target.emit('deviceorientation', { beta: 40, gamma: 2 })
  assert.ok(Math.abs(src.tiltFor(query()).x - 0.5) < 1e-9, '14° of 28 is half tilt')

  // Re-attaching re-baselines: the phone may have been put down and picked up.
  src.detach!()
  src.attach!()
  target.emit('deviceorientation', { beta: 40, gamma: 2 })
  assert.equal(src.tiltFor(query()).x, 0)
})

test('gyro reports one vector for every card — the device is one object', () => {
  const target = fakeTarget()
  const src = gyroSource({ target })
  src.attach!()
  target.emit('deviceorientation', { beta: 0, gamma: 0 })
  target.emit('deviceorientation', { beta: 14, gamma: 14 })
  assert.deepEqual(src.tiltFor(query({ id: 'a' })), src.tiltFor(query({ id: 'b', index: 9 })))
})

test('gyro clamps rather than running away', () => {
  const target = fakeTarget()
  const src = gyroSource({ target })
  src.attach!()
  target.emit('deviceorientation', { beta: 0, gamma: 0 })
  target.emit('deviceorientation', { beta: -900, gamma: 900 })
  assert.deepEqual(src.tiltFor(query()), { x: 1, y: 1 })
})

test('scroll reads the card rect, not scrollY', () => {
  const src = scrollSource()
  const vp = { width: 1000, height: 800 }
  const top = src.tiltFor(query({ rect: { x: 400, y: 0, width: 200, height: 280 }, viewport: vp }))
  const mid = src.tiltFor(query({ rect: { x: 400, y: 260, width: 200, height: 280 }, viewport: vp }))
  const bot = src.tiltFor(query({ rect: { x: 400, y: 520, width: 200, height: 280 }, viewport: vp }))
  assert.ok(top.y > 0 && bot.y < 0, 'a card leans as it travels through the viewport')
  assert.ok(Math.abs(mid.y) < 1e-9, 'level at centre')
})

test('sweep phases per card, so the shimmer travels', () => {
  const src = sweepSource()
  const a = src.tiltFor(query({ index: 0, time: 1 }))
  const b = src.tiltFor(query({ index: 7, time: 1 }))
  assert.notDeepEqual(a, b)
  // Deterministic in time — which is what makes it screenshot-safe.
  assert.deepEqual(src.tiltFor(query({ index: 3, time: 2.5 })), src.tiltFor(query({ index: 3, time: 2.5 })))
})

test('manual holds what it is given, clamped', () => {
  const src = manualSource()
  src.set!(0.4, -0.2)
  assert.deepEqual(src.tiltFor(query()), { x: 0.4, y: -0.2 })
  src.set!(4, -4)
  assert.deepEqual(src.tiltFor(query()), { x: 1, y: -1 })
})

test('none is at rest, and is not the same as no card', () => {
  assert.deepEqual(noneSource().tiltFor(query()), { x: 0, y: 0 })
})

test('every advertised source id constructs', () => {
  for (const id of ['pointer', 'gyro', 'scroll', 'sweep', 'manual', 'none'] as const) {
    const src = createTiltSource(id)
    assert.equal(src.id, id)
    assert.equal(typeof src.tiltFor, 'function')
    // Attaching and detaching with no window present must be a no-op, not a throw.
    src.attach?.()
    src.detach?.()
  }
})

test('a custom source is the same shape as a shipped one', () => {
  // The whole tilt-source contract, exercised: an id and a tiltFor.
  const wobble = {
    id: 'wobble',
    tiltFor: ({ time, index }: TiltQuery) => ({ x: Math.sin(time + index), y: 0 }),
  }
  assert.equal(wobble.tiltFor(query({ time: 0, index: 0 })).x, 0)
})
