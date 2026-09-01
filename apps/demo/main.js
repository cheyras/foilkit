// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The stress demo — several hundred cards, one context.
//
// This page is simultaneously the test, the benchmark, and the reason someone
// adopts the library. It is the proof that "more optimized" was an
// architecture problem: the workbench viewer built a WebGLRenderer per card,
// and browsers cap contexts somewhere between ~8 and 16 before silently losing
// the oldest one, so a grid was never possible at all. Here, three hundred
// cards cost one context, one program per distinct pattern, and one upload per
// distinct face.
//
// NO CARD IMAGERY IS COMMITTED OR FETCHED. The faces are drawn here, in a
// canvas, from arithmetic — the standing ownership rule applies to a demo
// exactly as it applies to the dataset. What is real is everything that
// matters to the claim: the shipped recipes, their canon snapshots from
// `data/foil-canon`, the shipped composite, and the shipped stage.
//
// Everything the acceptance test needs is on `window.foilkitDemo`.

// ── context instrumentation ────────────────────────────────────────────────
// Installed BEFORE anything constructs a renderer. The count is the headline
// assertion of this whole subtask, so the page measures it itself rather than
// trusting the library to report on its own behaviour.
const contexts = { created: 0, lost: 0, restored: 0, kinds: [] }
const realGetContext = HTMLCanvasElement.prototype.getContext
HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
  const ctx = realGetContext.call(this, type, ...rest)
  if (ctx && /webgl/i.test(String(type))) {
    contexts.created += 1
    contexts.kinds.push(String(type))
    this.addEventListener('webglcontextlost', () => (contexts.lost += 1))
    this.addEventListener('webglcontextrestored', () => (contexts.restored += 1))
  }
  return ctx
}

import * as THREE from 'three'
import { CARD_ASPECT, GLOBAL_DEFAULTS } from '@foilkit/core'
import { PATTERNS, patternById } from '@foilkit/patterns'
import { FoilStage, rasterizeSvgMask } from '@foilkit/three'

const q = new URLSearchParams(location.search)
const num = (k, d) => {
  const v = Number(q.get(k))
  return Number.isFinite(v) && v > 0 ? v : d
}

const N = num('n', 300)
const FACE_COUNT = num('faces', 6)
const PATTERN_COUNT = num('patterns', 6)
const TILE_W = num('tile', 176)
const GAP = 16
const OVERSCAN = 3
const FOOT_H = 25
const CORNER = 3 / 63 // era-layouts.cornerRadius, derived — the card's own radius

// ── the recipes on screen ──────────────────────────────────────────────────
// Deterministic and slug-stable: the implemented recipes, sorted, spread evenly
// so the sample is a cross-section of the taxonomy rather than six neighbours.
function choosePatterns() {
  const asked = q.get('patternIds')
  if (asked) return asked.split(',').map((id) => patternById(id.trim()))
  const pool = PATTERNS.filter((p) => p.implemented).sort((a, b) => a.id.localeCompare(b.id))
  const want = Math.min(PATTERN_COUNT, pool.length)
  const out = []
  for (let i = 0; i < want; i++) out.push(pool[Math.floor((i * pool.length) / want)])
  return out
}

/** Layer 1 + layer 2 of the canon model: code seed, overlaid with the snapshot. */
function canonBaseline(pattern, canon) {
  const u = { ...GLOBAL_DEFAULTS }
  for (const [k, v] of Object.entries(pattern.defaults)) u[k] = v
  for (const p of pattern.params) u[p.key] = p.default
  if (canon) for (const [k, v] of Object.entries(canon.uniforms)) u[k] = v
  return u
}

async function loadCanon(pattern) {
  try {
    const res = await fetch(`/data/foil-canon/${pattern.id}.json`)
    if (res.ok) return await res.json()
  } catch {
    /* no canon file for this recipe — the code defaults ARE the right baseline */
  }
  return null
}

// ── the faces ──────────────────────────────────────────────────────────────
// Procedural bases, authored here. A blank base is not a compromise for the
// stress proof: the texture budget is a function of SIZE and COUNT, and these
// are the same size and count real scans would be.

