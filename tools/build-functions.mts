// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// tools/build-functions.mts — the whole Vercel deployment, built here.
//
// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
//
// The first production deploy answered `500 FUNCTION_INVOCATION_FAILED` on
// every function. Not a handled error — a boot crash, before any handler code
// ran. Two independent causes, both in packaging rather than in the code:
//
//   1. `@vercel/node` transpiles each `.ts` file IN PLACE to `.js` and does not
//      rewrite import specifiers. `functions/image.ts` says `from './_lib/http.ts'`;
//      the emitted `api/image.js` still says `'./_lib/http.ts'`; the file on
//      disk is `_lib/http.js`. ERR_MODULE_NOT_FOUND, every function, always.
//
//      That is not a typo to fix, because the extension is load-bearing in the
//      other direction: Node's native TypeScript support is STRIP-ONLY, so a
//      relative import from a `.ts` file MUST end in `.ts` or it does not
//      resolve. Measured, all three forms, on Node 24: `./dep.ts` works,
//      `./dep.js` does not, `./dep` does not. `pnpm test` runs the api tests
//      through exactly that loader. So the source cannot use `.js` and the
//      Vercel builder cannot use `.ts`.
//
//   2. Workspace packages did not resolve either. nft traced `@foilkit/forge`
//      and copied `packages/forge/dist` INTO the function bundle, but emitted
//      no `node_modules` and no symlink, so nothing maps the bare specifier to
//      the files sitting right there. `mask`, `canon` and `window` would each
//      have boot-crashed the moment they were first hit — the report only named
//      `image` because `image` was the first one exercised.
//
// One change answers both, and removes the category rather than the instances:
// **bundle each function into a single self-contained file.** A bundle has no
// unresolved specifiers left to get wrong. `import.meta.url` walks, `node:`
// builtins and dynamic `process.env` reads all still work; nothing else is
// asked of the runtime.
//
// ── WHY THE BUILD OUTPUT API ──────────────────────────────────────────────
//
// Emitting `.vercel/output/` ourselves means Vercel uses it VERBATIM and does
// no framework detection and no function building of its own. That is the
// point: the artifact deployed is the artifact verified here, byte for byte —
// `tools/verify-functions.mts` boots every `.func` in this directory with an
// empty environment before anything is pushed. The previous failure was
// invisible locally precisely because `vercel build` "succeeded" while emitting
// something that could not start.
//
// CONSEQUENCE, and it is a trap worth naming: `vercel.json`'s `rewrites`,
// `headers`, `functions` and `outputDirectory` are IGNORED once this directory
// exists. The routing table below is the live one. `vercel.json` is reduced to
// the build and install commands for exactly that reason.

import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const API_DIR = join(ROOT, 'functions')
const STATIC_SRC = join(ROOT, 'apps', 'editor', 'dist')
const OUT = join(ROOT, '.vercel', 'output')

/**
 * Node 22, not 24, and deliberately.
 *
 * The root `package.json` declares `engines: { node: ">=22" }`, and Vercel
 * honours the floor of that range over the project setting — it said so in the
 * build log. Pinning the same number here means the runtime the bundle targets
 * and the runtime it lands on cannot disagree.
 */
const RUNTIME = 'nodejs22.x'
const TARGET = 'node22'

/**
 * One route per `.ts` file under `functions/`, minus `_`-prefixed paths and
 * tests. The sources live at `functions/` rather than `api/` DELIBERATELY: a
 * root-level `api/` is Vercel zero-config's trigger, and with the sources there
 * BOTH builders ran — Vercel's transpiler and this bundler wrote into the same
 * `.func` directory, and which `handler` the `.vc-config.json` ended up naming
 * was a race. Moving the sources one directory over is what makes this file the
 * only thing that builds a function.
 */
function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('_') || name.startsWith('.')) continue
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) {
      routeFiles(abs, acc)
      continue
    }
    if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.d.ts')) continue
    acc.push(abs)
  }
  return acc
}

function routeNameOf(abs: string): string {
  return relative(API_DIR, abs).split(sep).join('/').replace(/\.ts$/, '')
}

