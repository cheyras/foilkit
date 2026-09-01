// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// THE DATA RECEIPT: does the resolver answer the same thing after the move?
//
//   node --conditions source tools/parity/resolver-receipt.mjs \
//        [--resolver <module>] [--assignments <file>] [--out receipt.json]
//
// The catalog that the resolver actually runs against is a database, and there
// is none here. So the probe is built from the CORPUS ITSELF: every entity the
// assignment file names — every set id, card id, rarity, variant kind and
// facet — crossed with every series slug the era layouts declare. That is the
// full reachable surface of the assignment tier, plus everything the usage
// table catches underneath it, and it needs no catalog to enumerate.
//
// The output is a sorted list of (input -> guess) pairs and a sha256 over it.
// Two runs of this script against two builds of the resolver either produce the
// same digest or they do not; nothing is eyeballed.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d
}

const RESOLVER = arg('resolver', '@foilkit/resolver')
const ASSIGNMENTS = arg(
  'assignments',
  fileURLToPath(new URL('../../data/foil-card-assignments.json', import.meta.url)),
)
const OUT = arg('out', null)

const { resolveFoil, RESOLVER_VERSION, ERAS } = await import(RESOLVER)
const corpus = JSON.parse(readFileSync(ASSIGNMENTS, 'utf8'))

const SERIES = [...new Set(Object.values(ERAS).flatMap((e) => e.seriesSlugs))].sort()

// A representative variant kind per assignment class, for rows that name a
// class but no explicit kinds. These are the kind codes the class means.
const KINDS_BY_CLASS = {
  holo: ['holo', 'holo-foil-cosmos'],
  reverse: ['reverse', 'reverse-holo'],
  'full-foil': ['holo'],
  'normal+facet': ['normal-foil-galaxy'],
  normal: ['normal'],
}

const RARITIES = [
  null,
  'common',
  'rare',
  'rare holo',
  'double rare',
  'ultra rare',
  'illustration rare',
  'special illustration rare',
  'hyper rare',
  'secret rare',
  'radiant rare',
]

const inputs = []
const push = (i) => inputs.push(i)

for (const row of corpus.rows) {
  const sel = row.sel ?? {}
  const setIds = sel.setIds ?? [null]
  const cardIds = sel.cardIds ?? []
  const rarities = sel.rarities ?? [null]
  const kinds = sel.variantKinds ?? KINDS_BY_CLASS[sel.cls] ?? ['holo']
  for (const seriesSlug of SERIES) {
    for (const setId of setIds) {
      for (const variantKind of kinds) {
        for (const rarity of rarities) push({ seriesSlug, setId, cardId: null, variantKind, rarity })
      }
    }
    for (const cardId of cardIds) {
      const setId = String(cardId).split('-')[0]
      for (const variantKind of kinds) push({ seriesSlug, setId, cardId, variantKind, rarity: null })
    }
  }
}

// Facet rows are catalog-wide: they turn on a variant KIND regardless of set.
for (const f of corpus.facet_rows ?? []) {
  for (const seriesSlug of SERIES) {
    for (const rarity of RARITIES) {
      push({ seriesSlug, setId: null, cardId: null, variantKind: `holo-foil-${f.facet}`, rarity })
      push({ seriesSlug, setId: null, cardId: null, variantKind: `reverse-holo-foil-${f.facet}`, rarity })
    }
  }
}

// …and the fall-through floor: every series, every rarity, the bare kinds. This
// is what a printing with no assignment row at all resolves to, which is most
// of the catalog and therefore most of what a regression would break.
for (const seriesSlug of SERIES) {
  for (const rarity of RARITIES) {
    for (const variantKind of [null, 'normal', 'holo', 'reverse', 'reverse-holo']) {
      push({ seriesSlug, setId: null, cardId: null, variantKind, rarity })
    }
  }
}

// De-duplicate, then sort, so the digest depends on the CONTENT of the probe
// and not on the order the loops above happened to visit it in.
const seen = new Map()
for (const i of inputs) {
  const k = `${i.seriesSlug}|${i.setId ?? ''}|${i.cardId ?? ''}|${i.variantKind ?? ''}|${i.rarity ?? ''}`
  if (!seen.has(k)) seen.set(k, i)
}
const probe = [...seen.keys()].sort()

const lines = []
const patternCounts = new Map()
const matchCounts = new Map()
for (const k of probe) {
  const i = seen.get(k)
  const g = resolveFoil(i)
  const out = `${k} => ${g.patternId}|${g.scope}|${g.eraId}|${g.guess.match}|${g.guess.confidence}`
  lines.push(out)
  patternCounts.set(g.patternId, (patternCounts.get(g.patternId) ?? 0) + 1)
  matchCounts.set(g.guess.match, (matchCounts.get(g.guess.match) ?? 0) + 1)
}

const body = `${lines.join('\n')}\n`
const digest = createHash('sha256').update(body).digest('hex')

const summary = {
  resolver: RESOLVER,
  resolverVersion: RESOLVER_VERSION,
  assignments: ASSIGNMENTS,
  seriesSlugs: SERIES.length,
  probes: probe.length,
  digest,
  byMatch: Object.fromEntries([...matchCounts].sort((a, b) => b[1] - a[1])),
  distinctPatterns: patternCounts.size,
  byPattern: Object.fromEntries([...patternCounts].sort((a, b) => b[1] - a[1])),
}
console.log(JSON.stringify(summary, null, 2))
if (OUT) {
  writeFileSync(OUT, body)
  writeFileSync(`${OUT}.summary.json`, `${JSON.stringify(summary, null, 2)}\n`)
}
