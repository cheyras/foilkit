// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Tilt sources — six shipped, and a seventh is about ten lines.
//
// A tilt source answers one question: given a card's registration and its
// current screen rect, what is its tilt vector right now? Per-card by
// construction. That is not a flourish — a single shared `{x, y}` cannot
// express pointer-follow across a grid, where the card under the cursor leans
// one way and the card three columns over leans the other.
//
// `pointer` and `gyro` are DeckPal's `useTilt` split in two, intact: the same
// -1..1 mapping, the same first-reading gyro baseline so "how you hold it" is
// neutral, the same iOS 13+ `requestPermission` gate, and the same
// prefers-reduced-motion default of no motion-driven animation.
//
// Listeners attach to an injectable target (default `window`) so every source
// in this file is exercised by `node --test` with no browser present.

import type { Tilt, TiltPermission, TiltQuery, TiltSource, TiltSourceId } from './types.ts'

const clamp1 = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v)
const REST: Tilt = { x: 0, y: 0 }

/** Minimal shape of what a source listens on — `window` satisfies it. */
export interface ListenTarget {
  addEventListener(type: string, listener: (e: never) => void): void
  removeEventListener(type: string, listener: (e: never) => void): void
}

interface SourceOptions {
  target?: ListenTarget | null
}

function defaultTarget(): ListenTarget | null {
  return typeof globalThis !== 'undefined' && 'window' in globalThis
    ? (globalThis as unknown as { window: ListenTarget }).window
    : null
}

// ── pointer ────────────────────────────────────────────────────────────────

export interface PointerSourceOptions extends SourceOptions {
  /**
   * How far outside its own box a card still tracks the pointer, as a multiple
   * of the card's size. 1 = the card's tilt saturates at one card-width away,
   * which is what makes a grid lean toward the cursor rather than snapping.
   */
  reach?: number
}

/**
 * Desktop: the pointer's position relative to EACH card's box maps to that
 * card's tilt. A card centred under the cursor is at rest; the corner nearest
 * the cursor lifts.
 */
export function pointerSource(options: PointerSourceOptions = {}): TiltSource {
  const target = options.target === undefined ? defaultTarget() : options.target
  const reach = options.reach ?? 1
  let px = Number.NaN
  let py = Number.NaN

  const onMove = (e: { clientX: number; clientY: number }) => {
    px = e.clientX
    py = e.clientY
  }
  const onLeave = () => {
    px = Number.NaN
    py = Number.NaN
  }

  return {
    id: 'pointer',
    attach() {
      if (!target) return
      target.addEventListener('pointermove', onMove as (e: never) => void)
      target.addEventListener('pointerdown', onMove as (e: never) => void)
      target.addEventListener('pointerleave', onLeave as (e: never) => void)
      target.addEventListener('blur', onLeave as (e: never) => void)
    },
    detach() {
      if (!target) return
      target.removeEventListener('pointermove', onMove as (e: never) => void)
      target.removeEventListener('pointerdown', onMove as (e: never) => void)
      target.removeEventListener('pointerleave', onLeave as (e: never) => void)
      target.removeEventListener('blur', onLeave as (e: never) => void)
      onLeave()
    },
    tiltFor({ rect }: TiltQuery): Tilt {
      if (Number.isNaN(px) || rect.width <= 0 || rect.height <= 0) return REST
      const nx = ((px - rect.x) / rect.width) * 2 - 1
      const ny = ((py - rect.y) / rect.height) * 2 - 1
      return { x: clamp1(nx / reach), y: clamp1(-ny / reach) }
    },
    /** Test and host hook: feed a pointer position without an event. */
    set(x: number, y: number) {
      px = x
      py = y
    },
  }
}

// ── gyro ───────────────────────────────────────────────────────────────────

export interface GyroSourceOptions extends SourceOptions {
  /** Degrees of device rotation that map to full tilt. Default 28. */
  degreesPerUnit?: number
  /**
   * Called with the new vector on every accepted reading. The stage polls
   * `tiltFor` and needs nothing; a host holding its own tilt ref (React's
   * `useTilt`) uses this rather than adding a second listener whose ordering
   * against this one would be an implementation detail.
   */
  onChange?: (tilt: Tilt) => void
}

/**
 * Phone: `deviceorientation`, baselined to the FIRST reading so however the
 * device happened to be held when the source attached is neutral. Every card
 * gets the same vector — the device is one object.
 */
