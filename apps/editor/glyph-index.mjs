// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The glyph slot, served from the hosted editor's own asset route.
//
// `@foilkit/three`'s `glyphs.ts` used to hardcode `/deckscout/api`, which meant
// nothing outside DeckPal; #5 repointed it at a relative `/foil-glyphs`. This is
// the other end of that route.
//
// THE SLOT IS EMPTY, AND THAT IS THE SHIPPING STATE. `assets/glyphs/` holds a
// README and nothing else, `uGlyphOn` stays 0 everywhere, and every slotted
// pattern renders its procedural fallback. Shipping the slot empty is how the
// work stays possible.
//
// So why serve an index at all rather than letting it 404? Because the two are
// different claims. A 404 tells the poller "this deployment has no glyph
// surface", which was true of production DeckPal and is not true here. An empty
// index says "the surface is here and nothing has been dropped into it" — which
// is the honest state, keeps the poller's contract intact, and means the day an
// original asset with its notice file lands in `assets/glyphs/<slug>/`, it is
// served with no further wiring.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

/** Image types the atlas rasterizer can load. */
const GLYPH_EXT = new Set(['.svg', '.png', '.webp'])

/**
 * Build the index `fetchGlyphIndex()` expects:
 * `{ patterns: { <slug>: { files: string[], mtime: number } } }`.
 *
 * `mtime` is the newest file in the directory, and it is what busts the
 * viewer's atlas cache on a re-drop — so it has to move when a file is
 * replaced, not only when one is added.
 */
export function buildGlyphIndex(glyphsDir) {
  const patterns = {}
  if (!existsSync(glyphsDir)) return { patterns }
  for (const slug of readdirSync(glyphsDir)) {
    const dir = join(glyphsDir, slug)
    let entries
    try {
      if (!statSync(dir).isDirectory()) continue
      entries = readdirSync(dir)
    } catch {
      continue
    }
    const files = entries.filter((f) => GLYPH_EXT.has(extname(f).toLowerCase())).sort()
    if (files.length === 0) continue
    let mtime = 0
    for (const f of files) mtime = Math.max(mtime, statSync(join(dir, f)).mtimeMs)
    patterns[slug] = { files, mtime: Math.round(mtime) }
  }
  return { patterns }
}
