// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// foil/ViewTransform.tsx — pan + pinch-zoom for the workbench viewer while a
// mask (or the window rect) is being edited.
//
// WHY A "VIEW OFFSET" AND NOT A CSS SCALE OF THE WHOLE VIEWER: the card is a
// three.js render, so CSS-scaling the viewer would just magnify a 390px-wide
// framebuffer — useless for tracing a printed edge. Instead the SAME transform
// is expressed twice, in the two places that matter:
//
//   • three.js — camera.setViewOffset(W·z, H·z, x, y, W, H) renders the (x,y,W,H)
//     window OUT OF a virtual W·z × H·z image. The card is re-rasterized at the
//     zoomed size, so 4× zoom is 4× real detail, not 4× blur.
//   • the overlays — one wrapper div carries
//     `translate(-x,-y) scale(z)`, applied imperatively (no React re-render per
//     frame; the whole workbench keeps the settingsRef/tilt-ref ethos).
//
// Because the projection is a pure crop of a linearly-scaled virtual render,
// a point at base (unzoomed) coord u lands on screen at u·z − offset — which is
// EXACTLY what the CSS transform does to the overlays. So the mask canvas and
// the rendered card stay locked together at every zoom, and the pointer→texel
// math in MaskEditor needs no changes at all: getBoundingClientRect() on a
// transformed element already reports the on-screen rect.
//
// Gesture rules (edit/adjust mode only — normal viewing keeps tilt untouched):
//   two fingers   pinch-zoom + pan (midpoint anchored)
//   one finger    pans UNLESS it is a drawing finger ("Allow finger drawing")
//                 or it grabbed a window handle — Procreate's model
//   pen           always draws; while a pen is down, touches are ignored (palm)
//   mouse         wheel/trackpad-pinch/Alt+wheel zooms at the cursor; Shift+wheel
//                 scrolls vertically; a trackpad's deltaX scrolls horizontally;
//                 middle-drag or Space+drag pans; +/−/0 keys, and Illustrator's
//                 Ctrl+= / Ctrl+- / Ctrl+0 / Ctrl+1 where the browser lets them
//                 through (see the caveat at the binding — Chrome owns those and
//                 can keep them)
//   a second finger landing mid-stroke ABORTS and rolls back that stroke.
//
// WHAT WE DELIBERATELY DID NOT CLONE from the spec's view section, so nobody has
// to re-derive it. The full argument for each lives at its code, or — for the
// two with no code — here:
//
//   • Ctrl+wheel = horizontal scroll (§E.6). On the web a trackpad PINCH arrives
//     as wheel+ctrlKey and cannot be told apart from it; taking the chord would
//     break pinch-zoom everywhere. See `onWheel`. Horizontal scroll lives on
//     `deltaX` instead.
//   • plain wheel = vertical scroll (§E.6). §E.6 itself says the zoom-with-wheel
//     preference is a MODE SWITCH that displaces plain scroll onto Shift, and
//     this app is permanently in that mode: the view is clamped and the card is
//     fully framed at 1x, so there is nothing to scroll to. See `onWheel`.
//   • `Z` Zoom tool + Alt+click to zoom out (I.119). A fifth tool through the
//     pen engine — its own ToolId, its own cursor, its own branch in every
//     pointer handler, and a handover so the pen surface yields the press it
//     currently owns — for a gesture this app already offers four ways: the
//     wheel, Ctrl+=/-/0/1, the ZoomHud's steppers, and ⤢ to fit. A marquee zoom
//     has no target here that one wheel notch does not reach.
//   • `H` Hand tool (§E). Space-drag is the same gesture and is already bound,
//     on both the host and — via the pen's pan intent — the pen surface.
//
// An overlay may take individual keys off this controller by passing
// `suspendKeys` — opt-in, key-by-key, and inert when nobody asks. That is how
// the pen surface claims `+ = - _` (Illustrator's anchor-tool keys) and routes
// Space through its own reducer without this file learning what a pen is.
//
// Pan is clamped to the virtual render, so the card can never be lost off-screen
// and "fit" is always one tap away anyway (⤢ in the HUD).

import { useEffect, useRef, useSyncExternalStore } from 'react'

