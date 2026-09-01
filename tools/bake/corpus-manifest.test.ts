// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The corpus manifest builder (tools/corpus-manifest/build.ts +
// tools/build-corpus-manifest.mts), exercised against SYNTHETIC corpora in a
// temp dir.
//
// It lives under tools/bake/ rather than beside the code it tests because the
// root `pnpm test` script globs `tools/bake/*.test.ts` and does NOT glob
// `tools/corpus-manifest/`, and this agent may not edit the root package.json.
// Move it next to build.ts the moment that glob covers it.
//
// Synthetic ids (`zz-*`) and a temp root throughout: data/ is the corpus and a
// test that mutates it would be editing the measurements to make itself pass.
// The one exception is the --check pair at the bottom, which drives the real
// CLI over the real data/ and writes only into the temp dir.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { encodePng } from '@foilkit/forge'
import { PATTERNS } from '@foilkit/patterns'
import { buildCorpusManifest, CorpusManifestError, serializeManifest } from '../corpus-manifest/build.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Canonical space (63 x 88 mm at 8 px/mm) so the fixtures resolve to a real frame. */
const W = 504
const H = 704

/** A genuine PNG — the builder reads its header for the frame and hashes its bytes. */
function pngBytes(seed: number): Buffer {
  const rgba = new Uint8Array(W * H * 4)
  rgba[0] = seed & 0xff // vary one pixel so each fixture gets its own sha256
  return encodePng({ width: W, height: H, rgba })
}

interface MaskFixture {
  cardId: string
  variantId: number
  scope: 'window' | 'sheet'
  savedAt: string
  method?: string
}

