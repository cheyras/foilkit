// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// tools/generated-masks/index.ts — the GENERATED-MASK INDEX: the per-set files
// that say which machine-generated foil mask and etch plate answers for each
// printing, and where its bytes live.
//
// WHY A SEPARATE STORE. A generated pass covers thousands of printings, and
// each machine record written through writeMaskRecord is four files in
// git. About 4,000 masks would be about 16,000 files, all copied into the
// editor build. The bytes therefore live in object storage, content-addressed
// (`<layer>/<sha256>.png`, immutable, so a URL never changes meaning). Git
// keeps only this index: card, variant, layer, scope, hash, size, the run that
// made it and that run's confidence. That is enough to audit a row and to
// reproduce it.
//
// WHAT IT IS NOT. It is not the mask corpus. Every row here is a GUESS
// (AGENTS.md F4): it answers only where `data/foil-masks/` has no record for
// that printing, it never becomes an exemplar (F3), and a human edit made over
// it is written through writeMaskRecord as an ordinary record that from then
// on wins. Regenerating rewrites rows here freely, and that can never touch a
// human decision because none live here.
//
// Layers:
//   foil   504 x 704, alpha = graded foil STRENGTH (R9-PLATES), RGB = display tint
//   etch   1008 x 1408 (2x canonical), red = etch height, white = etched/foil,
//          dark = line (the uEtchTex convention)

import { createHash } from 'node:crypto'

export const INDEX_VERSION = 1
export const LAYERS = { foil: { width: 504, height: 704 }, etch: { width: 1008, height: 1408 } } as const
export type Layer = keyof typeof LAYERS
export const SCOPES = ['window', 'sheet', 'full'] as const
export type Scope = (typeof SCOPES)[number]

/** One generator run: the identity every row it produced points at. */
export interface GeneratedRun {
  name: string
  version: number
  modelId: string | null
  /** Small scalars only — the 85 KB `report` string in one sidecar is the cautionary tale. */
  params: Record<string, number | string | boolean>
  generatedAt: string
}

/** [cardId, variantId, layer, scope, sha256, bytes, runId, confidence] */
export type IndexRow = [string, number, Layer, Scope, string, number, string, number | null]

export interface IndexShard {
  $doc: string
  version: number
  setId: string
  runs: Record<string, GeneratedRun>
  rows: IndexRow[]
}

export interface StoreConfig {
  bucket: string
  /** Public base URL of the bucket; null until the store is provisioned. */
  publicBase: string | null
  layout: string
}

export const SHARD_DOC =
  'Generated foil masks and etch plates for this set: GUESSES, never exemplars, answering only where data/foil-masks/ ' +
  'has no record. Bytes live in object storage at <publicBase>/<layer>/<sha256>.png (data/generated-masks/store.json). ' +
  'Row: [cardId, variantId, layer, scope, sha256, bytes, runId, confidence]. Written by tools/generated-masks/stage.mts.'

export const objectPath = (layer: Layer, sha256: string): string => `${layer}/${sha256}.png`

export const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

export const setIdOf = (cardId: string): string => cardId.slice(0, cardId.lastIndexOf('-'))

const CARD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const HEX64 = /^[0-9a-f]{64}$/

/** Structural validation; returns a list of problems (empty = valid). */
export function validateShard(s: IndexShard, setId: string): string[] {
  const out: string[] = []
  if (s.version !== INDEX_VERSION) out.push(`version ${s.version} != ${INDEX_VERSION}`)
  if (s.setId !== setId) out.push(`setId ${s.setId} != file name ${setId}`)
  const seen = new Set<string>()
  let prev = ''
  for (const r of s.rows) {
    const [cardId, variantId, layer, scope, hash, bytes, runId, conf] = r
    const where = `${cardId}/${variantId}/${layer}`
    if (!CARD_ID.test(cardId) || setIdOf(cardId) !== setId) out.push(`${where}: card id not in set ${setId}`)
    if (!Number.isInteger(variantId) || variantId < 1 || variantId > 9_999_999_999) out.push(`${where}: bad variantId`)
    if (!(layer in LAYERS)) out.push(`${where}: unknown layer`)
    if (!SCOPES.includes(scope)) out.push(`${where}: unknown scope ${scope}`)
    if (!HEX64.test(hash)) out.push(`${where}: bad sha256`)
    if (!Number.isInteger(bytes) || bytes <= 0 || bytes > 4 * 1024 * 1024) out.push(`${where}: bad size`)
    if (!(runId in s.runs)) out.push(`${where}: run ${runId} not declared`)
    if (conf !== null && !(conf >= 0 && conf <= 1)) out.push(`${where}: confidence outside 0..1`)
    if (seen.has(where)) out.push(`${where}: duplicate row`)
    seen.add(where)
    const key = rowKey(r)
    if (key < prev) out.push(`${where}: rows not sorted`)
    prev = key
  }
  return out
}

export const rowKey = (r: IndexRow): string => `${r[0]}\u0000${String(r[1]).padStart(10, '0')}\u0000${r[2]}`

/** Deterministic serialization: one row per line, so a regeneration diffs per printing. */
export function serializeShard(s: IndexShard): string {
  const rows = [...s.rows].sort((a, b) => (rowKey(a) < rowKey(b) ? -1 : rowKey(a) > rowKey(b) ? 1 : 0))
  const runs = Object.fromEntries(Object.keys(s.runs).sort().map((k) => [k, s.runs[k]]))
  const head = JSON.stringify({ $doc: s.$doc, version: s.version, setId: s.setId, runs }, null, 2)
  return `${head.slice(0, -2)},\n  "rows": [\n${rows.map((r) => `    ${JSON.stringify(r)}`).join(',\n')}\n  ]\n}\n`
}
