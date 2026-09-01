// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The acceptance run for the hosted editor, over the BUILT SITE.
//
// It drives the one journey the deploy is judged on, end to end, against the
// fixture bake:
//
//   browse the queue → open a card → draw a stroke with a synthetic pointer →
//   save to the session → reload → the session is still there → export and
//   re-import it → make upstream move → the conflict UI appears
//
// WHY THE BUILT SITE AND NOT THE DEV SERVER. Every interesting failure in this
// deploy is a build failure: an artifact that the dev middleware serves and
// `copy-data.mjs` forgets, a lazy chunk that never resolves, a rewrite that
// sends `/card?id=…` to a 404. A dev-server test would pass through all of them.
// So this serves `dist/` with the same SPA fallback `vercel.json` configures,
// and nothing in the loop knows it is a test.
//
// PLAYWRIGHT IS NOT A REPOSITORY DEPENDENCY — same rule the parity harness and
// the stage's acceptance run follow. Resolve it from anywhere and point PW_ROOT
// at that package.json.
//
//   node --conditions source tools/bake-fixture.mts --out data/fixture-bake
//   node --conditions source tools/build-corpus-manifest.mts
//   cd apps/editor && FOILKIT_BAKE=fixture pnpm build
//   node apps/editor/e2e/run.mjs

import { createRequire } from 'node:module'
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync, mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..')
const ROOT = path.resolve(APP, '../..')
const DIST = path.join(APP, 'dist')

const PW_ROOT = process.env.PW_ROOT ?? path.join(ROOT, 'package.json')
let chromium
try {
  ;({ chromium } = createRequire(PW_ROOT)('playwright'))
} catch {
  console.error(
    `playwright could not be resolved from ${PW_ROOT}. It is deliberately not a repository ` +
      'dependency; install it somewhere and set PW_ROOT=<that dir>/package.json.',
  )
  process.exit(2)
}

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.error(`no build at ${DIST}. Run: cd apps/editor && FOILKIT_BAKE=fixture pnpm build`)
  process.exit(2)
}

// ── The static server, with vercel.json's SPA fallback ──────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.map': 'application/json',
}

/** Set by a test to make upstream "move" under a staged session. */
let overrides = new Map()

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  if (overrides.has(url)) {
    const body = overrides.get(url)
    if (body === null) {
      res.statusCode = 404
      res.end('gone')
      return
    }
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(body)
    return
  }
  const abs = path.normalize(path.join(DIST, decodeURIComponent(url)))
  if (!abs.startsWith(DIST)) {
    res.statusCode = 400
    res.end('bad path')
    return
  }
  if (existsSync(abs) && statSync(abs).isFile()) {
    res.setHeader('content-type', MIME[path.extname(abs)] ?? 'application/octet-stream')
    createReadStream(abs).pipe(res)
    return
  }
  // vercel.json rewrites `/foil-glyphs` to the generated index; the static
  // server has to do the same or the glyph poller reads the SPA's index.html
  // as its index, which is a different bug in every deployment that has one.
  if (url === '/foil-glyphs') {
    res.setHeader('content-type', 'application/json')
    return createReadStream(path.join(DIST, 'foil-glyphs.json')).pipe(res)
  }
  // Anything under /api/ 404s, exactly as `vite dev` does and as a deploy with
  // no functions would — the editor must read that as "signed out".
  if (url.startsWith('/api/')) {
    res.statusCode = 404
    res.setHeader('content-type', 'application/json')
    res.end('{"error":{"code":"not_running"}}')
    return
  }
  res.setHeader('content-type', MIME['.html'])
  createReadStream(path.join(DIST, 'index.html')).pipe(res)
})

const PORT = Number(process.env.E2E_PORT ?? 5273)
await new Promise((resolve) => server.listen(PORT, resolve))
const BASE = `http://127.0.0.1:${PORT}`

// ── Assertions ──────────────────────────────────────────────────────────────
let passed = 0
const failures = []
function ok(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** A 1x1 opaque PNG. Stands in for a card scan the fixture cannot have. */
const FAKE_SCAN = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z/C/HgAGgwJ/lK3Q6wAAAABJRU5ErkJggg==',
  'base64',
)

const browser = await chromium.launch({
  // WebGL in headless Chromium, the same way the stage's acceptance run gets it.
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
})
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })

// The fixture's card ids are real; its images are not, and `fixture.invalid`
// can never resolve by design. Fulfil them so the viewer has a texture.
await context.route('**://fixture.invalid/**', (route) =>
  route.fulfill({ status: 200, contentType: 'image/png', body: FAKE_SCAN }),
)

const page = await context.newPage()
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

