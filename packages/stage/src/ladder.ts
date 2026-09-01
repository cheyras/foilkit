// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The budget ladder — measured, not configured.
//
// The stage watches its own frame time and moves itself. There is no tuning
// table, no device list and no per-phone constant anywhere in this file, which
// is what makes it land correctly on hardware that does not exist yet.
//
// The order is the contract, and it is the order the steps are declared in:
//
//   1. RENDER RESOLUTION. Stage pixel ratio first, then per-card render scale.
//      The foil layer is low-frequency light — this is the cheapest thing to
//      give and the last thing an eye notices.
//   2. FRAME RATE, UNIFORMLY. Every card drops together. A page where
//      everything runs at 30 reads as deliberate; a page where some cards run
//      at 60 and others at 20 reads as broken.
//   3. FREEZE EXCESS CARDS MID-TILT. A still foil card is a resting state, not
//      a failure.
//   4. STOP CARDS FARTHEST FROM VIEWPORT CENTRE.
//
// WHAT IS MEASURED. The signal is the stage's own WORK time — how long its
// frame callback took — not the wall-clock gap between frames. Using the gap
// would be self-defeating: rung 2 makes the gap longer on purpose, and a
// ladder reading its own cadence as evidence of load can never climb back.
//
// WHICH BUDGET. Dropping is judged against the cadence currently being run
// (at a 30fps cap, 33ms of work is fine). Climbing is judged against the
// TARGET cadence, because the question "should I go back to 60?" is answered
// by whether the work would fit in 16.6ms, not by whether it fits in 33.

import type { LadderRung, StagePlan } from './types.ts'

const full = (
  step: number,
  rung: LadderRung,
  label: string,
  over: Partial<StagePlan> = {},
): StagePlan => ({
  pixelRatioScale: 1,
  renderScale: 1,
  fpsCap: 60,
  animateCap: Number.POSITIVE_INFINITY,
  order: 'registration',
  park: false,
  step,
  rung,
  label,
  ...over,
})

/**
 * The step table. Declared, not computed, so the ORDER is readable and a test
 * can assert the ladder never reaches for rung 3 while rung 1 has slack left.
 *
 * `animateCap` is a FRACTION of the visible-card count here; `planFor`
 * resolves it against the live count. Infinity means no cap.
 */
export const LADDER_STEPS: readonly StagePlan[] = [
  full(0, 0, 'full quality'),

  // 1 — render resolution: the stage's pixel ratio, walking down from the
  // min(dpr, 2) ceiling.
  full(1, 1, 'pixel ratio ×0.85', { pixelRatioScale: 0.85 }),
  full(2, 1, 'pixel ratio ×0.7', { pixelRatioScale: 0.7 }),
  full(3, 1, 'pixel ratio ×0.5', { pixelRatioScale: 0.5 }),
  // …then per-card render scale (live in blit; a no-op in underlay, where a
  // card's pixels are the page's pixels — see StagePlan.renderScale).
  full(4, 1, 'render scale ×0.75', { pixelRatioScale: 0.5, renderScale: 0.75 }),
  full(5, 1, 'render scale ×0.5', { pixelRatioScale: 0.5, renderScale: 0.5 }),

  // 2 — frame rate, uniformly. Every card drops together.
  full(6, 2, '45 fps', { pixelRatioScale: 0.5, renderScale: 0.5, fpsCap: 45 }),
  full(7, 2, '30 fps', { pixelRatioScale: 0.5, renderScale: 0.5, fpsCap: 30 }),
  full(8, 2, '20 fps', { pixelRatioScale: 0.5, renderScale: 0.5, fpsCap: 20 }),

  // 3 — freeze the excess mid-tilt, in registration order.
  full(9, 3, 'freeze half', {
    pixelRatioScale: 0.5, renderScale: 0.5, fpsCap: 20, animateCap: 0.5,
  }),
  full(10, 3, 'freeze three quarters', {
    pixelRatioScale: 0.5, renderScale: 0.5, fpsCap: 20, animateCap: 0.25,
  }),

  // 4 — stop the ones farthest from viewport centre, and park them at rest.
  full(11, 4, 'stop all but the centre eighth', {
    pixelRatioScale: 0.5, renderScale: 0.5, fpsCap: 20,
    animateCap: 0.125, order: 'distance', park: true,
  }),
  full(12, 4, 'stop all but the centre card', {
    pixelRatioScale: 0.5, renderScale: 0.5, fpsCap: 20,
    animateCap: 0, order: 'distance', park: true,
  }),
]

export interface LadderOptions {
  /** The cadence the stage is trying to hold. Default 60. */
  targetFps?: number
  /** Sustained over-budget time before stepping down. Default 300ms. */
  dropAfterMs?: number
  /** Sustained headroom before stepping back up. Default 1500ms. */
  climbAfterMs?: number
  /**
   * Fraction of the TARGET frame budget the smoothed work time must sit under
   * before the ladder climbs on the fast path. Default 0.6 — the gap between
   * this and 1.0 is the dead band, where a correctly-chosen rung sits.
   */
  climbHeadroom?: number
  /**
   * How long the ladder sits in the DEAD BAND — under budget, but without
   * clear headroom — before it probes one step up to see whether the step
   * above holds. Default 5000ms.
   *
   * Without this the ladder is a one-way door. A machine whose resting work
   * lands in the dead band is stable wherever it happens to be, so a single
   * transient — one big decode, one GC pause — knocks it down a rung it can
   * never climb out of, and the page is quietly worse until it reloads. "It
   * climbs back up as headroom returns" has to mean this too, or a stall is
   * indistinguishable from a correct answer.
   */
  probeAfterMs?: number
  /**
   * A probe that is undone by a drop within this window counts as refused, and
   * the probe interval doubles. Default 3000ms.
   */
  probeGraceMs?: number
  /** Ceiling for the doubling. Default 60000ms. */
  maxProbeMs?: number
  /** EMA weight for a new sample. Default 0.2. */
  smoothing?: number
  /** Frames ignored at startup, where shader compilation dominates. Default 10. */
  warmupFrames?: number
}

