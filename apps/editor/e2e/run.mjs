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
//   cd apps/editor && FOILKIT_BAKE=fixture pnpm build   # prebuild writes both
//   node apps/editor/e2e/run.mjs                        # generated artifacts
//
// The editor's `prebuild` runs `build-corpus-manifest.mts` and
// `build-task-queue.mts`, so the fixture bake's `task-queue.json` — which the
// laundry-list assertions read as their expected values — is written by the
// build itself rather than by a step this comment could go stale about.

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
  // R8-INK: without this an ink tile 200s as application/octet-stream and the
  // <img> silently refuses it — a tile that is present renders exactly like a
  // tile that is absent. Vercel's static host gets it right; this mirror of it
  // did not, and neither did tools/parity/serve.mjs.
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
}

/** Set by a test to make upstream "move" under a staged session. */
let overrides = new Map()

/**
 * Set by a test to make matching artifacts answer SLOWLY.
 *
 * Not a flourish: two of the bugs this run exists to catch are races that a
 * localhost static server cannot lose. On the deployed site the card-detail
 * shard is a cold CDN fetch while `catalog/index.json` is already warm, so the
 * picker's auto-select chain finishes first and overwrites the deep link. Every
 * file here answers in under a millisecond, so the chain never gets the chance
 * and the test passes against the bug — which is the worst outcome a regression
 * test has. Delaying the specific artifacts that are cold in production is what
 * makes the race REPRODUCIBLE rather than lucky.
 */
let slowUrls = null
const SLOW_MS = 600

const server = createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  if (slowUrls !== null && slowUrls.test(url)) await new Promise((r) => setTimeout(r, SLOW_MS))
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

/**
 * The stand-in card scan, and it is deliberately NOT a flat colour.
 *
 * Top half white, bottom half black. That asymmetry is the whole point: the
 * face texture shipped upside down for an entire release and every check the
 * project had missed it, because the render-parity harness and the stage
 * acceptance both run on BLANK bases where a flip is invisible by construction.
 * A one-pixel fixture would have hidden it here too.
 */
const { encodePng } = await import('@foilkit/forge')
const SCAN_W = 64
const SCAN_H = 88
const FAKE_SCAN = (() => {
  const rgba = new Uint8Array(SCAN_W * SCAN_H * 4)
  for (let y = 0; y < SCAN_H; y++) {
    const v = y < SCAN_H / 2 ? 255 : 0
    for (let x = 0; x < SCAN_W; x++) {
      const o = (y * SCAN_W + x) * 4
      rgba[o] = rgba[o + 1] = rgba[o + 2] = v
      rgba[o + 3] = 255
    }
  }
  return encodePng({ width: SCAN_W, height: SCAN_H, rgba })
})()

/**
 * Press "Provisional diff" and return the numbers it prints, as one string.
 *
 * The numbers are a fingerprint of the CANVAS — the editor rasterizes the era
 * rule and diffs the live alpha against it — which is what makes them the right
 * thing to compare across a reload. Every digit on the line is captured rather
 * than parsed into fields: a comparison that decides which digits matter is a
 * comparison that can be made to pass.
 */
async function readProvisional(page) {
  await page.getByRole('button', { name: 'Provisional diff' }).click()
  const line = page.locator('[data-testid="provisional-diff"]')
  await line.waitFor({ timeout: 10000 })
  const text = await line.innerText()
  const nums = text.match(/[\d][\d.,]*/g)
  return nums === null ? null : nums.join('|')
}