async function writeMask(root: string, m: MaskFixture): Promise<void> {
  const dir = join(root, 'data', 'foil-masks', m.cardId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${m.variantId}.png`), pngBytes(m.variantId))
  await writeFile(
    join(dir, `${m.variantId}.json`),
    JSON.stringify({
      version: 4,
      cardId: m.cardId,
      variantId: m.variantId,
      artworkKey: m.cardId,
      width: W,
      height: H,
      frame: 'canonical',
      channel: 'alpha',
      derivation_method: m.method ?? 'hand',
      savedAt: m.savedAt,
      artworkUrl: null,
      prior: { source: 'layout', eraId: 'zz-era', scope: m.scope, rect: [0, 0, 1, 1], radius: 0, invert: false, feather: 0, resolverVersion: 5 },
      diff: { agreement: 0.5 },
    }),
    'utf8',
  )
}

/** A fixture root with the two directories the builder refuses to do without. */
async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'foilkit-cm-'))
  await mkdir(join(root, 'data', 'foil-masks'), { recursive: true })
  await mkdir(join(root, 'data', 'foil-canon'), { recursive: true })
  return root
}

const roots: string[] = []
async function fixture(): Promise<string> {
  const root = await newRoot()
  roots.push(root)
  return root
}

after(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

describe('corpus manifest — aliasing (the counting units)', () => {
  it('collapses two variants of one card at the same scope into ONE unit', async () => {
    const root = await fixture()
    // Same card, same scope, two printings. One mask serves both siblings, so
    // this is one (cardId, scope) coverage unit — not two.
    await writeMask(root, { cardId: 'zz-1', variantId: 11, scope: 'window', savedAt: '2026-01-01T00:00:00.000Z' })
    await writeMask(root, { cardId: 'zz-1', variantId: 12, scope: 'window', savedAt: '2026-02-01T00:00:00.000Z' })

    const { manifest } = await buildCorpusManifest(root)
    assert.equal(manifest.counts.maskRecords, 2, 'both files are records')
    assert.equal(manifest.counts.maskCards, 1)
    assert.equal(manifest.counts.maskUnits, 1, 'one (cardId, scope) unit, not two')
    assert.deepEqual(Object.keys(manifest.maskUnits), ['zz-1|window'])
    // Newest savedAt wins — that is the alias the editor resolves client-side.
    assert.equal(manifest.maskUnits['zz-1|window'], 12)
    assert.deepEqual(Object.keys(manifest.masks['zz-1']!).sort(), ['11', '12'], 'both records still emitted')
  })

  it('keeps the same card at window and sheet as TWO units', async () => {
    const root = await fixture()
    // A holo (window) and a reverse (sheet) of one card are different masks and
    // must never alias to each other — scope is part of the key for this reason.
    await writeMask(root, { cardId: 'zz-2', variantId: 21, scope: 'window', savedAt: '2026-01-01T00:00:00.000Z' })
    await writeMask(root, { cardId: 'zz-2', variantId: 22, scope: 'sheet', savedAt: '2026-01-02T00:00:00.000Z' })

    const { manifest } = await buildCorpusManifest(root)
    assert.equal(manifest.counts.maskCards, 1)
    assert.equal(manifest.counts.maskUnits, 2)
    assert.deepEqual(Object.keys(manifest.maskUnits).sort(), ['zz-2|sheet', 'zz-2|window'])
    assert.equal(manifest.maskUnits['zz-2|window'], 21)
    assert.equal(manifest.maskUnits['zz-2|sheet'], 22)
  })

  it('never aliases across cards', async () => {
    const root = await fixture()
    await writeMask(root, { cardId: 'zz-3', variantId: 31, scope: 'window', savedAt: '2026-01-01T00:00:00.000Z' })
    await writeMask(root, { cardId: 'zz-4', variantId: 41, scope: 'window', savedAt: '2026-01-01T00:00:00.000Z' })

    const { manifest } = await buildCorpusManifest(root)
    assert.equal(manifest.counts.maskUnits, 2, 'two cards, two units, whatever they depict')
  })

  it('counts window geometry per cardId, scope-agnostically', async () => {
    const root = await fixture()
    const dir = join(root, 'data', 'foil-windows', 'zz-5')
    await mkdir(dir, { recursive: true })
    // Two geometry files on one card — a sheet is the same art box inverted, so
    // this is one covered card, two files.
    for (const v of [51, 52]) {
      await writeFile(join(dir, `${v}.json`), JSON.stringify({ version: 2, cardId: 'zz-5', variantId: v, savedAt: '2026-03-01T00:00:00.000Z', rect: [0, 0, 1, 1] }), 'utf8')
    }
    const { manifest } = await buildCorpusManifest(root)
    assert.equal(manifest.counts.windowFiles, 2)
    assert.equal(manifest.counts.windowCards, 1)
    assert.deepEqual(manifest.windows['zz-5'], [51, 52])
  })
})

describe('corpus manifest — absence is data', () => {
  it('derives the uncanoned list from PATTERNS ∖ the canon directory, never a constant', async () => {
    const root = await fixture()
    const implemented = PATTERNS.map((p) => p.id).filter((id) => id !== 'none')
    // Exactly two canon files, both named for real patterns.
    for (const id of ['cosmos', 'mirror']) {
      await writeFile(join(root, 'data', 'foil-canon', `${id}.json`), JSON.stringify({ version: 1, patternId: id, contract: 4, savedAt: '2026-04-01T00:00:00.000Z', uniforms: { a: 1, b: 2 } }), 'utf8')
    }

    const { manifest } = await buildCorpusManifest(root)
    assert.equal(manifest.counts.canonFiles, 2)
    assert.equal(manifest.counts.patterns, PATTERNS.length, 'patterns is PATTERNS.length, "none" included')
    // If the list were hardcoded at 13 this would fail: it tracks THIS corpus.
    assert.equal(manifest.counts.uncanonedPatterns, implemented.length - 2)
    assert.equal(manifest.uncanoned.length, implemented.length - 2)
    assert.ok(!manifest.uncanoned.includes('cosmos'))
    assert.ok(!manifest.uncanoned.includes('mirror'))
    assert.ok(!manifest.uncanoned.includes('none'), "'none' is the no-foil recipe — it has no canon by definition")
    assert.deepEqual(manifest.uncanoned, [...manifest.uncanoned].sort(), 'sorted')
    assert.deepEqual(manifest.canon['cosmos'], { exists: true, contract: 4, savedAt: '2026-04-01T00:00:00.000Z', uniforms: 2 })
  })

  it('reports the whole implemented set as uncanoned when there is no canon at all', async () => {
    const root = await fixture()
    const { manifest } = await buildCorpusManifest(root)
    assert.equal(manifest.counts.canonFiles, 0)
    assert.equal(manifest.counts.uncanonedPatterns, PATTERNS.length - 1)
  })

  it('tolerates an absent data/foil-windows — the one absence that is not a finding', async () => {
    const root = await fixture()
    await writeMask(root, { cardId: 'zz-6', variantId: 61, scope: 'window', savedAt: '2026-01-01T00:00:00.000Z' })
    const { manifest, windowsDirAbsent } = await buildCorpusManifest(root)
    assert.equal(windowsDirAbsent, true)
    assert.equal(manifest.counts.windowFiles, 0)
    assert.equal(manifest.counts.windowCards, 0)
  })
})

describe('corpus manifest — fails loudly', () => {
  it('rejects a mask PNG with no sidecar', async () => {
    const root = await fixture()
    await writeMask(root, { cardId: 'zz-7', variantId: 71, scope: 'window', savedAt: '2026-01-01T00:00:00.000Z' })
    // Planted: pixels with no provenance. readCorpus would skip it silently,
    // and the manifest would then under-report coverage. It must not build.
    await writeFile(join(root, 'data', 'foil-masks', 'zz-7', '72.png'), pngBytes(72))

    await assert.rejects(
      () => buildCorpusManifest(root),
      (err: unknown) => {
        assert.ok(err instanceof CorpusManifestError)
        assert.match(err.message, /zz-7\/72\.png has no sidecar/)
        return true
      },
    )
  })

  it('rejects a sidecar with no mask PNG (a half-record)', async () => {
    const root = await fixture()
    const dir = join(root, 'data', 'foil-masks', 'zz-8')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '81.json'), JSON.stringify({ cardId: 'zz-8', width: W, height: H }), 'utf8')
    await assert.rejects(() => buildCorpusManifest(root), /zz-8\/81\.json has no mask/)
  })

  it('rejects a sidecar normalizeSidecar will not accept', async () => {
    const root = await fixture()
    const dir = join(root, 'data', 'foil-masks', 'zz-9')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '91.png'), pngBytes(91))
    // Parses fine; is not a sidecar (no cardId / width / height).
    await writeFile(join(dir, '91.json'), JSON.stringify({ hello: 'world' }), 'utf8')
    await assert.rejects(() => buildCorpusManifest(root), /zz-9\/91\.json was rejected by normalizeSidecar/)
  })

  it('rejects a sidecar that will not parse', async () => {
    const root = await fixture()
    const dir = join(root, 'data', 'foil-masks', 'zz-10')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '101.png'), pngBytes(101))
    await writeFile(join(dir, '101.json'), '{ not json', 'utf8')
    await assert.rejects(() => buildCorpusManifest(root), /zz-10\/101\.json will not parse as JSON/)
  })

  it('rejects a canon file that will not parse', async () => {
    const root = await fixture()
    await writeFile(join(root, 'data', 'foil-canon', 'cosmos.json'), '{ not json', 'utf8')
    await assert.rejects(() => buildCorpusManifest(root), /foil-canon\/cosmos\.json will not parse as JSON/)
  })

  it('rejects a canon file named for something that is not a pattern', async () => {
    const root = await fixture()
    await writeFile(join(root, 'data', 'foil-canon', 'zz-not-a-pattern.json'), JSON.stringify({ uniforms: {} }), 'utf8')
    await assert.rejects(() => buildCorpusManifest(root), /is not an implemented pattern id/)
  })

  it('rejects an absent mask corpus (only foil-windows may be missing)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'foilkit-cm-'))
    roots.push(root)
    await mkdir(join(root, 'data', 'foil-canon'), { recursive: true })
    await assert.rejects(() => buildCorpusManifest(root), /foil-masks does not exist/)
  })
})

describe('corpus manifest — determinism', () => {
  it('serializes byte-identically when nothing changed', async () => {
    const root = await fixture()
    // Deliberately written out of order, so a stable result can only come from
    // sorting rather than from insertion order.
    await writeMask(root, { cardId: 'zz-b', variantId: 200, scope: 'sheet', savedAt: '2026-05-02T00:00:00.000Z' })
    await writeMask(root, { cardId: 'zz-a', variantId: 100, scope: 'window', savedAt: '2026-05-01T00:00:00.000Z' })
    await writeFile(join(root, 'data', 'foil-canon', 'mirror.json'), JSON.stringify({ contract: 4, savedAt: '2026-05-03T00:00:00.000Z', uniforms: { a: 1 } }), 'utf8')

    const a = serializeManifest((await buildCorpusManifest(root)).manifest)
    const b = serializeManifest((await buildCorpusManifest(root)).manifest)
    assert.equal(a, b, 'two builds of one corpus must be byte-identical')

    // generatedAt is a property of the DATA, not the clock — that is what makes
    // the equality above (and therefore --check) mean anything.
    const parsed = JSON.parse(a) as { generatedAt: string }
    assert.equal(parsed.generatedAt, '2026-05-03T00:00:00.000Z', 'the corpus\'s newest savedAt')

    assert.ok(a.endsWith('}\n'), 'pretty-printed with a trailing newline')
    assert.match(a, /\n {2}"counts": \{/, 'two-space indent')
  })

  it('sorts every object key, at every depth', async () => {
    const root = await fixture()
    await writeMask(root, { cardId: 'zz-c', variantId: 300, scope: 'window', savedAt: '2026-06-01T00:00:00.000Z' })
    const text = serializeManifest((await buildCorpusManifest(root)).manifest)
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk)
      if (v !== null && typeof v === 'object') {
        const keys = Object.keys(v as object)
        // Integer-like keys (variantIds) are re-ordered numerically by the JSON
        // serializer whatever we do, and are deterministic either way.
        if (!keys.every((k) => /^\d+$/.test(k))) {
          assert.deepEqual(keys, [...keys].sort(), `unsorted keys: ${keys.join(',')}`)
        }
        for (const k of keys) walk((v as Record<string, unknown>)[k])
      }
    }
    walk(JSON.parse(text))
  })
})

describe('corpus manifest — the CLI, over the real data/', () => {
  let out = ''
  const run = (args: string[]): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, ['--conditions', 'source', join(REPO_ROOT, 'tools', 'build-corpus-manifest.mts'), ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })

  before(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'foilkit-cm-cli-'))
    roots.push(dir)
    out = join(dir, 'corpus-manifest.json')
  })

  it('writes, then reports the file as current', () => {
    const wrote = run(['--out', out, '--quiet'])
    assert.equal(wrote.status, 0, String(wrote.stderr))
    assert.match(String(wrote.stdout), /counts: maskRecords \d+/)

    const check = run(['--check', '--out', out, '--quiet'])
    assert.equal(check.status, 0, String(check.stderr))
    assert.match(String(check.stdout), /is current/)
  })

  it('--check exits non-zero on a stale file, and writes nothing', async () => {
    // Simulate the corpus moving under a committed manifest.
    await writeFile(out, '{\n  "version": 1\n}\n', 'utf8')
    const check = run(['--check', '--out', out, '--quiet'])
    assert.equal(check.status, 1)
    assert.match(String(check.stderr), /STALE/)

    const { readFile } = await import('node:fs/promises')
    assert.equal(await readFile(out, 'utf8'), '{\n  "version": 1\n}\n', '--check must not write')
  })

  it('--check exits non-zero when the file is not there at all', () => {
    const check = run(['--check', '--out', join(dirname(out), 'nope.json'), '--quiet'])
    assert.equal(check.status, 1)
    assert.match(String(check.stderr), /does not exist/)
  })
})
