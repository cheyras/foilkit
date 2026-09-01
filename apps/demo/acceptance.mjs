// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The stage's acceptance run — the demo, driven, asserted, in headless Chromium.
//
//   node tools/parity/serve.mjs --page apps/demo/index.html --port 5200 &
//   node apps/demo/acceptance.mjs
//
// It asserts the five claims of subtask 6, in both presentation modes:
//
//   1. ONE WebGL context at any card count. Counted by instrumenting
//      HTMLCanvasElement.prototype.getContext from an init script — before any
//      page code runs — rather than by asking the library about itself. Context
//      LOSS is counted separately: past the browser's cap the oldest context is
//      lost silently, so zero losses is half the claim.
//   2. ONE COMPILED PROGRAM PER DISTINCT PATTERN, read from three's own
//      `renderer.info.programs`, not from the stage's material map. The map is
//      what the stage intends; `info.programs` is what the GPU was actually
//      asked to compile.
//   3. ONE TEXTURE UPLOAD PER DISTINCT URL, with the virtualizer mounting and
//      unmounting cards continuously underneath.
//   4. THE LADDER ENGAGES AND RECOVERS, forced by the demo's synthetic-load
//      knob. A real slow device is not available in CI and would not be
//      reproducible if it were; forcing measurable work into the measured
//      region is the honest equivalent, because the ladder reads work time and
//      has no idea where the work came from.
//   5. BOTH MODES RENDER. A screenshot of one card's box, checked for real
//      variance — a blank pass is the failure this catches, and "it didn't
//      throw" is not evidence of pixels.
//
// PLAYWRIGHT IS NOT A REPOSITORY DEPENDENCY, by the same rule the parity
// harness follows: the library and the test suite need none. Resolve it from
// anywhere and point PW_ROOT at that package.json.

import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
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
const BASE = arg('base', process.env.DEMO_BASE ?? 'http://127.0.0.1:5200')
const CARDS = Number(arg('cards', '300'))
const OUT = arg('out', path.join(ROOT, 'apps/demo/.acceptance'))
const SLOW_MS = Number(arg('slow', '26'))

mkdirSync(OUT, { recursive: true })

const results = []
let failures = 0
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

// Counted before the page's own module runs. The demo instruments itself too;
// two independent counters agreeing is the point.
const initScript = () => {
  window.__ctx = { created: 0, lost: 0 }
  const real = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const c = real.call(this, type, ...rest)
    if (c && /webgl/i.test(String(type))) {
      window.__ctx.created += 1
      this.addEventListener('webglcontextlost', () => (window.__ctx.lost += 1))
    }
    return c
  }
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
  // A canon 404 is the expected answer for a recipe with no snapshot: the code
  // defaults ARE the right baseline there, and 32 of the 45 recipes have a
  // file. Anything else at 400+ is a real problem.
  if (r.status() >= 400 && !r.url().includes('/data/foil-canon/')) {
    console.error('http', r.status(), r.url())
  }
})

const stats = () => page.evaluate(() => window.foilkitDemo.stats())
const settle = async (frames = 30) => {
  await page.evaluate(
    (n) =>
      new Promise((resolve) => {
        let i = 0
        const step = () => (++i >= n ? resolve() : requestAnimationFrame(step))
        requestAnimationFrame(step)
      }),
    frames,
  )
}

await page.goto(`${BASE}/?n=${CARDS}&mode=underlay&source=sweep`, { waitUntil: 'load' })
await page.waitForFunction(() => window.__demoReady === true || window.__demoError, null, {
  timeout: 30000,
})
const bootError = await page.evaluate(() => window.__demoError ?? null)
check('the demo boots', !bootError, bootError ?? undefined)
if (bootError) {
  await browser.close()
  process.exit(1)
}

// Give the virtualizer, the canon fetches and the face decodes time to land.
await settle(90)

// ── 1. one context, and no lost ones ───────────────────────────────────────
{
  const s = await stats()
  const ctx = await page.evaluate(() => window.__ctx)
  check(
    `exactly one WebGL context at ${s.requested} registered cards`,
    ctx.created === 1,
    `created ${ctx.created}, demo-side ${s.contexts}, mounted ${s.mounted}`,
  )
  check('no context was lost', ctx.lost === 0 && s.contextsLost === 0, `lost ${ctx.lost}`)
  check('cards actually registered', s.cards > 0 && s.drawCalls > 0, `cards ${s.cards}, drawn ${s.drawCalls}`)
}

