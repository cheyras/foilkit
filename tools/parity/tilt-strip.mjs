// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// THE RENDER EVIDENCE: an 8-frame tilt sweep, as one strip.
//
// A foil measurement is a claim about how a surface behaves when you MOVE it.
// A single still cannot carry that claim — the whole reason foil is hard to
// review from a diff is that the interesting behaviour is the change between
// angles, and a mask PNG viewed in GitHub's image diff shows a pink blob.
//
// So the evidence a contribution PR carries is the pattern rendered through the
// FRAME-STEPPED ZERO-DELTA HARNESS at eight tilt angles, composited into one
// wide image that a reviewer reads left to right in a second.
//
// ── IT RENDERS ON THE BLANK BASE, AND THAT IS A LICENCE DECISION ───────────
//
// AGENTS.md F2, the standing ownership rule: ship nothing we do not own
// outright — no card artwork, not in data/, not in a demo, not in a test
// fixture. The strip is COMMITTED, so a strip containing a rendered card scan
// would put third-party pixels into the repository, which is exactly the thing
// that makes a CC0 dedication unreliable.
//
// The blank base is also the better picture. It shows how the foil behaves
// inside the region the human drew, with no printed ink competing for
// attention, which is the thing under review.
//
// ── DETERMINISM IS INHERITED, NOT REBUILT ─────────────────────────────────
//
// Every trick in `run.mjs` applies here and for the same reasons — rAF stubbed
// and stepped, performance.now frozen, ~300 frames to the easing's fixpoint,
// SwiftShader. Each tilt step is a fresh page load with its own parked target,
// so the eight frames are eight independent fixpoints rather than eight samples
// of one animation, and two runs of this tool on the same inputs produce
// byte-identical strips.
//
// ── ONE DEPARTURE: THE PIXELS COME OFF THE CANVAS, NOT OFF THE COMPOSITOR ──
//
// `run.mjs` uses `page.screenshot({ clip })`. This tool does not, and three CI
// runs bought that sentence: `page.screenshot` asks the BROWSER COMPOSITOR for
// a frame, and on a GitHub Linux runner that call logs "fonts loaded" and then
// sits there until it times out — while returning perfectly well on a Windows
// Chromium build, so every local run was green. Neither disabling the animation
// wait nor restoring the page's real `requestAnimationFrame` changed it.
//
// So the compositor comes out of the path. The host page exposes `__grabNext()`,
// which arms a flag that the render loop services by calling `toDataURL()` on
// the renderer's own canvas in the SAME TASK as the draw, while the drawing
// buffer is still valid. No compositor, no font pass, no device-scale
// negotiation, no viewport. The card rect is then cropped in Node, from
// `__cardRect`, which is arithmetic rather than a bounding box.
//
// That is a strictly better capture for something that must run unattended, and
// it is why this file's output is not comparable byte-for-byte with `run.mjs`'s
// — different capture, same render.
//
// Usage:
//   node tools/parity/serve.mjs --port 5199 &
//   node tools/parity/tilt-strip.mjs --pattern cosmos --out evidence/strip.png
//   node tools/parity/tilt-strip.mjs --pattern cosmos --mask /data/foil-masks/base1-4/15.png \
//        --out evidence/strip.png --meta evidence/strip.json

import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng, encodePng, resampleRgba } from '@foilkit/forge'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const PW_ROOT = process.env.PW_ROOT ?? path.join(ROOT, 'package.json')
let chromium
try {
  ;({ chromium } = createRequire(PW_ROOT)('playwright'))
} catch {
  console.error(
    `playwright could not be resolved from ${PW_ROOT}. It is deliberately not a ` +
      'repository dependency; install it somewhere and set PW_ROOT=<that dir>/package.json.',
  )
  process.exit(2)
}

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d
}

const ORIGIN = arg('url', 'http://127.0.0.1:5199')
const PATTERN = arg('pattern', 'cosmos')
const MASK = arg('mask', '')
const CANON_FILE = arg('canonFile', '')
const OUT = path.resolve(arg('out', 'evidence/strip.png'))
const META = arg('meta', null)
const FRAMES = Number(arg('frames', '300'))
const TONE = arg('tone', 'dark')
const MAX_TILT = arg('maxTilt', '16')
/** How much each frame shrinks. A full clip is ~494×690; /2 keeps eight of them
 *  under a couple of hundred kilobytes and still shows band structure. */
const SCALE = Number(arg('scale', '2'))
/** Transparent gutter between frames, in output pixels. */
const GUTTER = Number(arg('gutter', '8'))

/**
 * THE SWEEP. Eight angles across the full tilt range, left to right, with the
 * middle two straddling zero — so a reviewer sees both extremes, both
 * near-normal states, and the transitions, which is where a foil recipe either
 * behaves or does not.
 */
const TILTS = [-1, -0.7, -0.35, -0.1, 0.1, 0.35, 0.7, 1]

