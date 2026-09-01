// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The frame-stepped ZERO-DELTA harness. Renders every pattern on a blank card
// base in headless Chromium and screenshots it DETERMINISTICALLY: two runs with
// identical inputs produce byte-identical PNGs.
//
// WHY EACH PIECE IS THERE — every one of these was a real failure first:
//   * requestAnimationFrame is STUBBED, callbacks queued and driven by
//     window.__stepFrames(n). With real rAF the tilt easing (x += (t-x)*0.12)
//     never settles; a residual of 2e-5 tilt still flips hundreds of 1-LSB
//     pixels along pattern band edges, and a same-settings control pair one
//     second apart diffed 15k px.
//   * performance.now() is FROZEN, so uTime is exactly 0 every frame — ambient
//     drift is a clock read, not an animation.
//   * ~300 stepped frames drive the easing to its float64 underflow fixpoint.
//     30 frames is NOT converged and the difference is visible in a diff.
//   * page.screenshot({ clip }) ONLY. Element screenshots wait on real
//     animation frames for their stability check and HANG against the stub.
//   * SwiftShader, so rasterization does not vary with the GPU.
//
// PLAYWRIGHT IS NOT A REPOSITORY DEPENDENCY — the test suite and the library
// need none, and this instrument is a tool rather than a gate. Point PW_ROOT at
// a package.json that can resolve it (`npm i -g playwright`, or `npm i
// playwright` anywhere then PW_ROOT=<that>/package.json).
//
// Usage:
//   node tools/parity/serve.mjs &
//   node tools/parity/run.mjs --out shots/foilkit
//   node tools/parity/run.mjs --out shots/origin \
//        --shaderUrl /origin/shader.js --materialUrl /origin/shader.js \
//        --patternsUrl /origin/patterns.js --canonUrl /origin-canon

import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const PW_ROOT = process.env.PW_ROOT ?? path.join(ROOT, 'package.json')
let chromium
try {
  ;({ chromium } = createRequire(PW_ROOT)('playwright'))
} catch {
  console.error(
    `playwright could not be resolved from ${PW_ROOT}. It is deliberately not a ` +
      'repository dependency; install it somewhere and set PW_ROOT=<that dir>/package.json, ' +
      'then `npx playwright install chromium`.',
  )
  process.exit(2)
}

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d
}

const ORIGIN = arg('url', 'http://127.0.0.1:5199')
const OUT = path.resolve(arg('out', 'shots'))
const FRAMES = Number(arg('frames', '300'))
const TONE = arg('tone', 'dark')
const ONLY = arg('pattern', null)
const PASSTHROUGH = ['shaderUrl', 'materialUrl', 'patternsUrl', 'canonUrl', 'tiltx', 'tilty', 'maxTilt']

mkdirSync(OUT, { recursive: true })

// The pattern list comes from the build under test, so a recipe added on one
// side and not the other shows up as a list difference rather than silently.
function initScript() {
  const FROZEN = 1000 // ms; any constant works — uTime is a delta from mount
  const queue = []
  const cbs = new Map()
  let nextId = 1
  window.requestAnimationFrame = (cb) => {
    const id = nextId++
    cbs.set(id, cb)
    queue.push(id)
    return id
  }
  window.cancelAnimationFrame = (id) => cbs.delete(id)
  performance.now = () => FROZEN
  window.__framesRun = 0
  window.__stepFrames = (n) => {
    for (let k = 0; k < n; k++) {
      const batch = queue.splice(0, queue.length)
      if (batch.length === 0) break
      for (const id of batch) {
        const cb = cbs.get(id)
        if (!cb) continue
        cbs.delete(id)
        cb(FROZEN)
      }
      window.__framesRun++
    }
    return window.__framesRun
  }
  window.__pendingFrames = () => queue.length
}

