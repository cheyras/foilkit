// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Compare two harness runs, pattern by pattern.
//
//   node tools/parity/compare.mjs <dirA> <dirB> [--out receipt.json]
//
// Reports, per pattern: whether the PNGs are byte-identical, and if not, the
// mean and max absolute error per channel over the card rect. Byte identity is
// the bar for a MOVE — the same code rendering the same uniforms through the
// same three.js on the same rasterizer has no licence to differ by a bit.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { decodePng } from '../rectifier/png.ts'

const [dirA, dirB] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (!dirA || !dirB) {
  console.error('usage: node tools/parity/compare.mjs <dirA> <dirB> [--out receipt.json]')
  process.exit(2)
}
const outIdx = process.argv.indexOf('--out')
const OUT = outIdx >= 0 ? process.argv[outIdx + 1] : null

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const ids = readdirSync(dirA)
  .filter((f) => f.endsWith('.png'))
  .map((f) => f.slice(0, -4))
  .sort()

const rows = []
for (const id of ids) {
  const a = path.join(dirA, `${id}.png`)
  const b = path.join(dirB, `${id}.png`)
  if (!existsSync(b)) {
    rows.push({ id, status: 'missing-in-b' })
    continue
  }
  const shaA = sha(a)
  const shaB = sha(b)
  if (shaA === shaB) {
    rows.push({ id, status: 'identical', sha256: shaA })
    continue
  }
  const ia = decodePng(readFileSync(a))
  const ib = decodePng(readFileSync(b))
  if (ia.width !== ib.width || ia.height !== ib.height) {
    rows.push({ id, status: 'size-differs', a: [ia.width, ia.height], b: [ib.width, ib.height] })
    continue
  }
  let sum = 0
  let max = 0
  let diff = 0
  for (let i = 0; i < ia.data.length; i++) {
    const d = Math.abs(ia.data[i] - ib.data[i])
    if (d) diff++
    sum += d
    if (d > max) max = d
  }
  rows.push({
    id,
    status: 'differs',
    meanAbsError: sum / ia.data.length,
    maxAbsError: max,
    channelsDiffering: diff,
    pixels: ia.width * ia.height,
  })
}

const identical = rows.filter((r) => r.status === 'identical').length
const summary = {
  a: path.resolve(dirA),
  b: path.resolve(dirB),
  patterns: rows.length,
  identical,
  differing: rows.length - identical,
  rows,
}
for (const r of rows) {
  const tag =
    r.status === 'identical'
      ? `IDENTICAL  ${r.sha256.slice(0, 16)}`
      : r.status === 'differs'
        ? `DIFFERS    mean AE ${r.meanAbsError.toFixed(6)}  max ${r.maxAbsError}  channels ${r.channelsDiffering}`
        : r.status.toUpperCase()
  console.log(`${r.id.padEnd(26)} ${tag}`)
}
console.log(`\n${identical}/${rows.length} byte-identical`)
if (OUT) writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`)
process.exit(identical === rows.length ? 0 : 1)
