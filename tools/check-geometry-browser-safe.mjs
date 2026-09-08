// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// @foilkit/forge/geometry HAS NO NODE BUILTIN IN IT — proved, not asserted.
//
//   node tools/check-geometry-browser-safe.mjs
//
// Why this is a standing check and not a one-time note. The forge is an
// authoring stack: its barrel re-exports the PNG codec, the mask corpus and the
// generator, so `import '@foilkit/forge'` drags in node:fs, node:zlib and
// node:child_process. The editor runs in a browser and cannot have any of that,
// so the first time it needed forge geometry it HAND-PORTED the functions into
// apps/editor/src/staging/provisionalDiff.ts, with a byte-parity test alongside
// to keep the copy honest. The `./geometry` subpath exists so the pen tool does
// not become the second one — because two hand-ported copies is a fork that has
// not noticed yet, and a parity test only proves the copies agree today.
//
// Nothing enforces the boundary except vigilance, and the way it breaks is never
// a `node:fs` added to geometry.ts. It is a `node:fs` added three modules down,
// by someone with no reason to know a browser reads their code — at which point
// the subpath still typechecks, still passes `node --test`, and fails in a
// bundler, or worse, at runtime in a user's browser on a code path nobody
// exercised. So the walk is TRANSITIVE.
//
// THE DISTINCTION THAT MATTERS, and the reason this is not a grep for `node:`:
// `import type { RgbaImage } from './png.ts'` erases completely at compile time
// — png.ts is never loaded, its `node:zlib` never resolved — and both line-snap
// and edge-trace legitimately do exactly that. But under `verbatimModuleSyntax`,
// which this repository sets, `import { type RgbaImage } from './png.ts'` is a
// DIFFERENT STATEMENT: the inline modifier drops the binding and keeps the
// module load. Only a statement-level `import type` / `export type` is a
// non-edge. Treat the two as the same and the check either passes something
// that breaks in a browser, or fails something that is fine — and the second
// failure mode is the one that gets a check deleted.

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ENTRY = join(ROOT, 'packages/forge/src/geometry.ts')
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])
const rel = (p) => relative(ROOT, p).replaceAll('\\', '/')

const isBuiltin = (spec) => BUILTINS.has(spec) || spec.startsWith('node:')

// Comments first, so a `node:fs` sitting in an explanatory paragraph — this file
// is full of them — is prose rather than a violation. The `:` guard keeps a URL
// inside a string literal from swallowing the rest of its line.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * Every module specifier a file references, tagged with whether the reference
 * survives to runtime.
 *
 * The keyword is found by scanning BACKWARD from each `from` clause rather than
 * by matching a bounded window forward from `import` — a re-export list long
 * enough to run past that window would be silently dropped from the graph, and a
 * module the walk never visits is a module this check does not cover.
 */
function edgesOf(file) {
  const src = stripComments(readFileSync(file, 'utf8'))
  const edges = []

  const keywords = [...src.matchAll(/\b(import|export)\b/g)]
  for (const m of src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
    let kw = null
    for (const k of keywords) {
      if (k.index > m.index) break
      kw = k
    }
    if (!kw) continue
    const after = src.slice(kw.index + kw[1].length)
    const typeOnly = /^\s+type\b/.test(after)
    edges.push({ spec: m[1], typeOnly, how: `${kw[1]}${typeOnly ? ' type' : ''}` })
  }

  // Side-effect imports, and the two dynamic forms. A `await import('node:fs')`
  // declares nothing and would pass a declaration-only scan; it is exactly the
  // shape someone reaches for when a static import has already been forbidden.
  for (const m of src.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) {
    edges.push({ spec: m[1], typeOnly: false, how: 'import (side effect)' })
  }
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    edges.push({ spec: m[1], typeOnly: false, how: 'import()' })
  }
  for (const m of src.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    edges.push({ spec: m[1], typeOnly: false, how: 'require()' })
  }
  return edges
}

function resolveRelative(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec)
  const tries = [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')]
  for (const t of tries) if (existsSync(t) && statSync(t).isFile()) return t
  return null
}