function mulberry(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeFace(seed) {
  const w = 512
  const h = Math.round(w * CARD_ASPECT)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  const rnd = mulberry(seed * 7919 + 13)
  const hue = Math.floor(rnd() * 360)

  const bg = ctx.createLinearGradient(0, 0, w, h)
  bg.addColorStop(0, `hsl(${hue} 42% 22%)`)
  bg.addColorStop(1, `hsl(${(hue + 48) % 360} 38% 12%)`)
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)

  // An "art window" at the era rect's proportions, so the art-gate uniform has
  // something structurally card-shaped to gate against.
  const ax = w * 0.075
  const ay = h * 0.098
  const aw = w * 0.85
  const ah = h * 0.375
  const art = ctx.createLinearGradient(ax, ay, ax + aw, ay + ah)
  art.addColorStop(0, `hsl(${(hue + 180) % 360} 55% 58%)`)
  art.addColorStop(1, `hsl(${(hue + 120) % 360} 48% 30%)`)
  ctx.fillStyle = art
  ctx.fillRect(ax, ay, aw, ah)
  for (let i = 0; i < 26; i++) {
    ctx.globalAlpha = 0.1 + rnd() * 0.22
    ctx.fillStyle = `hsl(${Math.floor(rnd() * 360)} 65% ${35 + rnd() * 40}%)`
    ctx.beginPath()
    ctx.ellipse(
      ax + rnd() * aw,
      ay + rnd() * ah,
      12 + rnd() * 70,
      10 + rnd() * 46,
      rnd() * Math.PI,
      0,
      Math.PI * 2,
    )
    ctx.fill()
  }
  ctx.globalAlpha = 1

  // Ink below the window: a text block and a tag block, so uInkGuard and the
  // ink-pop term have real dark structure to protect.
  ctx.fillStyle = 'rgba(240,240,244,0.9)'
  for (let i = 0; i < 7; i++) {
    ctx.fillRect(w * 0.09, h * (0.53 + i * 0.037), w * (0.5 + rnd() * 0.32), h * 0.014)
  }
  ctx.fillStyle = 'rgba(18,18,22,0.85)'
  ctx.fillRect(w * 0.07, h * 0.9, w * 0.42, h * 0.05)
  return c.toDataURL('image/jpeg', 0.86)
}

// ── boot ───────────────────────────────────────────────────────────────────

// ── the mask tiers, both on screen at once ─────────────────────────────────
//
// Most cards here carry NO mask texture: the layout-rect tier is a `rectMask`
// in the shader and uploads nothing, which at grid scale is the common case
// and is why three hundred cards hold six textures rather than three hundred
// and six.
//
// Every third card carries a VECTOR mask instead — an art-window path in card
// fractions, rasterised client-side at whatever size the stage picked for that
// card's box. The geometry is resolution-independent, so mask resizing is never
// a question; and because they share one id, the whole screen's worth of them
// rasterises once per size rather than once per card.
const WINDOW_PATH =
  'M0.115,0.098 H0.885 A0.04,0.04 0 0 1 0.925,0.138 V0.433 ' +
  'A0.04,0.04 0 0 1 0.885,0.473 H0.115 A0.04,0.04 0 0 1 0.075,0.433 ' +
  'V0.138 A0.04,0.04 0 0 1 0.115,0.098 Z'
const windowMask = rasterizeSvgMask(WINDOW_PATH)
const hasVectorMask = (i) => i % 3 === 1

const grid = document.getElementById('grid')
const readout = document.getElementById('readout')

const state = {
  count: N,
  cols: 1,
  rows: 0,
  tileH: 0,
  mounted: new Map(), // cardIndex -> { el, handle }
  patterns: [],
  uniforms: [], // per pattern index
  faces: [],
  distinctPatterns: new Set(),
  distinctFaces: new Set(),
  stage: null,
  virtualize: q.get('virtualize') !== '0',
  manual: { x: 0.35, y: -0.2 },
}

const patternFor = (i) => state.patterns[i % state.patterns.length]
const faceFor = (i) => state.faces[i % state.faces.length]

/** One card's live uniform state, read by the stage every frame. */
function settingsFor(i) {
  const uniforms = state.uniforms[i % state.patterns.length]
  return () => ({
    uniforms,
    maskRect: [0, 0, 1, 1],
    maskRadius: CORNER,
    maskFeather: 0.008,
    maskInvert: false,
    maskView: false,
    maskTexOn: false,
    maskTexVersion: 0,
    maxTiltDeg: 16,
    // A synthetic blank base, not a scan: the classic composite applies.
    scanBase: false,
  })
}

function layout() {
  const inner = Math.max(240, window.innerWidth - 32)
  state.cols = Math.max(1, Math.floor((inner + GAP) / (TILE_W + GAP)))
  const gridW = state.cols * TILE_W + (state.cols - 1) * GAP
  grid.style.width = `${gridW}px`
  state.tileH = Math.round(TILE_W * CARD_ASPECT) + FOOT_H
  state.rows = Math.ceil(state.count / state.cols)
  grid.style.height = `${state.rows * (state.tileH + GAP)}px`
}

