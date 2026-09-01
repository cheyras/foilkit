// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// @foilkit/three — the drop-in glyph slot (R3-GLYPH, 2026-08-03).
//
// Four patterns carry a glyph slot: a place for real, ORIGINAL glyph artwork
// to replace the procedural stand-in the recipe draws today. This module turns
// files dropped into the glyph asset directory into a rasterized texture atlas
// the shader samples via the glyphTex() preamble helper (@foilkit/core). The
// whole path is optional: no assets (or no asset route) = uGlyphOn stays 0 and
// every recipe renders its procedural fallback — zero code changes when the
// files land. See assets/glyphs/README.md for the drop contract, and for the
// ORIGINALS-ONLY rule that governs what may enter it at all.
//
// THE SHIPPING STATE IS uGlyphOn 0 EVERYWHERE. That is not a defect: the slot
// exists so the work stays possible, and a traced trademark glyph cannot enter
// a CC0 dataset (AGENTS.md F2). Every slotted pattern renders its fallback.
//
// SERVING. The route is configurable rather than hardcoded — DeckPal's copy
// pointed at its own `/deckscout/api` prefix, which meant nothing outside
// DeckPal. The default is RELATIVE (`/foil-glyphs`), so a static host that
// simply serves the asset directory needs no configuration at all; anything
// else calls configureGlyphSource() once at startup.
//
// The expected shape, whatever serves it:
//   GET <base>            -> { patterns: { <slug>: { files: string[], mtime: number } } }
//   GET <base>/<slug>/<f> -> the asset bytes
//
// A host that re-reads the directory per request makes saving a file the whole
// deploy: the viewer polls the index while a glyph-capable pattern is on
// screen and re-rasterizes when `mtime` moves.

let BASE = '/foil-glyphs'

/**
 * Point the glyph slot at wherever this deployment serves its glyph assets.
 * Call once at startup; a trailing slash is trimmed. Pass '' for same-origin
 * root-relative.
 */
export function configureGlyphSource(base: string): void {
  BASE = base.replace(/\/+$/, '')
}

/** The route currently in use — for diagnostics and tests. */
export function glyphSource(): string {
  return BASE
}

/**
 * Patterns with a glyph slot. `shares` names a sibling slug whose assets are
 * used when this slug's own dir is empty (energy-symbols-ii may reuse the
 * energy-symbols atlas — Chey said "really the same thing with the other
 * energy symbols one").
 */
export const GLYPH_SLOTS: Record<string, { shares?: string }> = {
  'reverse-sheet': {},
  'energy-symbols': {},
  'energy-symbols-ii': { shares: 'energy-symbols' },
  'prismatic-pokeball': {},
}

/** The glyph-slot slug for a pattern id, or null when the pattern has none. */
export function glyphSlotFor(patternId: string): string | null {
  return patternId in GLYPH_SLOTS ? patternId : null
}

export type GlyphIndex = Record<string, { files: string[]; mtime: number }>

/** Rasterized atlas ready to become a CanvasTexture. */
export interface GlyphAtlas {
  canvas: HTMLCanvasElement
  count: number
  cols: number
  /** Which glyph asset dir answered (may be the shared dir). */
  sourceDir: string
  /** Change-detection key: dir + mtime + file list. */
  key: string
}

/**
 * Glyph asset index from the dev api, or null when the dev surface is absent
 * (prod / api down) — null tells the poller to stop for this mount.
 */
export async function fetchGlyphIndex(signal?: AbortSignal): Promise<GlyphIndex | null> {
  try {
    const res = await fetch(`${BASE}`, { signal })
    if (!res.ok) return null
    return ((await res.json()) as { patterns: GlyphIndex }).patterns
  } catch {
    return null
  }
}

/** Resolve which dir serves a slug's assets (own dir first, then `shares`). */
export function resolveGlyphDir(index: GlyphIndex, slug: string): string | null {
  if (index[slug]?.files.length) return slug
  const shared = GLYPH_SLOTS[slug]?.shares
  if (shared && index[shared]?.files.length) return shared
  return null
}

const CELL = 256 // px per atlas cell — glyphs render small on-card; 256 is generous
const PAD = 0.06 // cell fraction left empty around each glyph (bleed guard)
const MAX_GLYPHS = 16

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

/**
 * Fetch + rasterize a slug's glyph files into a square grid atlas.
 * Returns null when nothing rasterized (treat as "no assets").
 */
export async function buildGlyphAtlas(dir: string, entry: { files: string[]; mtime: number }): Promise<GlyphAtlas | null> {
  const files = entry.files.slice(0, MAX_GLYPHS)
  const images = await Promise.all(
    // mtime in the URL busts any intermediary cache on re-drop
    files.map((f) => loadImage(`${BASE}/${encodeURIComponent(dir)}/${f}?v=${entry.mtime}`)),
  )
  const ok = images.filter((i): i is HTMLImageElement => i !== null)
  if (ok.length === 0) return null

  const cols = Math.max(1, Math.ceil(Math.sqrt(ok.length)))
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = cols * CELL
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const inner = CELL * (1 - 2 * PAD)
  ok.forEach((img, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    // contain-fit, centered; SVGs without intrinsic size draw at cell size
    const w = img.naturalWidth || inner
    const h = img.naturalHeight || inner
    const s = Math.min(inner / w, inner / h)
    const dw = w * s
    const dh = h * s
    ctx.drawImage(img, col * CELL + (CELL - dw) / 2, row * CELL + (CELL - dh) / 2, dw, dh)
  })

  return {
    canvas,
    count: ok.length,
    cols,
    sourceDir: dir,
    key: `${dir}:${entry.mtime}:${files.join(',')}`,
  }
}