async function main(): Promise<void> {
  if (!existsSync(STATIC_SRC)) {
    throw new Error(
      `no static build at ${STATIC_SRC} — run \`pnpm --filter foilkit-editor run build\` first ` +
        '(pnpm run build:vercel does both in order)',
    )
  }

  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(join(OUT, 'functions'), { recursive: true })

  // ── The static half ──────────────────────────────────────────────────────
  cpSync(STATIC_SRC, join(OUT, 'static'), { recursive: true })
  const staticFiles = countFiles(join(OUT, 'static'))

  // ── The functions ────────────────────────────────────────────────────────
  const routes = routeFiles(API_DIR)
  if (routes.length === 0) throw new Error('no api routes found — that cannot be right')

  const report: { route: string; bytes: number }[] = []
  for (const entry of routes) {
    const name = routeNameOf(entry)
    const funcDir = join(OUT, 'functions', 'api', `${name}.func`)
    mkdirSync(funcDir, { recursive: true })

    await build({
      entryPoints: [entry],
      outfile: join(funcDir, 'index.js'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: TARGET,
      // `source` first so `@foilkit/*` bundle from their TypeScript rather than
      // from a `dist/` that may not have been rebuilt. One fewer ordering
      // dependency, and the bundle cannot be stale relative to the packages.
      conditions: ['source', 'node', 'import', 'default'],
      // Nothing is external. That is the entire fix: a bundle with an external
      // is a bundle with a specifier left to resolve, and resolving specifiers
      // is what the runtime could not do.
      external: [],
      sourcemap: true,
      // A crash in production should name a real line. These functions are cold
      // -start sensitive but they are kilobytes; minifying would buy nothing and
      // cost every future stack trace.
      minify: false,
      logLevel: 'warning',
      metafile: false,
      define: { 'process.env.NODE_ENV': '"production"' },
    })

    // `"type": "module"` is what makes the emitted ESM load as ESM. Without it
    // Node reads `index.js` as CommonJS and the bundle fails on its first
    // `import` — a different boot crash with the same shape as the one this
    // file exists to end.
    writeFileSync(join(funcDir, 'package.json'), JSON.stringify({ type: 'module' }) + '\n')
    writeFileSync(
      join(funcDir, '.vc-config.json'),
      JSON.stringify(
        {
          runtime: RUNTIME,
          handler: 'index.js',
          launcherType: 'Nodejs',
          // The launcher's req/res helpers — `req.body`, `req.query`. `functions/_lib/
          // http.ts` does not REQUIRE them (it falls back to parsing `req.url`
          // and reading the stream) but it uses them when present.
          shouldAddHelpers: true,
          shouldAddSourcemapSupport: true,
          memory: 1024,
          maxDuration: 30,
        },
        null,
        2,
      ) + '\n',
    )
    report.push({ route: `/api/${name}`, bytes: statSync(join(funcDir, 'index.js')).size })
  }

  // ── The routing table ────────────────────────────────────────────────────
  //
  // This replaces `vercel.json`'s `rewrites` and `headers`, which the Build
  // Output API ignores. Phases, in order: `headers` routes with `continue`,
  // then the filesystem (which is where a `.func` becomes a live endpoint and
  // where every baked artifact is served), then the SPA fallback.
  const config = {
    version: 3,
    routes: [
      // Immutable: content-hashed bundle assets.
      {
        src: '^/assets/(.*)$',
        headers: { 'cache-control': 'public, max-age=31536000, immutable' },
        continue: true,
      },
      // The corpus can change under a direct write, so it revalidates. Short
      // rather than immutable: a contributor who saves a mask must see it.
      {
        src: '^/foil-(masks|canon|windows|glyphs)/(.*)$',
        headers: { 'cache-control': 'public, max-age=300, must-revalidate' },
        continue: true,
      },
      {
        src: '^/(catalog|search)/(.*)$',
        headers: { 'cache-control': 'public, max-age=600, must-revalidate' },
        continue: true,
      },
      {
        src: '^/(corpus-manifest|foil-verification-map|foil-pattern-cards|bake-receipt|foil-glyphs)\\.json$',
        headers: { 'cache-control': 'public, max-age=300, must-revalidate' },
        continue: true,
      },
      {
        src: '^/(.*)$',
        headers: {
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'strict-origin-when-cross-origin',
          'x-frame-options': 'DENY',
        },
        continue: true,
      },
      // `/foil-glyphs` is a DIRECTORY in static, so the filesystem cannot answer
      // it; the index that `@foilkit/three` polls is the sibling `.json`. Without
      // this the poller parses index.html as its glyph index.
      { src: '^/foil-glyphs/?$', dest: '/foil-glyphs.json' },

      { handle: 'filesystem' },

      // Past the filesystem, an unmatched /api path is a missing endpoint —
      // answer 404 rather than handing back the SPA, which would make a typo in
      // a fetch look like a JSON parse error.
      { src: '^/api/(.*)$', status: 404, dest: '/404-api' },
      // Everything else is a client route.
      { src: '^/(.*)$', dest: '/index.html' },
    ],
  }
  writeFileSync(join(OUT, 'config.json'), JSON.stringify(config, null, 2) + '\n')

  console.log(`build-functions: ${OUT}`)
  console.log(`  static:    ${staticFiles} file(s) from apps/editor/dist`)
  console.log(`  functions: ${report.length}`)
  for (const r of report) console.log(`    ${r.route.padEnd(24)} ${(r.bytes / 1024).toFixed(1)} KB`)
  console.log(`  runtime:   ${RUNTIME} (bundled; no unresolved specifiers)`)
}

function countFiles(dir: string): number {
  let n = 0
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    n += statSync(abs).isDirectory() ? countFiles(abs) : 1
  }
  return n
}

await main()
