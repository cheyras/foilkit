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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { encodePng } from '@foilkit/forge'

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
  FOILKIT_APP_ID: undefined,
  FOILKIT_APP_PRIVATE_KEY: undefined,
  FOILKIT_APP_INSTALLATION_ID: undefined,
  FOILKIT_APP_SLUG: undefined,
  FOILKIT_APP_USER_ID: undefined,
}
const SESSION_SECRET = 'verification-secret-that-is-long-enough-for-the-check'
const SECRET_ONLY = { ...CLEAN_ENV, FOILKIT_SESSION_SECRET: SESSION_SECRET }

// ── The contribution pipeline, end to end, against a GitHub that is a stub ──
//
// THE ONLY PLACE THE WHOLE PIPELINE RUNS. `functions/_lib/*.test.ts` covers
// each module; this drives the BUILT `/api/contribute.func` — the exact bytes
// that get uploaded — from an HTTP request through validation, through
// `writeMaskRecord` against a /tmp tree, to the four GitHub calls, and asserts
// the sequence and the payloads.
//
// `globalThis.fetch` is replaced wholesale rather than injected, because the
// bundled function has no seam to inject through and should not grow one: a
// production code path that exists so a test can reach it is a production code
// path that can be reached. Everything the function would have fetched is
// answered from a routing table here, including the repository reads —
// `data/frames.json` is served from disk, so the frame gate is exercised
// against the real registry rather than a fixture of it.
//
// It runs under `--no-network` too. There is no network in it.

interface GhCall {
  method: string
  path: string
  body: unknown
}

function installFakeGithub(
  routes: Record<string, { status?: number; json?: unknown; bytes?: Buffer }>,
): { calls: GhCall[]; restore: () => void } {
  const calls: GhCall[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === 'object' && 'url' in input ? input.url : input)
    const path = url.replace('https://api.github.com', '')
    const method = init?.method ?? 'GET'
    let body: unknown
    try {
      body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
    } catch {
      body = String(init?.body)
    }
    calls.push({ method, path, body })
    const route = routes[`${method} ${path}`]
    if (route === undefined) {
      return new Response(JSON.stringify({ message: `unrouted ${method} ${path}` }), { status: 599 })
    }
    if (route.bytes !== undefined) {
      return new Response(route.bytes as unknown as BodyInit, { status: route.status ?? 200 })
    }
    return new Response(JSON.stringify(route.json ?? {}), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { calls, restore: () => void (globalThis.fetch = real) }
}

/** A mask PNG at the canonical raster, `coverage` of it drawn. */
function canonicalMaskDataUrl(coverage = 0.25): string {
  const width = 504
  const height = 704
  const rgba = new Uint8Array(width * height * 4)
  const drawn = Math.round(width * height * coverage)
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    rgba[o] = 255
    rgba[o + 1] = 45
    rgba[o + 2] = 100
    rgba[o + 3] = i < drawn ? 255 : 0
  }
  return `data:image/png;base64,${Buffer.from(encodePng({ width, height, rgba })).toString('base64')}`
}

const MASK_SUBMISSION = {
  kind: 'mask',
  cardId: 'base1-4',
  variantId: 15,
  width: 504,
  height: 704,
  prior: {
    scope: 'window',
    eraId: 'wotc',
    rect: [0.06, 0.44, 0.88, 0.42],
    radius: 0.01,
    invert: false,
    feather: 0.008,
    resolverVersion: 3,
  },
  derivation: { startedFrom: 'layout', parent: null },
  seed: { parentSha256: null, resolvedFrom: null, seededAt: '2026-09-05T10:00:00.000Z' },
  conflict: { kind: 'none', acknowledged: false, detail: '' },
  card: { setId: 'base1', seriesSlug: 'base', name: 'Charizard', number: '4' },
  comment: 'The holo window is short at the bottom on this print run.',
  provisional: { agreement: 0.8123, addedPx: 4210, removedPx: 980, unchangedPx: 71000 },
}

