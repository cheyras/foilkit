// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// foil/PenEditor.tsx — the pen tool's SURFACE. `MaskEditor`'s sibling, and deliberately dumber.
//
// `MaskEditor` owns its behaviour: it decides what a stroke is, what pressure means, what a
// cancelled gesture rolls back. This component owns none of the pen's. Every judgement — what a
// click means, which handle moves, which badge the cursor shows, which handles are visible —
// lives in `@foilkit/forge`'s `pen-engine.ts`, where a `node --test` file drives ninety gestures
// in a millisecond. What is left here is exactly three jobs, and it is worth naming them because
// each one is a place a bezier editor traditionally grows a second brain:
//
//   1. NORMALISE. DOM events become `PenInput` (`pen-surface.ts`), including the two pieces of
//      modifier state no event property carries: Caps Lock, via `getModifierState`, and whether
//      the spacebar is HELD.
//   2. REDUCE. `reduce(state, input, cfg)`. Nothing else mutates `state`.
//   3. RENDER. The cursor is `cursorFor(state)`. The handles to draw are `visibleHandles(state,
//      cfg)` — including the rule that selecting ONE anchor shows FOUR handle stubs, both of
//      that anchor plus the one facing handle on each neighbour (spec I.99). The keys are
//      `PEN_KEY_BINDINGS`. There is no second table, no second cursor rule, no local hit test.
//
// TWO LAYERS, AND THE SEPARATION IS THE WHOLE POINT.
//
// The FILL is rasterised through `rasterizePolygons` — the same function the vector templates
// and the fitted masks go through — straight into FoilLab's persistent mask canvas, and the host
// then bumps `maskTexVersion` so the shader re-uploads. That is the proven path in `stage.ts`,
// so the foil preview under the pen is the real shader reading the real mask while the path is
// still being drawn, rather than a drawing of what the shader might do.
//
// The CHROME — anchors, direction lines, direction points, rubber band, marquee — renders to a
// separate SVG layer ABOVE the fill and never touches those bytes. Baking chrome into the mask
// would contaminate the committed artifact with UI furniture, which is the worst bug available
// in this file, and it is structurally impossible rather than merely avoided: `rasterizePenDoc`
// takes a `PenDoc` and has no access to the selection, the hover or the rubber band at all.
// SVG rather than a third canvas because chrome must stay CRISP as well as constant-sized at 8x
// zoom, and a canvas inside a CSS-scaled wrapper is a fixed grid of pixels being magnified.
//
// COORDINATES. `getBoundingClientRect()` of the SVG already carries the view controller's CSS
// zoom, so pointer -> document needs no zoom term — the same reliance `MaskEditor.toMask`
// documents. What DOES need the scale is everything measured in screen pixels: hit radii (the
// engine divides those itself, given `input.zoom`) and chrome sizes (`chromeMetrics`). One
// factor, `screenPerDoc`, named once.
//
// THE BACKDROP IS NOT SILENTLY VECTORISED. A saved mask is a raster. It is shown underneath at
// low opacity as something to TRACE, and the pen document starts empty. Auto-tracing it into
// paths would be a machine guess wearing a human decision's clothes (F3/F4), and this surface
// refuses to make it. The consequence is honest and visible: until the first subpath encloses
// something, the pen document rasterises to nothing, so the mask canvas is left holding the
// backdrop's own pixels rather than being blanked — the preview keeps telling the truth about
// what the mask currently IS. If a real vector form ever exists for a card, `loadVPath` on the
// handle imports it through `fromVPath` and the user edits anchors instead of tracing.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_PEN_CONFIG,
  cloneDoc,
  createPenState,
  cursorFor,
  fromVPath,
  isRetracted,
  reduce,
  visibleHandles,
  type HandleStub,
  type PenConfig,
  type PenCursor,
  type PenDoc,
  type PenInput,
  type PenPath,
  type PenState,
  type VPath,
} from '@foilkit/forge/geometry'
import { MASK_H, MASK_W } from './MaskEditor.tsx'
import {
  chromeMetrics,
  consumesKey,
  keyInput,
  paintAlpha,
  penPathD,
  pointerInput,
  rasterizePenDoc,
  screenPerDoc,
} from './pen-surface.ts'
import type { ViewController } from './ViewTransform.tsx'

/** The tint's RGB. Only alpha reaches the shader; this is what the eye sees on the canvas. */
const TINT_RGB: [number, number, number] = [255, 45, 100]

/** Illustrator's selection blue, near enough. Chrome only — never rasterised. */
const CHROME = '#3d8bff'
const CHROME_SOFT = 'rgba(61, 139, 255, 0.75)'
/** The casing every stroke gets, so a hairline survives a white border and a black one alike. */
const CASING = 'rgba(0, 0, 0, 0.55)'

/**
 * The rays the construction guides offer when they are switched on: the same 45-degree family
 * Shift constrains to, so the guide is the automatic version of a rule the user already knows
 * rather than a second, differently-shaped one to learn.
 */
const CONSTRUCTION_ANGLES = [0, 45, 90, 135]

