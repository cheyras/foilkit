// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// FoilStage — one canvas, one WebGLRenderer, any number of cards.
//
// THE BOTTLENECK THIS EXISTS TO REMOVE. The workbench viewer did
// `new THREE.WebGLRenderer(...)` per card. That is correct for one card and
// fatal past a handful: browsers cap WebGL contexts somewhere between ~8
// (three.js's own guidance) and 16 (Chrome), and past the cap the OLDEST
// context is silently lost — the card does not error, it goes blank. Worse,
// resources cannot be shared across contexts, so every card re-uploads its own
// copy of the same texture and recompiles its own copy of the same program.
//
// So: one context, and card count stops being something a host reasons about.
//   * a material cache keyed by patternId — two cosmos cards compile ONE
//     program, because three keys its program cache on the shader source and
//     the source is the same object;
//   * a texture cache keyed by URL — two tiles showing the same card upload
//     once, at a size chosen from the card's on-screen box;
//   * one rAF loop, one IntersectionObserver, one ResizeObserver.
//
// WHAT IS NOT DECIDED HERE. Which cards animate, at what resolution, at what
// cadence, from which tilt source — all of that is @foilkit/stage, which
// imports no renderer and is unit-tested without a GPU. This file is the
// binding: it measures, asks, and draws.
//
// EXTERNALLY SUPPLIED RENDERERS. A host already running its own three.js scene
// must not be forced into a second context — that is the exact problem being
// solved — so `options.renderer` is honoured and never restyled or disposed.

import * as THREE from 'three'
import { CARD_ASPECT } from '@foilkit/core'
import type { FoilPattern } from '@foilkit/patterns'
import {
  STAGE_DEFAULTS,
  createLadder,
  createTiltSource,
  defaultTiltSourceId,
  easeToward,
  faceTextureWidth,
  needsLargerDecode,
  scheduleFrame,
  scissorBox,
  shortEdge,
  type CardState,
  type LadderOptions,
  type PresentationMode,
  type Rect,
  type StagePlan,
  type Tilt,
  type TiltSource,
  type TiltSourceId,
} from '@foilkit/stage'
import { buildFoilMaterial, transparentTexture } from './material.ts'

/** The live per-card uniform state the stage reads every frame. */
export interface CardSettings {
  /** Core + pattern uniform values, keyed by uniform name. */
  uniforms: Record<string, number>
  maskRect: [number, number, number, number]
  maskRadius: number
  maskFeather: number
  maskInvert: boolean
  maskView: boolean
  /** Hand-mask tier: sample the mask canvas instead of the layout rect. */
  maskTexOn: boolean
  /** Bump to signal the mask canvas contents changed (stroke finished). */
  maskTexVersion: number
  /** Max card rotation in degrees at |tilt| = 1. */
  maxTiltDeg: number
  /**
   * Is uFace a REAL CARD SCAN (true/undefined — the scan-additive composite
   * applies) or a synthetic blank base (false — the classic composite, and
   * bit-identical canon renders)?
   */
  scanBase?: boolean
}

/** Pan/zoom, as the mask editor drives it. */
export interface CardViewOffset {
  zoom: number
  x: number
  y: number
}

export interface CardConfig {
  pattern: FoilPattern
  imageUrl?: string | null
  /** Read every frame — slider changes never need to re-register a card. */
  settings?: () => CardSettings
  /** Hand-mask drawing surface (alpha = coverage). */
  maskCanvas?: HTMLCanvasElement | null
  /** Glyph atlas for the recipes that take one (R3-GLYPH). */
  glyphTexture?: THREE.Texture | null
  glyphInfo?: { count: number; cols: number } | null
  /** Per-card presentation override; defaults to the stage's mode. */
  mode?: PresentationMode
  /** Per-card tilt source override, by id or as an object. */
  tiltSource?: TiltSourceId | TiltSource
  /** Read every frame; drives camera.setViewOffset for zoomed editing. */
  viewOffset?: () => CardViewOffset | null
  /** Below this short edge (CSS px) the card renders one static frame. */
  minAnimateWidth?: number
}