/** Every staged session in the page's IndexedDB. */
function readSessions(page) {
  return page.evaluate(
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
}

/** setId from a cardId — everything before the last `-`, the bake's own rule. */
const setIdOf = (cardId) => cardId.slice(0, cardId.lastIndexOf('-'))

/**
 * A fixture card's printed name, read from whichever page of its set shard
 * holds it.
 *
 * It walks hyphens right-to-left for the same reason `Catalog.setIdCandidates`
 * does: the fixture deliberately contains a promo whose NUMBER carries a hyphen
 * (`fxsp-FX-257`), so "everything before the last hyphen" names no shard. A
 * helper that could not find those cards failed the assertion on whichever runs
 * the queue happened to sample one — a flake that reports the FIXED code as
 * broken, which is how a regression test loses its authority.
 */
function fixtureCard(cardId) {
  const dir = path.join(ROOT, 'data', 'fixture-bake', 'catalog', 'sets')
  for (let cut = cardId.lastIndexOf('-'); cut > 0; cut = cardId.lastIndexOf('-', cut - 1)) {
    const setId = cardId.slice(0, cut)
    for (const file of [`${setId}.json`, `${setId}.p2.json`, `${setId}.p3.json`]) {
      const abs = path.join(dir, file)
      if (!existsSync(abs)) continue
      const shard = JSON.parse(readFileSync(abs, 'utf8'))
      const found = shard.cards.find((c) => c.cardId === cardId)
      if (found) return { ...found, setName: shard.set.name }
    }
  }
  return null
}

/**
 * The line the viewer prints under the card name: `<set> · #<number>`.
 *
 * The NAME alone is not enough to identify a card here. The fixture reuses
 * Greek-letter names across sets — `fxs1-1` and `fxp2.5-1` are both
 * "9 Fixture" — so asserting on the name would pass while the editor showed a
 * card from a different set, which is the exact failure being tested for. Set
 * plus number is unique.
 */
function fixtureCardLabel(cardId) {
  const c = fixtureCard(cardId)
  return c === null ? null : `${c.setName} · #${c.number}`
}

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

  // ── 1b. THE LAUNDRY LIST ─────────────────────────────────────────────────
  //
  // The leverage table answers one question. #11 made it one section of a full
  // contribution list generated from six committed artifacts, and everything
  // below is about that list being REAL: the cards come from the artifact, the
  // filters actually filter, and the guards are rendered where they apply.
  const queueFile = JSON.parse(readFileSync(path.join(ROOT, 'data', 'fixture-bake', 'task-queue.json'), 'utf8'))
  await page.waitForSelector('[data-testid="task-list"]', { timeout: 15000 })
  const cardCount = await page.locator('[data-testid="task-list"] > li').count()
  ok(
    'the queue renders task cards, not just a leverage table',
    cardCount > 0 && cardCount <= queueFile.tasks.length,
    `${cardCount} card(s) of ${queueFile.tasks.length}`,
  )
  ok(
    'and it says how many there are in total, rather than implying the first screen is all of it',
    (await page.getByText(`${queueFile.counts.tasks} things`, { exact: false }).count()) > 0,
    `expected "${queueFile.counts.tasks} things"`,
  )

  // The first card is the artifact's first card. If the page re-sorted, the
  // impact ranking the generator computed would be decorative.
  const firstCardText = await page.locator('[data-testid="task-list"] > li').first().innerText()
  ok(
    'the first card is the highest-impact task in the artifact — the page does not re-rank',
    firstCardText.includes(queueFile.tasks[0].title),
    `expected "${queueFile.tasks[0].title}", got "${firstCardText.split('\n').slice(0, 2).join(' / ')}"`,
  )

  for (const heading of [
    'Everything that needs doing',
    'Recipes the resolver never picks',
    'What the documents say, and what the data says',
  ]) {
    ok(`the queue renders the "${heading}" section`, (await page.getByText(heading, { exact: false }).count()) > 0)
  }

  // ── 1c. THE SKILL FILTER ─────────────────────────────────────────────────
  //
  // Pressed for real, and checked against the ARTIFACT's own counts rather
  // than against whatever the page says it filtered to — a filter test that
  // trusts the page for its expected value proves nothing.
  const maskChip = `Mask drawing (${queueFile.counts.bySkill.mask})`
  await page.getByRole('button', { name: maskChip }).click()
  await page.waitForTimeout(200)
  const afterFilter = await page.locator('[data-testid="task-list"] > li').count()
  ok(
    'the skill filter narrows the list to that skill',
    afterFilter === Math.min(queueFile.counts.bySkill.mask, 20),
    `${afterFilter} shown, expected ${Math.min(queueFile.counts.bySkill.mask, 20)}`,
  )
  const shownCards = await page.locator('[data-testid="task-list"] > li').allInnerTexts()
  ok(
    'and every card it left is a mask-drawing card',
    shownCards.length > 0 && shownCards.every((t) => t.includes('Mask drawing')),
    shownCards.find((t) => !t.includes('Mask drawing'))?.slice(0, 90) ?? '',
  )
  await page.getByRole('button', { name: maskChip }).click()

  // The live-tilt chip: a skill that exists only because a still-frame judge
  // is structurally blind to motion. Its cards must SAY that, in words.
  const tiltChip = `Live tilt (${queueFile.counts.bySkill['live-tilt']})`
  await page.getByRole('button', { name: tiltChip }).click()
  await page.waitForTimeout(200)
  ok(
    'the live-tilt filter finds the verdicts a still-frame judge cannot settle',
    (await page.locator('[data-testid="task-list"] > li').count()) === queueFile.counts.bySkill['live-tilt'],
  )
  const tiltGuards = await page.locator('[data-testid="task-guard"]').allInnerTexts()
  ok(
    'and those cards say the ask is a live-tilt human verdict, NOT another GLSL round',
    tiltGuards.length > 0 && tiltGuards.every((t) => /not another GLSL round/i.test(t)),
    `${tiltGuards.length} guard(s) rendered`,
  )
  await page.getByRole('button', { name: tiltChip }).click()
  await page.waitForTimeout(200)

  // ── 1d. THE TWO GUARDS THAT ARE THE POINT ────────────────────────────────
  const diagnoses = await page.locator('[data-testid="diagnosis-verbatim"]').allInnerTexts()
  const bakeSentences = queueFile.emptyPools.map((p) => p.detail)
  ok(
    "the empty-pool diagnosis is the bake's own sentence, unedited",
    diagnoses.length === bakeSentences.length && diagnoses.every((t, i) => t.trim() === bakeSentences[i].trim()),
    `${diagnoses.length} rendered vs ${bakeSentences.length} in the artifact`,
  )
  if (queueFile.emptyPools.some((p) => p.reason === 'outranked')) {
    ok(
      'an outranked pool renders the do-not-flip-a-winner guard',
      (await page.getByText('Do not flip a resolver winner', { exact: false }).count()) > 0,
    )
  }
  ok(
    'the queue shows where the documents and the data disagree',
    (await page.locator('[data-testid="reconciliation"]').count()) === queueFile.reconciliation.length,
  )

  // ── 1d-ii. EVERY CARD IN THE ARTIFACT RENDERS ────────────────────────────
  //
  // THE ONE THAT WOULD HAVE CAUGHT THE WHITE SCREEN.
  //
  // The queue's landing screen shows the first 20 cards. When the builder
  // gained a seventh source, the client had no label for the new type, reading
  // the badge off the table threw, and React unmounted the whole app — in
  // PRODUCTION, where those cards rank 10th and 11th. CI missed it because the
  // fixture could not size them, `null` sorts last, and they landed at 60-65:
  // past the first screen, never rendered, never a failure.
  //
  // Both halves of that are now closed. The fixture carries the ink registry's
  // real set ids so its ink cards rank inside the first screen the way
  // production's do (tools/bake-fixture.mts), and this presses "Show the other
  // N" so the run renders EVERY card in the artifact regardless of how any
  // future source happens to rank. A card that cannot be labelled must render
  // degraded, not take the page with it.
  const listItems = page.locator('[data-testid="task-list"] > li')
  const firstScreen = await listItems.count()
  ok(
    'the first screen is capped, and says how many are behind the cap',
    firstScreen === Math.min(20, queueFile.tasks.length),
    `${firstScreen} shown of ${queueFile.tasks.length}`,
  )
  const kindsOnFirstScreen = new Set(queueFile.tasks.slice(0, firstScreen).map((t) => t.type))
  ok(
    'the fixture ranks an ink-tile card inside the first screen, exactly as production does',
    kindsOnFirstScreen.has('ink-tile'),
    `first screen carries: ${[...kindsOnFirstScreen].join(', ')}`,
  )
  const showRest = page.getByRole('button', { name: /^Show the other \d+$/ })
  ok('the tail is one press away, and the button says how many', (await showRest.count()) === 1)
  await showRest.click()
  await page.waitForTimeout(300)
  const allCards = await listItems.count()
  ok(
    'pressing it renders every card in the artifact',
    allCards === queueFile.tasks.length,
    `${allCards} rendered of ${queueFile.tasks.length}`,
  )
  // A label lookup that came back undefined renders an EMPTY badge rather than
  // throwing, once the page is hardened — so an empty badge is still a bug, and
  // it is checked separately from the page surviving.
  const badges = await page.locator('[data-testid="task-badge"]').allInnerTexts()
  ok(
    'every card wears a kind badge with words in it',
    badges.length === queueFile.tasks.length && badges.every((b) => b.trim().length > 0),
    `${badges.filter((b) => b.trim().length === 0).length} blank of ${badges.length}`,
  )
  const skillLines = await page.locator('[data-testid="task-skill"]').allInnerTexts()
  ok(
    'and names a skill and an estimate a contributor can plan around',
    skillLines.length === queueFile.tasks.length && skillLines.every((s) => /\S+.*·.*\S+/.test(s)),
    skillLines.find((s) => !/\S+.*·.*\S+/.test(s)) ?? '',
  )
  // Every DISTINCT kind the artifact carries is on screen. A kind the client
  // silently dropped would leave its cards unrendered while the count above
  // still matched, if two bugs ever cancelled.
  const artifactKinds = [...new Set(queueFile.tasks.map((t) => t.type))]
  const missingKinds = artifactKinds.filter((k) => !badges.some((b) => b.trim().length > 0))
  ok(
    `all ${artifactKinds.length} kinds in the artifact reached the screen`,
    missingKinds.length === 0 && new Set(badges.map((b) => b.trim())).size >= artifactKinds.length,
    `${new Set(badges.map((b) => b.trim())).size} distinct badges for ${artifactKinds.length} kinds`,
  )
  // The `art` skill's chip, which only exists because of the seventh source.
  ok(
    'the new skill has a chip of its own, with its cards behind it',
    (await page.getByRole('button', { name: `Original geometry (${queueFile.counts.bySkill.art})` }).count()) === 1,
    `expected an "Original geometry (${queueFile.counts.bySkill.art})" chip`,
  )
  // The guard is the whole point of an ink-tile card: a queued slot with no
  // caution attached is a slot somebody eventually fills with a tracing.
  ok(
    'and an ink-tile card carries the originals-only caution, rendered',
    (await page.getByText('may be filled ONLY by an original recreation', { exact: false }).count()) > 0,
  )
  // A React unmount is not a console error; it is a pageerror. Checked HERE
  // rather than only at the end, so the failure names the list that caused it.
  ok(
    'rendering the whole list threw nothing — the page is still mounted',
    consoleErrors.filter((t) => t.startsWith('pageerror:')).length === 0,
    consoleErrors.filter((t) => t.startsWith('pageerror:')).slice(0, 2).join(' | '),
  )

  // ── 1e. A TASK CARD DEEP-LINKS TO THE CARD IT NAMES ──────────────────────
  //
  // The one journey that makes the list a queue rather than a report. It uses
  // the highest-impact card that HAS a card link, and asserts on the set+number
  // line rather than the name, for the reason fixtureCardLabel documents.
  const linked = queueFile.tasks.find((t) => t.link !== null && t.link.startsWith('/card?id='))
  if (linked) {
    const linkedId = new URLSearchParams(linked.link.slice(linked.link.indexOf('?'))).get('id')
    await page.getByRole('button', { name: `${linked.type === 'mask' ? 'Mask drawing' : 'Research / citation'} (${queueFile.counts.bySkill[linked.skill]})` }).click()
    await page.waitForTimeout(200)
    const openIt = page.getByRole('button', { name: 'Open it' }).first()
    await openIt.click()
    await page.waitForURL(/\/card\?id=/, { timeout: 15000 })
    await page.waitForSelector('text=Card (full catalog, by era)', { timeout: 20000 })
    await page.waitForTimeout(2000)
    const landed = new URL(page.url()).searchParams.get('id')
    ok('a task card deep-links to the card it names', landed === linkedId, `asked ${linkedId}, landed ${landed}`)
    ok(
      'and that card is the one on screen',
      (await page.getByText(fixtureCardLabel(linkedId) ?? ' ', { exact: false }).count()) > 0,
      `expected "${fixtureCardLabel(linkedId)}" for ${linkedId}`,
    )
  } else {
    ok('a task card deep-links to the card it names', false, 'no task in the fixture queue carries a /card link')
  }

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

  // …and an ERASE stroke, which is not decoration.
  //
  // The brush stroke above lands INSIDE the committed mask, where it changes
  // partial alpha and nothing else — and the provisional diff is thresholded at
  // alpha ≥ 128, so it reports the identical numbers for the drawn canvas and
  // for plain upstream (measured: 66.4% / +0 / −39,869 either way). An assertion
  // that the numbers survive a reload would then have held while the pixels were
  // being destroyed, which is the exact failure mode it exists to catch. Erasing
  // removes covered pixels, and a change the diff can measure is the only kind
  // this test can pin.
  await page.getByRole('button', { name: 'Erase', exact: true }).first().click()
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.32)
  await page.mouse.down()
  for (let i = 1; i <= 16; i++) {
    await page.mouse.move(box.x + box.width * (0.3 + i * 0.025), box.y + box.height * 0.32)
  }
  await page.mouse.up()
  await page.getByRole('button', { name: 'Brush', exact: true }).first().click()
  await page.waitForTimeout(200)

  // WHAT THE CONTRIBUTOR JUST DREW, as a number, read HERE — before anything is
  // staged.
  //
  // Because staging was itself one of the ways the pixels got destroyed:
  // `staging.save` re-reads the session store, the store's list was a dependency
  // of the mask loader, so pressing "Save to session" re-ran the upstream fetch
  // and painted over the very canvas it had just written. Taking the reading
  // afterwards compares upstream against upstream and calls it stable.
  const provisionalNow = await readProvisional(page)
  ok(
    'the provisional diff reports numbers for the drawn mask',
    provisionalNow !== null,
    String(provisionalNow),
  )

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
  let s = staged[0] ?? {}
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

  // Staging must not have moved the canvas either — same numbers, still.
  ok(
    'staging the session does not repaint the canvas from upstream',
    (await readProvisional(page)) === provisionalNow,
    String(provisionalNow),
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

  // ── 5b. THE STAGED PIXELS SURVIVE THE RELOAD, NOT JUST THE RECORD ────────
  //
  // The regression this exists for: the session record came back and the
  // PIXELS did not. `getMask` fetched the committed upstream mask and drew it
  // over the canvas, unguarded, while the staged restore had already latched
  // and would not run again — a network fetch beats a data-URL decode every
  // time. The record survived, the contribution did not, and the next "Save to
  // session" wrote the upstream pixels over it. Measured live at 61.1% → 66.4%
  // agreement, which is exactly the upstream mask's own number.
  //
  // ASSERT THE NUMBERS, NOT THE EXISTENCE OF A SESSION. "A session is still
  // there" was already true while this bug was destroying work — it is what
  // made the bug invisible.
  // SETTLE FIRST. Reading the canvas the instant the session badge appears is
  // how this assertion passes against the bug: the staged restore is a local
  // decode and lands quickly, the upstream fetch that clobbers it lands a beat
  // later. Give the clobber every chance to happen before measuring.
  await page.waitForTimeout(2500)
  const provisionalAfter = await readProvisional(page)
  ok(
    'the provisional diff is UNCHANGED across a reload — the staged pixels own the canvas',
    provisionalAfter !== null && provisionalAfter === provisionalNow,
    `before ${provisionalNow} / after ${provisionalAfter}`,
  )

  // …and staging again writes back what was restored, not what upstream holds.
  await page.getByRole('button', { name: /Save to session/ }).click()
  await page.waitForSelector('text=/Staged ✓|Staged 20/', { timeout: 10000 })
  const restaged = await readSessions(page)
  ok(
    'saving to the session after a reload does not overwrite the staged PNG with upstream',
    restaged.length === 1 && restaged[0].png === s.png,
    restaged.length === 1 ? `${(restaged[0].png ?? '').length} vs ${(s.png ?? '').length} bytes` : 'no session',
  )
  // The re-save bumped `updatedAt`, so the export/import round trip below has to
  // compare against the record as it stands now rather than as it was staged.
  s = restaged[0] ?? s

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

  // ── 8. THE CARD IS THE RIGHT WAY UP ──────────────────────────────────────
  //
  // The scan is white on top, black on the bottom. Sample the rendered card and
  // assert the same. This is the check that did not exist when the face texture
  // uploaded bottom-up on every real deploy: `uScanBase 0` renders a flat base,
  // so a vertical flip cannot be seen without a scan that has a top and a
  // bottom. It reads the CANVAS rather than a screenshot, so it fails on the
  // pixels rather than on a diff threshold.
  await page.goto(`${BASE}/card?id=base1-4&v=${variantId}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('canvas', { timeout: 20000 })
  await page.waitForTimeout(2500)
  const orientation = await page.evaluate(() => {
    const card = [...document.querySelectorAll('canvas')]
      .map((c) => ({ c, r: c.getBoundingClientRect() }))
      .filter((x) => x.r.width > 100 && x.r.width < window.innerWidth)
      .sort((a, b) => b.r.width - a.r.width)[0]
    if (!card) return null
    const t = document.createElement('canvas')
    t.width = 32
    t.height = 32
    const g = t.getContext('2d', { willReadFrequently: true })
    g.drawImage(card.c, 0, 0, 32, 32)
    const d = g.getImageData(0, 0, 32, 32).data
    const band = (y0, y1) => {
      let sum = 0
      let n = 0
      for (let y = y0; y < y1; y++)
        for (let x = 8; x < 24; x++) {
          const i = (y * 32 + x) * 4
          sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
          n++
        }
      return sum / n
    }
    // Skip the outer rows: the mesh has margin inside its box.
    return { top: band(6, 13), bottom: band(19, 26) }
  })
  ok('the rendered card samples its scan somewhere', orientation !== null)
  ok(
    'the card is the RIGHT WAY UP — the scan’s white half renders at the top',
    orientation !== null && orientation.top > orientation.bottom + 20,
    orientation === null ? 'no canvas' : `top ${orientation.top.toFixed(1)} vs bottom ${orientation.bottom.toFixed(1)}`,
  )

  // ── 9. The glyph slot is present and EMPTY ───────────────────────────────
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

  // ── 9b. THE REFERENCE PANE: A CLICK BUYS THE EMBED, NOTHING ELSE DOES ────
  //
  // The other slot that shipped empty. Subtask 2 removed the committed clip
  // per pattern (cited, never vendored — AGENTS.md F2) and this fills it with
  // an embed of the same seconds of the same source video.
  //
  // NOTHING HERE TOUCHES youtube.com. The IFrame API script and the player
  // origin are both intercepted: CI must not depend on a third party being up,
  // and a test that silently started hitting the network would be measuring
  // Google's uptime rather than this repository's behaviour. The stub is a real
  // `YT.Player` shape whose clock runs forward, which is what lets the loop be
  // observed rather than assumed.
  {
    const clips = JSON.parse(
      readFileSync(path.join(ROOT, 'packages', 'patterns', 'src', 'reference-clips.json'), 'utf8'),
    )
    // `cosmos` is the canon lab's default pattern (CanonLab.tsx loadPatternId).
    const cosmos = clips.clips['cosmos']
    const creator = clips.sources[cosmos.videoId].creator

    const ref = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    // Every request to a Google-owned host, in order. The privacy claim the
    // pane makes is a claim about THIS list being empty before the click.
    const thirdParty = []
    ref.on('request', (r) => {
      const host = new URL(r.url()).hostname
      if (/youtube|ytimg|google|ggpht|doubleclick/.test(host)) thirdParty.push(host)
    })

    const STUB_API = `
      window.__ytSeeks = [];
      window.__ytAdopted = [];
      window.YT = { Player: function (el, cfg) {
        var self = this;
        window.__ytAdopted.push(el && el.tagName === 'IFRAME' ? el.getAttribute('src') : String(el));
        var t = 0;
        this.getCurrentTime = function () { t += 2; return t; };
        this.seekTo = function (s) { window.__ytSeeks.push(s); t = s; };
        this.destroy = function () { window.__ytDestroyed = true; };
        setTimeout(function () {
          if (cfg && cfg.events && cfg.events.onReady) cfg.events.onReady({ target: self });
        }, 0);
      } };
      if (window.onYouTubeIframeAPIReady) window.onYouTubeIframeAPIReady();
    `
    await ref.route('**/iframe_api*', (route) =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: STUB_API }),
    )
    await ref.route('**://*.youtube-nocookie.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub player</title>' }),
    )

    const refPage = await ref.newPage()
    await refPage.goto(`${BASE}/canon`, { waitUntil: 'networkidle' })
    await refPage.waitForSelector('[data-testid="reference-pane"]', { timeout: 20000 })

    // 1. THE PLACEHOLDER. Local markup, the datum's own text, and — the whole
    // point — not one byte fetched from Google. The tempting placeholder is the
    // video's own thumbnail from i.ytimg.com, which would be the same
    // third-party request on page load wearing a different hostname.
    ok(
      'the reference pane renders its placeholder before anything is activated',
      (await refPage.getByText('Load the reference clip').count()) === 1,
    )
    ok(
      'and the placeholder names the video and the seconds it will loop',
      (await refPage.getByText(clips.sources[cosmos.videoId].title, { exact: false }).count()) > 0 &&
        (await refPage.getByText('loops', { exact: false }).count()) > 0,
    )
    ok(
      'NOTHING is fetched from a Google host until the click',
      thirdParty.length === 0,
      thirdParty.join(', '),
    )
    ok('no iframe exists yet either', (await refPage.locator('iframe').count()) === 0)

    // 2. THE CLICK. It buys an iframe on the nocookie domain, with the params
    // that make the JS API and mobile autoplay work at all.
    await refPage.getByTestId('reference-activate').click()
    await refPage.waitForSelector('iframe', { timeout: 15000 })
    const src = await refPage.locator('iframe').first().getAttribute('src')
    const embed = new URL(src)
    ok(
      'the player is embedded from youtube-nocookie.com, not youtube.com',
      embed.hostname === 'www.youtube-nocookie.com',
      embed.hostname,
    )
    ok('and it embeds the video the notes cite', embed.pathname.endsWith(`/${cosmos.videoId}`), embed.pathname)
    ok(
      'enablejsapi=1 is set, or the loop would poll a player that never answers',
      embed.searchParams.get('enablejsapi') === '1',
    )
    ok(
      'mute=1 and playsinline=1 — autoplay does not fire unmuted, and review happens on phones',
      embed.searchParams.get('mute') === '1' && embed.searchParams.get('playsinline') === '1',
    )
    ok(
      'the start param is an INTEGER, because that parameter takes nothing else',
      embed.searchParams.get('start') === String(Math.floor(cosmos.clipStart)),
      embed.searchParams.get('start'),
    )

    // 3. THE LOOP. The stub's clock runs forward past the clip end; the pane
    // must send it back — to the FRACTIONAL start, which is the bound the notes
    // record and the one the integer `start` param cannot express.
    await refPage.waitForFunction(() => (window.__ytSeeks ?? []).length > 0, null, { timeout: 15000 })
    const seeks = await refPage.evaluate(() => window.__ytSeeks)
    ok(
      'the loop seeks back to the clip start once playback passes the end',
      seeks.length > 0 && seeks.every((s) => s === cosmos.clipStart),
      `${JSON.stringify(seeks)} vs ${cosmos.clipStart}`,
    )
    const adopted = await refPage.evaluate(() => window.__ytAdopted)
    ok(
      'the API ADOPTED our own iframe — that is what keeps the nocookie domain ours',
      adopted.length === 1 && String(adopted[0]).includes('youtube-nocookie.com'),
      JSON.stringify(adopted),
    )

    // 4. THE CREDIT. In every state, and it claims no permission — nobody has
    // been asked, and a line saying otherwise would be false about a real person.
    ok('the creator is credited by name', (await refPage.getByText(creator, { exact: false }).count()) > 0)
    const watch = await refPage.getByRole('link', { name: /watch on YouTube/i }).getAttribute('href')
    ok(
      'and the link out carries the timestamp, so the view lands on the demo',
      watch.includes(`t=${Math.floor(cosmos.clipStart)}`),
      watch,
    )
    ok(
      'no permission is claimed anywhere in the pane',
      (await refPage.getByText(/with permission/i).count()) === 0,
    )

    // 5. THE SAME PANE ON SURFACE B, COLLAPSED. Card adjust is about one card's
    // differences from the canon, so the pattern's generic footage rides along
    // behind a disclosure rather than taking a column. The claim worth pinning
    // is that being on the page costs nothing: closed, and no Google host
    // contacted by simply opening a card.
    const cardCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const cardHosts = []
    cardCtx.on('request', (r) => {
      const host = new URL(r.url()).hostname
      if (/youtube|ytimg|google|ggpht|doubleclick/.test(host)) cardHosts.push(host)
    })
    await cardCtx.route('**://fixture.invalid/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: FAKE_SCAN }),
    )
    const cardPage = await cardCtx.newPage()
    await cardPage.goto(`${BASE}/card?id=base1-4&v=${variantId}`, { waitUntil: 'networkidle' })
    await cardPage.waitForSelector('text=Card (full catalog, by era)', { timeout: 20000 })
    const disclosure = cardPage.locator('details', { hasText: 'Reference clip' }).first()
    ok('card adjust carries the reference pane behind a disclosure', (await disclosure.count()) === 1)
    ok('and it is CLOSED — the clip is a thing you go and check, not the view', await disclosure.evaluate((d) => !d.open))
    ok('opening a card contacts no Google host', cardHosts.length === 0, cardHosts.join(', '))
    await cardCtx.close()

    // 6. OFFLINE. A blocked or unreachable IFrame API must leave a pane that
    // can still do the work by hand: the link, and the seconds to watch. This
    // is not a rare case — a content blocker is enough to produce it.
    const offline = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await offline.route('**/iframe_api*', (route) => route.abort())
    const offPage = await offline.newPage()
    await offPage.goto(`${BASE}/canon`, { waitUntil: 'networkidle' })
    await offPage.getByTestId('reference-activate').click()
    await offPage.waitForSelector('text=The embedded player is unavailable', { timeout: 20000 })
    ok('an IFrame API that will not load degrades to a stated failure, not a blank box', true)
    const fallback = await offPage.getByRole('link', { name: /Open at /i }).getAttribute('href')
    ok(
      'and the fallback link still lands on the clip, so the work is still doable',
      fallback.includes(`t=${Math.floor(cosmos.clipStart)}`),
      fallback,
    )
    ok(
      'the bounds are on screen in that state too',
      (await offPage.getByText('0:45.6', { exact: false }).count()) > 0,
    )
    await offline.close()

    // 7. NO CLIP, HONESTLY. `none` is the plain-card baseline: no foil, nothing
    // to film. It is not offered in the picker, so the state is reached the way
    // a stale preference would reach it — which is exactly the path that would
    // otherwise rot unnoticed.
    const bare = await browser.newContext({ viewport: { width: 390, height: 844 } })
    await bare.addInitScript(() => localStorage.setItem('foil-lab:canon-pattern', 'none'))
    const barePage = await bare.newPage()
    await barePage.goto(`${BASE}/canon`, { waitUntil: 'networkidle' })
    await barePage.waitForSelector('[data-testid="reference-pane"]', { timeout: 20000 })
    ok(
      'a pattern with no reference says so, rather than rendering an empty box',
      (await barePage.getByText('No physical reference', { exact: false }).count()) === 1,
    )
    ok(
      'and it offers no player to activate',
      (await barePage.getByText('Load the reference clip').count()) === 0,
    )
    // 390px is the review width — the pane must not push the page sideways.
    const overflow = await barePage.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    )
    ok('the canon lab does not scroll horizontally at 390px', overflow)
    await bare.close()
    await ref.close()
  }

  // ── 10. THE CARD YOU ASKED FOR IS THE CARD YOU GET ───────────────────────
  //
  // The regression this exists for: a deep link arrives with its series and set
  // slots empty, because only the card detail knows what they are. The
  // auto-select chain fills empty slots — and the SET step fills `setId` by
  // clearing `cardId` — so it resolved first, landed on Base Set Machamp, and
  // the URL-sync effect then rewrote the address bar to match. Measured live at
  // 3/3 wrong for queue picks outside `base1` and 2/4 wrong for cold deep links.
  //
  // Both entry points are exercised, because they fail the same way and are
  // fixed by the same guard, and because "the queue sends you somewhere else"
  // is the one that costs a contributor an hour.
  // Everything the DEFAULT chain needs stays instant; everything a non-default
  // card needs goes cold. That is the production shape of this race, and the
  // only shape in which the bug is visible at all.
  slowUrls = /^\/catalog\/(sets\/(?!base1\.json)|series\/(?!base\.json))/

  const queueTargets = []
  for (let row = 0; row < 4; row++) {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
    await page.waitForSelector('text=Where an hour moves the most pixels', { timeout: 15000 })
    const button = page.getByRole('button', { name: 'Work this' }).nth(row)
    if ((await button.count()) === 0) break
    await button.click()
    await page.waitForURL(/\/card\?id=/, { timeout: 15000 })
    const asked = new URL(page.url()).searchParams.get('id')
    await page.waitForSelector('text=Card (full catalog, by era)', { timeout: 20000 })
    // Long enough for the series → sets → cards chain to have run if it were
    // going to. A shorter wait would pass against the bug it is here to catch.
    await page.waitForTimeout(2000)
    const landed = new URL(page.url()).searchParams.get('id')
    const label = fixtureCardLabel(asked)
    queueTargets.push(asked)
    ok(
      `queue row ${row}: the address bar still says the card it picked`,
      landed === asked,
      `asked ${asked}, landed ${landed}`,
    )
    ok(
      `queue row ${row}: and that card is the one on screen`,
      label !== null && (await page.getByText(label, { exact: false }).count()) > 0,
      `expected "${label}" for ${asked}`,
    )
  }
  ok(
    'at least one queue pick was OUTSIDE base1 — otherwise this proves nothing',
    queueTargets.some((id) => setIdOf(id) !== 'base1'),
    queueTargets.join(', '),
  )

  // A COLD deep link into a different series, with no localStorage help: a fresh
  // context, one navigation, and the card had better be the one named.
  const cold = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await cold.route('**://fixture.invalid/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: FAKE_SCAN }),
  )
  const coldPage = await cold.newPage()
  const COLD_ID = 'fxs1-1'
  const coldVariant = JSON.parse(
    readFileSync(path.join(ROOT, 'data', 'fixture-bake', 'catalog', 'sets', 'fxs1.json'), 'utf8'),
  ).cards.find((c) => c.cardId === COLD_ID).variants[0].variantId
  await coldPage.goto(`${BASE}/card?id=${COLD_ID}&v=${coldVariant}`, { waitUntil: 'networkidle' })
  await coldPage.waitForSelector('text=Card (full catalog, by era)', { timeout: 20000 })
  await coldPage.waitForTimeout(2000)
  ok(
    'a cold deep link outside the default series keeps its id in the address bar',
    new URL(coldPage.url()).searchParams.get('id') === COLD_ID,
    coldPage.url(),
  )
  ok(
    'and opens that card, not the auto-selected default',
    (await coldPage.getByText(fixtureCardLabel(COLD_ID), { exact: false }).count()) > 0,
    `expected "${fixtureCardLabel(COLD_ID)}"`,
  )
  await cold.close()
  slowUrls = null

  // ── 11. No console errors on the happy path ──────────────────────────────
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