export function gyroSource(options: GyroSourceOptions = {}): TiltSource {
  const target = options.target === undefined ? defaultTarget() : options.target
  const per = options.degreesPerUnit ?? 28
  let base: { beta: number; gamma: number } | null = null
  let tilt: Tilt = REST

  const onOrient = (e: { beta: number | null; gamma: number | null }) => {
    if (e.beta == null || e.gamma == null) return
    base ??= { beta: e.beta, gamma: e.gamma }
    tilt = {
      x: clamp1((e.gamma - base.gamma) / per),
      y: clamp1(-(e.beta - base.beta) / per),
    }
    options.onChange?.(tilt)
  }

  return {
    id: 'gyro',
    attach() {
      base = null
      tilt = REST
      target?.addEventListener('deviceorientation', onOrient as (e: never) => void)
    },
    detach() {
      target?.removeEventListener('deviceorientation', onOrient as (e: never) => void)
    },
    tiltFor(): Tilt {
      return tilt
    },
    async requestPermission(): Promise<TiltPermission> {
      const ctor = (globalThis as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent as
        | { requestPermission?: () => Promise<string> }
        | undefined
      if (!ctor) return 'unsupported'
      if (typeof ctor.requestPermission !== 'function') return 'granted'
      try {
        // iOS 13+: must be called from inside a user gesture.
        const res = await ctor.requestPermission()
        return res === 'granted' ? 'granted' : 'denied'
      } catch {
        return 'denied'
      }
    },
  }
}

/** What `gyroSource` would report before anyone asks for permission. */
export function gyroPermissionState(): TiltPermission {
  const ctor = (globalThis as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent as
    | { requestPermission?: () => Promise<string> }
    | undefined
  if (!ctor) return 'unsupported'
  return typeof ctor.requestPermission === 'function' ? 'prompt' : 'granted'
}

// ── scroll ─────────────────────────────────────────────────────────────────

export interface ScrollSourceOptions {
  /** Extra horizontal lean from the card's column. Default 0.35. */
  lateral?: number
}

/**
 * The card's own travel through the viewport IS the input: a card entering
 * from the bottom is tilted one way, level at centre, tilted the other on its
 * way out. No listener — the stage already measures every rect each frame,
 * and reading the rect is strictly more accurate than reading `scrollY`
 * (it survives nested scrollers, sticky headers and zoom).
 */
export function scrollSource(options: ScrollSourceOptions = {}): TiltSource {
  const lateral = options.lateral ?? 0.35
  return {
    id: 'scroll',
    tiltFor({ rect, viewport }: TiltQuery): Tilt {
      if (viewport.height <= 0) return REST
      const cy = rect.y + rect.height / 2
      const cx = rect.x + rect.width / 2
      return {
        x: clamp1(((cx / Math.max(1, viewport.width)) * 2 - 1) * lateral),
        y: clamp1(-((cy / viewport.height) * 2 - 1)),
      }
    },
  }
}

// ── sweep ──────────────────────────────────────────────────────────────────

export interface SweepSourceOptions {
  /** Sweeps per second. Default 0.25 — one slow pass every four seconds. */
  speed?: number
  /** Phase offset per card index, radians. Default 0.4: a travelling wave. */
  stagger?: number
}

/**
 * A hands-free demo source: a slow lissajous with a per-card phase offset, so
 * the shimmer travels across a grid instead of every card moving in lockstep.
 * Deterministic in `time`, which is what makes it usable in a screenshot test.
 */
export function sweepSource(options: SweepSourceOptions = {}): TiltSource {
  const speed = options.speed ?? 0.25
  const stagger = options.stagger ?? 0.4
  return {
    id: 'sweep',
    tiltFor({ time, index }: TiltQuery): Tilt {
      const p = time * speed * Math.PI * 2 + index * stagger
      return { x: Math.sin(p), y: 0.55 * Math.sin(p * 0.6 + 1.1) }
    },
  }
}

// ── manual / none ──────────────────────────────────────────────────────────

/** Sliders, a saved pose, a test fixture. Also the reduced-motion default. */
export function manualSource(initial: Tilt = REST): TiltSource {
  let tilt = { ...initial }
  return {
    id: 'manual',
    tiltFor: () => tilt,
    set(x: number, y: number) {
      tilt = { x: clamp1(x), y: clamp1(y) }
    },
  }
}

/** Foil at rest. Not the same as "no foil" — the card still renders. */
export function noneSource(): TiltSource {
  return { id: 'none', tiltFor: () => REST }
}

// ── selection ──────────────────────────────────────────────────────────────

export function prefersReducedMotion(): boolean {
  const w = globalThis as { matchMedia?: (q: string) => { matches: boolean } }
  if (typeof w.matchMedia !== 'function') return false
  return w.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * `manual` when the reader asked for reduced motion, `pointer` otherwise.
 * The reduced-motion answer is a source that never moves on its own, not a
 * card that refuses to render.
 */
export function defaultTiltSourceId(): TiltSourceId {
  return prefersReducedMotion() ? 'manual' : 'pointer'
}

export function createTiltSource(id: TiltSourceId): TiltSource {
  switch (id) {
    case 'pointer':
      return pointerSource()
    case 'gyro':
      return gyroSource()
    case 'scroll':
      return scrollSource()
    case 'sweep':
      return sweepSource()
    case 'manual':
      return manualSource()
    case 'none':
      return noneSource()
    default: {
      const never: never = id
      throw new Error(`unknown tilt source: ${String(never)}`)
    }
  }
}
