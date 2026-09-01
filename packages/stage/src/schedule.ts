// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Who draws, who animates, who is frozen — one pure function per frame.
//
// The stage does not assume the host virtualizes. Hosts commonly do, and the
// DOM then holds tens of tiles rather than hundreds — but "commonly" is not a
// contract, so the scheduler is written as if every registered card might be
// on screen at once and decides three things per card:
//
//   draw    — it is on screen. Off screen means no uniform update and no draw.
//   animate — it is large enough to be worth animating AND inside the current
//             rung's animating budget.
//   park    — rung 4: ease its tilt back to rest rather than holding it.
//
// Frozen is not broken. A still foil card is a resting state — the effect is
// for interactive use, and a frozen frame is honest about a card nobody is
// touching.

import { resolveAnimateCap } from './ladder.ts'
import { distanceFromCentre } from './geometry.ts'
import type { CardSchedule, CardState, StagePlan, Viewport } from './types.ts'

export interface ScheduleOptions {
  /**
   * Short edge below which a card renders one static frame instead of
   * animating. Defaults to 150 CSS px at the call site (`STAGE_DEFAULTS`).
   * It is a host number, not a rule — a developer who wants foil on a 60px
   * thumbnail gets it by setting the knob.
   */
  minAnimateWidth: number
}

/**
 * Decide the frame.
 *
 * `cards` arrives in registration order; the returned array is in the same
 * order, so a caller can zip it against its own list without a lookup.
 */
export function scheduleFrame(
  cards: readonly CardState[],
  plan: StagePlan,
  viewport: Viewport,
): CardSchedule[] {
  const visible = cards.filter((c) => c.intersecting)
  const cap = resolveAnimateCap(plan, visible.length)

  // Candidates are the visible cards big enough to be worth animating; the
  // small ones never consume budget in the first place.
  const candidates = visible.filter((c) => c.largeEnough)

  let allowed: Set<string>
  if (cap === Number.POSITIVE_INFINITY || candidates.length <= cap) {
    allowed = new Set(candidates.map((c) => c.id))
  } else if (plan.order === 'distance') {
    const ranked = [...candidates].sort(
      (a, b) => distanceFromCentre(a.rect, viewport) - distanceFromCentre(b.rect, viewport),
    )
    allowed = new Set(ranked.slice(0, cap).map((c) => c.id))
  } else {
    // Registration order: the EXCESS freezes. Which cards those are is stable
    // frame to frame, so nothing flickers between frozen and live.
    allowed = new Set(candidates.slice(0, cap).map((c) => c.id))
  }

  return cards.map((c) => {
    const animate = c.intersecting && c.largeEnough && allowed.has(c.id)
    return {
      id: c.id,
      draw: c.intersecting,
      animate,
      park: plan.park && !animate,
    }
  })
}
