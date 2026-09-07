// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// @foilkit/three — the ink-tile slot (R8-INK, 2026-09-07).
//
// The reverse-holo DESIGN layer's browser half. `@foilkit/resolver`'s
// `resolveInk` answers WHICH tile and WHERE; this turns that answer into a
// texture the shader can sample, and nothing else.
//
// It is deliberately the glyph slot's shape (glyphs.ts), because the glyph slot
// got the mechanism right and the KEY wrong. A glyph slot is per PATTERN, and
// the whole finding of this tier is that the design is not a property of the
// pattern — a dozen visually different reverses share one vertical-sheen sheet.
// So: same optional-by-construction loader, same configurable route, same "no
// asset means uInkOn 0 and the procedural fallback renders", keyed per SCOPE
// instead.
//
// A queued tile — a trademarked mark we may not trace — never reaches here at
// all: `resolveInk` returns state 'queued' with `tileId` null, and a caller that
// simply passes that through gets today's render for free. There is no code path
// in which an empty slot costs anything.
//
// SERVING. Relative by default (`/ink-tiles`), so a static host that serves the
// committed `data/ink-tiles/` directory needs no configuration. The tiles are
// COMMITTED corpus, not a drop directory the dev api reads — which is the one
// real difference from the glyph slot, and it is why this needs no index fetch
// and no polling: the registry already says which files exist, and the builder
// (tools/build-ink-index.mjs) fails the build if one does not.

import * as THREE from 'three'

let BASE = '/ink-tiles'

/** Point the ink slot at wherever this deployment serves data/ink-tiles/. */
export function configureInkSource(base: string): void {
  BASE = base.replace(/\/+$/, '')
}

/** The route currently in use — for diagnostics and tests. */
export function inkSource(): string {
  return BASE
}

/** The URL a tile id resolves to under the current route. */
export function inkTileUrl(tileId: string): string {
  return `${BASE}/${encodeURIComponent(tileId)}.svg`
}

/** The rasterised tile, plus the key that says whether it needs rebuilding. */
export interface InkTile {
  canvas: HTMLCanvasElement
  tileId: string
  key: string
}

/**
 * Cell resolution. A tile is one lattice cell drawn at whatever size the design
 * repeats at on screen — a few tens of pixels — so 256 is generous and 512
 * would only cost memory. The shader samples with LinearFilter and no mips.
 */
const CELL = 256

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

/**
 * Fetch and rasterise one tile. Returns null when it does not load — treat that
 * exactly as "no design": the caller leaves uInkOn 0 and the recipe falls back.
 * A missing tile must never be louder than that, because the whole tier's
 * contract is that an absent asset costs nothing.
 *
 * The tile is drawn to FILL the cell, not contain-fit it. That is the opposite
 * of the glyph atlas and it is deliberate: a glyph is a stamp centred in a cell
 * with bleed guard around it, while a tile's edges are load-bearing — the
 * pinstripe and crosshatch tiles are authored corner-to-corner precisely so
 * neighbouring cells join, and a 6% pad would break every seam.
 */
export async function buildInkTile(tileId: string): Promise<InkTile | null> {
  const img = await loadImage(inkTileUrl(tileId))
  if (!img) return null
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = CELL
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.clearRect(0, 0, CELL, CELL)
  ctx.drawImage(img, 0, 0, CELL, CELL)
  return { canvas, tileId, key: `${BASE}:${tileId}` }
}

/** Wrap a rasterised tile as a texture with the shader's sampling contract. */
export function inkTexture(tile: InkTile): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(tile.canvas)
  // Exactly one V flip, and it lives in the shader — the same convention the
  // hand mask and the glyph atlas already follow.
  tex.flipY = false
  // No mips: the sampler runs inside non-uniform control flow.
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  // The shader clamps each cell to [0,1] itself, so edge clamping is what keeps
  // a half-texel of the opposite edge out of a seam.
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.colorSpace = THREE.NoColorSpace
  return tex
}
