// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The generated-mask parent, recorded at save time.
//
// The editor can open a printing whose only answer is a row in
// data/generated-masks/ (bytes in object storage, not in git). If a human paints
// over it and saves, the honest record is "machine output, corrected by a
// human" — derivation_method `ai-corrected` with the machine mask as parent.
// Without this step the save would see no parent on disk and call itself
// `hand`, claiming more human authorship than happened (F3).
//
// So before the human write, the route writes the generated mask as an
// ordinary MACHINE record through writeMaskRecord, with the run's identity from
// the committed index. Both land in the same commit. The bytes are fetched from
// the store and must hash to the index row: the client names WHICH generated
// mask it started from (a sha256), it never supplies the pixels or the identity.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { decodePng, writeMaskRecord, type MaskPrior } from '@foilkit/forge'
import { readFileAt, type RepoRef } from './github.ts'

interface Shard {
  setId: string
  runs: Record<string, { name: string; version: number; modelId: string | null; params: Record<string, number | string | boolean>; generatedAt: string }>
  rows: [string, number, string, string, string, number, string, number | null][]
}

export class GeneratedSeedError extends Error {}

const HEX64 = /^[0-9a-f]{64}$/

/**
 * Write the generated foil mask `sha256` for (cardId, variantId) into the
 * workspace as a machine record, if — and only if — no record exists there yet.
 * Returns true when it wrote one.
 */
export async function recordGeneratedParent(opts: {
  ref: RepoRef
  masksDir: string
  cardId: string
  variantId: number
  sha256: string
  prior: MaskPrior
  fetchBytes?: (url: string) => Promise<Buffer | null>
  /** Test seam: read a repository file at `ref`. */
  readRepoFile?: (ref: RepoRef, path: string) => Promise<Buffer | null>
}): Promise<boolean> {
  const { ref, masksDir, cardId, variantId, sha256 } = opts
  if (!HEX64.test(sha256)) throw new GeneratedSeedError('derivation.generated.sha256 must be 64 hex characters')
  // A human (or earlier) record already answers: that is the parent, and the
  // generated row is irrelevant. Never write a machine record over it (F4).
  if (existsSync(join(masksDir, cardId, `${variantId}.json`))) return false

  const setId = cardId.slice(0, cardId.lastIndexOf('-'))
  const read = opts.readRepoFile ?? readFileAt
  const [shardBytes, storeBytes] = await Promise.all([
    read(ref, `data/generated-masks/sets/${setId}.json`),
    read(ref, 'data/generated-masks/store.json'),
  ])
  if (shardBytes === null || storeBytes === null) throw new GeneratedSeedError(`no generated index for ${setId}`)
  const shard = JSON.parse(shardBytes.toString('utf8')) as Shard
  const store = JSON.parse(storeBytes.toString('utf8')) as { publicBase: string | null }
  const row = shard.rows.find((r) => r[0] === cardId && r[1] === variantId && r[2] === 'foil')
  if (!row || row[4] !== sha256) throw new GeneratedSeedError('the generated mask this edit started from is not the indexed one')
  if (!store.publicBase) throw new GeneratedSeedError('the generated-mask store is not provisioned')
  const run = shard.runs[row[6]]
  if (!run) throw new GeneratedSeedError(`run ${row[6]} is not declared`)

  const url = `${store.publicBase.replace(/\/$/, '')}/foil/${sha256}.png`
  const fetchBytes = opts.fetchBytes ?? (async (u: string) => {
    const r = await fetch(u)
    return r.ok ? Buffer.from(await r.arrayBuffer()) : null
  })
  const png = await fetchBytes(url)
  if (png === null) throw new GeneratedSeedError('the generated mask could not be fetched')
  if (createHash('sha256').update(png).digest('hex') !== sha256) throw new GeneratedSeedError('the stored generated mask does not match its hash')
  const img = decodePng(png)

  await writeMaskRecord({
    masksDir,
    cardId,
    variantId: String(variantId),
    png,
    width: img.width,
    height: img.height,
    prior: { ...opts.prior, scope: row[3] as MaskPrior['scope'] },
    startedFrom: 'layout',
    machine: {
      name: run.name,
      version: run.version,
      modelId: run.modelId,
      runId: row[6],
      params: run.params,
      exemplars: [],
      confidence: row[7],
      generatedAt: run.generatedAt,
    },
  })
  return true
}