try {
  // ── 1. The queue is the home screen ──────────────────────────────────────
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.waitForSelector('text=Where an hour moves the most pixels', { timeout: 15000 })
  const ruleRows = await page.locator('table tbody tr').count()
  ok('the queue renders rule groups ranked by leverage', ruleRows > 0, `${ruleRows} rows`)
  const workButtons = await page.getByRole('button', { name: 'Work this' }).count()
  ok('every rule group offers a card to work', workButtons === ruleRows)
  const fixtureBanner = await page.locator('text=Fixture data').count()
  ok('a fixture catalog is badged as one, visibly', fixtureBanner === 1)
  const noProgressBar = await page.locator('progress').count()
  ok('there is no completion bar — nothing here is ever finished', noProgressBar === 0)

  // ── 2. Open a card by deep link ──────────────────────────────────────────
  // base1-4 carries a real committed hand mask, which is what makes the seed
  // and the conflict check meaningful rather than synthetic.
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'data', 'corpus-manifest.json'), 'utf8'))
  const variantId = Object.values(manifest.masks['base1-4'])[0].variantId
  await page.goto(`${BASE}/card?id=base1-4&v=${variantId}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('text=Card (full catalog, by era)', { timeout: 20000 })
  // The card id is not rendered anywhere (a contributor reads names), so the
  // deep link is verified against the shard: whatever name the bake gave
  // base1-4 has to be the name on screen.
  const shard = JSON.parse(readFileSync(path.join(ROOT, 'data', 'fixture-bake', 'catalog', 'sets', 'base1.json'), 'utf8'))
  const expectedName = shard.cards.find((c) => c.cardId === 'base1-4').name
  ok(
    'a deep link opens the card it names',
    (await page.getByText(expectedName, { exact: false }).count()) > 0,
    `expected ${expectedName} on screen`,
  )
  ok('and the address bar keeps saying so', page.url().includes('id=base1-4'), page.url())

  // The committed hand mask for this printing has to be what loaded — if the
  // static reader resolved nothing, the whole provenance surface is decorative.
  const provenance = await page.locator('text=/Hand-painted|Hand-refined|AI proposal|Flattened|Layout/').count()
  ok('the committed mask and its provenance loaded from static files', provenance > 0)

  // ── 3. Draw a stroke with a synthetic pointer ────────────────────────────
  await page.getByRole('button', { name: /Edit mask/ }).click()
  await page.waitForSelector('[data-testid="mask-canvas"]', { timeout: 15000 })
  const canvas = page.locator('[data-testid="mask-canvas"]')
  const box = await canvas.boundingBox()
  ok('the mask editor is on screen and has a box', box !== null && box.width > 10)
  // A real drag: down, several moves, up. `MaskEditor` commits on stroke end,
  // so a single click would leave nothing to stage.
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.4)
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(box.x + box.width * (0.35 + i * 0.02), box.y + box.height * (0.4 + i * 0.015))
  }
  await page.mouse.up()
  await page.waitForTimeout(200)

  // ── 4. Save to the session ───────────────────────────────────────────────
  const save = page.getByRole('button', { name: /Save to session/ })
  ok('an unsigned-in visitor is offered the staging path, not a sign-in wall', (await save.count()) === 1)
  await save.click()
  await page.waitForSelector('text=/Staged ✓|Staged 20/', { timeout: 10000 })

  const staged = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('foilkit-staging', 1)
        req.onsuccess = () => {
          const tx = req.result.transaction('sessions', 'readonly')
          const all = tx.objectStore('sessions').getAll()
          all.onsuccess = () => resolve(all.result)
          all.onerror = () => resolve([])
        }
        req.onerror = () => resolve([])
      }),
  )
  ok('the session landed in IndexedDB', staged.length === 1, `${staged.length} session(s)`)
  const s = staged[0] ?? {}
  ok('it is keyed by card and variant', s.id === `mask:base1-4:${variantId}`, String(s.id))
  ok('it carries pixels', typeof s.png === 'string' && s.png.startsWith('data:image/png;base64,'))
  ok('it pins the parent sha at seed time', typeof s.seed?.parentSha256 === 'string', String(s.seed?.parentSha256))
  ok('it records what it started from', s.seed?.startedFrom === 'mask', String(s.seed?.startedFrom))
  ok(
    'THE CLIENT NEVER LABELS A MASK — no derivation_method in the stored session',
    !JSON.stringify(s).includes('derivation_method'),
  )
  ok(
    'the undo stack is NOT persisted — the session is kilobytes, not megabytes',
    JSON.stringify(s).length < 400_000,
    `${JSON.stringify(s).length} bytes`,
  )

  // ── 5. It survives a reload ──────────────────────────────────────────────
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('text=Card (full catalog, by era)', { timeout: 20000 })
  const afterReload = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('foilkit-staging', 1)
        req.onsuccess = () => {
          const tx = req.result.transaction('sessions', 'readonly')
          const all = tx.objectStore('sessions').getAll()
          all.onsuccess = () => resolve(all.result)
        }
      }),
  )
  ok('the session survives a reload', afterReload.length === 1 && afterReload[0].png === s.png)
  await page.waitForSelector('text=/Staged \\d/', { timeout: 15000 })
  ok('the reloaded page shows the staged session', true)

  // ── 6. Export / import round-trip ────────────────────────────────────────
  await page.goto(`${BASE}/staged`, { waitUntil: 'networkidle' })
  await page.waitForSelector('text=Move work between browsers', { timeout: 15000 })
  const download = page.waitForEvent('download', { timeout: 15000 })
  await page.getByRole('button', { name: 'Export all' }).click()
  const file = await download
  const tmp = path.join(mkdtempSync(path.join(tmpdir(), 'foilkit-e2e-')), 'bundle.json')
  await file.saveAs(tmp)
  const bundle = JSON.parse(readFileSync(tmp, 'utf8'))
  ok('the export is a foilkit session bundle', bundle.kind === 'foilkit.staged-sessions')
  ok('it contains the session, pixels and all', bundle.sessions.length === 1 && bundle.sessions[0].png === s.png)

  // Clear the store, then import the file back.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('foilkit-staging', 1)
        req.onsuccess = () => {
          const tx = req.result.transaction('sessions', 'readwrite')
          tx.objectStore('sessions').clear()
          tx.oncomplete = () => resolve(true)
        }
      }),
  )
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('text=Move work between browsers', { timeout: 15000 })
  await page.setInputFiles('input[type=file]', tmp)
  await page.waitForSelector('text=/Imported 1 new/', { timeout: 15000 })
  const reimported = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('foilkit-staging', 1)
        req.onsuccess = () => {
          const tx = req.result.transaction('sessions', 'readonly')
          const all = tx.objectStore('sessions').getAll()
          all.onsuccess = () => resolve(all.result)
        }
      }),
  )
  ok(
    'import round-trips the session exactly',
    reimported.length === 1 && JSON.stringify(reimported[0]) === JSON.stringify(s),
  )

  // ── 7. Upstream moves; the conflict UI appears ───────────────────────────
  // Rewrite the manifest the site serves so a DIFFERENT sha answers for this
  // printing — which is exactly what a second contributor saving over it looks
  // like from here.
  const moved = JSON.parse(JSON.stringify(manifest))
  moved.masks['base1-4'][String(variantId)].sha256 = 'f'.repeat(64)
  overrides.set('/corpus-manifest.json', JSON.stringify(moved))

  await page.goto(`${BASE}/card?id=base1-4&v=${variantId}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('text=parent-changed', { timeout: 20000 })
  ok('a changed upstream sha raises a conflict', true)
  const choices = await Promise.all(
    ['Keep mine', 'Take theirs', 'Re-trace'].map((n) => page.getByRole('button', { name: n }).count()),
  )
  ok('all three choices are offered', choices.every((c) => c === 1), JSON.stringify(choices))
  ok(
    'and nothing offers to merge them',
    (await page.locator('text=/merge|Merge/i').count()) >= 1 &&
      (await page.getByRole('button', { name: /merge/i }).count()) === 0,
  )

  // THE SUBTLE CASE: same bytes, a different record answers. The sha alone
  // cannot see this, so it is asserted separately.
  const aliased = JSON.parse(JSON.stringify(manifest))
  aliased.maskUnits['base1-4|window'] = 99999
  aliased.masks['base1-4']['99999'] = { ...aliased.masks['base1-4'][String(variantId)], variantId: 99999 }
  overrides.set('/corpus-manifest.json', JSON.stringify(aliased))
  await page.goto(`${BASE}/card?id=base1-4&v=${variantId}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('text=alias-moved', { timeout: 20000 })
  ok('an alias that moved raises a conflict even with identical pixels', true)

  overrides = new Map()

  // ── 8. The glyph slot is present and EMPTY ───────────────────────────────
  // `uGlyphOn` stays 0 and every slotted pattern renders its procedural
  // fallback. An empty index is a different claim from a 404: it says the
  // surface is here and nothing has been dropped into it, which is true, and it
  // is what makes the first original asset a drop rather than a wiring job.
  const glyphs = await page.evaluate(async () => {
    const res = await fetch('/foil-glyphs')
    return res.ok ? await res.json() : null
  })
  ok('the glyph slot answers with an index, not a 404', glyphs !== null)
  ok('and the slot is empty, which is the shipping state', Object.keys(glyphs?.patterns ?? {}).length === 0)

  // ── 9. No console errors on the happy path ───────────────────────────────
  const real = consoleErrors.filter(
    (t) => !/fixture\.invalid|ERR_NAME_NOT_RESOLVED|Failed to load resource.*40[34]/.test(t),
  )
  ok('no unexplained console errors', real.length === 0, real.slice(0, 3).join(' | '))
} catch (err) {
  failures.push(`threw: ${err.message}`)
  console.error(err)
  await page.screenshot({ path: path.join(HERE, 'failure.png') }).catch(() => undefined)
} finally {
  await browser.close()
  server.close()
}

const report = { passed, failed: failures.length, failures, at: new Date().toISOString() }
writeFileSync(path.join(HERE, 'last-run.json'), JSON.stringify(report, null, 2) + '\n')
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
