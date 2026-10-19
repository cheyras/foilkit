// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodePng } from '@foilkit/forge'
import { buildEtchWrite } from '../etch.ts'

const png = (w: number, h: number) => {
  const rgba = new Uint8Array(w * h * 4).fill(255)
  return 'data:image/png;base64,' + encodePng({ width: w, height: h, rgba }).toString('base64')
}
const who = { login: 'someone', id: 1 }

test('an off switch is a record with no files, and deletes any stale plate', () => {
  const { record, changes } = buildEtchWrite({ cardId: 'sv06-130', variantId: 29851, enabled: false }, who)
  assert.equal(record.enabled, false)
  assert.deepEqual(record.files, { etch: null, segs: null })
  assert.deepEqual(changes.map((c) => [c.path, c.content === null]), [
    ['data/foil-etches/sv06-130/29851.json', false],
    ['data/foil-etches/sv06-130/29851.png', true],
    ['data/foil-etches/sv06-130/29851.segs.png', true],
  ])
})

test('an edited etch carries its plate, its segment map and agent-readable sections', () => {
  const { record } = buildEtchWrite({
    cardId: 'sv06-130', variantId: 29851, enabled: true,
    base: { kind: 'generated', sha256: 'a'.repeat(64) },
    sections: { A: { pattern: 'contour', angle: 135, pitch: 4.85, weight: 0.55, cx: 0.5, cy: 0.4, phase: 0, amount: 0.5, note: 'body' }, B: { pattern: 'solid', angle: 0, pitch: 4, weight: 0.5, cx: 0, cy: 0, phase: 0, amount: 0, note: 'eyes' } },
    etch: png(1008, 1408), segs: png(504, 704),
  }, who)
  assert.equal(record.files.etch, '29851.png')
  assert.equal(record.sections.A?.note, 'body')
  assert.equal(record.sections.B?.pattern, 'solid')
  assert.equal(record.base.sha256, 'a'.repeat(64))
  assert.match(record.legend['3']!, /section A/)
})

test('wrong sizes, unknown patterns and out-of-range numbers are refused', () => {
  assert.throws(() => buildEtchWrite({ cardId: 'sv06-130', variantId: 1, enabled: true, etch: png(504, 704) }, who), /1008x1408/)
  assert.throws(() => buildEtchWrite({ cardId: 'sv06-130', variantId: 1, enabled: true, sections: { A: { pattern: 'paisley' } } }, who), /unknown pattern/)
  assert.throws(() => buildEtchWrite({ cardId: 'sv06-130', variantId: 1, enabled: true, sections: { A: { pattern: 'parallel', angle: 0, pitch: 0.1, weight: 0.5, cx: 0, cy: 0, phase: 0, amount: 0 } } }, who), /pitch/)
  assert.throws(() => buildEtchWrite({ cardId: 'sv06-130', variantId: 1, enabled: 'yes' }, who), /enabled/)
})