/**
 * The engine's cursor states, as the closest thing a browser can render.
 *
 * We ship NO pen-badge cursor art, and inventing traced Illustrator glyphs would break F2 as
 * surely as tracing a card would. So the badge is rendered twice: as the nearest standard CSS
 * cursor, and as `data-pen-cursor` on the surface, which is a real semantic hook — the e2e run
 * asserts on it, and dropping in cursor art later is a change to this table and nothing else.
 */
const CSS_CURSOR: Record<PenCursor, string> = {
  start: 'crosshair',
  drawing: 'crosshair',
  continue: 'copy',
  close: 'pointer',
  add: 'copy',
  delete: 'no-drop',
  convert: 'pointer',
  merge: 'alias',
  blocked: 'not-allowed',
  crosshair: 'crosshair',
}

/**
 * `visibleHandles` plus the anchor currently under the hand.
 *
 * NOT a second opinion about which handles are visible — it answers a different question.
 * `visibleHandles` implements spec F.4, which is entirely about SELECTION: what an already-placed
 * anchor shows once you pick it, including the four-stub rule. The anchor being dragged RIGHT NOW
 * is not selected (placement selects the path, not the point), and spec A.3 turns on being able to
 * see it: "the handle under the cursor is the OUTGOING one", and users aim by watching the
 * committed segment behind them re-render against it. Hiding the handle you are dragging is the
 * fastest way to make a pen tool feel like it is guessing.
 */
function withDragStubs(state: PenState, stubs: HandleStub[]): HandleStub[] {
  const d = state.drag
  if (!d || (d.kind !== 'place' && d.kind !== 'close' && d.kind !== 'convert-anchor' && d.kind !== 'move-handle')) {
    return stubs
  }
  const out = stubs.slice()
  const seen = new Set(stubs.map((s) => `${s.path}:${s.point}:${s.side}`))
  for (const side of ['left', 'right'] as const) {
    const k = `${d.path}:${d.point}:${side}`
    if (seen.has(k)) continue
    const pt = state.doc.paths[d.path]?.points[d.point]
    if (!pt) continue
    const h = side === 'left' ? pt.leftDirection : pt.rightDirection
    if (isRetracted(h, pt.anchor, DEFAULT_PEN_CONFIG.retractEpsilon)) continue
    out.push({ path: d.path, point: d.point, side })
  }
  return out
}

export interface PenEditorHandle {
  /** The live engine state. A snapshot for the host to read; never mutate it. */
  state: () => PenState
  /** The pen document, cloned — this is what a persistence layer would save. */
  doc: () => PenDoc
  undo: () => void
  redo: () => void
  /** Drop every path and end the session. Does NOT touch the backdrop. */
  clear: () => void
  /** Import an existing VECTOR form for editing (spec: `fromVPath`), replacing the document. */
  loadVPath: (paths: VPath[]) => void
  /** Import already-editable paths, e.g. from a persistence layer that stored them. */
  loadPaths: (paths: PenPath[]) => void
}