function contributionRoutes(existingPr: boolean): Record<string, { status?: number; json?: unknown; bytes?: Buffer }> {
  const framesBytes = readFileSync(join(ROOT, 'data', 'frames.json'))
  const head = 'cheyras%3Acontrib%2Fqa-contributor%2Fbase1-4-15-new'
  return {
    // The App's credential exchange.
    'POST /app/installations/424242/access_tokens': {
      status: 201,
      json: { token: 'ghs_verification_installation', expires_at: new Date(Date.now() + 3600_000).toISOString() },
    },
    // The repository reads `materialise` performs, from the real registry.
    'GET /repos/cheyras/foilkit/contents/data/frames.json?ref=main': { json: { sha: 'FRAMES', type: 'file' } },
    'GET /repos/cheyras/foilkit/git/blobs/FRAMES': { bytes: framesBytes },
    'GET /repos/cheyras/foilkit/contents/data/foil-masks/base1-4?ref=main': {
      // No mask upstream yet. `listDir` reads a 404 as "no directory", which is
      // the common case and not an error.
      status: 404,
      json: { message: 'Not Found' },
    },
    // Branch, commit, pull request.
    'GET /repos/cheyras/foilkit/git/ref/heads/main': { json: { object: { sha: 'BASESHA' } } },
    'GET /repos/cheyras/foilkit/git/ref/heads/contrib/qa-contributor/base1-4-15-new': existingPr
      ? { json: { object: { sha: 'OLDHEAD' } } }
      : { status: 404, json: { message: 'Not Found' } },
    'GET /repos/cheyras/foilkit/git/commits/BASESHA': { json: { tree: { sha: 'BASETREE' } } },
    'POST /repos/cheyras/foilkit/git/blobs': { json: { sha: 'BLOBSHA' } },
    'POST /repos/cheyras/foilkit/git/trees': { json: { sha: 'TREESHA' } },
    'POST /repos/cheyras/foilkit/git/commits': { json: { sha: 'COMMITSHA' } },
    'POST /repos/cheyras/foilkit/git/refs': { json: {} },
    'PATCH /repos/cheyras/foilkit/git/refs/heads/contrib/qa-contributor/base1-4-15-new': { json: {} },
    [`GET /repos/cheyras/foilkit/pulls?state=open&head=${head}`]: {
      json: existingPr ? [{ number: 11, html_url: 'https://github.com/cheyras/foilkit/pull/11' }] : [],
    },
    'POST /repos/cheyras/foilkit/pulls': {
      json: { number: 11, html_url: 'https://github.com/cheyras/foilkit/pull/11' },
    },
    'PATCH /repos/cheyras/foilkit/pulls/11': { json: {} },
  }
}

