// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The hosted editor's build. Two things here are load-bearing:
//
//  1. `resolve.conditions` puts `source` first, so `@foilkit/*` resolve to
//     their TypeScript sources rather than `dist/`. The editor then cannot
//     drift from a stale build of the packages it is the front end for, and a
//     contributor gets `pnpm dev` with no build step — the same property
//     `node --conditions source --test` gives the package tests.
//
//  2. `bakeData()` serves the baked artifacts in dev from wherever they
//     actually live (`data/`, or `data/fixture-bake` under FOILKIT_BAKE=fixture)
//     at the SAME urls the CDN serves them from in production. The alternative —
//     copying them into `public/` — would mean the dev server reads a stale
//     copy of files the build regenerates, which is exactly the class of bug
//     "a stale bake must be visible" exists to prevent.

import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { defineConfig, type Plugin, type ViteDevServer } from 'vite'
// @ts-expect-error -- plain .mjs, shared with copy-data.mjs so the dev server
// and the build cannot disagree about what the glyph slot contains.
import { buildGlyphIndex } from './glyph-index.mjs'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const ROOT = resolve(import.meta.dirname, '..', '..')

/**
 * Where the baked artifacts are read from. `fixture` points the whole editor
 * at the synthetic bake so every screen is exercisable before the real bake
 * (which needs a database the editor's author does not have) exists.
 */
export const BAKE_DIR =
  process.env.FOILKIT_BAKE === 'fixture' ? join(ROOT, 'data', 'fixture-bake') : join(ROOT, 'data')

/** The artifact urls, and the file each one is served from. See docs/HOSTED-EDITOR.md. */
export const DATA_ROUTES: { prefix: string; dir: string }[] = [
  { prefix: '/catalog/', dir: 'catalog' },
  { prefix: '/search/', dir: 'search' },
  // The corpus itself — masks, canon, window geometry. These are COMMITTED,
  // not baked, so they are always present and always served from `data/` even
  // under FOILKIT_BAKE=fixture: a fixture catalog with the real corpus is the
  // combination that makes provenance testable without a database.
  { prefix: '/foil-masks/', dir: 'foil-masks' },
  { prefix: '/foil-canon/', dir: 'foil-canon' },
  { prefix: '/foil-windows/', dir: 'foil-windows' },
]

/** The glyph drop directory, served at the route `@foilkit/three` polls. */
export const GLYPHS_DIR = join(ROOT, 'assets', 'glyphs')

/** Directories that live in `data/` regardless of which bake is selected. */
export const CORPUS_DIRS = new Set(['foil-masks', 'foil-canon', 'foil-windows'])
export const DATA_FILES: Record<string, string> = {
  '/foil-verification-map.json': 'foil-verification-map.json',
  '/foil-pattern-cards.json': 'foil-pattern-cards.json',
}
/**
 * Built on every build from the corpus itself rather than baked from a
 * database, so it always comes from `data/` — a fixture catalog with the REAL
 * corpus is the combination that makes provenance testable without Postgres.
 */
export const CORPUS_FILES: Record<string, string> = {
  '/corpus-manifest.json': 'corpus-manifest.json',
}

const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

function bakeData(): Plugin {
  return {
    name: 'foilkit-bake-data',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0] ?? ''
        // The glyph slot. `/foil-glyphs` is the index; `/foil-glyphs/<slug>/<file>`
        // is an asset. Empty today, and answering with an empty index rather
        // than a 404 is the honest difference between "no surface" and
        // "nothing dropped in yet".
        if (url === '/foil-glyphs' || url === '/foil-glyphs/') {
          res.setHeader('content-type', MIME['.json']!)
          res.end(JSON.stringify(buildGlyphIndex(GLYPHS_DIR)))
          return
        }
        if (url.startsWith('/foil-glyphs/')) {
          const abs = normalize(join(GLYPHS_DIR, decodeURIComponent(url.slice('/foil-glyphs/'.length))))
          if (!abs.startsWith(normalize(GLYPHS_DIR)) || !existsSync(abs) || !statSync(abs).isFile()) {
            res.statusCode = 404
            res.end('no such glyph asset')
            return
          }
          res.setHeader('content-type', MIME[extname(abs)] ?? 'application/octet-stream')
          createReadStream(abs).pipe(res)
          return
        }

        let rel: string | null = DATA_FILES[url] ?? null
        let root = BAKE_DIR
        if (rel === null && CORPUS_FILES[url] !== undefined) {
          rel = CORPUS_FILES[url]
          root = join(ROOT, 'data')
        }
        if (rel === null) {
          const route = DATA_ROUTES.find((r) => url.startsWith(r.prefix))
          if (route) {
            rel = join(route.dir, decodeURIComponent(url.slice(route.prefix.length)))
            if (CORPUS_DIRS.has(route.dir)) root = join(ROOT, 'data')
          }
        }
        if (rel === null) return next()
        // Path containment: the url decides a file name, so it is untrusted.
        const abs = normalize(join(root, rel))
        if (!abs.startsWith(normalize(root))) {
          res.statusCode = 400
          res.end('bad path')
          return
        }
        if (!existsSync(abs) || !statSync(abs).isFile()) {
          // 404 is the honest answer and the editor already reads it as
          // "this artifact has not been baked", which is what it means.
          res.statusCode = 404
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: { code: 'not_baked', artifact: rel } }))
          return
        }
        res.setHeader('content-type', MIME[extname(abs)] ?? 'application/octet-stream')
        createReadStream(abs).pipe(res)
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), bakeData()],
  resolve: {
    conditions: ['source', 'browser', 'module', 'import', 'default'],
  },
  server: {
    port: 5173,
    // The functions in `functions/` are not run by vite. `pnpm dev` therefore sees a
    // 404 from /api/*, which the editor already treats as "feature
    // unavailable" — the same state the read path shipped in. `vercel dev`
    // runs them for real.
    fs: { allow: [ROOT] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // A source map is what makes a stack trace from an iPad readable at all,
    // and this bundle is not shipped to anyone's bandwidth budget in anger.
    sourcemap: true,
  },
})