export function PenEditor({
  canvas,
  rect,
  allowTouch = false,
  config = DEFAULT_PEN_CONFIG,
  snapNote = null,
  initialPaths = null,
  view,
  onCommit,
  registerHandle,
}: {
  /** FoilLab's persistent mask canvas — the one the shader samples as `uMaskTex`. */
  canvas: HTMLCanvasElement
  /** Card-face rect within the viewer host (px) — BASE coords, pre-zoom, as `MaskEditor` takes. */
  rect: { left: number; top: number; width: number; height: number }
  allowTouch?: boolean
  config?: PenConfig
  /**
   * What the host's snap evidence has to say for itself — "still reading the scan", "1,204px of
   * printed edge", "this scan's pixels cannot be read back". The surface shows it verbatim,
   * because the difference between a snapper that is loading, one that gave up, and one that
   * found nothing on this card is invisible from the pen's behaviour alone: all three feel like
   * a pen that simply is not catching anything.
   */
  snapNote?: string | null
  /** A vector form to open for EDITING, when one exists. Null means "trace the backdrop". */
  initialPaths?: PenPath[] | null
  /** Pan/zoom controller — gesture arbitration, and the host end of the pen's pan intent. */
  view?: ViewController
  /** The document changed and the mask canvas was rewritten: bump `maskTexVersion`. */
  onCommit: () => void
  registerHandle?: (h: PenEditorHandle) => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const fillRef = useRef<HTMLCanvasElement>(null)
  const backdropRef = useRef<HTMLCanvasElement>(null)

  const stateRef = useRef<PenState>(createPenState({ paths: initialPaths ?? [] }))
  /**
   * Construction guides, the one PREFERENCE this surface owns rather than the host.
   *
   * Illustrator ships them OFF (I.104) and so do we — an angular capture nobody asked for reads
   * as the tool arguing with the hand. It lives here rather than in the host's config because it
   * is a view preference the user flips while drawing, exactly like Outline mode; the host still
   * owns the `snap` provider, which is evidence rather than preference.
   */
  const [guides, setGuides] = useState(false)
  const cfg = useMemo(
    () => (guides ? { ...config, constructionAngles: CONSTRUCTION_ANGLES } : config),
    [config, guides],
  )
  /** Whether the spacebar is HELD. No event property carries this; the surface must track it. */
  const spaceRef = useRef(false)
  /** The document as of the last rasterisation, so hover moves do not re-rasterise. */
  const rasterisedRef = useRef<PenDoc | null>(null)
  const rafRef = useRef<number | null>(null)
  const [, bump] = useState(0)
  /**
   * Screen px per document unit, as a RENDER input.
   *
   * Measured in an effect rather than during render (reading layout during render is how a
   * component gets a different answer than the one it painted) and only stored when it actually
   * moved, or the measure -> setState -> measure loop never settles.
   */
  const [scale, setScale] = useState(1)

  /**
   * The backdrop: whatever was on the mask canvas when the pen opened.
   *
   * Captured ONCE, at mount. It is the thing being traced, and it is explicitly not converted to
   * paths — see the header. Kept as its own canvas so the pen can own the mask canvas outright
   * from the first enclosed subpath onward without having destroyed what it started from.
   */
  const backdropData = useRef<ImageData | null>(null)
  const hasInk = useRef(false)
  /**
   * Has the pen's own document taken the mask canvas over yet?
   *
   * Written by `rasterise` from the pixels it just produced, not guessed from the path count: a
   * three-anchor path only owns the canvas once it actually encloses something, and "encloses
   * something" is a question only the rasteriser can answer.
   */
  const penOwnsMask = useRef(false)
  /** The last pointer position in CLIENT space, for auto-scroll — see `autoScroll`. */
  const lastPointer = useRef<{ clientX: number; clientY: number; altKey: boolean; ctrlKey: boolean; shiftKey: boolean; capsLock: boolean } | null>(null)
  if (backdropData.current === null && typeof document !== 'undefined') {
    const c = canvas.getContext('2d')
    if (c) {
      const d = c.getImageData(0, 0, MASK_W, MASK_H)
      backdropData.current = d
      for (let i = 3; i < d.data.length; i += 4) {
        if (d.data[i]! > 0) {
          hasInk.current = true
          break
        }
      }
    }
  }

  /**
   * The overlay's on-screen box. Declared up here because the auto-scroll loop below needs it and
   * a `useCallback` dependency array cannot name an identifier that is still in its own TDZ.
   */
  const dispRect = useCallback((): { left: number; top: number; width: number; height: number } => {
    const el = svgRef.current
    if (!el) return { left: 0, top: 0, width: 0, height: 0 }
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  }, [])

  /** Paint the captured backdrop into its own display canvas, once it exists. */
  useEffect(() => {
    const el = backdropRef.current
    const data = backdropData.current
    if (!el || !data) return
    el.getContext('2d')?.putImageData(data, 0, 0)
  }, [])

  /**
   * Rasterise the document into the mask canvas, then blit the visible copy.
   *
   * The empty-document case restores the backdrop rather than clearing, which is the honest
   * answer to "what is the mask right now": nothing has been drawn, so it is still whatever was
   * loaded. From the first enclosed subpath the pen owns the canvas and the backdrop stays as a
   * tracing reference only.
   */
  const rasterise = useCallback(() => {
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const doc = stateRef.current.doc
    const alpha = rasterizePenDoc(doc, MASK_W, MASK_H)
    let any = false
    for (let i = 0; i < alpha.length; i++) {
      if (alpha[i]! > 0) {
        any = true
        break
      }
    }
    // The one bit that makes the replacement legible instead of silent — see `MASK NOTICE` below.
    penOwnsMask.current = any
    if (!any && backdropData.current) {
      ctx.putImageData(backdropData.current, 0, 0)
    } else {
      const img = ctx.createImageData(MASK_W, MASK_H)
      paintAlpha(img.data, alpha, TINT_RGB)
      ctx.putImageData(img, 0, 0)
    }
    const fill = fillRef.current
    if (fill) {
      const fctx = fill.getContext('2d')
      if (fctx) {
        fctx.clearRect(0, 0, MASK_W, MASK_H)
        fctx.drawImage(canvas, 0, 0)
      }
    }
    rasterisedRef.current = doc
    onCommit()
  }, [canvas, onCommit])

  /**
   * One render pass per animation frame, coalesced.
   *
   * A pointermove can arrive several times per frame and the rasteriser walks every scanline;
   * doing that synchronously per event is how a pen tool ends up feeling like it is dragging the
   * cursor rather than following it. The document identity is the dirty flag — `reduce` returns
   * a new `doc` only when the geometry actually changed, so hovering re-renders the chrome and
   * touches neither the raster nor the shader.
   */
  /**
   * Conformance I.14 — a drag that leaves the surface keeps going, by scrolling the view under it.
   *
   * AND I.15, WHICH IS THE HALF THAT MAKES IT SAFE: only while a drag is in progress. Waving the
   * cursor off the card with nothing but the rubber band showing must not scroll, or the view
   * runs away from a user who was merely reaching for a menu. `stateRef.current.drag` is that
   * test, and it is the engine's own state rather than a second notion of "am I drawing".
   *
   * The engine deliberately owns no viewport (spec B.3), so the pan is the host's `panBy` — and
   * the clamped view means this is a no-op at 1x, where the card is fully framed and there is
   * nowhere to go. Speed rises with the overshoot and caps, so a cursor parked just outside the
   * edge creeps and one flung across the room does not teleport.
   *
   * The synthetic pointermove afterwards is not optional: panning changes the client -> document
   * map, so a stationary cursor is now over a DIFFERENT document point, and without re-feeding it
   * the handle would stay behind while the artwork slid out from under it. It reduces directly
   * rather than through `apply` to keep `schedule` -> `autoScroll` -> `apply` -> `schedule` from
   * becoming a dependency cycle.
   */
  const autoScroll = useCallback((): boolean => {
    const p = lastPointer.current
    if (!view || !p || !stateRef.current.drag) return false
    const r = dispRect()
    if (r.width <= 0 || r.height <= 0) return false
    const past = (lo: number, hi: number, x: number): number => (x < lo ? x - lo : x > hi ? x - hi : 0)
    const overX = past(r.left, r.left + r.width, p.clientX)
    const overY = past(r.top, r.top + r.height, p.clientY)
    if (overX === 0 && overY === 0) return false
    const step = (d: number): number => (d === 0 ? 0 : Math.sign(d) * Math.min(28, 2 + Math.abs(d) * 0.3))
    view.panBy(step(overX), step(overY))
    stateRef.current = reduce(
      stateRef.current,
      pointerInput('pointermove', { ...p, getModifierState: () => p.capsLock }, dispRect(), MASK_W, MASK_H, spaceRef.current),
      cfg,
    )
    return true
  }, [cfg, dispRect, view])

  const schedule = useCallback(() => {
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      // Auto-scroll first: it may move the geometry, and the raster below should show where the
      // drag ended up this frame rather than a frame behind it.
      const scrolling = autoScroll()
      if (stateRef.current.doc !== rasterisedRef.current) rasterise()
      // A cursor held outside the edge produces no further events, so the loop has to keep its
      // own frame alive — and stop the moment it comes back inside or the button comes up.
      if (scrolling) schedule()
      bump((n) => n + 1)
    })
  }, [autoScroll, rasterise])

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  /**
   * A vector form opened for editing has to reach the mask canvas before the first gesture, or
   * the shader would keep showing the backdrop while the chrome already shows the paths. An
   * EMPTY document deliberately does not schedule: opening the pen must not mark the mask dirty.
   */
  useEffect(() => {
    if (initialPaths && initialPaths.length > 0) schedule()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Apply one input, then honour whatever the engine asked the host to do.
   *
   * `state.intent` is the engine's only way to reach the viewport: it does not pan, it says the
   * host should (spec B.3). Spacebar with the button DOWN is consumed as an anchor translate and
   * produces no intent; with the button UP it produces `{kind:'pan'}` and the host arms its
   * Space-drag pan. Same key, two meanings, and the decision is the engine's.
   */
  const apply = useCallback(
    (input: PenInput) => {
      const next = reduce(stateRef.current, input, cfg)
      stateRef.current = next
      if (next.intent?.kind === 'pan') view?.setSpacePan(true)
      schedule()
    },
    [cfg, schedule, view],
  )

  // The measured scale, kept fresh across zoom (the controller notifies on every zoom change)
  // and across layout. Only written when it moved by more than a fifth of a percent.
  useEffect(() => {
    const measure = () => {
      const s = screenPerDoc(dispRect(), MASK_W)
      setScale((prev) => (Math.abs(prev - s) > prev * 0.002 ? s : prev))
    }
    measure()
    const un = view?.subscribe(measure)
    window.addEventListener('resize', measure)
    return () => {
      un?.()
      window.removeEventListener('resize', measure)
    }
  }, [dispRect, view, rect.width, rect.height])

  // ── Keyboard ──────────────────────────────────────────────────────────────
  //
  // Window-level, because an SVG overlay is not focusable and a pen tool whose shortcuts need a
  // click first is a pen tool nobody uses the shortcuts of. The INPUT/TEXTAREA/contentEditable
  // guard is the same one `ViewTransform.onKey` carries — typing a comment must not place an
  // anchor. The host yields `+ = - _` and Space while this surface is mounted (see the
  // `suspendKeys` prop threaded from FoilLab); everything else it binds still works.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const space = e.code === 'Space' || e.key === ' '
      if (space) {
        // Both halves prevented, for `ViewTransform`'s reason: Space is a modifier here, and a
        // focused <button> in the HUD activates on keyUP.
        e.preventDefault()
        if (e.type === 'keydown') {
          if (spaceRef.current) return // autorepeat is not a second press
          spaceRef.current = true
        } else {
          spaceRef.current = false
          view?.setSpacePan(false)
        }
      }
      const input = keyInput(e.type === 'keydown' ? 'keydown' : 'keyup', e, dispRect(), MASK_W, spaceRef.current)
      if (!space && e.type === 'keydown' && consumesKey(e)) e.preventDefault()
      apply(input)
    }
    const onBlur = () => {
      spaceRef.current = false
      view?.setSpacePan(false)
      apply({ type: 'blur', mods: { alt: false, ctrl: false, shift: false, space: false, capsLock: false }, zoom: scale })
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', onBlur)
    }
  }, [apply, dispRect, scale, view])

  // ── Imperative handle ─────────────────────────────────────────────────────
  //
  // Undo, redo and clear go through `reduce` with a synthetic key event rather than through a
  // private code path, so the button and the keystroke are the same operation by construction —
  // `PEN_KEY_BINDINGS` stays the only binding table, and a rebind moves both.
  const key = useCallback(
    (k: string, mods: { alt?: boolean; ctrl?: boolean; shift?: boolean }): void => {
      apply({
        type: 'keydown',
        key: k,
        mods: { alt: false, ctrl: false, shift: false, space: false, capsLock: false, ...mods },
        zoom: scale,
      })
    },
    [apply, scale],
  )

  const load = useCallback(
    (paths: PenPath[]): void => {
      stateRef.current = createPenState({ paths })
      rasterisedRef.current = null
      schedule()
    },
    [schedule],
  )

  useEffect(() => {
    if (!registerHandle) return
    registerHandle({
      state: () => stateRef.current,
      doc: () => cloneDoc(stateRef.current.doc),
      undo: () => key('z', { ctrl: true }),
      redo: () => key('z', { ctrl: true, shift: true }),
      clear: () => load([]),
      loadVPath: (paths) => load(paths.map((p) => fromVPath(p))),
      loadPaths: load,
    })
  }, [key, load, registerHandle])

  // ── The saved mask, and the moment the pen takes it over ──────────────────
  //
  // MASK NOTICE. The pen opens over whatever mask was already committed and shows it as something
  // to trace. While the pen document rasterises to nothing the canvas keeps holding that
  // backdrop, so the preview is telling the truth. From the FIRST ENCLOSED SUBPATH the pen owns
  // the canvas outright and the saved mask is gone from it — and `onCommit` has already marked the
  // mask dirty. Open the pen to REFINE a good mask, drop three anchors by accident, hit Save, and
  // the mask is now that triangle. Nothing on screen said so, and `Clear paths` — the only way
  // back — is not labelled as one.
  //
  // WHY THIS AFFORDANCE AND NOT ANOTHER. Three were on the table:
  //
  //   • Merge the pen's output into the existing raster. Rejected outright: it would make the
  //     preview a lie about what a save writes, and it would make an accidental three-anchor
  //     triangle un-erasable rather than merely destructive. The pen's document IS the mask it
  //     saves; a compositing step would give the surface a second opinion about that.
  //   • A modal confirmation at the third anchor. Rejected: the destructive moment is a normal
  //     part of drawing, and a dialog in the middle of a bezier gesture is worse than the bug.
  //   • What is here: say it, before it is true, and label the way back. The notice arms at the
  //     FIRST anchor — while the saved mask is still intact and the transition is still only
  //     coming — and changes wording once the pen actually owns the canvas.
  //
  // The way back is `Ctrl+A` then `Delete` through the engine's own binding table, NOT a private
  // reset: that keeps it one undo step, so the restore is itself reversible and a user who
  // panicked can Ctrl+Z their paths straight back. `rasterise` then finds an empty document and
  // puts the backdrop back byte for byte.
  const restoreSavedMask = useCallback(() => {
    key('a', { ctrl: true })
    key('Delete', {})
  }, [key])

  const anchorCount = stateRef.current.doc.paths.reduce((n, p) => n + p.points.length, 0)
  const maskStage: 'none' | 'armed' | 'replaced' = !hasInk.current
    ? 'none'                                    // nothing committed here yet — nothing to destroy
    : penOwnsMask.current
      ? 'replaced'
      : anchorCount > 0
        ? 'armed'
        : 'none'

  // ── Pointer ───────────────────────────────────────────────────────────────

  /**
   * A pan or a pinch started mid-gesture: abort the drag the way Escape does.
   *
   * `MaskEditor` registers a stroke rollback here for the same reason, and the failure mode is
   * the same shape: `accepts` stands the pen down for the duration, so the pointerup that would
   * have ended the drag never arrives and the engine is left holding an anchor forever. `blur`
   * is exactly the input the engine documents for "a gesture that will never finish".
   */
  useEffect(() => {
    if (!view) return
    const abort = () => {
      if (!stateRef.current.drag) return
      apply({ type: 'blur', mods: { alt: false, ctrl: false, shift: false, space: false, capsLock: false }, zoom: scale })
    }
    view.setStrokeAbort(abort)
    return () => view.setStrokeAbort(null)
  }, [apply, scale, view])

  /** Remember where the hand is in CLIENT space — the only coordinate auto-scroll can use, since
   *  the document mapping is exactly what it is about to change. */
  const remember = (e: React.PointerEvent): void => {
    lastPointer.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      capsLock: e.getModifierState?.('CapsLock') ?? false,
    }
  }

  const accepts = (e: React.PointerEvent): boolean =>
    !view?.gesturing() &&
    (e.pointerType === 'pen' || e.pointerType === 'mouse' || (allowTouch && e.pointerType === 'touch'))

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    // Space is held: this press is the start of a PAN, and the view controller's own host
    // listener has already claimed it. Gated here and not in `accepts` on purpose — spec B.3
    // says Space DURING a placement translates the anchor, so a pointermove with space held
    // must keep reaching the engine. It is only the press that starts a gesture instead.
    if (spaceRef.current) return
    if (!accepts(e)) return
    e.preventDefault()
    try {
      // A drag that leaves the card face still tracks — placing an anchor near the edge and
      // pulling a long handle off it is a normal gesture, not an aborted one.
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* synthetic events (tests) have no active pointer — capture is best-effort */
    }
    remember(e)
    apply(pointerInput('pointerdown', e, dispRect(), MASK_W, MASK_H, spaceRef.current))
  }
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!accepts(e)) return
    remember(e)
    apply(pointerInput('pointermove', e, dispRect(), MASK_W, MASK_H, spaceRef.current))
  }
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    lastPointer.current = null      // the drag is over; nothing left for auto-scroll to chase
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    apply(pointerInput('pointerup', e, dispRect(), MASK_W, MASK_H, spaceRef.current))
  }

  // ── Chrome ────────────────────────────────────────────────────────────────

  const state = stateRef.current
  const m = chromeMetrics(scale)
  const cursor = cursorFor(state)
  const stubs = withDragStubs(state, visibleHandles(state, cfg))
  const selected = new Set(state.selection.anchors.map((a) => `${a.path}:${a.point}`))
  const hovered = state.hover?.target?.kind === 'anchor' ? `${state.hover.target.path}:${state.hover.target.point}` : null
  const rb = state.rubberBand

  return (
    <>
      {/* The thing being traced. Faint, beneath everything, never edited. */}
      <canvas
        ref={backdropRef}
        data-testid="pen-backdrop"
        width={MASK_W}
        height={MASK_H}
        className="pointer-events-none absolute rounded-[4.7%/3.4%] opacity-25"
        style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      />
      {/* The live fill — a blit of the real mask canvas, so what is on screen is what the
          shader is sampling rather than a second drawing of the same intent.

          OUTLINE MODE (Ctrl+Y, I.116) hides THIS and nothing else. The rasteriser keeps writing
          the same bytes into the mask canvas and the shader keeps reading them — an outline mode
          that stopped rasterising would let someone save a mask they had never looked at. It is a
          way of looking, never a way of storing. */}
      <canvas
        ref={fillRef}
        data-testid="pen-fill"
        width={MASK_W}
        height={MASK_H}
        className="pointer-events-none absolute rounded-[4.7%/3.4%] opacity-45"
        style={{
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          display: state.outline ? 'none' : undefined,
        }}
      />
      {/* The chrome. Its own layer, above the fill, and the only one that takes input. */}
      <svg
        ref={svgRef}
        data-testid="pen-chrome"
        data-pen-cursor={cursor}
        data-pen-anchors={state.doc.paths.reduce((n, p) => n + p.points.length, 0)}
        data-pen-paths={state.doc.paths.length}
        data-pen-closed={state.doc.paths.filter((p) => p.closed).length}
        data-pen-backdrop={hasInk.current ? 'raster' : 'empty'}
        data-pen-mask={maskStage}
        data-pen-outline={state.outline ? 'true' : 'false'}
        data-pen-edges={state.hideEdges ? 'hidden' : 'shown'}
        // Snapping, as three separate facts, because they fail separately: whether the user has
        // it on, what the last gesture actually caught, and what it declined to do. The e2e run
        // reads all three — a snap that quietly does nothing and a snap that refuses out loud are
        // the same pixels on screen and very different tools.
        data-pen-snap={state.snapEnabled ? 'on' : 'off'}
        // Whether a provider is WIRED, which is a different fact from whether the user has
        // snapping on: preparing the evidence is asynchronous, and until it lands the pen draws
        // unsnapped with the switch still showing "on". A test that cannot tell those apart is a
        // test that races the idle callback and passes or fails by machine speed.
        data-pen-snap-provider={cfg.snap ? 'wired' : 'none'}
        data-pen-snap-kind={state.snapped?.kind ?? ''}
        data-pen-snap-refusal={state.snapRefusal ?? ''}
        data-pen-guides={guides ? 'on' : 'off'}
        viewBox={`0 0 ${MASK_W} ${MASK_H}`}
        preserveAspectRatio="none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDragStart={(e) => e.preventDefault()}
        className="absolute"
        style={{
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          touchAction: 'none',
          pointerEvents: 'auto',
          // The controller sets --foil-cursor to grab/grabbing while Space is held; the pen's
          // own badge is the fallback, so panning wins while it is happening.
          cursor: `var(--foil-cursor, ${CSS_CURSOR[cursor]})`,
          userSelect: 'none',
          WebkitUserSelect: 'none',
          WebkitTouchCallout: 'none',
        } as React.CSSProperties}
      >
        {/* HIDE EDGES (Ctrl+H, I.118). The whole chrome layer goes; the artwork and the fill
            stay. Gotcha 27 calls it the most-used key for "let me see the artwork without my
            anchors all over it", so it is one `<g>` and not a per-element opinion — a hide that
            left the rubber band behind would be the one thing people press it to get rid of.
            The surface itself stays mounted and still takes input: this hides the edges, it does
            not put the pen down. */}
        <g style={{ display: state.hideEdges ? 'none' : undefined }}>
        {/* EVERY STROKE IS CASED. The chrome sits over a card scan whose local value is
            unknowable — Charizard's flames and Base Set's black border are the same overlay —
            and a single-colour hairline disappears into one of them wherever it happens to
            cross. A dark casing under the selection colour reads on both, which is what makes
            "the anchors are visible" a property of the tool rather than of the artwork. */}
        {penPathD(state.doc).map((d, i) => (
          <g key={`p${i}`} fill="none">
            <path d={d} stroke={CASING} strokeWidth={m.outline * 3} />
            <path d={d} stroke={CHROME} strokeWidth={m.outline} />
          </g>
        ))}

        {/* Spec A.4: the last anchor's REAL outgoing handle and a retracted incoming handle at
            the cursor — so it is straight out of a corner and a curve out of a smooth point. */}
        {rb && (
          <g data-testid="pen-rubber-band" fill="none">
            <path
              d={`M ${rb.from[0]} ${rb.from[1]} C ${rb.c1[0]} ${rb.c1[1]} ${rb.c2[0]} ${rb.c2[1]} ${rb.to[0]} ${rb.to[1]}`}
              stroke={CASING}
              strokeWidth={m.outline * 3}
            />
            <path
              d={`M ${rb.from[0]} ${rb.from[1]} C ${rb.c1[0]} ${rb.c1[1]} ${rb.c2[0]} ${rb.c2[1]} ${rb.to[0]} ${rb.to[1]}`}
              stroke={CHROME_SOFT}
              strokeWidth={m.outline}
            />
          </g>
        )}

        {/* Direction lines and points. WHICH ones is `visibleHandles` (plus the anchor in the
            hand, see `withDragStubs`), never a local rule about geometry. */}
        {stubs.map((s) => {
          const pt = state.doc.paths[s.path]?.points[s.point]
          if (!pt) return null
          const h = s.side === 'left' ? pt.leftDirection : pt.rightDirection
          return (
            <g key={`h${s.path}:${s.point}:${s.side}`} data-testid="pen-handle">
              <line
                x1={pt.anchor[0]}
                y1={pt.anchor[1]}
                x2={h[0]}
                y2={h[1]}
                stroke={CASING}
                strokeWidth={m.directionLine * 3}
              />
              <line
                x1={pt.anchor[0]}
                y1={pt.anchor[1]}
                x2={h[0]}
                y2={h[1]}
                stroke={CHROME}
                strokeWidth={m.directionLine}
              />
              <circle cx={h[0]} cy={h[1]} r={m.handleDot} fill={CHROME} stroke={CASING} strokeWidth={m.directionLine} />
            </g>
          )
        })}

        {/* Anchors. Hollow unselected, filled selected, enlarged under the pointer (F.3). */}
        {state.doc.paths.flatMap((path, pi) =>
          path.points.map((pt, i) => {
            const k = `${pi}:${i}`
            const on = selected.has(k)
            const half = hovered === k ? m.hoverAnchor : m.anchor
            return (
              <rect
                key={`a${k}`}
                data-testid="pen-anchor"
                data-selected={on ? 'true' : 'false'}
                // The anchor's DOCUMENT position, verbatim. The rect's own x/y carry the chrome's
                // half-size offset and change with hover, so reading a placement back off them
                // means re-deriving `chromeMetrics` in the reader — which is how an acceptance
                // test ends up asserting against its own arithmetic instead of the geometry.
                data-anchor={`${pt.anchor[0]},${pt.anchor[1]}`}
                x={pt.anchor[0] - half}
                y={pt.anchor[1] - half}
                width={half * 2}
                height={half * 2}
                fill={on ? CHROME : '#ffffff'}
                stroke={on ? '#ffffff' : CASING}
                strokeWidth={m.directionLine}
              />
            )
          }),
        )}

        {state.marquee && (
          <rect
            data-testid="pen-marquee"
            x={Math.min(state.marquee.x0, state.marquee.x1)}
            y={Math.min(state.marquee.y0, state.marquee.y1)}
            width={Math.abs(state.marquee.x1 - state.marquee.x0)}
            height={Math.abs(state.marquee.y1 - state.marquee.y0)}
            fill="none"
            stroke={CHROME}
            strokeWidth={m.directionLine}
            strokeDasharray={`${m.marqueeDash} ${m.marqueeDash}`}
          />
        )}

        {/* Spec F.2: the only feedback that a snap actually captured. We draw no arrowhead, so
            the capture is a ring at the point it landed on rather than a hollowed cursor. */}
        {state.snapped && (
          <circle
            data-testid="pen-snap"
            cx={state.snapped.point[0]}
            cy={state.snapped.point[1]}
            r={m.handleDot * 2}
            fill="none"
            stroke={CHROME}
            strokeWidth={m.directionLine}
          />
        )}
        </g>
      </svg>

      {/*
        THE SNAP STRIP — the switch, and what the switch is currently doing.

        Snapping is the one feature here that MOVES SOMETHING THE USER PLACED. Everything else the
        pen does lands where the hand went, so a silent snapper is the only part of this tool that
        can leave a person wondering whether they mis-clicked. Hence: the state is on screen, the
        toggle is on screen next to it (Ctrl+U, spec I.102 — and the button dispatches the same
        binding rather than a private code path, so the two can never disagree), and the last
        thing it did is written out in words.

        THE REFUSAL IS SHOWN, QUIETLY. When the evidence is ambiguous the pen deliberately does
        not move the point, and a user who cannot tell that apart from a snapper that failed to
        notice the edge learns to distrust the whole feature. It is one dim line, it never blocks
        a click, and it is gone on the next gesture — not a dialog, not a toast, not a nag.
      */}
      <div
        data-testid="pen-snap-strip"
        className="absolute flex items-center px-2 text-[11px] leading-none"
        style={{
          left: rect.left,
          top: rect.top + rect.height - 26,
          width: rect.width,
          height: 26,
          // Inline, and `gap` specifically: the mask notice above spells out why a utility class
          // in this package is a bet on the HOST app's Tailwind content globs, and the strip's
          // three items ran together with no space between them the first time this shipped.
          gap: 8,
          // Inline for the same reason the mask notice is: this renders into the viewer's
          // pointer-events-none overlay, and a Tailwind class here would depend on the HOST app's
          // content globs reaching a file inside `packages/three`.
          pointerEvents: 'none',
          background: 'rgba(10, 12, 18, 0.66)',
          color: '#e7ecf5',
          zIndex: 5,
          display: state.hideEdges ? 'none' : undefined,
        }}
      >
        <button
          type="button"
          data-testid="pen-snap-toggle"
          onClick={() => key('u', { ctrl: true })}
          title="Snap to printed edges (Ctrl+U)"
          className="shrink-0 rounded-full border px-2 py-[3px]"
          style={{
            pointerEvents: 'auto',
            borderColor: state.snapEnabled ? CHROME : 'rgba(255,255,255,0.3)',
            color: state.snapEnabled ? CHROME : 'inherit',
          }}
        >
          Snap {state.snapEnabled ? 'on' : 'off'} ⌃U
        </button>
        <button
          type="button"
          data-testid="pen-guides-toggle"
          onClick={() => setGuides((g) => !g)}
          title="Capture onto 45° rays from the previous anchor"
          className="shrink-0 rounded-full border px-2 py-[3px]"
          style={{
            pointerEvents: 'auto',
            borderColor: guides ? CHROME : 'rgba(255,255,255,0.3)',
            color: guides ? CHROME : 'inherit',
          }}
        >
          45° guides {guides ? 'on' : 'off'}
        </button>
        <span data-testid="pen-snap-note" className="truncate" style={{ opacity: 0.75 }}>
          {!state.snapEnabled
            ? 'anchors land exactly where you click'
            : (state.snapRefusal ?? (state.snapped ? `caught: ${state.snapped.kind}` : (snapNote ?? '')))}
        </span>
      </div>

      {/* THE MASK NOTICE — see the block comment above `restoreSavedMask` for the reasoning.
          Pinned to the very top of the card face and only ~26px tall so it clears every part of
          the artwork a trace actually starts on, and `pointer-events: none` on the strip with
          `auto` on the button alone, so the notice can never eat an anchor. */}
      {maskStage !== 'none' && (
        <div
          data-testid="pen-mask-notice"
          data-stage={maskStage}
          className="absolute flex items-center gap-2 rounded-t-[4.7%] px-2 text-[11px] leading-none"
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: 26,
            // INLINE, not a utility class. The overlay layer this renders into is itself
            // `pointer-events: none` and the chrome SVG re-enables its own the same way; a
            // Tailwind class here would depend on the HOST app's content globs reaching a file in
            // `packages/three`, and a button you can see and cannot press is worse than no button.
            pointerEvents: 'none',
            background: maskStage === 'replaced' ? 'rgba(120, 20, 40, 0.86)' : 'rgba(90, 60, 0, 0.82)',
            color: '#fff',
            // Explicit, because the chrome SVG is a sibling that covers the same box and takes
            // pointer events: without a stacking order the "Restore saved mask" button is a
            // button you can see and cannot press, which is worse than not offering it.
            zIndex: 5,
          }}
        >
          <span className="truncate">
            {maskStage === 'replaced'
              ? 'These paths have REPLACED the saved mask. Saving keeps them.'
              : 'The saved mask will be replaced by these paths once one encloses an area.'}
          </span>
          <button
            type="button"
            onClick={restoreSavedMask}
            className="ml-auto shrink-0 rounded-full border border-white/40 px-2 py-[3px] hover:bg-white/15"
            style={{ pointerEvents: 'auto' }}
          >
            Restore saved mask
          </button>
        </div>
      )}
    </>
  )
}
