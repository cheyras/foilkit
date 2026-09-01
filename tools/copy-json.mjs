// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// tsc does not emit imported .json into outDir, so a built package's `dist`
// would import a file that is not there. Copy them, preserving the tree.
//
//   node tools/copy-json.mjs [packages/core …]     (default: every package)
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const pkgs = args.length
  ? args
  : readdirSync(join(ROOT, 'packages')).map((d) => join('packages', d))

let total = 0
for (const pkg of pkgs) {
  const src = join(ROOT, pkg, 'src')
  const out = join(ROOT, pkg, 'dist')
  if (!existsSync(src) || !existsSync(out)) continue
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
  if (n) console.log(`copy-json: ${n} file(s) -> ${pkg}/dist`)
  total += n
}
console.log(`copy-json: ${total} file(s) total`)