/** Scale + view offset. offset is in px of the virtual (zoomed) render. */
export interface ViewTransform {
  zoom: number
  x: number
  y: number
}

export const MIN_ZOOM = 1
export const MAX_ZOOM = 8

export interface ViewOpts {
  /** Gestures are live only while an editing surface is open. */
  enabled: boolean
  /** Mask-paint surface open (vs. window-adjust). */
  editing: boolean
  /** "Allow finger drawing" — when on, one finger paints so pan needs two. */
  fingerDraws: boolean
  /**
   * `KeyboardEvent.key` values this controller must NOT act on while an overlay owns them.
   *
   * The handover is opt-in and it is a LIST OF KEYS rather than a mode, because the alternative
   * — teaching the view controller which surfaces exist and what each one wants — puts knowledge
   * of the pen in a file that has no other reason to know the pen exists. The pen surface passes
   * `PEN_CLAIMED_HOST_KEYS` plus `' '`: `+`/`-`/`=`/`_` are Illustrator's Add / Delete Anchor
   * Point tool keys, and Space is routed through the pen's reducer instead (with a button down
   * it translates the anchor being placed; with the button up the engine emits a pan intent and
   * calls `setSpacePan` right back here). Pass nothing and every binding below is exactly what
   * it was — this changes no behaviour for the brush or the window-adjust surface.
   */
  suspendKeys?: readonly string[]
}

export interface ViewController {
  /** Attach/detach the window-level listeners. MUST be symmetric — StrictMode
   *  runs mount → cleanup → mount, and a one-shot registration in the factory
   *  would be torn down on that simulated unmount and never come back (which
   *  silently kills pointerup, i.e. gestures that start and never end). */
  attach: () => void
  detach: () => void
  /** Live transform — read by CardViewer's rAF loop and the brush scaler. */
  view: React.RefObject<ViewTransform>
  /** Callback ref for the viewer host (gesture + wheel + iOS listeners). */
  hostRef: (el: HTMLElement | null) => void
  /** Callback ref for the transformed overlay wrapper. */
  wrapRef: (el: HTMLElement | null) => void
  /** True while a pan/pinch owns the pointers — the brush stands down. */
  gesturing: () => boolean
  /** MaskEditor registers a rollback for a stroke a gesture interrupts. */
  setStrokeAbort: (fn: (() => void) | null) => void
  /**
   * Arm/disarm Space-drag panning from outside.
   *
   * The other half of `suspendKeys`. A surface that has taken Space off this controller still
   * needs to be able to say "now pan" — the pen's engine decides that, per spec B.3, and the
   * host does it. Identical to what the controller's own Space handler does, so the two routes
   * cannot drift.
   */
  setSpacePan: (on: boolean) => void
  /**
   * Scroll the view by screen px, clamped to the virtual render like every other move.
   *
   * The pen's auto-scroll (I.14) is the caller that needed this: a drag that leaves the surface
   * has to keep going, and the engine deliberately owns no viewport — it says what should happen
   * (spec B.3) and the host does it. Returns nothing; at 1x the clamp makes it a no-op, which is
   * honest, because at 1x the card is already fully framed.
   */
  panBy: (dx: number, dy: number) => void
  zoomBy: (factor: number) => void
  reset: () => void
  subscribe: (fn: () => void) => () => void
  /** Rounded zoom percentage — a stable snapshot for useSyncExternalStore. */
  zoomPct: () => number
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)