async function contributionPipeline(routes: Record<string, string>): Promise<void> {
  console.log('\nthe contribution pipeline, end to end, against a mocked GitHub')

  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const APP_ENV = {
    ...CLEAN_ENV,
    FOILKIT_SESSION_SECRET: SESSION_SECRET,
    FOILKIT_APP_ID: '111222',
    // Deliberately the ESCAPED form. This is how the key arrives from a `.env`
    // line or a JSON blob, and it is the shape a real deploy has most often
    // got wrong — so the artifact check exercises it rather than the easy one.
    FOILKIT_APP_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n'),
    FOILKIT_APP_INSTALLATION_ID: '424242',
    FOILKIT_APP_SLUG: 'foilkit-contribute',
    FOILKIT_APP_USER_ID: '9001',
  }

  // A signed cookie for a NON-WRITER. The whole point of this endpoint is that
  // it works for somebody who cannot write directly.
  process.env.FOILKIT_SESSION_SECRET = SESSION_SECRET
  const { signSession } = await import(pathToFileURL(join(ROOT, 'functions', '_lib', 'session.ts')).href)
  const cookie = `foilkit_session=${encodeURIComponent(
    signSession({
      login: 'qa-contributor',
      id: 777001,
      name: 'QA Contributor',
      avatarUrl: null,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  )}`

  const png = canonicalMaskDataUrl()

  // ── A submission that must be REFUSED, and must not touch GitHub ─────────
  {
    const gh = installFakeGithub(contributionRoutes(false))
    try {
      const h = await load(routes['/api/contribute']!, APP_ENV)
      const r = await call(h, {
        method: 'POST',
        url: '/api/contribute',
        headers: { cookie },
        body: { ...MASK_SUBMISSION, png, width: 512, height: 512 },
      })
      const body = r.json as { error?: { code?: string }; failures?: string[] } | null
      ok('a bad raster is refused with 422 validation_failed', r.status === 422 && body?.error?.code === 'validation_failed', `status ${r.status} body ${r.body.slice(0, 200)}`)
      ok(
        'and the refusal names the raster it wanted',
        (body?.failures ?? []).some((f) => f.includes('504×704')),
        JSON.stringify(body?.failures),
      )
      ok(
        'AND NOTHING WAS SENT TO GITHUB — no branch, no token, no pull request',
        gh.calls.length === 0,
        gh.calls.map((c) => `${c.method} ${c.path}`).join(', '),
      )
    } finally {
      gh.restore()
    }
  }

  // ── A signed-out submission ─────────────────────────────────────────────
  {
    const gh = installFakeGithub(contributionRoutes(false))
    try {
      const h = await load(routes['/api/contribute']!, APP_ENV)
      const r = await call(h, { method: 'POST', url: '/api/contribute', body: { ...MASK_SUBMISSION, png } })
      ok('a signed-out submission is 401, not 500', r.status === 401, `status ${r.status}`)
      ok('and nothing reached GitHub', gh.calls.length === 0)
    } finally {
      gh.restore()
    }
  }

  // ── THE FIRST SUBMISSION ────────────────────────────────────────────────
  let firstBody = ''
  {
    const gh = installFakeGithub(contributionRoutes(false))
    try {
      const h = await load(routes['/api/contribute']!, APP_ENV)
      const r = await call(h, {
        method: 'POST',
        url: '/api/contribute',
        headers: { cookie },
        body: { ...MASK_SUBMISSION, png },
      })
      firstBody = r.body
      const body = r.json as {
        pr?: { url?: string; number?: number; updated?: boolean }
        branch?: string
        sidecar?: { derivation_method?: string; diff?: { agreement?: number } }
      } | null
      ok(
        'a valid mask submission answers 200 with a pull request URL',
        r.status === 200 && body?.pr?.url === 'https://github.com/cheyras/foilkit/pull/11',
        `status ${r.status} body ${r.body.slice(0, 300)}`,
      )
      ok(
        'on the branch the session names',
        body?.branch === 'contrib/qa-contributor/base1-4-15-new',
        String(body?.branch),
      )
      ok('and it opened rather than updated', body?.pr?.updated === false, JSON.stringify(body?.pr))

      // THE PROVENANCE ASSERTION. The method and the agreement in the answer
      // came out of `writeMaskRecord`, from the pixels — not from anything the
      // client said. That is the whole reason the write runs against a /tmp
      // tree instead of being reimplemented.
      ok(
        'the sidecar carries a SERVER-DERIVED derivation method',
        typeof body?.sidecar?.derivation_method === 'string' && body.sidecar.derivation_method.length > 0,
        JSON.stringify(body?.sidecar?.derivation_method),
      )
      ok(
        'and a measured agreement against the era rule',
        typeof body?.sidecar?.diff?.agreement === 'number',
        JSON.stringify(body?.sidecar?.diff),
      )

      const seq = gh.calls.map((c) => `${c.method} ${c.path.split('?')[0]}`)
      ok(
        'the installation token is minted before anything else',
        seq[0] === 'POST /app/installations/424242/access_tokens',
        seq.slice(0, 3).join(' | '),
      )
      ok(
        'the sequence is read the corpus, then branch, then commit, then pull request',
        seq.includes('GET /repos/cheyras/foilkit/git/ref/heads/main') &&
          seq.indexOf('POST /repos/cheyras/foilkit/git/commits') < seq.indexOf('POST /repos/cheyras/foilkit/git/refs') &&
          seq.indexOf('POST /repos/cheyras/foilkit/git/refs') < seq.indexOf('POST /repos/cheyras/foilkit/pulls'),
        seq.join(' | '),
      )
      ok(
        'MAIN IS NEVER TOUCHED — the only ref write is the contribution branch',
        !gh.calls.some((c) => c.method !== 'GET' && c.path.includes('/refs/heads/main')),
        gh.calls.filter((c) => c.method !== 'GET').map((c) => c.path).join(', '),
      )

      const commit = gh.calls.find((c) => c.path === '/repos/cheyras/foilkit/git/commits' && c.method === 'POST')
      const message = String((commit?.body as { message?: string })?.message ?? '')
      ok('the commit is parented on main', JSON.stringify((commit?.body as { parents?: unknown })?.parents) === '["BASESHA"]', JSON.stringify((commit?.body as { parents?: unknown })?.parents))
      ok(
        'the commit is authored by the App bot',
        JSON.stringify((commit?.body as { author?: unknown })?.author) ===
          JSON.stringify({ name: 'foilkit-contribute[bot]', email: '9001+foilkit-contribute[bot]@users.noreply.github.com' }),
        JSON.stringify((commit?.body as { author?: unknown })?.author),
      )
      ok(
        'and Co-authored-by puts the contributor’s name on it',
        message.includes('Co-authored-by: QA Contributor <777001+qa-contributor@users.noreply.github.com>'),
        message.split('\n').slice(-3).join(' / '),
      )
      ok(
        'the commit carries the DCO sign-off',
        message.includes('Signed-off-by: QA Contributor <777001+qa-contributor@users.noreply.github.com>'),
        message.split('\n').slice(-3).join(' / '),
      )
      ok(
        'and the CC0 dedication, because this touches data/',
        message.includes('CC0-Dedication: I dedicate my contributions'),
        message.slice(0, 200),
      )

      const tree = gh.calls.find((c) => c.path === '/repos/cheyras/foilkit/git/trees')
      const paths = ((tree?.body as { tree?: { path: string }[] })?.tree ?? []).map((t) => t.path)
      ok(
        'the tree carries the mask, its sidecar and the diff picture',
        paths.some((p) => p.endsWith('/15.png')) &&
          paths.some((p) => p.endsWith('/15.json')) &&
          paths.some((p) => p.endsWith('/15.diff.png')),
        paths.join(', '),
      )
      ok(
        'and every path is inside data/foil-masks/',
        paths.length > 0 && paths.every((p) => p.startsWith('data/foil-masks/')),
        paths.join(', '),
      )

      const pr = gh.calls.find((c) => c.path === '/repos/cheyras/foilkit/pulls' && c.method === 'POST')
      const prBody = String((pr?.body as { body?: string })?.body ?? '')
      ok(
        'the pull request targets main from the contribution branch',
        (pr?.body as { base?: string })?.base === 'main' &&
          (pr?.body as { head?: string })?.head === 'contrib/qa-contributor/base1-4-15-new',
        JSON.stringify(pr?.body),
      )
      ok(
        'its body carries the CC0 dedication automatically',
        prBody.includes('CC0-Dedication: I dedicate my contributions'),
        prBody.slice(0, 160),
      )
      ok('its body carries the contributor’s own words', prBody.includes('short at the bottom on this print run'), prBody.slice(0, 160))
      ok('its body carries the provisional agreement', prBody.includes('0.8123'), prBody.slice(0, 160))
      ok('its body says the session is fresh rather than a supersede', prBody.includes('Conflict status: **fresh**'))
      ok('its body lists the validation the submission passed', prBody.includes('## Validation') && prBody.includes('✅'))
    } finally {
      gh.restore()
    }
  }

  // ── RE-SUBMITTING THE SAME SESSION ──────────────────────────────────────
  {
    const gh = installFakeGithub(contributionRoutes(true))
    try {
      const h = await load(routes['/api/contribute']!, APP_ENV)
      const r = await call(h, {
        method: 'POST',
        url: '/api/contribute',
        headers: { cookie },
        body: { ...MASK_SUBMISSION, png, comment: 'Second pass: tightened the left edge.' },
      })
      const body = r.json as { pr?: { number?: number; updated?: boolean } } | null
      ok('a re-submission answers 200', r.status === 200, `status ${r.status} ${r.body.slice(0, 200)}`)
      ok('and UPDATES the same pull request rather than opening a second', body?.pr?.updated === true && body?.pr?.number === 11, JSON.stringify(body?.pr))
      ok(
        'the branch is force-updated rather than created',
        gh.calls.some((c) => c.method === 'PATCH' && c.path.endsWith('/git/refs/heads/contrib/qa-contributor/base1-4-15-new')) &&
          !gh.calls.some((c) => c.method === 'POST' && c.path.endsWith('/git/refs')),
        gh.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`).join(', '),
      )
      ok(
        'no second pull request is opened',
        !gh.calls.some((c) => c.method === 'POST' && c.path === '/repos/cheyras/foilkit/pulls'),
      )
      const patch = gh.calls.find((c) => c.method === 'PATCH' && c.path === '/repos/cheyras/foilkit/pulls/11')
      ok(
        'and the pull request body is REWRITTEN, not appended to',
        String((patch?.body as { body?: string })?.body ?? '').includes('tightened the left edge') &&
          !String((patch?.body as { body?: string })?.body ?? '').includes('short at the bottom'),
        String((patch?.body as { body?: string })?.body ?? '').slice(0, 160),
      )
      void firstBody
    } finally {
      gh.restore()
    }
  }

  // ── A STALE SESSION NOBODY ACKNOWLEDGED ─────────────────────────────────
  {
    const gh = installFakeGithub(contributionRoutes(false))
    try {
      const h = await load(routes['/api/contribute']!, APP_ENV)
      const r = await call(h, {
        method: 'POST',
        url: '/api/contribute',
        headers: { cookie },
        body: { ...MASK_SUBMISSION, png, conflict: { kind: 'parent-changed', acknowledged: false, detail: '' } },
      })
      ok('a stale session that was never shown its conflict is refused', r.status === 422, `status ${r.status}`)
      ok('and it never reached GitHub either', gh.calls.length === 0)
    } finally {
      gh.restore()
    }
  }

  // ── A CANON CONTRIBUTION ────────────────────────────────────────────────
  {
    const canonRoutes = {
      ...contributionRoutes(false),
      'GET /repos/cheyras/foilkit/contents/data/foil-canon/cosmos.json?ref=main': {
        json: { sha: 'CANONBLOB', type: 'file' },
      },
      'GET /repos/cheyras/foilkit/git/blobs/CANONBLOB': {
        bytes: readFileSync(join(ROOT, 'data', 'foil-canon', 'cosmos.json')),
      },
      'GET /repos/cheyras/foilkit/git/ref/heads/contrib/qa-contributor/canon-cosmos-new': {
        status: 404,
        json: { message: 'Not Found' },
      },
      'GET /repos/cheyras/foilkit/pulls?state=open&head=cheyras%3Acontrib%2Fqa-contributor%2Fcanon-cosmos-new': {
        json: [],
      },
    }
    const gh = installFakeGithub(canonRoutes)
    try {
      const committed = JSON.parse(readFileSync(join(ROOT, 'data', 'foil-canon', 'cosmos.json'), 'utf8')) as {
        uniforms: Record<string, number>
      }
      const h = await load(routes['/api/contribute']!, APP_ENV)
      const r = await call(h, {
        method: 'POST',
        url: '/api/contribute',
        headers: { cookie },
        body: {
          kind: 'canon',
          patternId: 'cosmos',
          // A full snapshot with one dial moved — the shape the canon lab sends.
          uniforms: { ...committed.uniforms, uScale: (committed.uniforms.uScale ?? 1) * 1.1 },
          note: 'Loosened the disc stagger a little.',
          comment: 'The bubbles read too tight against a 2026 scan.',
          conflict: { kind: 'none', acknowledged: false, detail: '' },
          seedContract: 2,
          seedSha256: null,
        },
      })
      const body = r.json as { pr?: { url?: string }; canon?: { tunedUnderContract?: number; frozen?: unknown } } | null
      ok('a canon contribution answers 200 with a pull request', r.status === 200 && typeof body?.pr?.url === 'string', `status ${r.status} ${r.body.slice(0, 300)}`)
      ok(
        'and the written file carries tunedUnderContract, which the data receipt requires',
        typeof body?.canon?.tunedUnderContract === 'number',
        JSON.stringify(body?.canon?.tunedUnderContract),
      )
      const tree = gh.calls.find((c) => c.path === '/repos/cheyras/foilkit/git/trees')
      const paths = ((tree?.body as { tree?: { path: string }[] })?.tree ?? []).map((t) => t.path)
      ok('the tree writes exactly one canon file', paths.join(',') === 'data/foil-canon/cosmos.json', paths.join(','))
      const pr = gh.calls.find((c) => c.path === '/repos/cheyras/foilkit/pulls' && c.method === 'POST')
      const prBody = String((pr?.body as { body?: string })?.body ?? '')
      ok('the pull request tabulates the uniform that moved', prBody.includes('| `uScale` |'), prBody.slice(0, 200))
      ok('and carries the dedication, because a canon file is data', prBody.includes('CC0-Dedication'))
    } finally {
      gh.restore()
    }
  }

  // ── A CANON SUBMISSION THE CONTRACT REFUSES ─────────────────────────────
  {
    const gh = installFakeGithub(contributionRoutes(false))
    try {
      const h = await load(routes['/api/contribute']!, APP_ENV)
      const r = await call(h, {
        method: 'POST',
        url: '/api/contribute',
        headers: { cookie },
        body: {
          kind: 'canon',
          patternId: 'cosmos',
          uniforms: { uScale: 1 },
          conflict: { kind: 'none', acknowledged: false, detail: '' },
        },
      })
      const body = r.json as { failures?: string[] } | null
      ok('a partial canon snapshot is refused with 422', r.status === 422, `status ${r.status}`)
      ok(
        'and the refusal explains that a canon file is a full snapshot',
        (body?.failures ?? []).some((f) => f.includes('full snapshot')),
        JSON.stringify(body?.failures),
      )
      ok('nothing reached GitHub', gh.calls.length === 0)
    } finally {
      gh.restore()
    }
  }
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
    ['/api/contribute', { method: 'POST', url: '/api/contribute', body: { kind: 'canon', patternId: 'cosmos' } }],
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
  {
    // The contribution ladder is its OWN, not the write ladder. A deployment can
    // legitimately have the PAT and no App, or the App and no PAT, and saying
    // which is missing is what turns "Submit is broken" into a next step.
    const h = await load(routes['/api/contribute']!, SECRET_ONLY)
    const r = await call(h, { method: 'POST', url: '/api/contribute', body: { kind: 'canon', patternId: 'cosmos' } })
    const body = r.json as { error?: { missing?: string[] } } | null
    ok(
      '/api/contribute 503s naming the three App variables, not the PAT',
      r.status === 503 &&
        (body?.error?.missing ?? []).join(',') ===
          'FOILKIT_APP_ID,FOILKIT_APP_PRIVATE_KEY,FOILKIT_APP_INSTALLATION_ID',
      `status ${r.status} missing ${JSON.stringify(body?.error?.missing)}`,
    )
  }

  await contributionPipeline(routes)

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
}

await main()
