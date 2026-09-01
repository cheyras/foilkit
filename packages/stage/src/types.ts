// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// @foilkit/stage — the shapes the stage runs on.
//
// Nothing in this package imports a renderer. The stage's POLICY — which
// cards animate, at what resolution, at what cadence, from which tilt source —
// is arithmetic over rectangles and frame times, and arithmetic is testable
// without a GPU. `@foilkit/three` binds this policy to a WebGLRenderer; a
// future webgl2 or custom-element adapter binds the same policy.

/** A CSS-pixel rect in VIEWPORT coordinates — the shape of getBoundingClientRect(). */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The visible viewport, in CSS px. */
export interface Viewport {
  width: number
  height: number
}

/**
 * How finished pixels reach the page.
 *
 * `underlay` — one canvas fixed behind the page; scissor + viewport per card,
 * every visible card drawn in a single pass. The fast path and the default.
 * It asks the host for CSS discipline: anything opaque stacked over the card
 * blocks the view.
 *
 * `blit` — each element gets its own canvas carrying the finished pixels,
 * blitted from the shared WebGL canvas. One operation per card per frame,
 * total layout independence. The escape hatch for layouts the developer does
 * not control, and what a tile with chrome stacked on it needs.
 */
export type PresentationMode = 'underlay' | 'blit'

/** Which rung of the budget ladder is engaged. 0 = full quality. */
export type LadderRung = 0 | 1 | 2 | 3 | 4

/**
 * What the stage will do on the next frame. Produced by the ladder, consumed
 * by the renderer binding — the ladder never touches a renderer and the
 * binding never decides policy.
 */
export interface StagePlan {
  /** Multiplier on the stage's pixel-ratio ceiling, `min(dpr, 2)`. */
  pixelRatioScale: number
  /**
   * Multiplier on each card's own render resolution. Live in `blit`, where a
   * card's pixels are its own; a no-op in `underlay`, where a card's pixels
   * ARE the page's pixels and cannot be scaled up after the fact.
   */
  renderScale: number
  /** Frames per second the whole stage runs at. Uniform across cards, always. */
  fpsCap: number
  /** How many visible cards may animate. Infinity = all of them. */
  animateCap: number
  /**
   * Which cards lose animation first when `animateCap` bites.
   * `registration` — the excess, in registration order (rung 3).
   * `distance` — farthest from viewport centre first (rung 4).
   */
  order: 'registration' | 'distance'
  /** Rung 4 parks a stopped card's tilt at rest instead of holding it mid-tilt. */
  park: boolean
  rung: LadderRung
  /** Index into the ladder's step table — the readout's fine grain. */
  step: number
  /** One-line human description of this step, for the demo's rung readout. */
  label: string
}

/** A card's per-frame tilt, in the shader's -1..1 units. */
export interface Tilt {
  x: number
  y: number
}

/** What a tilt source is told about the card it is being asked about. */
export interface TiltQuery {
  /** The card's stable registration id. */
  id: string
  /** Where the card is on screen right now, CSS px. */
  rect: Rect
  /** The visible viewport, CSS px. */
  viewport: Viewport
  /** Registration order — a sweep uses it to phase the wave across a grid. */
  index: number
  /** Seconds since the stage started. */
  time: number
}

/**
 * A tilt source answers exactly one question: given a card's registration and
 * its current screen rect, what is its tilt vector right now?
 *
 * Per-card by construction — which is what pointer-follow across a grid
 * requires, and what a single shared `{x, y}` could never express. A host
 * writes its own in about ten lines: an `id` and a `tiltFor`.
 */
export interface TiltSource {
  readonly id: string
  /** Attach whatever listeners the source needs. Called when it becomes active. */
  attach?(): void
  /** Detach them. Called when another source takes over, and on teardown. */
  detach?(): void
  /** The card's tilt for this frame. Must be pure w.r.t. the query. */
  tiltFor(q: TiltQuery): Tilt
  /**
   * iOS 13+ gates DeviceOrientationEvent behind a user gesture. A source that
   * needs one exposes it; the host calls it from a click handler.
   */
  requestPermission?(): Promise<TiltPermission>
  /** Sources whose value the host sets directly (manual). */
  set?(x: number, y: number): void
}

export type TiltPermission = 'unsupported' | 'prompt' | 'granted' | 'denied'

/** The built-in source ids. A host may register any other name. */
export type TiltSourceId = 'pointer' | 'gyro' | 'scroll' | 'sweep' | 'manual' | 'none'

/** One registered card, from the scheduler's point of view. */
export interface CardState {
  id: string
  /** Registration order. Stable for the card's lifetime. */
  index: number
  rect: Rect
  /** IntersectionObserver says it is on screen. */
  intersecting: boolean
  /** Short edge is at least `minAnimateWidth`. */
  largeEnough: boolean
}

/** What the scheduler decided for one card this frame. */
export interface CardSchedule {
  id: string
  /** Draw it at all. A card off screen is not drawn and not updated. */
  draw: boolean
  /** Ease its tilt toward the source's target and push live uniforms. */
  animate: boolean
  /** Rung 4: park the tilt at rest rather than holding it where it was. */
  park: boolean
}