export interface CardHandle {
  readonly id: string
  /** Patch the config in place. A pattern change swaps material, not context. */
  update(patch: Partial<CardConfig>): void
  /** The card's current eased tilt — what a host would draw an overlay against. */
  tilt(): Tilt
  unregister(): void
}

export interface StageOptions {
  /**
   * An existing renderer. Supplied: the stage never restyles, resizes the
   * style of, or disposes it. Absent: the stage makes one and owns it.
   */
  renderer?: THREE.WebGLRenderer
  /** Where the underlay canvas is inserted. Default `document.body`. */
  container?: HTMLElement
  mode?: PresentationMode
  tiltSource?: TiltSourceId | TiltSource
  minAnimateWidth?: number
  /** Ceiling for `setPixelRatio`. Default 2 — rung 1 walks down from it. */
  maxPixelRatio?: number
  targetFps?: number
  ladder?: LadderOptions
  /** IntersectionObserver root margin. Default '128px'. */
  rootMargin?: string
  /** z-index for the underlay canvas. Default 0. */
  underlayZIndex?: number
  /** Start the loop on construction. Default true. */
  autoStart?: boolean
}

export interface StageStats {
  /** WebGL contexts this stage owns. One. Always one — that is the deliverable. */
  contexts: number
  cards: number
  visible: number
  animating: number
  /** Distinct patterns with a material, and therefore a program. */
  materials: number
  /** three's own compiled-program count. The honest number. */
  programs: number
  /** Distinct face-texture URLs uploaded. */
  textures: number
  mode: PresentationMode
  tiltSource: string
  rung: number
  step: number
  rungLabel: string
  /** Smoothed stage work time, ms. */
  workMs: number
  /** Measured frames per second over the last second. */
  fps: number
  pixelRatio: number
  /** Draw calls issued last frame. */
  drawCalls: number
}

interface TextureEntry {
  texture: THREE.Texture | null
  width: number
  refs: number
  loading: boolean
}

interface CardEntry {
  id: string
  index: number
  el: HTMLElement
  config: CardConfig
  rect: Rect
  intersecting: boolean
  tilt: Tilt
  /** The blit target, when this card is presented that way. */
  blitCanvas: HTMLCanvasElement | null
  blitCtx: CanvasRenderingContext2D | null
  /** Which URL this card holds a texture reference for. */
  textureUrl: string | null
  maskTexture: THREE.CanvasTexture | null
  maskCanvasSeen: HTMLCanvasElement | null
  maskVersionSeen: number
  /** Per-card tilt-source overrides, constructed lazily and kept off the config. */
  sources: Map<string, TiltSource>
  removed: boolean
}

const FALLBACK_SETTINGS: CardSettings = {
  uniforms: {},
  maskRect: [0, 0, 1, 1],
  maskRadius: 0.01,
  maskFeather: 0.008,
  maskInvert: false,
  maskView: false,
  maskTexOn: false,
  maskTexVersion: 0,
  maxTiltDeg: STAGE_DEFAULTS.maxTiltDeg,
  scanBase: true,
}

let nextStageId = 0

export class FoilStage {
  readonly renderer: THREE.WebGLRenderer
  private readonly ownsRenderer: boolean
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(32, 1, 0.1, 20)
  private readonly geometry = new THREE.PlaneGeometry(1, CARD_ASPECT, 12, 16)
  private readonly mesh: THREE.Mesh
  private readonly materials = new Map<string, THREE.ShaderMaterial>()
  private readonly textures = new Map<string, TextureEntry>()
  private readonly cards = new Map<string, CardEntry>()
  private readonly byElement = new WeakMap<Element, CardEntry>()
  private readonly ladder: ReturnType<typeof createLadder>
  private readonly io: IntersectionObserver | null
  private readonly ro: ResizeObserver | null
  private readonly options: Required<
    Pick<
      StageOptions,
      'minAnimateWidth' | 'maxPixelRatio' | 'targetFps' | 'rootMargin' | 'underlayZIndex'
    >
  >
  private readonly stageId = `foilkit-stage-${nextStageId++}`
  private readonly container: HTMLElement | null