/** A workspace package, reached through its own `source` export condition. */
function resolveWorkspace(spec) {
  const m = /^@foilkit\/([^/]+)(\/.*)?$/.exec(spec)
  if (!m) return null
  const pkgJson = join(ROOT, 'packages', m[1], 'package.json')
  if (!existsSync(pkgJson)) return null
  const exp = JSON.parse(readFileSync(pkgJson, 'utf8')).exports ?? {}
  const entry = exp[m[2] ? `.${m[2]}` : '.']
  const source = typeof entry === 'string' ? entry : entry?.source
  if (!source) return null
  const p = join(ROOT, 'packages', m[1], source)
  return existsSync(p) ? p : null
}

// ── the walk ───────────────────────────────────────────────────────────────
const seen = new Set()
const queue = [ENTRY]
const violations = []
const unresolved = []

while (queue.length) {
  const file = queue.pop()
  if (seen.has(file)) continue
  seen.add(file)

  for (const e of edgesOf(file)) {
    if (e.typeOnly) continue                         // erased; the module is never loaded
    if (isBuiltin(e.spec)) {
      violations.push(`${rel(file)}: ${e.how} of '${e.spec}'`)
      continue
    }
    const next = e.spec.startsWith('.') ? resolveRelative(file, e.spec) : resolveWorkspace(e.spec)
    if (next) {
      queue.push(next)
      continue
    }
    // A bare specifier we cannot follow is not automatically wrong, but it IS
    // an unreviewed runtime dependency of a browser bundle, which is the same
    // category of surprise this check exists for. Report it as a failure so the
    // decision to add one is made on purpose.
    unresolved.push(`${rel(file)}: ${e.how} of '${e.spec}' — cannot follow, so cannot vouch for it`)
  }
}

if (violations.length || unresolved.length) {
  console.error(
    'FAIL — @foilkit/forge/geometry is not browser-safe:\n  ' + [...violations, ...unresolved].join('\n  ') +
      '\n\nThe editor imports this subpath. A node builtin here either breaks the bundle or,\n' +
      'worse, sends the editor back to hand-porting forge functions into\n' +
      'apps/editor/src/staging/provisionalDiff.ts. Move the offending code out of the\n' +
      'geometry graph, or narrow the import to `import type` if that is all it ever was.',
  )
  process.exit(1)
}

const modules = [...seen].map(rel).sort()
console.log(`import graph: ${modules.length} modules reachable from ${rel(ENTRY)} — no node: builtin in a value import`)
for (const m of modules) console.log(`  ${m}`)

// ── and it RUNS ────────────────────────────────────────────────────────────
// The scan above reads declarations. This resolves the subpath the way the
// editor will, executes every module in the graph, and exercises the geometry —
// so an export that resolves but throws on load, or a subpath condition that is
// mis-shaped in package.json, fails here rather than in someone's dev server.
execFileSync(
  process.execPath,
  ['--conditions', 'source', '--input-type=module', '-e',
    `const g = await import('@foilkit/forge/geometry')
     const path = { start: [0, 0], prims: [
       { k: 'cubic', c1: [0, 80], c2: [80, 100], to: [100, 0] },
       { k: 'line', to: [0, 0] },
     ] }
     const poly = g.flattenPath(path, 0.05)
     if (poly.length < 8) throw new Error('the cubic did not flatten')
     const b = g.pathBounds(path)
     if (!(b.y1 < 80)) throw new Error('the bounding box is the control hull, not the curve')
     if (!g.pointInPath(path, { x: 50, y: 30 }, 0.05)) throw new Error('nonzero winding disagrees')
     if (typeof g.rasterizePolygons !== 'function' || typeof g.contourSegments !== 'function') {
       throw new Error('the shared rasteriser or the contour tracer did not come through')
     }
     console.log('runtime: the subpath loaded, flattened', poly.length, 'chords and bounded the curve at y =', b.y1.toFixed(2), '(the hull says 100)')`,
  ],
  { cwd: ROOT, stdio: 'inherit' },
)
