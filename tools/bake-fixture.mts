// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// tools/bake-fixture.mts — a small SYNTHETIC bake, so apps/editor is testable
// before anybody with a database has run the real one.
//
// No Postgres, no network, no third-party bytes. It fabricates a catalog and
// hands it to the SAME emitter tools/bake-catalog.mts uses
// (tools/bake/emit.ts). That sharing is the whole design: a fixture with its
// own writer would let the editor be built against a shape the real bake never
// produces, and the mismatch would surface after a deploy, on real data, in
// front of somebody.
//
//   node --conditions source tools/bake-fixture.mts [--out <dir>] [--name <n>]
//
// Default output is <root>/data/fixture-bake, which is NOT the path the editor
// build copies — a fixture must never be mistaken for the real artifacts, so
// pointing the editor at one is a deliberate act.
//
// ── F2 (ownership) applies here more than anywhere ────────────────────────
// Every name below is invented. No real card names, no real set names, no
// real artwork, and image URLs point at fixture.invalid — a reserved TLD that
// can never resolve, so a fixture cannot silently start hitting a real CDN.
// A test fixture is the easiest place in a repository to accidentally vendor
// somebody else's trademark, and the hardest place to notice it afterwards.

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RESOLVER_VERSION } from '@foilkit/resolver'
import {
  emitCatalog,
  formatSizeReport,
  variantDisplayName,
  variantTier,
  type BakeCard,
  type BakeSeries,
  type BakeSet,
  type CatalogModel,
} from './bake/emit.ts'
import { buildPatternCards, readEvidence, type CatalogRow } from './bake/pattern-cards.ts'
import { assertNoUserScopedFields } from './bake/guards.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (flag: string): string | null => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}
const OUT = arg('--out') ?? join(ROOT, 'data', 'fixture-bake')
const NAME = arg('--name') ?? 'synthetic'

// ── The synthetic catalog ──────────────────────────────────────────────────
//
// Greek letters as card names: unmistakably not a real card, and they spread
// across enough of the alphabet to exercise bucketing without inventing three
// hundred distinct words. The name is `<Letter> Fixture`, not `Fixture
// <Letter>`, precisely so the FIRST letter varies — a fixture where every
// name started with F would put every search row in one bucket and prove
// nothing about the partitioning.
const GREEK = [
  'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta',
  'Iota', 'Kappa', 'Lambda', 'Mu', 'Nu', 'Xi', 'Omicron', 'Pi',
  'Rho', 'Sigma', 'Tau', 'Upsilon', 'Phi', 'Chi', 'Psi', 'Omega',
]

/** Names that are deliberately awkward, one per bucketing edge case (§2). */
const EDGE_NAMES = [
  '9 Fixture', // leading digit → bucket '0'
  '≡ Fixture', // leading symbol → bucket '_'
  'Épsilon Fixture', // leading accented letter → decomposes to bucket 'e'
  'Ωmega Fixture', // leading non-decomposing letter → bucket '_'
]

const RARITIES = ['Fixture Common', 'Fixture Uncommon', 'Fixture Rare', 'Fixture Rare Holo']
const KINDS = ['normal', 'holo', 'reverse-holo']

let nextVariantId = 900001

function makeCard(setId: string, index: number, opts: { dashedNumber?: boolean } = {}): BakeCard {
  const word = GREEK[index % GREEK.length]!
  const name = index < EDGE_NAMES.length ? EDGE_NAMES[index]! : `${word} Fixture ${Math.floor(index / GREEK.length) + 1}`
  // A dashed number is the round-trip counter-example §2 asks the bake to
  // handle: 'fxsp-FX-007' splits on its LAST '-', so the reader would read the
  // number as '007' and the setId as 'fxsp-FX'. The row therefore carries an
  // explicit number, and the emitter counts the setId as a mismatch.
  const number = opts.dashedNumber ? `FX-${String(index + 1).padStart(3, '0')}` : String(index + 1)
  const cardId = `${setId}-${number}`
  // One variant for most cards, three for every fifth — enough that printings
  // and cards are DIFFERENT numbers, which is what catches a bake that
  // conflates them.
  const kinds = index % 5 === 0 ? KINDS : [KINDS[index % KINDS.length]!]
  return {
    cardId,
    number,
    name,
    rarity: RARITIES[index % RARITIES.length]!,
    images: {
      // fixture.invalid — reserved, unresolvable, obviously not a CDN.
      low: `https://fixture.invalid/${setId}/${number}/low.webp`,
      high: `https://fixture.invalid/${setId}/${number}/high.webp`,
    },
    variants: kinds.map((kind) => ({
      variantId: nextVariantId++,
      kind,
      displayName: variantDisplayName(kind),
      tier: variantTier(kind),
    })),
  }
}

