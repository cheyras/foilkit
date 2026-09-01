// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// tools/verify-functions.mts — boot and exercise the ACTUAL deploy artifact.
//
// This exists because the first production deploy failed in a way no test could
// see. `vercel build` reported "Build completed successfully" while emitting
// functions that could not start: the code was correct, the packaging was not,
// and every unit test in the repository passed the whole time. A green suite
// over source that is never assembled the way it ships is a green suite that
// tells you nothing about shipping.
//
// So this runs against `.vercel/output/functions/**/*.func/index.js` — the exact
// bytes that get uploaded — and asserts two things about each one:
//
//   1. IT BOOTS. With an EMPTY environment. A boot crash is the failure mode
//      that produced `FUNCTION_INVOCATION_FAILED` on every route, and it is
//      invisible to anything that imports the TypeScript source instead.
//
//   2. IT DEGRADES HONESTLY. A deployment part-way through configuration — which
//      is the normal state, because secrets are added by a human over time — must
//      answer a NAMED 503 on the routes it cannot serve, keep serving the ones it
//      can, and never 500. `/api/image` must work with no environment at all,
//      because card scans are what a visitor sees before they have any reason to
//      sign in.
//
//   node --conditions source tools/verify-functions.mts [--no-network]
//
// `--no-network` skips the one real upstream fetch (CI without egress).

import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FUNCS = join(ROOT, '.vercel', 'output', 'functions')
const NO_NETWORK = process.argv.includes('--no-network')

let passed = 0
const failures: string[] = []
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── A minimal stand-in for the Vercel launcher's req/res pair ──────────────
interface Captured {
  status: number
  headers: Record<string, string | string[]>
  body: string
  json: unknown
}

function makeRes(): { res: Record<string, unknown>; done: Promise<Captured> } {
  let settle: (c: Captured) => void
  const done = new Promise<Captured>((r) => (settle = r))
  const headers: Record<string, string | string[]> = {}
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string | number | readonly string[]) {
      headers[name.toLowerCase()] = Array.isArray(value) ? [...value] : String(value)
      return res
    },
    end(chunk?: string | Uint8Array) {
      const body = chunk === undefined ? '' : typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('binary')
      let json: unknown = null
      try {
        json = JSON.parse(body)
      } catch {
        /* not JSON; several of these answer bytes */
      }
      settle({ status: (res as { statusCode: number }).statusCode, headers, body, json })
      return res
    },
  }
  return { res, done }
}

async function call(
  handler: (req: unknown, res: unknown) => unknown,
  req: { method: string; url: string; headers?: Record<string, string>; body?: unknown },
): Promise<Captured> {
  const { res, done } = makeRes()
  await Promise.resolve(
    handler({ method: req.method, url: req.url, headers: req.headers ?? {}, body: req.body }, res),
  ).catch((err) => {
    const { res: r2, done: d2 } = makeRes()
    void r2
    void d2
    throw err
  })
  return done
}

/** Every route in the built output, as `<name>` → absolute `index.js`. */
function builtRoutes(dir: string, acc: Record<string, string> = {}, base = dir): Record<string, string> {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (!statSync(abs).isDirectory()) continue
    if (name.endsWith('.func')) {
      const route = '/' + relative(base, abs).split(sep).join('/').replace(/\.func$/, '')
      acc[route] = join(abs, 'index.js')
      continue
    }
    builtRoutes(abs, acc, base)
  }
  return acc
}

/** Load a built function fresh, under a specific environment. */
async function load(file: string, env: Record<string, string | undefined>): Promise<(req: unknown, res: unknown) => unknown> {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  // A cache-busting query so each environment gets a fresh module: several of
  // these read env at module scope, and a cached copy would test the last one.
  const mod = (await import(`${pathToFileURL(file).href}?v=${Math.random()}`)) as { default: (req: unknown, res: unknown) => unknown }
  return mod.default
}

const CLEAN_ENV = {
  FOILKIT_SESSION_SECRET: undefined,
  FOILKIT_OAUTH_CLIENT_ID: undefined,
  FOILKIT_OAUTH_CLIENT_SECRET: undefined,
  FOILKIT_GITHUB_TOKEN: undefined,
}
const SECRET_ONLY = {
  ...CLEAN_ENV,
  FOILKIT_SESSION_SECRET: 'verification-secret-that-is-long-enough-for-the-check',
}

