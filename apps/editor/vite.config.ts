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
]
export const DATA_FILES: Record<string, string> = {
  '/corpus-manifest.json': 'corpus-manifest.json',
  '/foil-verification-map.json': 'foil-verification-map.json',
  '/foil-pattern-cards.json': 'foil-pattern-cards.json',
}

const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

function bakeData(): Plugin {
  return {
    name: 'foilkit-bake-data',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0] ?? ''
        let rel: string | null = DATA_FILES[url] ?? null
        if (rel === null) {
          const route = DATA_ROUTES.find((r) => url.startsWith(r.prefix))
          if (route) rel = join(route.dir, url.slice(route.prefix.length))
        }
        if (rel === null) return next()
        // Path containment: the url decides a file name, so it is untrusted.
        const abs = normalize(join(BAKE_DIR, rel))
        if (!abs.startsWith(normalize(BAKE_DIR))) {
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
    // The functions in `api/` are not run by vite. `pnpm dev` therefore sees a
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
