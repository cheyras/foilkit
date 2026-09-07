// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// tools/build-task-queue.mts — write ONE file, <bake>/task-queue.json: the
// hosted editor's contribution queue, generated from the repository's own
// artifacts.
//
// WHAT IT IS FOR. foilkit.deckpal.app's home screen ranked rule groups by
// leverage and showed nothing else, so five other kinds of contribution — an
// approximated recipe, a canon-less pattern, a standing verification nay, an
// uncorrected machine mask, an untargeted research residual, an empty resolver
// pool — were recorded in this repository and invisible from the site. This
// producer turns all six into one list of task cards, each saying what is
// needed, roughly how long it takes, which skill it wants, how many printings
// it moves, and which file it came from.
//
// Like tools/build-corpus-manifest.mts and unlike tools/bake-catalog.mts, it
// needs no database and runs on EVERY build.
//
// Run from anywhere (the root is resolved from this file, not from cwd):
//
//   node --conditions source tools/build-task-queue.mts
//   FOILKIT_BAKE=fixture node --conditions source tools/build-task-queue.mts
//   node --conditions source tools/build-task-queue.mts --check   # CI
//
//   --out <path>   destination (default <bake>/task-queue.json)
//   --bake <dir>   the bake directory (default data/, or data/fixture-bake
//                  when FOILKIT_BAKE=fixture — the same seam
//                  apps/editor/copy-data.mjs and vite.config.ts use)
//   --check        build in memory, print the report, WRITE NOTHING, and exit
//                  non-zero if the file on disk differs. CI's proof that the
//                  committed queue is current, which only works because the
//                  output is deterministic (see build.ts § Serialization).
//   --quiet        counts line only; findings and errors still print.
//
// FINDINGS ARE NOT FAILURES. A `reconciliation` row where a document's count
// disagrees with the data is printed loudly and does NOT fail the build. The
// document is a claim; the corpus is the measurement; and a build that failed
// on every stale sentence would mean nobody could commit a measurement until
// they had also rewritten the prose. Printing it is what makes it impossible
// to miss.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildTaskQueue, serializeQueue, TaskQueueError } from './task-queue/build.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const CHECK = argv.includes('--check')
const QUIET = argv.includes('--quiet')

function flag(name: string): string | null {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return null
  const v = argv[i + 1]
  if (v === undefined) {
    console.error(`--${name} needs a path`)
    process.exit(2)
  }
  return v
}

/** The same seam apps/editor/copy-data.mjs and vite.config.ts resolve. */
const BAKE = (() => {
  const explicit = flag('bake')
  if (explicit !== null) return resolve(explicit)
  return process.env.FOILKIT_BAKE === 'fixture'
    ? resolve(ROOT, 'data', 'fixture-bake')
    : resolve(ROOT, 'data')
})()

const OUT = flag('out') === null ? resolve(BAKE, 'task-queue.json') : resolve(flag('out')!)

function line(s: string): void {
  if (!QUIET) console.log(s)
}

async function main(): Promise<void> {
  const { queue, findings, shardsRead } = await buildTaskQueue(ROOT, BAKE)
  const text = serializeQueue(queue)
  const c = queue.counts

  const types = Object.entries(c.byType)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k} ${n}`)
    .join(', ')
  const skills = Object.entries(c.bySkill)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k} ${n}`)
    .join(', ')

  console.log(`counts: ${c.tasks} task(s) — ${types}`)
  line(`skills: ${skills}`)
  line(`impact: ${c.impactTotal.toLocaleString()} printing(s) governed, ${c.unsized} task(s) this bake cannot size`)
  line(`bake:   ${BAKE}`)
  for (const [name, present] of Object.entries(queue.bakedInputs)) {
    if (!present) line(`        ${name} is NOT baked — the sections it feeds are empty (see RUN-BAKE.md)`)
  }
  line(`read:   ${shardsRead} catalog set shard(s), on demand`)

  // The whole point of emitting reconciliation rows. Loud, always, even quiet.
  for (const f of findings) {
    console.log(`FINDING: ${f.key} — the doc says "${f.claim}" (${f.claimedAt});`)
    console.log(`         the data says ${f.measured}.`)
    console.log(`         ${f.note}`)
  }

  if (CHECK) {
    const onDisk = await readFile(OUT, 'utf8').catch(() => null)
    if (onDisk === null) {
      console.error(`--check: ${OUT} does not exist. Run this tool without --check and commit its output.`)
      process.exit(1)
    }
    if (onDisk !== text) {
      console.error(
        `--check: ${OUT} differs from what this data would produce (${onDisk.length} bytes on disk, ` +
          `${text.length} bytes built). Regenerate it and commit the result.`,
      )
      process.exit(1)
    }
    line(`--check: ${OUT} is current.`)
    return
  }

  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, text, 'utf8')
  line(`wrote ${OUT} (${text.length} bytes)`)
}

main().catch((err: unknown) => {
  if (err instanceof TaskQueueError) {
    console.error(`task queue: ${err.message}`)
    process.exit(1)
  }
  throw err
})
