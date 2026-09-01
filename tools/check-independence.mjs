// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// @foilkit/core DOES NOT DEPEND ON THREE.JS — proved, not asserted.
//
//   node tools/check-independence.mjs
//
// Why this is a standing check and not a one-time note. `core` emits GLSL
// strings and a uniform table; the three.js binding is sixty lines in
// @foilkit/three. Nothing enforces that except vigilance, and one convenient
// `import * as THREE` inside core is all it takes to make the future `webgl2`
// and `element` packages a rewrite instead of an addition. That is the single
// obligation the extraction carries forward for them, and it costs nothing —
// but only while it is still true.
//
// The check builds `core` (and `patterns`, which is data with no renderer in
// it either) in an isolated directory whose node_modules contains typescript
// and @types/node and NOTHING ELSE. If either package reaches for three, or
// react, or anything else, the compile fails there rather than in someone's
// bundle six months from now.

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGES = ['core', 'patterns']
const BANNED = ['three', 'react', 'react-dom']

// ── 1. the source says so ──────────────────────────────────────────────────
const hits = []
for (const pkg of PACKAGES) {
  const dir = join(ROOT, 'packages', pkg, 'src')
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      if (statSync(p).isDirectory()) {
        walk(p)
        continue
      }
      if (!/\.(ts|tsx)$/.test(e)) continue
      const src = readFileSync(p, 'utf8')
      for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]{0,200}?from\s+'([^']+)'/g)) {
        const spec = m[1]
        if (spec.startsWith('.')) continue
        if (BANNED.includes(spec) || BANNED.some((b) => spec.startsWith(`${b}/`))) {
          hits.push(`${pkg}/${e}: imports '${spec}'`)
        }
      }
    }
  }
  walk(dir)
}
if (hits.length) {
  console.error('FAIL — renderer imports found:\n  ' + hits.join('\n  '))
  process.exit(1)
}
console.log(`source scan: no ${BANNED.join('/')} import in packages/{${PACKAGES.join(',')}}`)

// ── 2. and the compiler agrees, with three ABSENT from the tree ────────────
const sandbox = join(tmpdir(), `foilkit-independence-${process.pid}`)
rmSync(sandbox, { recursive: true, force: true })
mkdirSync(join(sandbox, 'node_modules'), { recursive: true })
for (const pkg of PACKAGES) cpSync(join(ROOT, 'packages', pkg, 'src'), join(sandbox, pkg), { recursive: true })
// Exactly two things in the sandbox's module tree. No three, no @types/three.
for (const dep of ['typescript', '@types/node', 'undici-types']) {
  const from = join(ROOT, 'node_modules', dep)
  try {
    cpSync(from, join(sandbox, 'node_modules', dep), { recursive: true, dereference: true })
  } catch {
    /* optional transitive types package */
  }
}
// patterns imports its ABI types from core; in the sandbox that is a path map,
// so the two compile together with nothing else on the resolution path.
writeFileSync(
  join(sandbox, 'tsconfig.json'),
  `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2023', 'DOM'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        allowImportingTsExtensions: true,
        resolveJsonModule: true,
        verbatimModuleSyntax: true,
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: ['node'],
        baseUrl: '.',
        paths: { '@foilkit/core': ['./core/index.ts'] },
      },
      include: PACKAGES.map((p) => `${p}/**/*`),
    },
    null,
    2,
  )}\n`,
)

try {
  execFileSync(process.execPath, [join(sandbox, 'node_modules/typescript/bin/tsc'), '-p', sandbox], {
    stdio: 'inherit',
  })
  console.log(`tsc: packages/{${PACKAGES.join(',')}} typecheck clean with three.js absent from node_modules`)
} finally {
  const listed = readdirSync(join(sandbox, 'node_modules'))
  console.log(`sandbox node_modules: ${listed.join(', ')}`)
  rmSync(sandbox, { recursive: true, force: true })
}

// ── 3. and it RUNS with three unresolvable ─────────────────────────────────
// The source scan and the compile both look at declarations; this executes the
// module. A dynamic `await import('three')` would pass both and fail here.
execFileSync(process.execPath, ['--conditions', 'source', '--input-type=module', '-e',
  `import { buildFoilShader, CANONICAL_W, GLOBAL_DEFAULTS } from '@foilkit/core'
   import { PATTERNS } from '@foilkit/patterns'
   const src = buildFoilShader(PATTERNS.find((p) => p.id === 'cosmos'))
   if (CANONICAL_W !== 504) throw new Error('canonical width')
   if (!src.fragmentShader.includes('vec3 foilPattern')) throw new Error('no recipe in the fragment shader')
   if (typeof GLOBAL_DEFAULTS.uSheen !== 'number') throw new Error('no uniform table')
   console.log('runtime: core + patterns assembled a', src.fragmentShader.length, 'char shader with no renderer loaded')`,
], { cwd: ROOT, stdio: 'inherit' })