function makeController(optsRef: { current: ViewOpts }): ViewController {
  const view = { current: { zoom: 1, x: 0, y: 0 } as ViewTransform }
  let hostEl: HTMLElement | null = null
  let wrapEl: HTMLElement | null = null

  const subs = new Set<() => void>()
  let pct = 100

  const touches = new Map<number, { x: number; y: number }>()
  let penDown = false
  let mode: 'none' | 'pan' | 'pinch' = 'none'
  let panId = -1
  let start = { zoom: 1, x: 0, y: 0, mx: 0, my: 0, dist: 1 }
  let space = false
  let abortStroke: (() => void) | null = null
  let moveBound = false

  const notify = () => {
    const p = Math.round(view.current.zoom * 100)
    if (p === pct) return
    pct = p
    for (const f of subs) f()
  }

  const cursor = (c: string | null) => {
    if (!hostEl) return
    if (c) hostEl.style.setProperty('--foil-cursor', c)
    else hostEl.style.removeProperty('--foil-cursor')
  }

  /** Keep the visible window inside the virtual render — the card can't escape. */
  const clampView = () => {
    const v = view.current
    v.zoom = clamp(v.zoom, MIN_ZOOM, MAX_ZOOM)
    if (!hostEl) return // no box to clamp against yet — don't zero the pan
    const W = hostEl.clientWidth
    const H = hostEl.clientHeight
    v.x = clamp(v.x, 0, Math.max(0, W * (v.zoom - 1)))
    v.y = clamp(v.y, 0, Math.max(0, H * (v.zoom - 1)))
  }

  const apply = () => {
    clampView()
    const v = view.current
    if (wrapEl) {
      wrapEl.style.transformOrigin = '0 0'
      wrapEl.style.transform = `translate(${-v.x}px, ${-v.y}px) scale(${v.zoom})`
      // Handles/outlines counter-scale off this so they stay finger-sized.
      wrapEl.style.setProperty('--foil-zoom', String(v.zoom))
    }
    notify()
  }

  const pt = (e: { clientX: number; clientY: number }) => {
    if (!hostEl) return { x: 0, y: 0 }
    const r = hostEl.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  /** Zoom keeping the base-space point under (cx,cy) pinned there. */
  const zoomAbout = (factor: number, cx: number, cy: number) => {
    const v = view.current
    const z0 = v.zoom
    const z1 = clamp(z0 * factor, MIN_ZOOM, MAX_ZOOM)
    if (z1 === z0) return
    const ux = (cx + v.x) / z0
    const uy = (cy + v.y) / z0
    v.zoom = z1
    v.x = ux * z1 - cx
    v.y = uy * z1 - cy
    apply()
  }

  // ── gesture bookkeeping ──────────────────────────────────────────────────

  const bindMove = () => {
    if (moveBound) return
    moveBound = true
    window.addEventListener('pointermove', onWinMove, { passive: false })
  }
  const endGesture = () => {
    mode = 'none'
    panId = -1
    if (moveBound) {
      moveBound = false
      window.removeEventListener('pointermove', onWinMove)
    }
    cursor(space ? 'grab' : null)
  }

  const beginPan = (id: number, p: { x: number; y: number }) => {
    abortStroke?.()
    mode = 'pan'
    panId = id
    const v = view.current
    start = { zoom: v.zoom, x: v.x, y: v.y, mx: p.x, my: p.y, dist: 1 }
    bindMove()
    cursor('grabbing')
  }

  const beginPinch = () => {
    abortStroke?.()
    const pts = [...touches.values()]
    const a = pts[0]!
    const b = pts[1]!
    const v = view.current
    start = {
      zoom: v.zoom,
      x: v.x,
      y: v.y,
      mx: (a.x + b.x) / 2,
      my: (a.y + b.y) / 2,
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    }
    mode = 'pinch'
    panId = -1
    bindMove()
  }

  // ── listeners ────────────────────────────────────────────────────────────

  function onWinMove(e: PointerEvent) {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, pt(e))
    const v = view.current
    if (mode === 'pinch') {
      const pts = [...touches.values()]
      if (pts.length < 2) return
      const a = pts[0]!
      const b = pts[1]!
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y))
      const z1 = clamp(start.zoom * (dist / start.dist), MIN_ZOOM, MAX_ZOOM)
      // Anchor: the base-space point under the gesture's ORIGINAL midpoint
      // rides the CURRENT midpoint — one formula gives zoom and pan together.
      const ux = (start.mx + start.x) / start.zoom
      const uy = (start.my + start.y) / start.zoom
      v.zoom = z1
      v.x = ux * z1 - mx
      v.y = uy * z1 - my
      apply()
    } else if (mode === 'pan' && e.pointerId === panId) {
      const p = pt(e)
      // Recomputed from the gesture start every move (never accumulated), so
      // clamping at an edge can't drift the anchor.
      v.zoom = start.zoom
      v.x = start.x + (start.mx - p.x)
      v.y = start.y + (start.my - p.y)
      apply()
    }
  }

  const onDown = (e: PointerEvent) => {
    const o = optsRef.current
    if (!o.enabled) return
    if (e.pointerType === 'pen') {
      penDown = true
      touches.clear()
      if (mode !== 'none') endGesture()
      return
    }
    if (e.pointerType === 'mouse') {
      if (e.button === 1 || space) {
        e.preventDefault()
        beginPan(e.pointerId, pt(e))
      }
      return
    }
    if (penDown) return // palm rejection: a pen owns the surface
    touches.set(e.pointerId, pt(e))
    if (touches.size === 2) {
      beginPinch()
      return
    }
    if (touches.size !== 1) return
    const target = e.target as Element | null
    const onHandle = Boolean(target?.closest?.('[data-window-handle]'))
    const fingerPaints = o.editing && o.fingerDraws
    if (!onHandle && !fingerPaints) beginPan(e.pointerId, pt(e))
  }

  const onUp = (e: PointerEvent) => {
    if (e.pointerType === 'pen') penDown = false
    touches.delete(e.pointerId)
    if (mode === 'pinch' && touches.size < 2) endGesture()
    else if (mode === 'pan' && e.pointerId === panId) endGesture()
  }

  /** Scroll the view by screen px, clamped like every other move. Used by wheel + auto-scroll. */
  const panBy = (dx: number, dy: number) => {
    if (dx === 0 && dy === 0) return
    const v = view.current
    v.x += dx
    v.y += dy
    apply()
  }

  /**
   * The wheel. Spec §E.6 — and the ONE binding set that needed a decision rather than a clone.
   *
   * Illustrator's table is: plain wheel scrolls vertically, Shift+wheel scrolls vertically FASTER,
   * Ctrl+wheel scrolls HORIZONTALLY, Alt+wheel zooms about the cursor. The spec flags this as the
   * set most secondary sources get wrong, because browsers train Shift=horizontal and Ctrl=zoom.
   * Here is what we took, what we did not, and why — the reasoning belongs next to the code
   * because the next person to read this file will otherwise "fix" it back.
   *
   * PLAIN WHEEL STAYS ZOOM, and that is not a lapse. §E.6 says `Zoom with Mouse Wheel` is a MODE
   * SWITCH rather than an added binding (I.122), and enabling it in Illustrator DISPLACES plain
   * scroll onto Shift. This app is permanently in that mode, for a reason the artboard does not
   * have: the view is clamped to the virtual render and `MIN_ZOOM` is 1, so at the zoom the
   * surface opens in the card is fully framed and there is nowhere to scroll TO. Cloning plain
   * scroll would trade the one wheel gesture that always does something for one that usually does
   * nothing — and it would take the brush's wheel with it, which has zoomed since long before the
   * pen existed. So: mode on, plain wheel zooms, and Shift takes the vertical scroll it displaces.
   *
   * CTRL+WHEEL STAYS ZOOM TOO, and this is the one item we deliberately did not clone. On the web
   * a trackpad PINCH is delivered as `wheel` with `ctrlKey: true` and there is no reliable way to
   * tell it from a real Ctrl+wheel. Taking Ctrl for horizontal scroll would break pinch-zoom on
   * every trackpad in exchange for a scroll axis a two-finger swipe already supplies as `deltaX`
   * — which is honoured below, so horizontal scrolling exists, just not on that chord.
   *
   * ALT+WHEEL is Illustrator's zoom and now works here as well, unchanged: an Illustrator user's
   * hand finds it, and it costs nothing because it lands on the same behaviour.
   */
  const onWheel = (e: WheelEvent) => {
    if (!optsRef.current.enabled || !hostEl) return
    e.preventDefault()
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? hostEl.clientHeight || 400 : 1
    const dy = clamp(e.deltaY * unit, -240, 240)
    const dx = clamp((e.deltaX || 0) * unit, -240, 240)
    // Shift+wheel: the vertical scroll the zoom mode displaced. Accelerated, as §E.6 has it —
    // Shift is a speed multiplier on this axis in Illustrator, never a switch to the other one.
    if (e.shiftKey && !e.ctrlKey && !e.altKey) {
      panBy(0, dy * 3)
      return
    }
    const p = pt(e)
    zoomAbout(Math.exp(-dy * 0.0028), p.x, p.y)
    // A trackpad's sideways swipe, free: it arrives as `deltaX` on the same event and is the
    // horizontal scroll Ctrl+wheel could not safely be.
    if (dx !== 0) panBy(dx, 0)
  }

  // Safari (iOS + macOS) still page-zooms on a pinch even with touch-action:none
  // — its gesture* events are the only reliable veto.
  const onSafariGesture = (e: Event) => {
    if (optsRef.current.enabled) e.preventDefault()
  }
  // Belt and braces for iOS: kill the scroll/zoom default for touches that
  // started in the viewer while editing.
  const onTouchMove = (e: TouchEvent) => {
    if (optsRef.current.enabled && e.cancelable) e.preventDefault()
  }
  // Fix 2: no text/image selection, no drag ghost, ever, on the viewer.
  const onSelectStart = (e: Event) => e.preventDefault()
  const onDragStart = (e: Event) => e.preventDefault()

  const setSpacePan = (on: boolean) => {
    if (space === on) return
    space = on
    if (mode !== 'pan') cursor(on ? 'grab' : null)
  }

  const onKey = (e: KeyboardEvent) => {
    const o = optsRef.current
    if (!o.enabled) return
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    // Illustrator's own zoom bindings, added alongside the bare keys rather than replacing them.
    // ABOVE the handover on purpose: what an overlay claims is the BARE key — `+` is the Add
    // Anchor Point TOOL — and `Ctrl+=` is a different chord that has always meant zoom. Putting
    // this below the gate would make the pen swallow a shortcut it does not implement.
    //
    // HONEST CAVEAT: Ctrl+= / Ctrl+- / Ctrl+0 are ALSO Chrome's page-zoom shortcuts, and a web
    // page cannot reliably veto those — `preventDefault` is ignored for browser zoom in current
    // Chrome. So these are best-effort: where the browser lets them through the view zooms, and
    // where it does not the page zooms instead and nothing here breaks. The bindings you can
    // count on remain the wheel, the pinch, the bare keys and the ZoomHud, which is why none of
    // those moved to make room for these.
    if (e.type === 'keydown' && e.ctrlKey && !e.altKey) {
      if (e.key === '=' || e.key === '+') return void ctl.zoomBy(1.5)
      if (e.key === '-' || e.key === '_') return void ctl.zoomBy(1 / 1.5)
      // Fit and 100% are the same view here: MIN_ZOOM is 1 and the fit framing IS 1x, so both
      // reset. Bound separately anyway because an Illustrator user presses whichever they mean.
      if (e.key === '0' || e.key === '1') return void ctl.reset()
    }
    // The opt-in handover. An overlay that claimed a key gets it whole — this controller does
    // not act on it and does not preventDefault it either, or both would be handling it.
    const claimed = o.suspendKeys
    if (claimed && claimed.length > 0 && (claimed.includes(e.key) || (e.code === 'Space' && claimed.includes(' ')))) return
    if (e.code === 'Space') {
      // Both halves are prevented: Space is the pan modifier here, and a
      // <button> in the HUD activates on keyUP — an unprevented keyup would
      // re-fire whichever zoom button was last clicked.
      e.preventDefault()
      setSpacePan(e.type === 'keydown')
      return
    }
    if (e.type !== 'keydown') return
    if (e.key === '0') ctl.reset()
    else if (e.key === '+' || e.key === '=') ctl.zoomBy(1.5)
    else if (e.key === '-' || e.key === '_') ctl.zoomBy(1 / 1.5)
  }

  const onBlur = () => setSpacePan(false)

  const HOST_EVENTS: [string, EventListener, AddEventListenerOptions?][] = [
    ['pointerdown', onDown as EventListener],
    ['wheel', onWheel as EventListener, { passive: false }],
    ['touchmove', onTouchMove as EventListener, { passive: false }],
    ['gesturestart', onSafariGesture, { passive: false }],
    ['gesturechange', onSafariGesture, { passive: false }],
    ['gestureend', onSafariGesture, { passive: false }],
    ['selectstart', onSelectStart],
    ['dragstart', onDragStart],
  ]

  let ro: ResizeObserver | null = null
  let attached = false

  const ctl: ViewController = {
    attach: () => {
      if (attached) return
      attached = true
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
      window.addEventListener('keydown', onKey)
      window.addEventListener('keyup', onKey)
      window.addEventListener('blur', onBlur)
    },
    detach: () => {
      if (!attached) return
      attached = false
      endGesture()
      touches.clear()
      penDown = false
      space = false
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', onBlur)
    },
    view,
    hostRef: (el) => {
      if (hostEl === el) return
      if (hostEl) {
        for (const [type, fn] of HOST_EVENTS) hostEl.removeEventListener(type, fn)
        ro?.disconnect()
        ro = null
      }
      hostEl = el
      if (!el) return
      for (const [type, fn, opt] of HOST_EVENTS) el.addEventListener(type, fn, opt)
      // A resize changes the clamp envelope (and the virtual render size).
      ro = new ResizeObserver(() => apply())
      ro.observe(el)
      apply()
    },
    wrapRef: (el) => {
      wrapEl = el
      apply()
    },
    gesturing: () => mode !== 'none',
    setStrokeAbort: (fn) => {
      abortStroke = fn
    },
    setSpacePan,
    panBy,
    zoomBy: (factor) => {
      const W = hostEl?.clientWidth ?? 0
      const H = hostEl?.clientHeight ?? 0
      zoomAbout(factor, W / 2, H / 2)
    },
    reset: () => {
      view.current = { zoom: 1, x: 0, y: 0 }
      apply()
    },
    subscribe: (fn) => {
      subs.add(fn)
      return () => {
        subs.delete(fn)
      }
    },
    zoomPct: () => pct,
  }

  return ctl
}