function initScript() {
  const FROZEN = 1000
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
page.on('pageerror', (e) => pageErrors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`)
})

const tmp = path.join(path.dirname(OUT), `.tilt-strip-${process.pid}`)
mkdirSync(tmp, { recursive: true })
mkdirSync(path.dirname(OUT), { recursive: true })

const frames = []
try {
  for (const tiltx of TILTS) {
    const params = new URLSearchParams({
      pattern: PATTERN,
      tone: TONE,
      maxTilt: MAX_TILT,
      tiltx: String(tiltx),
      // A fixed vertical component so the sweep is a HORIZONTAL rotation and
      // nothing else moves. Two axes changing at once makes it impossible to
      // say which one produced a difference.
      tilty: '-0.2',
    })
    if (MASK) params.set('maskUrl', MASK)
    if (CANON_FILE) params.set('canonFile', CANON_FILE)

    await page.goto(`${ORIGIN}/?${params}`, { waitUntil: 'domcontentloaded' })
    // POLLING, not rAF: Playwright's waitForFunction polls on requestAnimationFrame
    // by default, which this harness has stubbed and does not flush.
    await page.waitForFunction(() => window.__parity?.ready || window.__parityError, null, {
      polling: 50,
      timeout: 60_000,
    })
    const err = await page.evaluate(() => window.__parityError ?? null)
    if (err) throw new Error(`${PATTERN} @ tilt ${tiltx}: ${err}`)
    await page.waitForFunction(() => window.__ready?.() === true, null, { polling: 50, timeout: 30_000 })
    await page.evaluate((n) => window.__stepFrames(n), FRAMES)
    const err2 = await page.evaluate(() => window.__parityError ?? null)
    if (err2) throw new Error(`${PATTERN} @ tilt ${tiltx}: ${err2}`)

    // Arm the capture, then step ONE more frame — which renders and grabs the
    // drawing buffer in the same task. The easing is at its fixpoint, so that
    // frame is identical to the 300 before it.
    await page.evaluate(() => window.__grabNext())
    await page.evaluate(() => window.__stepFrames(1))
    const dataUrl = await page.evaluate(() => window.__capture)
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
      throw new Error(`${PATTERN} @ tilt ${tiltx}: the canvas capture came back empty`)
    }
    const full = decodePng(Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'))

    // The card rect out of the host canvas. Arithmetic, from the page's own
    // inverse of its fit() projection — not a bounding box, so it cannot depend
    // on layout, scrollbars or a window manager.
    const rect = await page.evaluate(() => window.__cardRect)
    const x = Math.ceil(rect.x)
    const y = Math.ceil(rect.y)
    const clip = { x, y, width: Math.floor(rect.x + rect.width) - x, height: Math.floor(rect.y + rect.height) - y }
    const cropped = { width: clip.width, height: clip.height, rgba: new Uint8Array(clip.width * clip.height * 4) }
    for (let row = 0; row < clip.height; row++) {
      const src = ((y + row) * full.width + x) * 4
      cropped.rgba.set(full.rgba.subarray(src, src + clip.width * 4), row * clip.width * 4)
    }
    const file = path.join(tmp, `${TILTS.indexOf(tiltx)}.png`)
    writeFileSync(file, encodePng(cropped))
    frames.push({ tiltx, file, image: cropped })
    process.stdout.write(`  tilt ${String(tiltx).padStart(5)}  ${clip.width}×${clip.height}\n`)
  }

  if (pageErrors.length > 0) {
    // THE COMPILE GATE. A shader that does not link surfaces here as a
    // pageerror or a console error out of three.js's program log — this is the
    // real GL driver, so this is where a canon file naming a uniform the
    // recipe does not declare, or a recipe whose GLSL does not compile, is
    // caught. The submit endpoint's structural checks are the cheap half; this
    // is the expensive, authoritative one.
    throw new Error(`the page reported errors:\n  ${pageErrors.join('\n  ')}`)
  }

  // ── Compose ────────────────────────────────────────────────────────────
  const small = frames.map((f) => ({
    ...f,
    image: resampleRgba(f.image, Math.round(f.image.width / SCALE), Math.round(f.image.height / SCALE)),
  }))
  const cellW = small[0].image.width
  const cellH = small[0].image.height
  for (const f of small) {
    if (f.image.width !== cellW || f.image.height !== cellH) {
      throw new Error('the eight frames are not the same size — the clip moved between loads')
    }
  }
  const width = cellW * small.length + GUTTER * (small.length - 1)
  const height = cellH
  const rgba = new Uint8Array(width * height * 4)
  small.forEach((f, i) => {
    const ox = i * (cellW + GUTTER)
    for (let y = 0; y < cellH; y++) {
      const src = y * cellW * 4
      const dst = (y * width + ox) * 4
      rgba.set(f.image.rgba.subarray(src, src + cellW * 4), dst)
    }
  })
  const png = encodePng({ width, height, rgba })
  writeFileSync(OUT, png)

  const meta = {
    generatedAt: new Date().toISOString(),
    pattern: PATTERN,
    mask: MASK || null,
    canonFile: CANON_FILE || null,
    tone: TONE,
    maxTiltDeg: Number(MAX_TILT),
    framesPerStep: FRAMES,
    tilts: TILTS,
    cell: { width: cellW, height: cellH },
    strip: { width, height, bytes: png.length },
    sha256: createHash('sha256').update(png).digest('hex'),
  }
  if (META) writeFileSync(path.resolve(META), `${JSON.stringify(meta, null, 2)}\n`)
  console.log(`\ntilt strip -> ${OUT}  ${width}×${height}  ${(png.length / 1024).toFixed(1)} KB`)
  console.log(`sha256 ${meta.sha256}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
  await browser.close()
}
