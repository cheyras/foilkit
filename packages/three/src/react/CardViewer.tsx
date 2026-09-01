// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// CardViewer — the same component, on a shared stage.
//
// Its public shape is unchanged, deliberately: same props, same overlay
// children, same `cardScreenRect`. What changed is underneath. It used to
// build a WebGLRenderer, a scene, a camera, a rAF loop and a ResizeObserver
// PER CARD, which is correct for a one-card workbench and fatal past a
// handful — browsers cap WebGL contexts and silently lose the oldest.
//
// Now it registers one element with the shared `FoilStage` and gets out of the
// way. The rAF loop, the tilt easing, the uniform push and the fit math live
// in the stage; the second viewer on a page costs one registration, not one
// context.
//
// It registers in `blit` mode: the canvas lives INSIDE the host element, so
// the mask overlays, the pan/zoom wrapper and every existing bit of CSS around
// this component keep working exactly as they did. A grid wants `underlay`,
// and gets it by registering against the stage directly.

import { useCallback, useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { FoilPattern } from '@foilkit/patterns'
import { CARD_ASPECT } from '@foilkit/core'
import { cardFitRect, type Tilt, type TiltSource } from '@foilkit/stage'
import { buildGlyphAtlas, fetchGlyphIndex, glyphSlotFor, resolveGlyphDir } from '../glyphs.ts'
import { getDefaultStage, type CardHandle, type CardSettings, type FoilStage } from '../stage.ts'
import type { ViewController } from './ViewTransform.tsx'

/** The live uniform state a viewer pushes every frame. Unchanged shape. */
export type ViewerSettings = CardSettings

export function CardViewer({
  imageUrl,
  pattern,
  settingsRef,
  tiltTarget,
  maskCanvas,
  view,
  stage,
  onPointerMove,
  onPointerLeave,
  className = '',
  children,
}: {
  imageUrl: string | null
  pattern: FoilPattern
  settingsRef: React.RefObject<ViewerSettings>
  tiltTarget: React.RefObject<{ x: number; y: number }>
  /** Hand-mask drawing surface (alpha = coverage); null when layout tier active. */
  maskCanvas?: HTMLCanvasElement | null
  /** Pan/zoom while editing — drives camera.setViewOffset and the overlay wrapper. */
  view?: ViewController
  /** Join a specific stage. Omitted: the page's shared default stage. */
  stage?: FoilStage
  onPointerMove?: (e: React.PointerEvent<HTMLElement>) => void
  onPointerLeave?: () => void
  className?: string
  /** Overlays (e.g. the mask editor), rendered above the canvas. */
  children?: React.ReactNode
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<CardHandle | null>(null)
  const glyphTexRef = useRef<THREE.CanvasTexture | null>(null)

  // The controller is stable, but keep it in a ref so the once-only
  // registration effect never closes over a stale value.
  const viewCtlRef = useRef<ViewController | undefined>(view)
  viewCtlRef.current = view

  // The whole tilt-source contract, from a host's side: an id and a tiltFor.
  // `tiltTarget` is a mutable ref the workbench's `useTilt` writes into, so the
  // source is a two-line read of it and no React render is involved.
  const tiltSource = useMemo<TiltSource>(
    () => ({
      id: 'ref',
      tiltFor: (): Tilt => tiltTarget.current ?? { x: 0, y: 0 },
    }),
    [tiltTarget],
  )

  const setHost = useCallback(
    (el: HTMLDivElement | null) => {
      hostRef.current = el
      view?.hostRef(el)
    },
    [view],
  )

  // Registration — once. Everything that changes afterwards is a patch.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const st = stage ?? getDefaultStage()
    const handle = st.register(host, {
      pattern,
      imageUrl,
      maskCanvas,
      mode: 'blit',
      tiltSource,
      settings: () => settingsRef.current,
      viewOffset: () => viewCtlRef.current?.view.current ?? null,
      // A workbench card is the thing being looked at, whatever size it is.
      minAnimateWidth: 0,
    })
    handleRef.current = handle
    return () => {
      handle.unregister()
      handleRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    handleRef.current?.update({ pattern })
  }, [pattern])

  useEffect(() => {
    handleRef.current?.update({ imageUrl })
  }, [imageUrl])

  useEffect(() => {
    handleRef.current?.update({ maskCanvas })
  }, [maskCanvas])

  // Glyph slot (R3-GLYPH): while a glyph-capable pattern is displayed, poll the
  // dev api's glyph index and (re)rasterize the dropped artwork into the atlas
  // texture — saving a file into the glyph directory IS the deploy. No dev api
  // (prod) → the first fetch returns null and the poll stops; recipes keep
  // their procedural fallback (uGlyphOn 0).
  useEffect(() => {
    glyphTexRef.current?.dispose()
    glyphTexRef.current = null
    handleRef.current?.update({ glyphTexture: null, glyphInfo: null })
    const slug = glyphSlotFor(pattern.id)
    if (!slug) return
    let cancelled = false
    let timer: number | undefined
    let lastKey = ''
    const tick = async () => {
      const index = await fetchGlyphIndex()
      if (cancelled) return
      if (index === null) return // dev surface absent — stop polling this mount
      const dir = resolveGlyphDir(index, slug)
      const key = dir ? `${dir}:${index[dir].mtime}:${index[dir].files.join(',')}` : ''
      if (key !== lastKey) {
        const atlas = dir ? await buildGlyphAtlas(dir, index[dir]) : null
        if (cancelled) return
        lastKey = key
        glyphTexRef.current?.dispose()
        if (atlas) {
          const tex = new THREE.CanvasTexture(atlas.canvas)
          // Same convention as the hand-mask: exactly one flip, in the shader.
          // LinearFilter (no mips): mip levels would bleed across atlas cells.
          tex.flipY = false
          tex.minFilter = THREE.LinearFilter
          tex.magFilter = THREE.LinearFilter
          glyphTexRef.current = tex
          handleRef.current?.update({
            glyphTexture: tex,
            glyphInfo: { count: atlas.count, cols: atlas.cols },
          })
        } else {
          glyphTexRef.current = null
          // Assets deleted → procedural fallback.
          handleRef.current?.update({ glyphTexture: null, glyphInfo: null })
        }
      }
      timer = window.setTimeout(() => void tick(), 2500)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pattern])

  useEffect(
    () => () => {
      glyphTexRef.current?.dispose()
      glyphTexRef.current = null
    },
    [],
  )

  return (
    <div
      ref={setHost}
      className={`relative overflow-hidden select-none [-webkit-touch-callout:none] ${className}`}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      {/* Overlay wrapper — carries the pan/zoom transform (set imperatively by
          the controller) so the mask/window overlays stay locked to the card. */}
      <div
        ref={view?.wrapRef}
        data-testid="foil-view-wrap"
        className="pointer-events-none absolute inset-0"
        style={{ transformOrigin: '0 0' }}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * The on-screen rect (px, relative to the host) that the card face occupies at
 * zero tilt — the exact inverse of the stage's 1.16-margin projection. Used by
 * the mask editor to align its drawing overlay with the rendered card.
 */
export function cardScreenRect(
  hostW: number,
  hostH: number,
): { left: number; top: number; width: number; height: number } {
  const r = cardFitRect(hostW, hostH, CARD_ASPECT)
  return { left: r.x, top: r.y, width: r.width, height: r.height }
}
