// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// recordGeneratedParent: a human save seeded from a generated mask must derive
// as a CORRECTION of that machine mask, never as `hand` (F3), and the machine
// write must never land on an existing record (F4).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodePng, writeMaskRecord, type MaskPrior } from '@foilkit/forge'
import { GeneratedSeedError, recordGeneratedParent } from './generated.ts'

const W = 504
const H = 704
const PRIOR: MaskPrior = {
  source: 'layout', eraId: 'modern-sv', scope: 'sheet', rect: [0.1, 0.45, 0.8, 0.42],
  radius: 0.006, invert: true, feather: 0.008, resolverVersion: 5,
}
const REF = { owner: 'o', repo: 'r', branch: 'main', token: 't' }

function png(alpha: (x: number, y: number) => number): Buffer {
  const rgba = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4
    rgba[i] = 255; rgba[i + 1] = 45; rgba[i + 2] = 100; rgba[i + 3] = alpha(x, y)
  }
  return encodePng({ width: W, height: H, rgba })
}

const machine = png((x, y) => (y < H / 2 ? 200 : 0))
const hash = createHash('sha256').update(machine).digest('hex')
const shard = {
  setId: 'sv06',
  runs: { 'run-1': { name: 'modular-plates', version: 1, modelId: null, params: { gain: 0.66 }, generatedAt: '2026-10-18T00:00:00Z' } },
  rows: [['sv06-001', 42, 'foil', 'sheet', hash, machine.length, 'run-1', 0.8]],
}
const repo = (publicBase: string | null) => async (_ref: unknown, p: string) =>
  p.endsWith('sv06.json') ? Buffer.from(JSON.stringify(shard)) : p.endsWith('store.json') ? Buffer.from(JSON.stringify({ publicBase })) : null

test('a generated seed is recorded as the machine parent, and the human save derives ai-corrected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fk-gen-'))
  try {
    const wrote = await recordGeneratedParent({
      ref: REF, masksDir: dir, cardId: 'sv06-001', variantId: 42, sha256: hash, prior: PRIOR,
      readRepoFile: repo('https://store.example/foilkit-masks'),
      fetchBytes: async (u) => (u === `https://store.example/foilkit-masks/foil/${hash}.png` ? machine : null),
    })
    assert.equal(wrote, true)
    const human = await writeMaskRecord({
      masksDir: dir, cardId: 'sv06-001', variantId: '42', png: png((x, y) => (y < H / 2 + 40 ? 200 : 0)),
      width: W, height: H, prior: PRIOR, startedFrom: 'mask', parentRef: { cardId: 'sv06-001', variantId: 42 },
      author: { login: 'someone', id: 1, via: 'writer-direct' },
    })
    assert.equal(human.derivation_method, 'ai-corrected')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bytes that do not hash to the indexed row are refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fk-gen-'))
  try {
    await assert.rejects(
      recordGeneratedParent({
        ref: REF, masksDir: dir, cardId: 'sv06-001', variantId: 42, sha256: hash, prior: PRIOR,
        readRepoFile: repo('https://store.example/b'), fetchBytes: async () => png(() => 255),
      }),
      GeneratedSeedError,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unprovisioned store or an unindexed sha is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fk-gen-'))
  try {
    const base = { ref: REF, masksDir: dir, cardId: 'sv06-001', variantId: 42, prior: PRIOR, fetchBytes: async () => machine }
    await assert.rejects(recordGeneratedParent({ ...base, sha256: hash, readRepoFile: repo(null) }), GeneratedSeedError)
    await assert.rejects(recordGeneratedParent({ ...base, sha256: 'a'.repeat(64), readRepoFile: repo('https://s') }), GeneratedSeedError)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an existing record is the parent: no machine write lands on it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fk-gen-'))
  try {
    await writeMaskRecord({
      masksDir: dir, cardId: 'sv06-001', variantId: '42', png: png(() => 255), width: W, height: H,
      prior: PRIOR, startedFrom: 'layout', author: { login: 'someone', id: 1, via: 'writer-direct' },
    })
    const wrote = await recordGeneratedParent({
      ref: REF, masksDir: dir, cardId: 'sv06-001', variantId: 42, sha256: hash, prior: PRIOR,
      readRepoFile: repo('https://s'), fetchBytes: async () => machine,
    })
    assert.equal(wrote, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