/**
 * The virtualizer. Hosts commonly have one already — the stage does not assume
 * it, and runs its own IntersectionObserver regardless. This one exists so the
 * demo is honest about what a real grid does: at 300 cards the DOM holds a few
 * dozen tiles, and registration/unregistration churns constantly. A stage that
 * leaked a context, a program or a texture per mount would show it here within
 * seconds.
 */
function syncWindow() {
  const rowH = state.tileH + GAP
  // The grid's document offset, measured rather than assumed — the controls
  // bar is fixed, the page padding is CSS, and neither is this file's business.
  const gridTop = grid.getBoundingClientRect().top + window.scrollY
  const firstVisible = Math.floor((window.scrollY - gridTop) / rowH)
  const rowsOnScreen = Math.ceil(window.innerHeight / rowH)
  const from = Math.max(0, firstVisible - OVERSCAN)
  const to = Math.min(state.rows - 1, firstVisible + rowsOnScreen + OVERSCAN)

  const wanted = new Set()
  if (!state.virtualize) {
    // The unvirtualized stress case: every card registered at once. A host is
    // not obliged to virtualize, and the context-count claim has to hold when
    // it does not — that is the number this whole subtask exists to defend.
    for (let i = 0; i < state.count; i++) wanted.add(i)
  }
  for (let r = from; r <= to && state.virtualize; r++) {
    for (let c = 0; c < state.cols; c++) {
      const i = r * state.cols + c
      if (i < state.count) wanted.add(i)
    }
  }
  for (const [i, rec] of state.mounted) {
    if (!wanted.has(i)) {
      rec.handle.unregister()
      rec.el.remove()
      state.mounted.delete(i)
    }
  }
  for (const i of wanted) {
    if (state.mounted.has(i)) continue
    mount(i)
  }
}

function mount(i) {
  const r = Math.floor(i / state.cols)
  const c = i % state.cols
  const pattern = patternFor(i)
  const face = faceFor(i)

  const tile = document.createElement('div')
  tile.className = 'tile'
  tile.style.width = `${TILE_W}px`
  tile.style.height = `${state.tileH}px`
  tile.style.transform = `translate(${c * (TILE_W + GAP)}px, ${r * (state.tileH + GAP)}px)`

  const card = document.createElement('div')
  card.className = 'card'
  card.style.height = `${state.tileH - FOOT_H}px`
  card.dataset.card = String(i)

  const chrome = document.createElement('div')
  chrome.className = 'chrome'
  chrome.textContent = `×${1 + (i % 4)}`

  const foot = document.createElement('div')
  foot.className = 'foot'
  foot.innerHTML = `<b>#${i}</b><span>${pattern.id}${hasVectorMask(i) ? ' ▣' : ''}</span>`

  card.appendChild(chrome)
  tile.appendChild(card)
  tile.appendChild(foot)
  grid.appendChild(tile)

  const handle = state.stage.register(card, {
    pattern,
    imageUrl: face,
    settings: settingsFor(i),
    ...(hasVectorMask(i)
      ? { maskVector: windowMask, maskVectorId: 'demo/art-window' }
      : {}),
  })
  state.distinctPatterns.add(pattern.id)
  state.distinctFaces.add(face)
  state.mounted.set(i, { el: tile, handle })
}

function remountAll() {
  for (const [, rec] of state.mounted) {
    rec.handle.unregister()
    rec.el.remove()
  }
  state.mounted.clear()
  layout()
  syncWindow()
}

// ── readout ────────────────────────────────────────────────────────────────

function paint() {
  const s = state.stage.stats()
  const cls = s.rung === 0 ? 'ok' : s.rung <= 2 ? 'warn' : 'bad'
  const ctxCls = contexts.created === 1 && contexts.lost === 0 ? 'ok' : 'bad'
  readout.innerHTML =
    `<span id="rung" class="${cls}">rung ${s.rung} · ${s.rungLabel}</span>\n` +
    `step        ${s.step}\n` +
    `fps         ${s.fps.toFixed(1)}\n` +
    `work        ${Number.isNaN(s.workMs) ? '—' : `${s.workMs.toFixed(2)}ms`}\n` +
    `pixelRatio  ${s.pixelRatio.toFixed(2)}\n` +
    `mode        ${s.mode}\n` +
    `tilt        ${s.tiltSource}\n` +
    `cards       ${s.cards} of ${state.count}\n` +
    `drawn       ${s.drawCalls}\n` +
    `programs    ${s.programs} / ${state.distinctPatterns.size} patterns\n` +
    `textures    ${s.textures} / ${state.distinctFaces.size} urls\n` +
    `masks       ${s.maskTextures} vector rasters\n` +
    `<span class="${ctxCls}">contexts    ${contexts.created} (lost ${contexts.lost})</span>`
  requestAnimationFrame(paint)
}