export interface Ladder {
  /** The plan the next frame should run under. */
  readonly plan: StagePlan
  /** Current step index into LADDER_STEPS. */
  readonly step: number
  /** Smoothed work time, ms. NaN before the first post-warmup sample. */
  readonly workMs: number
  /**
   * Feed one measured frame: how long the stage's own work took, and when it
   * finished. Returns the plan for the next frame.
   */
  observe(workMs: number, nowMs: number): StagePlan
  /** Force a step — the demo's manual override, and how a test pins a rung. */
  setStep(step: number): StagePlan
  reset(): void
}

/**
 * Resolve a step's fractional `animateCap` against the live visible count.
 * Rung 3/4 caps are fractions so the ladder is independent of card count.
 */
export function resolveAnimateCap(plan: StagePlan, visibleCount: number): number {
  if (plan.animateCap === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY
  if (plan.animateCap === 0) return visibleCount > 0 ? 1 : 0
  return Math.max(1, Math.ceil(visibleCount * plan.animateCap))
}

export function createLadder(options: LadderOptions = {}): Ladder {
  const targetFps = options.targetFps ?? 60
  const dropAfterMs = options.dropAfterMs ?? 300
  const climbAfterMs = options.climbAfterMs ?? 1500
  const climbHeadroom = options.climbHeadroom ?? 0.6
  const alpha = options.smoothing ?? 0.2
  const warmup = options.warmupFrames ?? 10
  const probeAfterMs = options.probeAfterMs ?? 5000
  const probeGraceMs = options.probeGraceMs ?? 3000
  const maxProbeMs = options.maxProbeMs ?? 60000

  const targetBudget = 1000 / targetFps

  let step = 0
  let ema = Number.NaN
  let seen = 0
  let overSince = Number.NaN
  let underSince = Number.NaN
  let deadSince = Number.NaN
  let probeMs = probeAfterMs
  let probedAt = Number.NaN

  const clearTimers = () => {
    overSince = Number.NaN
    underSince = Number.NaN
    deadSince = Number.NaN
  }

  return {
    get plan() {
      return LADDER_STEPS[step]!
    },
    get step() {
      return step
    },
    get workMs() {
      return ema
    },
    setStep(next: number): StagePlan {
      step = Math.max(0, Math.min(LADDER_STEPS.length - 1, next))
      clearTimers()
      return LADDER_STEPS[step]!
    },
    reset() {
      step = 0
      ema = Number.NaN
      seen = 0
      probeMs = probeAfterMs
      probedAt = Number.NaN
      clearTimers()
    },
    observe(workMs: number, nowMs: number): StagePlan {
      seen += 1
      // Shader compilation lands in the first frames and is not a load signal.
      if (seen <= warmup) return LADDER_STEPS[step]!
      ema = Number.isNaN(ema) ? workMs : ema + (workMs - ema) * alpha

      const current = LADDER_STEPS[step]!
      // Dropping is judged against the cadence actually being run…
      const runningBudget = 1000 / current.fpsCap
      // …climbing against the one being aimed at.
      const climbBudget = targetBudget * climbHeadroom

      if (ema > runningBudget) {
        if (Number.isNaN(overSince)) overSince = nowMs
        underSince = Number.NaN
        deadSince = Number.NaN
        if (nowMs - overSince >= dropAfterMs && step < LADDER_STEPS.length - 1) {
          // A probe undone this quickly was refused: back off before trying
          // that step again, so a machine that genuinely cannot hold it
          // settles instead of flapping.
          if (!Number.isNaN(probedAt) && nowMs - probedAt <= probeGraceMs) {
            probeMs = Math.min(probeMs * 2, maxProbeMs)
          }
          step += 1
          probedAt = Number.NaN
          clearTimers()
        }
      } else if (ema <= climbBudget) {
        if (Number.isNaN(underSince)) underSince = nowMs
        overSince = Number.NaN
        deadSince = Number.NaN
        if (nowMs - underSince >= climbAfterMs && step > 0) {
          step -= 1
          // Clear headroom is evidence the machine changed, not a guess:
          // reset the backoff so the next stall is judged afresh.
          probeMs = probeAfterMs
          probedAt = Number.NaN
          clearTimers()
        }
      } else {
        // The dead band: under budget, but without clear headroom. This is
        // where a correctly-chosen rung SITS, so nothing happens quickly — but
        // something has to happen eventually, or the ladder is a one-way door
        // and one transient degrades the page until it reloads. So it probes.
        if (Number.isNaN(deadSince)) deadSince = nowMs
        overSince = Number.NaN
        underSince = Number.NaN
        if (nowMs - deadSince >= probeMs && step > 0) {
          step -= 1
          probedAt = nowMs
          clearTimers()
        }
      }
      return LADDER_STEPS[step]!
    },
  }
}