export function useViewTransform(opts: ViewOpts): ViewController {
  const optsRef = useRef<ViewOpts>(opts)
  optsRef.current = opts
  const ref = useRef<ViewController | null>(null)
  if (!ref.current) ref.current = makeController(optsRef)
  const ctl = ref.current

  // Symmetric on purpose — see ViewController.attach. The host/wrap listeners
  // and the ResizeObserver ride React's own ref cleanup, so there is nothing
  // else to tear down on unmount.
  useEffect(() => {
    ctl.attach()
    return () => ctl.detach()
  }, [ctl])
  // Leaving the editing surfaces returns the viewer to its normal framing.
  useEffect(() => {
    if (!opts.enabled) ctl.reset()
  }, [ctl, opts.enabled])

  return ctl
}

/** Zoom readout + steppers + fit — the way back, one-handed at 390px. */
export function ZoomHud({ ctl, className = '' }: { ctl: ViewController; className?: string }) {
  const pct = useSyncExternalStore(ctl.subscribe, ctl.zoomPct, ctl.zoomPct)
  // Deliberately compact: at 390px this floats over the card he is tracing, so
  // it buys back every px it can while staying a 32px thumb target.
  const btn =
    'flex h-[32px] w-[32px] items-center justify-center rounded-full text-[15px] leading-none text-text-primary hover:bg-surface-tertiary disabled:opacity-35'
  return (
    <div
      data-testid="zoom-hud"
      className={`flex select-none items-center rounded-full border border-border-default bg-surface-secondary/85 p-[2px] backdrop-blur-sm ${className}`}
    >
      <button className={btn} aria-label="Zoom out" disabled={pct <= MIN_ZOOM * 100} onClick={() => ctl.zoomBy(1 / 1.5)}>
        −
      </button>
      <span data-testid="zoom-pct" className="min-w-[42px] text-center text-[12px] tabular-nums text-text-muted">
        {pct}%
      </span>
      <button className={btn} aria-label="Zoom in" disabled={pct >= MAX_ZOOM * 100} onClick={() => ctl.zoomBy(1.5)}>
        +
      </button>
      <button className={btn} aria-label="Fit to view" title="Fit to view (0)" onClick={ctl.reset}>
        ⤢
      </button>
    </div>
  )
}
