// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Copy the baked artifacts into dist/ after `vite build`, at exactly the urls
// vite.config.ts's dev middleware serves them from. One mapping, written down
// twice on purpose: the dev server streams from `data/`, and the CDN needs
// real files. If these two ever disagree the editor works in dev and 404s in
// production, so `--check` below asserts they agree.
//
// A MISSING artifact is not fatal here. The bake needs a database, and the
// build must not require one — the editor already renders "this artifact has
// not been baked" as a visible banner. What is fatal is a SILENT miss, so
// every skip is printed.

import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const HERE = import.meta.dirname
const ROOT = resolve(HERE, '..', '..')
const DIST = join(HERE, 'dist')
const BAKE_DIR = process.env.FOILKIT_BAKE === 'fixture' ? join(ROOT, 'data', 'fixture-bake') : join(ROOT, 'data')

/** Must match DATA_ROUTES / DATA_FILES in vite.config.ts. */
const DIRS = [
  ['catalog', 'catalog'],
  ['search', 'search'],
]
const FILES = [
  ['corpus-manifest.json', 'corpus-manifest.json'],
  ['foil-verification-map.json', 'foil-verification-map.json'],
  ['foil-pattern-cards.json', 'foil-pattern-cards.json'],
]

let copied = 0
let missing = 0
const report = { source: BAKE_DIR, copiedAt: new Date().toISOString(), artifacts: {} }

for (const [from, to] of DIRS) {
  const src = join(BAKE_DIR, from)
  if (!existsSync(src)) {
    console.warn(`copy-data: SKIP ${from}/ — not baked (${src})`)
    report.artifacts[from] = { present: false }
    missing++
    continue
  }
  cpSync(src, join(DIST, to), { recursive: true })
  report.artifacts[from] = { present: true }
  copied++
  console.log(`copy-data: ${from}/ -> dist/${to}/`)
}

for (const [from, to] of FILES) {
  const src = join(BAKE_DIR, from)
  if (!existsSync(src)) {
    console.warn(`copy-data: SKIP ${from} — not baked (${src})`)
    report.artifacts[from] = { present: false }
    missing++
    continue
  }
  mkdirSync(dirname(join(DIST, to)), { recursive: true })
  cpSync(src, join(DIST, to))
  report.artifacts[from] = { present: true, bytes: statSync(src).size }
  copied++
  console.log(`copy-data: ${from} -> dist/${to} (${statSync(src).size} bytes)`)
}

// The build's own receipt. The editor fetches it and shows what shipped, so
// "which bake is this site serving" is answerable from the site itself rather
// than from whoever last ran the command.
mkdirSync(DIST, { recursive: true })
writeFileSync(join(DIST, 'bake-receipt.json'), JSON.stringify(report, null, 2) + '\n')

console.log(`copy-data: ${copied} artifact(s) copied, ${missing} not baked`)
if (missing > 0) {
  console.log('copy-data: run RUN-BAKE.md, or build with FOILKIT_BAKE=fixture for the synthetic bake.')
}

// Sanity: dist/index.html must exist, or vite build did not actually run.
if (!existsSync(join(DIST, 'index.html'))) {
  console.error('copy-data: dist/index.html missing — vite build did not produce a site.')
  process.exit(1)
}