// ── 2 & 3. the caches, under a scrolling virtualizer ───────────────────────
// Scroll the whole grid so every card mounts and unmounts at least once. A
// stage that leaked per mount shows it here and nowhere else.
for (let i = 0; i < 14; i++) {
  await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9))
  await settle(6)
}
await page.evaluate(() => window.scrollTo(0, 0))
await settle(40)

{
  const s = await stats()
  const ctx = await page.evaluate(() => window.__ctx)
  check(
    'still one context after a full scroll of the grid',
    ctx.created === 1 && ctx.lost === 0,
    `created ${ctx.created}, lost ${ctx.lost}`,
  )
  check(
    'one compiled program per distinct pattern',
    s.programs === s.distinctPatterns && s.materials === s.distinctPatterns,
    `programs ${s.programs}, materials ${s.materials}, distinct patterns ${s.distinctPatterns}`,
  )
  check(
    'one texture per distinct URL',
    s.textures === s.distinctFaces,
    `textures ${s.textures}, distinct urls ${s.distinctFaces}`,
  )
  // Both mask tiers are on screen: two thirds of the cards upload no mask at
  // all (the layout-rect tier is a rectMask in the shader), and the third that
  // carry a vector template share one rasterisation per size because they
  // share one id. A per-card rasterisation would show as dozens here.
  check(
    'vector masks rasterise per size, not per card',
    s.maskTextures >= 1 && s.maskTextures <= 4,
    `${s.maskTextures} rasters across ${s.mounted} mounted cards`,
  )
}

// ── all N registered at once, no virtualizer ───────────────────────────────
// A host is not obliged to virtualize. The context claim has to hold when it
// does not, and this is the shape the old per-card renderer could never take:
// three hundred simultaneous registrations against a cap of eight to sixteen.
{
  await page.evaluate(() => window.foilkitDemo.setVirtualize(false))
  await settle(60)
  const s = await stats()
  const ctx = await page.evaluate(() => window.__ctx)
  check(
    `all ${CARDS} cards registered simultaneously`,
    s.cards === CARDS && s.mounted === CARDS,
    `registered ${s.cards}, mounted ${s.mounted}`,
  )
  check(
    `still exactly one context with ${CARDS} live registrations`,
    ctx.created === 1 && ctx.lost === 0,
    `created ${ctx.created}, lost ${ctx.lost}, drawn this frame ${s.drawCalls}`,
  )
  check(
    'and still one program per pattern, one texture per url',
    s.programs === s.distinctPatterns && s.textures === s.distinctFaces,
    `programs ${s.programs}/${s.distinctPatterns}, textures ${s.textures}/${s.distinctFaces}`,
  )
  check(
    'offscreen cards are not drawn',
    s.drawCalls < s.cards,
    `${s.drawCalls} drawn of ${s.cards} registered`,
  )
  await page.evaluate(() => window.foilkitDemo.setVirtualize(true))
  await settle(30)
  await page.evaluate(() => window.foilkitDemo.resetLadder())
  await settle(20)
}

// ── 4. the ladder engages, and recovers ────────────────────────────────────
const ladder = { before: null, loaded: null, recovered: null }
{
  ladder.before = (await stats()).step
  await page.evaluate((ms) => window.foilkitDemo.setLoad(ms), SLOW_MS)
  await settle(220)
  ladder.loaded = await stats()
  check(
    'the ladder engages under forced load',
    ladder.loaded.step > ladder.before && ladder.loaded.rung >= 1,
    `step ${ladder.before} -> ${ladder.loaded.step} (rung ${ladder.loaded.rung}, "${ladder.loaded.rungLabel}")`,
  )
  check(
    'and it gives up resolution first, not animation',
    ladder.loaded.rung <= 2 || ladder.loaded.step >= 6,
    `rung ${ladder.loaded.rung} at step ${ladder.loaded.step}`,
  )

  await page.evaluate(() => window.foilkitDemo.setLoad(0))
  await settle(900)
  ladder.recovered = await stats()
  check(
    'and recovers when the load goes away',
    ladder.recovered.step < ladder.loaded.step && ladder.recovered.rung <= 1,
    `step ${ladder.loaded.step} -> ${ladder.recovered.step} (rung ${ladder.recovered.rung})`,
  )
}

