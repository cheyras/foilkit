// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// THE DATA RECEIPT: does the corpus still read?
//
//   node --conditions source tools/parity/data-receipt.mjs [--out receipt.json]
//
// Three questions, all of which have a wrong answer that a file copy could
// produce silently:
//
//   1. Do all 32 canon files load, name a real recipe, carry only uniforms the
//      contract declares, and stamp the composite contract they are read under?
//   2. Does every mask sidecar normalise through `normalizeSidecar` — the
//      version migration that infers the authoring FRAME from the raster rather
//      than trusting the field — and does its raster match its PNG's actual
//      pixels?
//   3. Is every mask PNG the canonical 504 × 704 the 4b migration moved them to?
//
// The mask half reads the PNGs, not just the JSON: a sidecar that claims a size
// its pixels deny is exactly the corruption a copy can introduce and a schema
// check cannot see.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CANONICAL_H, CANONICAL_W, GLOBAL_DEFAULTS } from '@foilkit/core'
import { PATTERNS } from '@foilkit/patterns'
import { normalizeSidecar, SIDECAR_VERSION } from '@foilkit/forge'
import { decodePng } from '../rectifier/png.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CANON_DIR = join(ROOT, 'data/foil-canon')
const MASKS_DIR = join(ROOT, 'data/foil-masks')
const WINDOWS_DIR = join(ROOT, 'data/foil-windows')
const outIdx = process.argv.indexOf('--out')
const OUT = outIdx >= 0 ? process.argv[outIdx + 1] : null

const contract = JSON.parse(readFileSync(join(ROOT, 'packages/core/src/composite-contract.json'), 'utf8')).contract
const byId = new Map(PATTERNS.map((p) => [p.id, p]))
const CORE_KEYS = new Set(Object.keys(GLOBAL_DEFAULTS))
const PARAM_KEYS = new Set(['uP0', 'uP1', 'uP2', 'uP3', 'uP4', 'uP5'])

const problems = []
const fail = (m) => problems.push(m)

// ── 1. canon ───────────────────────────────────────────────────────────────
const canonFiles = readdirSync(CANON_DIR).filter((f) => f.endsWith('.json')).sort()
let frozen = 0
let fullSnapshots = 0
for (const f of canonFiles) {
  const c = JSON.parse(readFileSync(join(CANON_DIR, f), 'utf8'))
  const pattern = byId.get(c.patternId)
  if (!pattern) fail(`${f}: patternId ${c.patternId} names no recipe`)
  if (c.contract !== contract) fail(`${f}: stamped contract ${c.contract}, current law is ${contract}`)
  if (typeof c.tunedUnderContract !== 'number') fail(`${f}: no tunedUnderContract`)
  if (c.frozen) frozen++
  const declared = new Set(pattern ? pattern.params.map((p) => p.key) : [])
  for (const k of Object.keys(c.uniforms)) {
    if (!CORE_KEYS.has(k) && !PARAM_KEYS.has(k)) fail(`${f}: ${k} is not a contract uniform`)
    if (PARAM_KEYS.has(k) && !declared.has(k)) fail(`${f}: ${k} is not declared by ${c.patternId}`)
    if (typeof c.uniforms[k] !== 'number') fail(`${f}: ${k} is not a number`)
  }
  // A FULL snapshot: every core uniform and every declared param, explicitly.
  const missing = [...CORE_KEYS, ...declared].filter((k) => !(k in c.uniforms))
  if (missing.length === 0) fullSnapshots++
  else fail(`${f}: still inherits ${missing.join(', ')} from code defaults`)
}

// ── 2 + 3. masks ───────────────────────────────────────────────────────────
const cards = readdirSync(MASKS_DIR).filter((d) => statSync(join(MASKS_DIR, d)).isDirectory()).sort()
let sidecars = 0
let normalised = 0
let pngs = 0
const frames = new Map()
const methods = new Map()
for (const cardId of cards) {
  const dir = join(MASKS_DIR, cardId)
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) continue
    if (f.endsWith('.png')) {
      pngs++
      const img = decodePng(readFileSync(p))
      if (img.width !== CANONICAL_W || img.height !== CANONICAL_H) {
        fail(`${cardId}/${f}: ${img.width}x${img.height}, not canonical ${CANONICAL_W}x${CANONICAL_H}`)
      }
      continue
    }
    if (!f.endsWith('.json')) continue
    sidecars++
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    const maskPng = join(dir, f.replace(/\.json$/, '.png'))
    const pixels = existsSync(maskPng)
      ? (() => {
          const i = decodePng(readFileSync(maskPng))
          return { width: i.width, height: i.height }
        })()
      : null
    const s = normalizeSidecar(raw, pixels)
    if (!s) {
      fail(`${cardId}/${f}: normalizeSidecar returned null`)
      continue
    }
    normalised++
    if (s.version !== SIDECAR_VERSION) fail(`${cardId}/${f}: normalised to v${s.version}, expected v${SIDECAR_VERSION}`)
    if (pixels && (s.width !== pixels.width || s.height !== pixels.height)) {
      fail(`${cardId}/${f}: sidecar says ${s.width}x${s.height}, pixels say ${pixels.width}x${pixels.height}`)
    }
    frames.set(s.frame ?? 'none', (frames.get(s.frame ?? 'none') ?? 0) + 1)
    methods.set(s.derivation_method, (methods.get(s.derivation_method) ?? 0) + 1)
  }
}

// ── windows ────────────────────────────────────────────────────────────────
let windows = 0
if (existsSync(WINDOWS_DIR)) {
  for (const d of readdirSync(WINDOWS_DIR)) {
    const dir = join(WINDOWS_DIR, d)
    if (!statSync(dir).isDirectory()) continue
    windows += readdirSync(dir).filter((f) => f.endsWith('.json')).length
  }
}

const summary = {
  contract,
  canon: { files: canonFiles.length, fullSnapshots, carryingFreezeRecord: frozen },
  masks: { cards: cards.length, sidecars, normalised, pngs, canonicalRaster: `${CANONICAL_W}x${CANONICAL_H}` },
  sidecarVersion: SIDECAR_VERSION,
  byFrame: Object.fromEntries([...frames].sort()),
  byDerivationMethod: Object.fromEntries([...methods].sort()),
  windows,
  problems,
}
console.log(JSON.stringify(summary, null, 2))
if (OUT) writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`)
process.exit(problems.length ? 1 : 0)