  private mode: PresentationMode
  private source: TiltSource
  private sourceOwned = true
  private plan: StagePlan
  private raf = 0
  private running = false
  private started = 0
  private lastFrameAt = 0
  private cardSeq = 0
  private appliedPixelRatio = 0
  private appliedSize = { width: 0, height: 0 }
  private fps = 0
  private fpsFrames = 0
  private fpsSince = 0
  private lastDrawCalls = 0
  private disposed = false

  /**
   * Debug knob — busy-wait this many ms inside the measured frame, to force
   * the ladder to engage without needing a slow machine. The acceptance test
   * uses it, which is the only honest way to assert "engages and recovers"
   * on hardware that happens to be fast.
   */
  syntheticLoadMs = 0

  constructor(options: StageOptions = {}) {
    this.options = {
      minAnimateWidth: options.minAnimateWidth ?? STAGE_DEFAULTS.minAnimateWidth,
      maxPixelRatio: options.maxPixelRatio ?? STAGE_DEFAULTS.maxPixelRatio,
      targetFps: options.targetFps ?? STAGE_DEFAULTS.targetFps,
      rootMargin: options.rootMargin ?? STAGE_DEFAULTS.rootMargin,
      underlayZIndex: options.underlayZIndex ?? 0,
    }
    this.mode = options.mode ?? 'underlay'
    this.ownsRenderer = !options.renderer
    this.renderer =
      options.renderer ?? new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.autoClear = false
    this.renderer.setClearColor(0x000000, 0)

    this.container =
      options.container ?? (typeof document !== 'undefined' ? document.body : null)
    if (this.ownsRenderer && this.container) this.attachCanvas()

    this.mesh = new THREE.Mesh(this.geometry)
    this.scene.add(this.mesh)

    this.ladder = createLadder({ targetFps: this.options.targetFps, ...options.ladder })
    this.plan = this.ladder.plan

    const src = options.tiltSource ?? defaultTiltSourceId()
    this.source = typeof src === 'string' ? createTiltSource(src) : src
    this.sourceOwned = typeof src === 'string'
    this.source.attach?.()

    this.io =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            (entries) => {
              for (const e of entries) {
                const card = this.byElement.get(e.target)
                if (card) card.intersecting = e.isIntersecting
              }
            },
            { rootMargin: this.options.rootMargin },
          )
    this.ro =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            for (const e of entries) {
              const card = this.byElement.get(e.target)
              if (card) this.measure(card)
            }
          })

    if (options.autoStart !== false) this.start()
  }

  // ── canvas ───────────────────────────────────────────────────────────────

  private attachCanvas(): void {
    const el = this.renderer.domElement
    el.dataset.foilkitStage = this.stageId
    el.style.position = 'fixed'
    el.style.left = '0'
    el.style.top = '0'
    el.style.width = '100%'
    el.style.height = '100%'
    el.style.pointerEvents = 'none'
    el.style.zIndex = String(this.options.underlayZIndex)
    // FIRST child, deliberately: a positioned sibling later in the document
    // then paints ABOVE it, which is what makes a card element a hole in the
    // page rather than a lid on the canvas.
    this.container!.prepend(el)
    this.applyMode()
  }

  private applyMode(): void {
    if (!this.ownsRenderer) return
    // `blit` draws into the same canvas and then hands each element a copy, so
    // the shared canvas itself must not be visible.
    this.renderer.domElement.style.visibility = this.mode === 'underlay' ? 'visible' : 'hidden'
  }

  // ── registration ─────────────────────────────────────────────────────────

  /**
   * Register a DOM element as a card. The element's box IS the card's box; the
   * stage never changes its layout, only what appears inside it.
   */
  register(el: HTMLElement, config: CardConfig): CardHandle {
    const id = `${this.stageId}-card-${this.cardSeq}`
    const entry: CardEntry = {
      id,
      index: this.cardSeq++,
      el,
      config,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      intersecting: false,
      tilt: { x: 0, y: 0 },
      blitCanvas: null,
      blitCtx: null,
      textureUrl: null,
      maskTexture: null,
      maskCanvasSeen: null,
      maskVersionSeen: -1,
      sources: new Map(),
      removed: false,
    }
    this.cards.set(id, entry)
    this.byElement.set(el, entry)
    this.io?.observe(el)
    this.ro?.observe(el)
    this.measure(entry)
    this.syncPresentation(entry)
    this.syncTexture(entry)
    this.syncMask(entry)
    // No IntersectionObserver (tests, jsdom): assume on screen rather than
    // silently rendering nothing.
    if (!this.io) entry.intersecting = true

    return {
      id,
      update: (patch: Partial<CardConfig>) => {
        if (entry.removed) return
        const before = entry.config
        entry.config = { ...before, ...patch }
        if ('imageUrl' in patch) this.syncTexture(entry)
        if ('maskCanvas' in patch) this.syncMask(entry)
        if ('mode' in patch) this.syncPresentation(entry)
      },
      tilt: () => ({ ...entry.tilt }),
      unregister: () => this.unregister(entry),
    }
  }

  private unregister(entry: CardEntry): void {
    if (entry.removed) return
    entry.removed = true
    this.cards.delete(entry.id)
    this.io?.unobserve(entry.el)
    this.ro?.unobserve(entry.el)
    entry.blitCanvas?.remove()
    entry.blitCanvas = null
    entry.blitCtx = null
    entry.maskTexture?.dispose()
    entry.maskTexture = null
    this.releaseTexture(entry)
  }

  private modeFor(entry: CardEntry): PresentationMode {
    return entry.config.mode ?? this.mode
  }

  private syncPresentation(entry: CardEntry): void {
    const wants = this.modeFor(entry) === 'blit'
    if (wants && !entry.blitCanvas) {
      const c = document.createElement('canvas')
      c.style.position = 'absolute'
      c.style.left = '0'
      c.style.top = '0'
      c.style.width = '100%'
      c.style.height = '100%'
      c.style.display = 'block'
      c.style.pointerEvents = 'none'
      // A paint gesture must never start a selection, a drag ghost, or iOS's
      // long-press callout on the rendered card.
      c.style.userSelect = 'none'
      c.style.setProperty('-webkit-user-select', 'none')
      c.style.setProperty('-webkit-touch-callout', 'none')
      c.draggable = false
      // The element is the card's box; a blit canvas inside it needs a
      // containing block or it escapes to the nearest positioned ancestor.
      const position = getComputedStyle(entry.el).position
      if (position === 'static') entry.el.style.position = 'relative'
      entry.el.prepend(c)
      entry.blitCanvas = c
      entry.blitCtx = c.getContext('2d', { alpha: true })
    } else if (!wants && entry.blitCanvas) {
      entry.blitCanvas.remove()
      entry.blitCanvas = null
      entry.blitCtx = null
    }
  }

  private measure(entry: CardEntry): void {
    const r = entry.el.getBoundingClientRect()
    entry.rect = { x: r.left, y: r.top, width: r.width, height: r.height }
  }

  // ── caches ───────────────────────────────────────────────────────────────

  /** The material for a pattern — created once, shared by every card using it. */
  private materialFor(pattern: FoilPattern): THREE.ShaderMaterial {
    let mat = this.materials.get(pattern.id)
    if (!mat) {
      mat = buildFoilMaterial(pattern)
      this.materials.set(pattern.id, mat)
    }
    return mat
  }

  private releaseTexture(entry: CardEntry): void {
    if (!entry.textureUrl) return
    const e = this.textures.get(entry.textureUrl)
    entry.textureUrl = null
    if (!e) return
    e.refs -= 1
    // Deliberately NOT disposed at refs 0: a virtualized grid unmounts and
    // remounts the same card constantly, and a cache that evicted on unmount
    // would re-upload the same bytes every scroll. Eviction is `trimTextures`.
  }

  private syncTexture(entry: CardEntry): void {
    const url = entry.config.imageUrl ?? null
    if (url === entry.textureUrl) return
    this.releaseTexture(entry)
    if (!url) return
    entry.textureUrl = url
    const want = faceTextureWidth(entry.rect.width || 300, {
      pixelRatio: Math.min(this.devicePixelRatio(), this.options.maxPixelRatio),
    })
    const existing = this.textures.get(url)
    if (existing) {
      existing.refs += 1
      if (!existing.loading && needsLargerDecode(existing.width, want)) {
        void this.load(url, want)
      }
      return
    }
    this.textures.set(url, { texture: null, width: 0, refs: 1, loading: true })
    void this.load(url, want)
  }

  /**
   * Decode a face at the capped width and upload it once.
   *
   * `colorSpace = NoColorSpace` is not an oversight: the foil composite is
   * authored in DISPLAY space, and letting the hardware decode sRGB at sample
   * time darkens every midtone of the scan under it.
   */
  private async load(url: string, width: number): Promise<void> {
    const entry = this.textures.get(url)
    if (!entry) return
    entry.loading = true
    try {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.decoding = 'async'
      img.src = url
      await img.decode()
      const natural = img.naturalWidth || width
      const w = Math.min(width, natural)
      const h = Math.max(1, Math.round((w * (img.naturalHeight || width)) / natural))
      let source: ImageBitmap | HTMLCanvasElement
      if (typeof createImageBitmap === 'function') {
        source = await createImageBitmap(img, {
          resizeWidth: w,
          resizeHeight: h,
          resizeQuality: 'high',
        })
      } else {
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        c.getContext('2d')!.drawImage(img, 0, 0, w, h)
        source = c
      }
      const live = this.textures.get(url)
      if (!live || this.disposed) return
      const tex = new THREE.Texture(source as unknown as HTMLCanvasElement)
      tex.colorSpace = THREE.NoColorSpace
      tex.anisotropy = 4
      tex.needsUpdate = true
      live.texture?.dispose()
      live.texture = tex
      live.width = w
      live.loading = false
    } catch {
      const live = this.textures.get(url)
      if (live) live.loading = false
    }
  }

  /** Drop cached textures nothing references. Hosts call it; the stage never does. */
  trimTextures(): number {
    let dropped = 0
    for (const [url, e] of this.textures) {
      if (e.refs > 0 || e.loading) continue
      e.texture?.dispose()
      this.textures.delete(url)
      dropped += 1
    }
    return dropped
  }

  private syncMask(entry: CardEntry): void {
    const canvas = entry.config.maskCanvas ?? null
    if (canvas === entry.maskCanvasSeen) return
    entry.maskTexture?.dispose()
    entry.maskTexture = null
    entry.maskCanvasSeen = canvas
    entry.maskVersionSeen = -1
    if (!canvas) return
    const tex = new THREE.CanvasTexture(canvas)
    // The shader flips V explicitly (canvas is y-down); disable the GPU-side
    // flip or the two cancel out and the mask renders upside down.
    tex.flipY = false
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    entry.maskTexture = tex
  }

  // ── the loop ─────────────────────────────────────────────────────────────

  start(): void {
    if (this.running || this.disposed) return
    this.running = true
    this.started = performance.now()
    this.fpsSince = this.started
    const tick = () => {
      if (!this.running) return
      this.raf = requestAnimationFrame(tick)
      this.frame(performance.now())
    }
    this.raf = requestAnimationFrame(tick)
  }

  stop(): void {
    this.running = false
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private devicePixelRatio(): number {
    return typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  }

  /** One frame. Public so a test can step the stage without a real rAF. */
  frame(now: number): void {
    if (this.disposed) return
    // Rung 2: every card drops together. A page where everything runs at 30
    // reads as deliberate; a mixed-cadence page reads as broken.
    const interval = 1000 / this.plan.fpsCap
    if (this.lastFrameAt && now - this.lastFrameAt < interval - 1) return
    this.lastFrameAt = now

    const t0 = performance.now()
    this.draw(now)
    if (this.syntheticLoadMs > 0) {
      const until = performance.now() + this.syntheticLoadMs
      while (performance.now() < until) {
        /* deliberate: the ladder must react to work, not to a reported number */
      }
    }
    const work = performance.now() - t0

    this.fpsFrames += 1
    if (now - this.fpsSince >= 500) {
      this.fps = (this.fpsFrames * 1000) / (now - this.fpsSince)
      this.fpsFrames = 0
      this.fpsSince = now
    }
    this.plan = this.ladder.observe(work, now)
  }

  private draw(now: number): void {
    const viewport = {
      width: typeof window === 'undefined' ? 0 : window.innerWidth,
      height: typeof window === 'undefined' ? 0 : window.innerHeight,
    }
    if (!viewport.width || !viewport.height) return

    const pixelRatio = Math.min(this.devicePixelRatio(), this.options.maxPixelRatio) *
      this.plan.pixelRatioScale
    // Assigning canvas.width RESETS the drawing buffer even when the value is
    // unchanged, so `setSize` is guarded rather than called every frame. An
    // unguarded call reallocates the buffer sixty times a second, which is a
    // performance bug that looks exactly like the one the stage exists to fix.
    if (
      Math.abs(pixelRatio - this.appliedPixelRatio) > 1e-6 ||
      viewport.width !== this.appliedSize.width ||
      viewport.height !== this.appliedSize.height
    ) {
      this.renderer.setPixelRatio(pixelRatio)
      this.renderer.setSize(viewport.width, viewport.height, false)
      this.appliedPixelRatio = pixelRatio
      this.appliedSize = { width: viewport.width, height: viewport.height }
    }

    const list = [...this.cards.values()]
    const states: CardState[] = []
    for (const c of list) {
      if (c.intersecting) this.measure(c)
      states.push({
        id: c.id,
        index: c.index,
        rect: c.rect,
        intersecting: c.intersecting && c.rect.width > 0 && c.rect.height > 0,
        largeEnough:
          shortEdge(c.rect) >= (c.config.minAnimateWidth ?? this.options.minAnimateWidth),
      })
    }
    const schedule = scheduleFrame(states, this.plan, viewport)

    this.renderer.setScissorTest(true)
    const canvasW = Math.round(viewport.width * pixelRatio)
    const canvasH = Math.round(viewport.height * pixelRatio)
    this.renderer.setScissor(0, 0, canvasW, canvasH)
    this.renderer.setViewport(0, 0, canvasW, canvasH)
    this.renderer.clear(true, true, false)

    const time = (now - this.started) / 1000
    let drawn = 0
    for (let i = 0; i < list.length; i++) {
      const card = list[i]!
      const s = schedule[i]!
      if (!s.draw) continue
      this.drawCard(card, s.animate, s.park, viewport, pixelRatio, time)
      drawn += 1
    }
    this.lastDrawCalls = drawn

    // Blit AFTER the single pass — one drawImage per card, GPU-side, inside
    // the same task, which is what lets the shared drawing buffer be read
    // without `preserveDrawingBuffer` and its per-frame copy.
    for (let i = 0; i < list.length; i++) {
      const card = list[i]!
      if (!schedule[i]!.draw || !card.blitCtx || !card.blitCanvas) continue
      this.blit(card, viewport, pixelRatio)
    }
  }

  private drawCard(
    card: CardEntry,
    animate: boolean,
    park: boolean,
    viewport: { width: number; height: number },
    pixelRatio: number,
    time: number,
  ): void {
    const settings = card.config.settings?.() ?? FALLBACK_SETTINGS
    const material = this.materialFor(card.config.pattern)
    this.mesh.material = material
    const u = material.uniforms

    if (animate || park) {
      const target = park
        ? { x: 0, y: 0 }
        : this.sourceFor(card).tiltFor({
            id: card.id,
            rect: card.rect,
            viewport,
            index: card.index,
            time,
          })
      card.tilt = {
        x: easeToward(card.tilt.x, target.x, STAGE_DEFAULTS.tiltEasing),
        y: easeToward(card.tilt.y, target.y, STAGE_DEFAULTS.tiltEasing),
      }
    }

    const maxRad = (settings.maxTiltDeg * Math.PI) / 180
    this.mesh.rotation.y = card.tilt.x * maxRad
    this.mesh.rotation.x = -card.tilt.y * maxRad

    ;(u.uTilt!.value as THREE.Vector2).set(card.tilt.x, card.tilt.y)
    u.uTime!.value = time
    for (const [k, v] of Object.entries(settings.uniforms)) {
      if (u[k]) u[k]!.value = v
    }
    ;(u.uMaskRect!.value as THREE.Vector4).set(...settings.maskRect)
    u.uMaskRadius!.value = settings.maskRadius
    u.uMaskFeather!.value = settings.maskFeather
    u.uMaskInvert!.value = settings.maskInvert ? 1 : 0
    u.uMaskView!.value = settings.maskView ? 1 : 0
    if (u.uScanBase) u.uScanBase.value = settings.scanBase === false ? 0 : 1

    // Face: the shared cache entry, or nothing. The layout-rect tier renders
    // with no texture at all, which is the common case at grid scale.
    const face = card.textureUrl ? (this.textures.get(card.textureUrl)?.texture ?? null) : null
    u.uFace!.value = face

    if (card.maskTexture) {
      u.uMaskTex!.value = card.maskTexture
      u.uMaskTexOn!.value = settings.maskTexOn ? 1 : 0
      if (settings.maskTexVersion !== card.maskVersionSeen) {
        card.maskTexture.needsUpdate = true
        card.maskVersionSeen = settings.maskTexVersion
      }
    } else {
      u.uMaskTexOn!.value = 0
    }

    if (u.uGlyphTex) {
      const info = card.config.glyphInfo ?? null
      u.uGlyphTex.value = card.config.glyphTexture ?? transparentTexture()
      u.uGlyphOn!.value = info ? 1 : 0
      u.uGlyphCount!.value = info?.count ?? 0
      u.uGlyphCols!.value = info?.cols ?? 1
    }

    // Geometry. In blit the card may be rendered smaller than its box and
    // stretched back on the way out (rung 1's second step); in underlay a
    // card's pixels ARE the page's pixels, so renderScale is a no-op there.
    const scale = this.modeFor(card) === 'blit' ? this.plan.renderScale : 1
    const box = scissorBox(card.rect, viewport, pixelRatio)
    const w = Math.max(1, Math.round(box.width * scale))
    const h = Math.max(1, Math.round(box.height * scale))
    const y = box.y + box.height - h // anchored to the card's top edge
    this.renderer.setScissor(box.x, y, w, h)
    this.renderer.setViewport(box.x, y, w, h)

    this.camera.aspect = w / h
    const fovY = (this.camera.fov * Math.PI) / 180
    const distH = (CARD_ASPECT / 2 / Math.tan(fovY / 2)) * 1.16
    const fovX = 2 * Math.atan(Math.tan(fovY / 2) * this.camera.aspect)
    const distW = (0.5 / Math.tan(fovX / 2)) * 1.16
    this.camera.position.z = Math.max(distH, distW)
    const vt = card.config.viewOffset?.() ?? null
    if (vt && vt.zoom !== 1) {
      this.camera.setViewOffset(
        card.rect.width * vt.zoom,
        card.rect.height * vt.zoom,
        vt.x,
        vt.y,
        card.rect.width,
        card.rect.height,
      )
    } else {
      this.camera.clearViewOffset()
    }
    this.camera.updateProjectionMatrix()
    this.renderer.render(this.scene, this.camera)
  }

  private blit(
    card: CardEntry,
    viewport: { width: number; height: number },
    pixelRatio: number,
  ): void {
    const canvas = card.blitCanvas!
    const ctx = card.blitCtx!
    const box = scissorBox(card.rect, viewport, pixelRatio)
    const scale = this.plan.renderScale
    const sw = Math.max(1, Math.round(box.width * scale))
    const sh = Math.max(1, Math.round(box.height * scale))
    if (canvas.width !== box.width || canvas.height !== box.height) {
      canvas.width = Math.max(1, box.width)
      canvas.height = Math.max(1, box.height)
    }
    // The source rect is in canvas pixels with a TOP-left origin, so the
    // scissor box's bottom-left y has to be flipped back.
    const canvasH = Math.round(viewport.height * pixelRatio)
    const sy = canvasH - (box.y + box.height)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(
      this.renderer.domElement,
      box.x,
      sy,
      sw,
      sh,
      0,
      0,
      canvas.width,
      canvas.height,
    )
  }

  private sourceFor(card: CardEntry): TiltSource {
    const s = card.config.tiltSource
    if (!s) return this.source
    if (typeof s !== 'string') return s
    // Per-card override by id, constructed lazily. Cards on the stage's own
    // source — which is the whole grid, normally — allocate nothing.
    let made = card.sources.get(s)
    if (!made) {
      made = createTiltSource(s)
      made.attach?.()
      card.sources.set(s, made)
    }
    return made
  }

  // ── control ──────────────────────────────────────────────────────────────

  setMode(mode: PresentationMode): void {
    if (mode === this.mode) return
    this.mode = mode
    this.applyMode()
    for (const card of this.cards.values()) this.syncPresentation(card)
  }

  getMode(): PresentationMode {
    return this.mode
  }

  setTiltSource(source: TiltSourceId | TiltSource): void {
    const next = typeof source === 'string' ? createTiltSource(source) : source
    if (next === this.source) return
    if (this.sourceOwned) this.source.detach?.()
    this.source = next
    this.sourceOwned = typeof source === 'string'
    this.source.attach?.()
  }

  getTiltSource(): TiltSource {
    return this.source
  }

  /** Pin the ladder (the demo's manual override); -1 hands control back. */
  setLadderStep(step: number): void {
    if (step < 0) {
      this.ladder.reset()
      this.plan = this.ladder.plan
    } else {
      this.plan = this.ladder.setStep(step)
    }
  }

  stats(): StageStats {
    let visible = 0
    for (const c of this.cards.values()) if (c.intersecting) visible += 1
    return {
      contexts: 1,
      cards: this.cards.size,
      visible,
      animating: this.lastDrawCalls,
      materials: this.materials.size,
      programs: this.renderer.info.programs?.length ?? 0,
      textures: this.textures.size,
      mode: this.mode,
      tiltSource: this.source.id,
      rung: this.plan.rung,
      step: this.plan.step,
      rungLabel: this.plan.label,
      workMs: this.ladder.workMs,
      fps: this.fps,
      pixelRatio: this.appliedPixelRatio,
      drawCalls: this.lastDrawCalls,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop()
    this.io?.disconnect()
    this.ro?.disconnect()
    if (this.sourceOwned) this.source.detach?.()
    for (const card of [...this.cards.values()]) this.unregister(card)
    for (const m of this.materials.values()) m.dispose()
    this.materials.clear()
    for (const t of this.textures.values()) t.texture?.dispose()
    this.textures.clear()
    this.geometry.dispose()
    if (this.ownsRenderer) {
      this.renderer.dispose()
      this.renderer.domElement.remove()
    }
  }
}

// ── the default stage ──────────────────────────────────────────────────────
//
// A host that never asks for a stage still gets exactly one. This is what lets
// `CardViewer` keep its old public shape while quietly becoming a thin host:
// the first viewer on the page creates the stage, the three hundredth joins it.

let defaultStage: FoilStage | null = null

export function getDefaultStage(options?: StageOptions): FoilStage {
  defaultStage ??= new FoilStage(options)
  return defaultStage
}

export function setDefaultStage(stage: FoilStage | null): void {
  defaultStage = stage
}

export function disposeDefaultStage(): void {
  defaultStage?.dispose()
  defaultStage = null
}