function makeSet(setId: string, name: string, releasedOn: string, count: number, dashedFrom = Infinity): BakeSet {
  const cards: BakeCard[] = []
  for (let i = 0; i < count; i++) cards.push(makeCard(setId, i, { dashedNumber: i >= dashedFrom }))
  return { setId, name, releasedOn, cardCountTotal: count, cards }
}

const series: BakeSeries[] = [
  {
    slug: 'fixture-prime',
    name: 'Fixture Prime',
    tcgdexId: 'fxp',
    sets: [
      makeSet('fxp1', 'Fixture Prime One', '2024-01-19', 20),
      // A '.' in the set id is legal and real (sv03.5). A '/' is not, and the
      // emitter rejects it — that path is covered by a unit test, not here,
      // because a fixture that throws is a fixture nobody can run.
      makeSet('fxp2.5', 'Fixture Prime Two And A Half', '2024-06-07', 12),
    ],
  },
  {
    slug: 'fixture-second',
    name: 'Fixture Second',
    tcgdexId: 'fxs',
    sets: [
      makeSet('fxs1', 'Fixture Second One', '2025-02-14', 8),
      // 260 cards: over PAGE_SIZE (250), so <setId>.json + <setId>.p2.json.
      // The last ten carry dashed numbers, so the number-override and
      // setId-mismatch paths both have live rows in a fixture bake.
      makeSet('fxsp', 'Fixture Second Promos', '2025-03-01', 260, 250),
    ],
  },
]

const generatedAt = new Date().toISOString()
const source = `fixture:${NAME}`
const model: CatalogModel = { generatedAt, source, resolverVersion: RESOLVER_VERSION, series }

const report = emitCatalog(model, { outDir: OUT })

// ── The other two artifacts, from the same synthetic rows ──────────────────
// The editor reads five files, so a fixture bake that produced three would
// still leave two panels untestable. These come out of the SAME core the real
// bake calls; the evidence half is the repository's own mask corpus, read off
// local disk, because that half never needed a database in the first place.
const rows: CatalogRow[] = []
for (const ser of series) {
  for (const s of ser.sets) {
    for (const c of s.cards) {
      for (const v of c.variants) {
        rows.push({
          card_id: c.cardId,
          card_name: c.name,
          rarity: c.rarity,
          set_id: s.setId,
          set_name: s.name,
          series_slug: ser.slug,
          variant_id: String(v.variantId),
          kind: v.kind,
        })
      }
    }
  }
}
const evidence = await readEvidence(ROOT)
const { patternCards, verificationMap } = buildPatternCards(rows, evidence, { source, generatedAt })
assertNoUserScopedFields(patternCards, 'foil-pattern-cards.json')
assertNoUserScopedFields(verificationMap, 'foil-verification-map.json')
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'foil-pattern-cards.json'), JSON.stringify(patternCards) + '\n', 'utf8')
writeFileSync(join(OUT, 'foil-verification-map.json'), JSON.stringify(verificationMap, null, 2) + '\n', 'utf8')

const assigned = patternCards.variantsAssigned as number
console.log(`fixture bake → ${OUT}`)
console.log(`  source ${source} — this is NOT the real catalog and every artifact says so.`)
console.log(
  `  ${report.counts.series} series, ${report.counts.sets} sets, ${report.counts.cards} cards, ` +
    `${report.counts.printings} printings, ${report.counts.setPages} set page(s), ` +
    `${report.counts.buckets} search bucket(s)`,
)
console.log(
  `  search rows with an explicit number: ${report.counts.numberOverrides}; ` +
    `setId round-trip mismatches: ${report.counts.setIdMismatches}`,
)
console.log(`  foil-pattern-cards.json — ${assigned}/${rows.length} printings assigned`)
console.log(
  `  foil-verification-map.json — ${(verificationMap.groups as unknown[]).length} rule group(s), ` +
    `${evidence.maskRecords} mask record(s) of real local evidence`,
)
console.log(formatSizeReport(report))
