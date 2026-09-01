// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// tsc does not emit imported .json into outDir, so a built package's `dist`
// would import a file that is not there. Copy them, preserving the tree.
//
//   node tools/copy-json.mjs packages/core
import { cpSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const pkg = process.argv[2]
if (!pkg) { console.error('usage: node tools/copy-json.mjs <package-dir>'); process.exit(2) }
const src = join(pkg, 'src')
const out = join(pkg, 'dist')
let n = 0
;(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) { walk(p); continue }
    if (!e.endsWith('.json')) continue
    const t = join(out, relative(src, p))
    mkdirSync(dirname(t), { recursive: true })
    cpSync(p, t)
    n++
  }
})(src)
console.log(`copy-json: ${n} file(s) -> ${out}`)
