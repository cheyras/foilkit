// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Rect arithmetic — the half of the stage that a GPU is not required to check.
//
// Two coordinate systems meet here and disagree about which way is up. CSS
// rects grow downward from the top-left of the viewport; a WebGL scissor box
// grows upward from the bottom-left of the drawing buffer, in device pixels.
// Every underlay draw crosses that boundary exactly once, in `scissorBox`.

import type { Rect, Viewport } from './types.ts'

/** A WebGL scissor/viewport box: device px, origin bottom-left. */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/**
 * A card's CSS rect as a scissor box on a canvas that covers the viewport.
 *
 * `pixelRatio` is the renderer's, so the box is in the same device pixels the
 * drawing buffer is sized in. Rounding is to whole device pixels — a
 * fractional scissor box is silently truncated by the driver, and a card whose
 * box is one pixel short of its CSS box shows a seam against the page.
 */
export function scissorBox(rect: Rect, viewport: Viewport, pixelRatio: number): Box {
  const left = Math.round(rect.x * pixelRatio)
  const top = Math.round(rect.y * pixelRatio)
  const width = Math.round(rect.width * pixelRatio)
  const height = Math.round(rect.height * pixelRatio)
  const canvasH = Math.round(viewport.height * pixelRatio)
  return { x: left, y: canvasH - top - height, width, height }
}

/** Does any part of the rect fall inside the viewport? */
export function intersectsViewport(rect: Rect, viewport: Viewport, margin = 0): boolean {
  return (
    rect.x + rect.width > -margin &&
    rect.y + rect.height > -margin &&
    rect.x < viewport.width + margin &&
    rect.y < viewport.height + margin
  )
}

/**
 * Distance from the card's centre to the viewport's, in CSS px. Rung 4's
 * ordering key: the farthest card is the one a reader is least likely to be
 * looking at, and the cheapest thing to stop.
 */
export function distanceFromCentre(rect: Rect, viewport: Viewport): number {
  const dx = rect.x + rect.width / 2 - viewport.width / 2
  const dy = rect.y + rect.height / 2 - viewport.height / 2
  return Math.hypot(dx, dy)
}

/** A card's short edge in CSS px — its width, since 63×88 is taller than wide. */
export function shortEdge(rect: Rect): number {
  return Math.min(rect.width, rect.height)
}

/**
 * The on-screen rect (px, relative to a host box) the card face occupies at
 * zero tilt — the exact inverse of the viewer's 1.16-margin projection.
 *
 * The margin is not decoration: the card ROTATES, and a card fitted edge to
 * edge clips its own corners the moment it tilts.
 */
export function cardFitRect(
  hostW: number,
  hostH: number,
  aspect: number,
  margin = 1.16,
): Rect {
  // Height-limited when the host is wider than the card's aspect, width-limited
  // otherwise — min() covers both.
  const height = Math.min(hostH, hostW * aspect) / margin
  const width = height / aspect
  return { x: (hostW - width) / 2, y: (hostH - height) / 2, width, height }
}
