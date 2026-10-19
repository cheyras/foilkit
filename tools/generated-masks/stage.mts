// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// tools/generated-masks/stage.mts — take one generator run's output, check every
// raster, content-address it, and merge its rows into data/generated-masks/sets/.
//
//   node --conditions source tools/generated-masks/stage.mts --in <runDir> [--objects <dir>] [--check]
//
// <runDir> holds:
//   run.json    { runId, name, version, modelId, params, generatedAt }
//   rows.json   [{ cardId, variantId, layer: 'foil'|'etch', scope, file, confidence }]
//   the PNGs named by `file`, relative to <runDir>
//
// --objects   where to copy the content-addressed bytes for upload.mts
//             (default <runDir>/objects). Never inside the repository.
// --check     validate every committed shard and write nothing (CI).
//
// A row for a (cardId, variantId, layer) that already exists is REPLACED: these
// are guesses and a newer run may rewrite any of them (F4 protects decisions,
// and no decision lives here). A row whose printing has a human record in
// data/foil-masks/ is still staged, because the editor needs to show what the
// generator thought, but it never renders over the human record.

import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng } from '@foilkit/forge'
import {
  INDEX_VERSION, LAYERS, SCOPES, SHARD_DOC, objectPath, serializeShard, setIdOf, sha256, validateShard,
  type GeneratedRun, type IndexRow, type IndexShard, type Layer, type Scope,
} from './index.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SETS = path.join(ROOT, 'data/generated-masks/sets')
const argv = process.argv.slice(2)
const arg = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 ? argv[i + 1] : undefined
}

async function loadShard(setId: string): Promise<IndexShard> {
  const f = path.join(SETS, `${setId}.json`)
  if (!existsSync(f)) return { $doc: SHARD_DOC, version: INDEX_VERSION, setId, runs: {}, rows: [] }
  return JSON.parse(await readFile(f, 'utf8')) as IndexShard
}

async function check(): Promise<number> {
  if (!existsSync(SETS)) return 0
  let bad = 0
  for (const f of (await readdir(SETS)).filter((x) => x.endsWith('.json')).sort()) {
    const setId = f.slice(0, -5)
    const text = await readFile(path.join(SETS, f), 'utf8')
    const shard = JSON.parse(text) as IndexShard
    const problems = validateShard(shard, setId)
    if (serializeShard(shard) !== text) problems.push('not in canonical serialization (re-run stage.mts)')
    for (const p of problems) console.error(`${f}: ${p}`)
    bad += problems.length
  }
  console.log(bad === 0 ? 'generated-masks: all shards valid' : `generated-masks: ${bad} problem(s)`)
  return bad === 0 ? 0 : 1
}

async function stage(runDir: string): Promise<void> {
  const run = JSON.parse(await readFile(path.join(runDir, 'run.json'), 'utf8')) as GeneratedRun & { runId: string }
  const rows = JSON.parse(await readFile(path.join(runDir, 'rows.json'), 'utf8')) as {
    cardId: string; variantId: number; layer: Layer; scope: Scope; file: string; confidence: number | null
  }[]
  const objects = path.resolve(arg('objects') ?? path.join(runDir, 'objects'))
  if (objects.startsWith(ROOT + path.sep)) throw new Error('--objects must be outside the repository')
  if (JSON.stringify(run.params ?? {}).length > 2048) throw new Error('run.params is over 2 KB; keep reports out of the index')
  const { runId, ...identity } = run
  const shards = new Map<string, IndexShard>()
  let n = 0
  for (const r of rows) {
    if (!(r.layer in LAYERS)) throw new Error(`${r.cardId}: unknown layer ${r.layer}`)
    if (!SCOPES.includes(r.scope)) throw new Error(`${r.cardId}: unknown scope ${r.scope}`)
    const bytes = await readFile(path.join(runDir, r.file))
    const img = decodePng(bytes)
    const want = LAYERS[r.layer]
    if (img.width !== want.width || img.height !== want.height) {
      throw new Error(`${r.file}: ${img.width}x${img.height}, ${r.layer} must be ${want.width}x${want.height}`)
    }
    const hash = sha256(bytes)
    const dest = path.join(objects, objectPath(r.layer, hash))
    await mkdir(path.dirname(dest), { recursive: true })
    if (!existsSync(dest)) await copyFile(path.join(runDir, r.file), dest)
    const setId = setIdOf(r.cardId)
    const shard = shards.get(setId) ?? (await loadShard(setId))
    shards.set(setId, shard)
    shard.runs[runId] = identity
    shard.rows = shard.rows.filter((x) => !(x[0] === r.cardId && x[1] === r.variantId && x[2] === r.layer))
    const row: IndexRow = [r.cardId, r.variantId, r.layer, r.scope, hash, bytes.length, runId, r.confidence]
    shard.rows.push(row)
    n++
  }
  await mkdir(SETS, { recursive: true })
  for (const [setId, shard] of shards) {
    // drop runs no row points at any more, so a shard never accumulates dead identities
    const used = new Set(shard.rows.map((r) => r[6]))
    shard.runs = Object.fromEntries(Object.entries(shard.runs).filter(([k]) => used.has(k)))
    const problems = validateShard({ ...shard, rows: JSON.parse(serializeShard(shard)).rows }, setId)
    if (problems.length) throw new Error(`${setId}: ${problems.join('; ')}`)
    await writeFile(path.join(SETS, `${setId}.json`), serializeShard(shard))
  }
  console.log(`staged ${n} rows into ${shards.size} set file(s); objects in ${objects}`)
}

if (argv.includes('--check')) process.exit(await check())
const runDir = arg('in')
if (!runDir) {
  console.error('usage: stage.mts --in <runDir> [--objects <dir>] | --check')
  process.exit(2)
}
await stage(path.resolve(runDir))
