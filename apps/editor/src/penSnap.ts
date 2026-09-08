// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// penSnap.ts — the card's own scan, prepared as the pen's snap evidence.
//
// `@foilkit/forge/geometry` holds the snapper (`pen-snap.ts`); it takes pixels and knows nothing
// about the DOM. This is the twenty lines that get the pixels: fetch the same scan the shader is
// texturing, draw it into CANONICAL MASK SPACE (504x704), and hand the ImageData over. Drawing it
// at the mask's own size is what makes every coordinate in the snapper already a pen document
// coordinate — the alternative is a scale factor threaded through a call chain, and the first
// time someone forgets it the anchors land on an edge that is not there.
//
// OFF THE INTERACTION PATH, DELIBERATELY. Preparing the structure tensor costs 60-90ms at
// canonical size (measured, `tools/measure-pen-snap.mts` runs the same code), which is nothing
// once and unacceptable on a pointermove. So it happens once per card, after an idle callback,
// and the pen is fully usable UNSNAPPED while it runs — `status` says which of those the user is
// looking at, because a snapper that is still loading and a snapper that has given up feel
// identical from the outside and are not the same thing.
//
// WHY IT CAN FAIL, AND WHY IT SAYS SO. Reading pixels back out of a canvas needs the image to be
// same-origin or CORS-clean; `assets.tcgdex.net` sends `access-control-allow-origin: *` and our
// own `/api/image` proxy is same-origin, so both work — but a card whose scan is missing
// upstream, or a future host that does not send the header, taints the canvas and `getImageData`
// throws. That is a real state and it gets its own honest sentence rather than a silent pen that
// mysteriously stops catching edges.

import { useEffect, useState } from 'react'
import { CANONICAL_H, CANONICAL_W } from '@foilkit/core'
import { penSnapProvider, preparePenSnap, type SnapFn } from '@foilkit/forge/geometry'

export interface PenSnapState {
  status: 'idle' | 'preparing' | 'ready' | 'unavailable'
  /** Null until ready. `PenConfig.snap` takes exactly this, and the engine still polices it. */
  snap: SnapFn | null
  /** One short sentence for the surface to show. Never null once anything has happened. */
  note: string | null
}

const IDLE: PenSnapState = { status: 'idle', snap: null, note: null }

/** `requestIdleCallback` where it exists, a macrotask where it does not (Safari). */
function whenIdle(fn: () => void): () => void {
  const w = window as typeof window & {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number
    cancelIdleCallback?: (h: number) => void
  }
  if (typeof w.requestIdleCallback === 'function') {
    const h = w.requestIdleCallback(fn, { timeout: 1500 })
    return () => w.cancelIdleCallback?.(h)
  }
  const t = window.setTimeout(fn, 0)
  return () => window.clearTimeout(t)
}

/**
 * Prepare the snapper for `imageUrl` while `active`, and forget it when either changes.
 *
 * Forgetting on card change is the point of the dependency list: an edge map is evidence about
 * ONE scan, and a stale one would snap this card's anchors onto the previous card's furniture.
 */
export function usePenSnap(imageUrl: string | null, active: boolean): PenSnapState {
  const [state, setState] = useState<PenSnapState>(IDLE)

  useEffect(() => {
    if (!active || !imageUrl) {
      setState(IDLE)
      return
    }
    let dead = false
    setState({ status: 'preparing', snap: null, note: 'reading the printed edges off this scan…' })
    const cancel = whenIdle(() => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.decoding = 'async'
      img.onerror = () => {
        if (!dead) {
          setState({ status: 'unavailable', snap: null, note: 'no scan loaded — the pen is drawing unsnapped' })
        }
      }
      img.onload = () => {
        if (dead) return
        try {
          const c = document.createElement('canvas')
          c.width = CANONICAL_W
          c.height = CANONICAL_H
          const ctx = c.getContext('2d', { willReadFrequently: true })
          if (!ctx) throw new Error('no 2d context')
          ctx.drawImage(img, 0, 0, CANONICAL_W, CANONICAL_H)
          const data = ctx.getImageData(0, 0, CANONICAL_W, CANONICAL_H)
          const src = preparePenSnap({
            width: CANONICAL_W,
            height: CANONICAL_H,
            rgba: new Uint8Array(data.data.buffer.slice(0)),
          })
          if (dead) return
          // The honest reading when a scan turns out to hold nothing to trace. It is not an
          // error and the pen still works; it is a fact about this card's image.
          const bare = src.evidence.edgePixels < 200
          setState({
            status: 'ready',
            snap: penSnapProvider(src),
            note: bare
              ? `this scan shows almost no printed edges (${src.evidence.edgePixels}px) — expect few catches`
              : `snapping to ${src.evidence.edgePixels.toLocaleString()}px of printed edge on this scan`,
          })
        } catch {
          // Almost always a tainted canvas: the scan loaded and rendered, and its PIXELS cannot
          // be read back. Worth distinguishing from "no scan" because the card looks fine.
          setState({
            status: 'unavailable',
            snap: null,
            note: 'this scan’s pixels cannot be read back (no CORS header) — the pen is drawing unsnapped',
          })
        }
      }
      img.src = imageUrl
    })
    return () => {
      dead = true
      cancel()
    }
  }, [imageUrl, active])

  return state
}