const params = new URLSearchParams({ tone: TONE })
for (const k of PASSTHROUGH) {
  const v = arg(k, null)
  if (v !== null) params.set(k, v)
}

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    '--disable-lcd-text',
    '--font-render-hinting=none',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ],
})
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 1,
  reducedMotion: 'no-preference',
  colorScheme: 'dark',
})
await context.addInitScript(initScript)

const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (e) => {
  pageErrors.push(String(e))
  console.error('pageerror:', String(e))
})
page.on('requestfailed', (r) => console.error('requestfailed:', r.url(), r.failure()?.errorText))
page.on('response', (r) => {
  if (r.status() >= 400) console.error('http', r.status(), r.url())
})

// POLLING, not rAF. Playwright's waitForFunction defaults to polling on
// requestAnimationFrame — which this harness has stubbed and does not flush, so
// an rAF-polled condition is evaluated exactly once and then never again. Every
// wait here is interval-polled.
const ready = (pg) =>
  pg.waitForFunction(() => window.__parity?.ready || window.__parityError, null, {
    polling: 50,
    timeout: 60_000,
  })

// One boot to read the recipe list out of the build under test.
const bootParams = new URLSearchParams(params)
bootParams.set('pattern', 'cosmos')
await page.goto(`${ORIGIN}/?${bootParams}`, { waitUntil: 'domcontentloaded' })
await ready(page)
const bootErr = await page.evaluate(() => window.__parityError ?? null)
if (bootErr) {
  console.error(bootErr)
  process.exit(3)
}
const patternsUrl = params.get('patternsUrl') ?? '/packages/patterns/dist/patterns.js'
const ids = await page.evaluate(
  async (u) => (await import(u)).PATTERNS.map((p) => p.id),
  new URL(patternsUrl, ORIGIN).href,
)

const list = ONLY ? [ONLY] : ids
const results = []

for (const id of list) {
  const p = new URLSearchParams(params)
  p.set('pattern', id)
  await page.goto(`${ORIGIN}/?${p}`, { waitUntil: 'domcontentloaded' })
  await ready(page)
  const err = await page.evaluate(() => window.__parityError ?? null)
  if (err) throw new Error(`${id}: ${err}`)
  // The blank base decodes as a TASK, not an animation frame, so it lands
  // against the stub — but it has to land before the first stepped frame or
  // uFace is null for that frame.
  await page.waitForFunction(() => window.__ready?.() === true, null, { polling: 50, timeout: 30_000 })
  const ran = await page.evaluate((n) => window.__stepFrames(n), FRAMES)
  const info = await page.evaluate(() => ({
    rect: window.__cardRect,
    canon: window.__parity.canon,
    canonUniforms: window.__parity.canonUniforms,
    cardAspect: window.__parity.cardAspect,
  }))
  const host = await page.locator('#host').boundingBox()
  const clip = (() => {
    const x = Math.ceil(host.x + info.rect.x)
    const y = Math.ceil(host.y + info.rect.y)
    return {
      x,
      y,
      width: Math.floor(host.x + info.rect.x + info.rect.width) - x,
      height: Math.floor(host.y + info.rect.y + info.rect.height) - y,
    }
  })()
  const file = path.join(OUT, `${id}.png`)
  await page.screenshot({ path: file, clip, animations: 'disabled' })
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex')
  results.push({ id, sha256: sha, framesRun: ran, canon: info.canon, canonUniforms: info.canonUniforms, clip })
  process.stdout.write(`${id.padEnd(26)} ${sha.slice(0, 16)}  canon=${info.canon ?? 'none'} (${info.canonUniforms})\n`)
}

const manifest = {
  generatedAt: new Date().toISOString(),
  origin: ORIGIN,
  params: Object.fromEntries(params),
  frames: FRAMES,
  tone: TONE,
  patterns: results.length,
  pageErrors,
  results,
}
writeFileSync(path.join(OUT, 'shots.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`\n${results.length} patterns -> ${OUT}`)
if (pageErrors.length) console.error('page errors:', pageErrors)

await browser.close()