async function main(): Promise<void> {
  if (!existsSync(FUNCS)) {
    console.error(`no built functions at ${FUNCS} — run \`pnpm run build:vercel\` first`)
    process.exit(2)
  }
  const routes = builtRoutes(FUNCS)
  const names = Object.keys(routes).sort()
  console.log(`verifying ${names.length} built function(s) in ${FUNCS}\n`)

  // ── 1. Every function boots, with NOTHING in the environment ────────────
  console.log('boot, empty environment')
  for (const route of names) {
    try {
      const h = await load(routes[route]!, CLEAN_ENV)
      ok(`${route} boots and exports a handler`, typeof h === 'function')
    } catch (err) {
      ok(`${route} boots`, false, `${(err as { code?: string }).code ?? ''} ${String((err as Error).message).split('\n')[0]}`)
    }
  }

  // ── 2. The image proxy needs no environment at all ──────────────────────
  console.log('\n/api/image — no environment required')
  {
    const h = await load(routes['/api/image']!, CLEAN_ENV)
    const bad = await call(h, { method: 'GET', url: '/api/image?p=../../etc/passwd' })
    ok('rejects a traversal with 400, not a crash', bad.status === 400, `status ${bad.status}`)
    const wrongMethod = await call(h, { method: 'POST', url: '/api/image?p=en/base/base1/4/high.webp' })
    ok('refuses a POST with 405', wrongMethod.status === 405, `status ${wrongMethod.status}`)

    if (NO_NETWORK) {
      console.log('  skip network fetch (--no-network)')
    } else {
      const good = await call(h, { method: 'GET', url: '/api/image?p=en/base/base1/4/high.webp' })
      ok('serves a real scan with an empty environment', good.status === 200, `status ${good.status} body ${good.body.slice(0, 120)}`)
      ok('as image/webp', String(good.headers['content-type'] ?? '').startsWith('image/webp'), String(good.headers['content-type']))
      ok(
        'and names the upstream it resolved, for the frame registry',
        String(good.headers['x-foilkit-upstream'] ?? '').startsWith('https://assets.tcgdex.net/'),
        String(good.headers['x-foilkit-upstream']),
      )
      // The `src=` form is what a recorded source URL passes through as — the
      // exact shape that 500'd in production.
      const viaSrc = await call(h, {
        method: 'GET',
        url: `/api/image?src=${encodeURIComponent('https://assets.tcgdex.net/en/base/base1/4/high.webp')}`,
      })
      ok('the src= form works too', viaSrc.status === 200, `status ${viaSrc.status}`)
      const foreign = await call(h, {
        method: 'GET',
        url: `/api/image?src=${encodeURIComponent('https://evil.invalid/x.webp')}`,
      })
      ok('and a foreign origin in src= is refused', foreign.status === 400, `status ${foreign.status}`)
    }
  }

  // ── 3. Nothing configured: named 503s, never 500, never a crash ─────────
  console.log('\nempty environment — every other route degrades to a named 503')
  const shouldRefuse: [string, { method: string; url: string; body?: unknown }][] = [
    ['/api/me', { method: 'GET', url: '/api/me' }],
    ['/api/auth/start', { method: 'GET', url: '/api/auth/start?return=/card' }],
    ['/api/auth/callback', { method: 'GET', url: '/api/auth/callback?code=abc&state=/card' }],
    ['/api/mask', { method: 'PUT', url: '/api/mask', body: { cardId: 'base1-4', variantId: 1 } }],
    ['/api/window', { method: 'PUT', url: '/api/window', body: { cardId: 'base1-4', variantId: 1 } }],
    ['/api/canon', { method: 'PUT', url: '/api/canon', body: { patternId: 'cosmos' } }],
  ]
  for (const [route, req] of shouldRefuse) {
    const h = await load(routes[route]!, CLEAN_ENV)
    const r = await call(h, req)
    const body = r.json as { error?: { code?: string; missing?: string[] } } | null
    ok(
      `${route} answers 503 not_configured`,
      r.status === 503 && body?.error?.code === 'not_configured',
      `status ${r.status} body ${r.body.slice(0, 160)}`,
    )
    ok(
      `${route} names the variables it needs`,
      Array.isArray(body?.error?.missing) && body!.error!.missing!.length > 0,
      JSON.stringify(body?.error?.missing),
    )
  }
  {
    // Sign-OUT needs nothing and must keep working, so a half-configured
    // deployment can still clear a stale cookie.
    const h = await load(routes['/api/auth/signout']!, CLEAN_ENV)
    const r = await call(h, { method: 'GET', url: '/api/auth/signout?return=/' })
    ok('/api/auth/signout still works with no environment', r.status === 302, `status ${r.status}`)
  }

  // ── 4. Session secret only — production's current state ─────────────────
  console.log('\nFOILKIT_SESSION_SECRET only — the state production is in today')
  {
    const h = await load(routes['/api/me']!, SECRET_ONLY)
    const r = await call(h, { method: 'GET', url: '/api/me' })
    const body = r.json as { login?: unknown; writer?: unknown; writers?: unknown } | null
    ok('/api/me answers 200 signed-out', r.status === 200, `status ${r.status} body ${r.body.slice(0, 160)}`)
    ok('with login null and writer false', body?.login === null && body?.writer === false, r.body.slice(0, 160))
    ok('and publishes the writer list', Array.isArray(body?.writers), r.body.slice(0, 160))
  }
  for (const [route, req] of [
    ['/api/mask', { method: 'PUT', url: '/api/mask', body: { cardId: 'base1-4', variantId: 1 } }],
    ['/api/canon', { method: 'PUT', url: '/api/canon', body: { patternId: 'cosmos' } }],
  ] as [string, { method: string; url: string; body?: unknown }][]) {
    const h = await load(routes[route]!, SECRET_ONLY)
    const r = await call(h, req)
    const body = r.json as { error?: { code?: string; missing?: string[] } } | null
    ok(
      `${route} still 503s, now naming only the token`,
      r.status === 503 && body?.error?.missing?.join(',') === 'FOILKIT_GITHUB_TOKEN',
      `status ${r.status} missing ${JSON.stringify(body?.error?.missing)}`,
    )
  }
  {
    const h = await load(routes['/api/auth/start']!, SECRET_ONLY)
    const r = await call(h, { method: 'GET', url: '/api/auth/start' })
    const body = r.json as { error?: { missing?: string[] } } | null
    ok(
      '/api/auth/start 503s naming the OAuth app',
      r.status === 503 && (body?.error?.missing ?? []).includes('FOILKIT_OAUTH_CLIENT_ID'),
      `status ${r.status} missing ${JSON.stringify(body?.error?.missing)}`,
    )
  }

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
}

await main()
