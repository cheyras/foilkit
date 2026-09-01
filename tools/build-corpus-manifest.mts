// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// tools/build-corpus-manifest.mts — walk data/foil-masks, data/foil-canon and
// data/foil-windows and write ONE file, data/corpus-manifest.json, in the shape
// docs/HOSTED-EDITOR.md §3 fixes.
//
// WHAT IT IS FOR. foilkit.deckpal.app has no database. Its contribution-shaped
// filters — "has a mask" / "has a canon" / "uncanon'd pattern" — are answered
// ENTIRELY from this file, and subtask 11's contribution queue is generated
// from it. That is why this producer, unlike `tools/bake-catalog.mts`, needs no
// Postgres and runs on EVERY build: the corpus is in the repository, so the
// answer can be too.
//
// Run from anywhere (the root is resolved from this file, not from cwd):
//
//   node --conditions source tools/build-corpus-manifest.mts
//   node --conditions source tools/build-corpus-manifest.mts --out /tmp/cm.json
//   node --conditions source tools/build-corpus-manifest.mts --check   # CI
//
//   --out <path>   destination (default <root>/data/corpus-manifest.json)
//   --check        build in memory, print the report, WRITE NOTHING, and exit
//                  non-zero if the file on disk differs from what would be
//                  written. This is CI's proof that the committed manifest is
//                  current — which only works because the output is
//                  deterministic (see build.ts § Serialization, and note that
//                  `generatedAt` is the corpus's newest savedAt, not a clock).
//   --quiet        counts line only; errors still print.
//
// The walk itself, the counting units, and every loud failure live in
// ./corpus-manifest/build.ts so a test can drive them against a synthetic
// corpus in a temp dir. This file is argv, stdout and exit codes.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCorpusManifest, CorpusManifestError, serializeManifest } from './corpus-manifest/build.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const CHECK = argv.includes('--check')
const QUIET = argv.includes('--quiet')
const OUT = (() => {
  const i = argv.indexOf('--out')
  if (i < 0) return resolve(ROOT, 'data', 'corpus-manifest.json')
  const p = argv[i + 1]
  if (!p) {
    console.error('--out needs a path')
    process.exit(2)
  }
  return resolve(p)
})()

/**
 * The 13 canon-less patterns docs/HOSTED-EDITOR.md §3 records from subtask 5.
 * NOT used to compute anything — the list is derived from PATTERNS ∖ the canon
 * directory (see build.ts). It is here only so a DIVERGENCE gets printed: a
 * change in this number is a finding about the corpus, and a build that
 * silently agreed with whatever it found would never surface it.
 */
const SUBTASK_5_UNCANONED = 13

function line(s: string): void {
  if (!QUIET) console.log(s)
}

async function main(): Promise<void> {
  const { manifest, maskDirsWalked, windowsDirAbsent } = await buildCorpusManifest(ROOT)
  const text = serializeManifest(manifest)
  const c = manifest.counts

  console.log(
    `counts: maskRecords ${c.maskRecords}, maskCards ${c.maskCards}, maskUnits ${c.maskUnits}, ` +
      `windowFiles ${c.windowFiles}, windowCards ${c.windowCards}, canonFiles ${c.canonFiles}, ` +
      `patterns ${c.patterns}, uncanonedPatterns ${c.uncanonedPatterns}`,
  )

  line(`walked ${maskDirsWalked} mask card dir(s) under data/foil-masks (codified/ skipped)`)
  if (windowsDirAbsent) line('data/foil-windows is absent — tolerated, window coverage reported as 0')
  line(`generatedAt ${manifest.generatedAt} (the corpus's newest savedAt, not a clock reading)`)

  // ── The finding, printed whether or not it agrees ────────────────────────
  if (c.uncanonedPatterns === SUBTASK_5_UNCANONED) {
    line(`uncanoned: ${c.uncanonedPatterns} — matches the ${SUBTASK_5_UNCANONED} subtask 5 recorded`)
  } else {
    // Not a build failure: the derived list is the truth and the doc is the
    // claim. But it is loud, because a moved number means a canon was added,
    // removed, or a pattern id appeared.
    console.log(
      `FINDING: uncanoned is ${c.uncanonedPatterns}, NOT the ${SUBTASK_5_UNCANONED} recorded in ` +
        `docs/HOSTED-EDITOR.md §3. ${c.patterns} implemented pattern(s) − ${c.canonFiles} canon file(s) ` +
        `− 1 ('none', the no-foil recipe, which has no canon by definition) = ${c.uncanonedPatterns}.`,
    )
  }
  line(`  ${manifest.uncanoned.join(', ')}`)

  if (!QUIET) {
    const maskCards = Object.keys(manifest.masks).sort()
    const sampleCard = maskCards[0]
    if (sampleCard) {
      const [variantId, rec] = Object.entries(manifest.masks[sampleCard]!)[0]!
      line(`sample mask ${sampleCard}/${variantId}: ${JSON.stringify(rec)}`)
    }
    line(`sample maskUnits: ${JSON.stringify(Object.fromEntries(Object.entries(manifest.maskUnits).slice(0, 4)))}`)
    line(`sample windows: ${JSON.stringify(Object.fromEntries(Object.entries(manifest.windows).slice(0, 4)))}`)
    const canonIds = Object.keys(manifest.canon).sort()
    if (canonIds[0]) line(`sample canon ${canonIds[0]}: ${JSON.stringify(manifest.canon[canonIds[0]])}`)
  }

  if (CHECK) {
    const onDisk = await readFile(OUT, 'utf8').catch(() => null)
    if (onDisk === null) {
      console.error(`--check: ${OUT} does not exist. Run without --check and commit the result.`)
      process.exit(1)
    }
    if (onDisk !== text) {
      console.error(
        `--check: ${OUT} is STALE — it differs from what this walk would write ` +
          `(${onDisk.length} byte(s) on disk vs ${Buffer.byteLength(text)} fresh). ` +
          'Run `node --conditions source tools/build-corpus-manifest.mts` and commit the result.',
      )
      process.exit(1)
    }
    console.log(`--check: ${OUT} is current (${Buffer.byteLength(text)} bytes). Nothing written.`)
    return
  }

  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, text, 'utf8')
  console.log(`wrote ${OUT} — ${Buffer.byteLength(text)} bytes`)
}

try {
  await main()
} catch (err) {
  // A CorpusManifestError already names the file and says what is wrong; a
  // stack trace on top of it would bury the one line that matters.
  if (err instanceof CorpusManifestError) {
    console.error(`corpus manifest: ${err.message}`)
    process.exit(1)
  }
  throw err
}