// ── controls ───────────────────────────────────────────────────────────────

function wireControls() {
  const modeSel = document.getElementById('mode')
  const sourceSel = document.getElementById('source')
  const countInput = document.getElementById('count')
  const load = document.getElementById('load')
  const loadv = document.getElementById('loadv')
  const permission = document.getElementById('permission')

  modeSel.value = q.get('mode') === 'blit' ? 'blit' : 'underlay'
  sourceSel.value = q.get('source') ?? state.stage.getTiltSource().id
  countInput.value = String(state.count)

  modeSel.addEventListener('change', () => state.stage.setMode(modeSel.value))
  sourceSel.addEventListener('change', async () => {
    state.stage.setTiltSource(sourceSel.value)
    const src = state.stage.getTiltSource()
    if (src.id === 'manual') src.set(state.manual.x, state.manual.y)
    permission.hidden = !src.requestPermission
    if (src.requestPermission) {
      // iOS 13+ only grants motion from inside a user gesture, so the button
      // stays visible until the reader presses it.
      permission.onclick = async () => {
        const res = await src.requestPermission()
        permission.hidden = res === 'granted'
      }
    }
  })
  countInput.addEventListener('change', () => {
    state.count = Math.max(1, Math.min(2000, Number(countInput.value) || 1))
    remountAll()
  })
  load.addEventListener('input', () => {
    state.stage.syntheticLoadMs = Number(load.value)
    loadv.textContent = `${load.value}ms`
  })
  document.getElementById('reset').addEventListener('click', () => {
    state.stage.setLadderStep(-1)
    state.stage.syntheticLoadMs = 0
    load.value = '0'
    loadv.textContent = '0ms'
  })
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  state.patterns = choosePatterns()
  const canons = await Promise.all(state.patterns.map(loadCanon))
  state.uniforms = state.patterns.map((p, i) => canonBaseline(p, canons[i]))
  state.faces = Array.from({ length: FACE_COUNT }, (_, i) => makeFace(i + 1))

  state.stage = new FoilStage({
    mode: q.get('mode') === 'blit' ? 'blit' : 'underlay',
    tiltSource: q.get('source') ?? 'pointer',
    // Every knob is a host knob. These are the demo's, not the library's.
    minAnimateWidth: num('minAnimateWidth', 150),
  })

  layout()
  syncWindow()
  wireControls()
  paint()

  window.addEventListener('scroll', syncWindow, { passive: true })
  window.addEventListener('resize', () => {
    layout()
    // Column count changes reposition every tile, so the window is rebuilt.
    remountAll()
  })

  // ── the acceptance surface ───────────────────────────────────────────────
  window.foilkitDemo = {
    stage: state.stage,
    contexts: () => ({ ...contexts }),
    stats: () => ({
      ...state.stage.stats(),
      requested: state.count,
      mounted: state.mounted.size,
      distinctPatterns: state.distinctPatterns.size,
      distinctFaces: state.distinctFaces.size,
      contexts: contexts.created,
      contextsLost: contexts.lost,
    }),
    setMode: (m) => {
      document.getElementById('mode').value = m
      state.stage.setMode(m)
    },
    setSource: (s) => {
      document.getElementById('source').value = s
      state.stage.setTiltSource(s)
      const src = state.stage.getTiltSource()
      if (src.id === 'manual') src.set(state.manual.x, state.manual.y)
    },
    setCount: (n) => {
      state.count = n
      document.getElementById('count').value = String(n)
      remountAll()
    },
    /** false = mount every card at once, no virtualizer. */
    setVirtualize: (on) => {
      state.virtualize = !!on
      remountAll()
    },
    setLoad: (ms) => {
      state.stage.syntheticLoadMs = ms
      document.getElementById('load').value = String(ms)
      document.getElementById('loadv').textContent = `${ms}ms`
    },
    resetLadder: () => state.stage.setLadderStep(-1),
    /** Rect of one mounted card, for a screenshot clip. */
    cardRect: (i) => {
      const rec = state.mounted.get(i ?? [...state.mounted.keys()][0])
      if (!rec) return null
      const el = rec.el.querySelector('.card')
      const r = el.getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    },
    THREE,
  }
  window.__demoReady = true
}

main().catch((err) => {
  readout.textContent = `boot failed: ${err && err.message ? err.message : String(err)}`
  window.__demoError = String(err && err.stack ? err.stack : err)
})