// ── every tilt source is live-switchable ───────────────────────────────────
for (const source of ['pointer', 'gyro', 'scroll', 'sweep', 'manual', 'none']) {
  await page.evaluate((s) => window.foilkitDemo.setSource(s), source)
  await settle(8)
  const s = await stats()
  const ctx = await page.evaluate(() => window.__ctx)
  check(
    `tilt source '${source}' switches live`,
    s.tiltSource === source && ctx.created === 1 && ctx.lost === 0,
    `source ${s.tiltSource}, contexts ${ctx.created}`,
  )
}
await page.evaluate(() => window.foilkitDemo.setSource('sweep'))

// ── 5. both modes render, and pass the same run ────────────────────────────
//
// "It did not throw" is not evidence of pixels, and a PNG byte count would pass
// a flat grey rectangle. So the screenshot goes BACK INTO the page, is decoded
// by the browser, and is measured: how many distinct colours, and how far the
// darkest sample is from the brightest. A blank pass has one colour and no
// range.
async function measure(png) {
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    const seen = new Set()
    let min = 255
    let max = 0
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] + d[i + 1] + d[i + 2]) / 3
      if (l < min) min = l
      if (l > max) max = l
      // 5 bits per channel: robust to SwiftShader's dithering, sensitive to
      // an actual image.
      seen.add(((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3))
    }
    return { distinct: seen.size, min, max, range: max - min, px: c.width * c.height }
  }, png.toString('base64'))
}

const modeReport = {}
for (const mode of ['underlay', 'blit']) {
  await page.evaluate((m) => window.foilkitDemo.setMode(m), mode)
  await settle(60)
  const s = await stats()
  const ctx = await page.evaluate(() => window.__ctx)

  const rect = await page.evaluate(() => window.foilkitDemo.cardRect())
  const clip = {
    x: Math.round(rect.x + rect.width * 0.2),
    y: Math.round(rect.y + rect.height * 0.2),
    width: Math.round(rect.width * 0.6),
    height: Math.round(rect.height * 0.6),
  }
  const png = await page.screenshot({ clip })
  writeFileSync(path.join(OUT, `${mode}.png`), png)
  const pixels = await measure(png)

  modeReport[mode] = {
    mode: s.mode,
    contexts: ctx.created,
    contextsLost: ctx.lost,
    programs: s.programs,
    materials: s.materials,
    textures: s.textures,
    distinctPatterns: s.distinctPatterns,
    distinctFaces: s.distinctFaces,
    drawCalls: s.drawCalls,
    pixels,
  }

  check(`'${mode}' renders one context`, ctx.created === 1 && ctx.lost === 0, `contexts ${ctx.created}`)
  check(
    `'${mode}' keeps one program per pattern and one texture per url`,
    s.programs === s.distinctPatterns && s.textures === s.distinctFaces,
    `programs ${s.programs}/${s.distinctPatterns}, textures ${s.textures}/${s.distinctFaces}`,
  )
  check(
    `'${mode}' renders a non-blank card`,
    pixels.distinct > 40 && pixels.range > 24,
    `${pixels.distinct} distinct colours, luma range ${pixels.min.toFixed(0)}–${pixels.max.toFixed(0)} over ${pixels.px}px`,
  )
}

check('no page errors during the run', pageErrors.length === 0, pageErrors.join(' | ') || undefined)

const summary = {
  base: BASE,
  cards: CARDS,
  forcedLoadMs: SLOW_MS,
  ladder,
  modes: modeReport,
  results,
  failures,
  at: new Date().toISOString(),
}
writeFileSync(path.join(OUT, 'acceptance.json'), `${JSON.stringify(summary, null, 2)}\n`)
console.log(`\n${results.length - failures}/${results.length} checks passed — ${OUT}`)

await browser.close()
process.exit(failures ? 1 : 0)
