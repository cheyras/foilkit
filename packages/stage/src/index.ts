// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// @foilkit/stage — the stage's policy, with no renderer in it.
//
// Splitting the package this way is deliberate. The stage is an ARCHITECTURE
// problem, not a shader problem: which cards animate, at what resolution, at
// what cadence, from which tilt source. All of that is arithmetic over
// rectangles and frame times, so it lives here where `node --test` can check
// it without a GPU, and `@foilkit/three` binds it to a WebGLRenderer. A future
// webgl2 or custom-element adapter binds the same policy rather than
// reimplementing it.

export * from './types.ts'
export * from './ladder.ts'
export * from './geometry.ts'
export * from './schedule.ts'
export * from './texture-policy.ts'
export * from './tilt.ts'

/** Every behavioural choice in the stage is a host knob with a good default. */
export const STAGE_DEFAULTS = {
  /**
   * Short edge, CSS px, below which a card renders one static frame instead of
   * animating. A host number, not a rule.
   */
  minAnimateWidth: 150,
  /** The ceiling rung 1 walks down from: `setPixelRatio(min(dpr, 2))`. */
  maxPixelRatio: 2,
  /** Cadence the ladder holds. */
  targetFps: 60,
  /** Per-frame tilt easing weight — the workbench viewer's, unchanged. */
  tiltEasing: 0.12,
  /** Max card rotation in degrees at |tilt| = 1. */
  maxTiltDeg: 16,
  /** IntersectionObserver root margin, so a card is ready before it arrives. */
  rootMargin: '128px',
} as const

/**
 * One step of the viewer's tilt easing: `v += (target - v) * weight`.
 *
 * Extracted rather than inlined because the parity harness's zero-delta claim
 * rests on this exact expression — a different easing is a different pixel.
 */
export function easeToward(current: number, target: number, weight: number): number {
  return current + (target - current) * weight
}
