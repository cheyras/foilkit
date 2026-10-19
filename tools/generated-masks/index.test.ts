// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INDEX_VERSION, SHARD_DOC, serializeShard, validateShard, type IndexShard } from './index.ts'

const H = 'a'.repeat(64)
const shard = (rows: IndexShard['rows']): IndexShard => ({
  $doc: SHARD_DOC, version: INDEX_VERSION, setId: 'sv06',
  runs: { r1: { name: 'g', version: 1, modelId: null, params: {}, generatedAt: '2026-10-18T00:00:00Z' } },
  rows,
})

test('a well-formed shard validates and round-trips byte-for-byte', () => {
  const s = shard([['sv06-001', 7, 'foil', 'sheet', H, 100, 'r1', 0.5], ['sv06-001', 7, 'etch', 'sheet', H, 100, 'r1', null]])
  const text = serializeShard(s)
  const back = JSON.parse(text) as IndexShard
  assert.deepEqual(validateShard(back, 'sv06'), [])
  assert.equal(serializeShard(back), text)
  // one row per line, so a regeneration diffs per printing
  assert.equal(text.split('\n').filter((l) => l.trim().startsWith('["sv06-')).length, 2)
})

test('rows from another set, unknown layers, undeclared runs and duplicates are all reported', () => {
  const s = shard([
    ['sv05-001', 7, 'foil', 'sheet', H, 100, 'r1', 0.5],
    ['sv06-002', 7, 'paint' as never, 'sheet', H, 100, 'r1', 0.5],
    ['sv06-003', 7, 'foil', 'sheet', H, 100, 'nope', 0.5],
    ['sv06-004', 7, 'foil', 'sheet', H, 100, 'r1', 2],
    ['sv06-004', 7, 'foil', 'sheet', H, 100, 'r1', 0.5],
  ])
  const p = validateShard(s, 'sv06').join('\n')
  for (const want of ['not in set sv06', 'unknown layer', 'run nope not declared', 'confidence outside 0..1', 'duplicate row']) {
    assert.match(p, new RegExp(want))
  }
})
