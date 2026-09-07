// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// tools/build-reference-clips.mts — parse every `reference/<slug>/notes.md`
// into `packages/patterns/src/reference-clips.json`, the datum the canon lab's
// reference pane reads.
//
// WHY IT IS A BUILD STEP AND NOT A RUNTIME PARSE. The citations live in prose
// because a human wrote them for humans, and they should stay there — the
// notes.md heading is the source of truth and always will be. But the pane runs
// in a browser, where `reference/` does not exist and Markdown is not a data
// format. So the prose is parsed ONCE, here, and the result is committed.
//
// Run from anywhere (the root is resolved from this file, not from cwd):
//
//   node --conditions source tools/build-reference-clips.mts
//   node --conditions source tools/build-reference-clips.mts --out /tmp/rc.json
//   node --conditions source tools/build-reference-clips.mts --check   # CI
//
//   --out <path>   destination (default packages/patterns/src/reference-clips.json)
//   --check        build in memory, print the report, WRITE NOTHING, and exit
//                  non-zero if the file on disk differs from what would be
//                  written. This is the gate that keeps the datum and the notes
//                  in sync, and it only works because the output is
//                  deterministic (see reference-clips/notes.ts § Serialization).
//   --quiet        counts line only; errors still print.
//
// The parse, the cross-check against MANIFEST.json and every loud failure live
// in ./reference-clips/notes.ts so a test can drive them against synthetic
// notes. This file is argv, stdout and exit codes.

import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildReferenceClips,
  ReferenceClipsError,
  serializeReferenceClips,
} from './reference-clips/notes.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const CHECK = argv.includes('--check')
const QUIET = argv.includes('--quiet')
const OUT = (() => {
  const i = argv.indexOf('--out')
  if (i < 0) return resolve(ROOT, 'packages', 'patterns', 'src', 'reference-clips.json')
  const p = argv[i + 1]
  if (!p) {
    console.error('--out needs a path')
    process.exit(2)
  }
  return resolve(p)
})()

/**
 * Every directory under `reference/` that carries a notes.md.
 *
 * `pipeline/` is the Gemini tooling and has none, so it drops out by the
 * notes.md test rather than by a name check that would need updating the next
 * time a non-pattern directory appears.
 */
async function readNotes(dir: string): Promise<Array<{ slug: string; markdown: string }>> {
  const out: Array<{ slug: string; markdown: string }> = []
  for (const entry of (await readdir(dir)).sort()) {
    const abs = join(dir, entry)
    if (!(await stat(abs)).isDirectory()) continue
    const notes = join(abs, 'notes.md')
    try {
      out.push({ slug: entry, markdown: await readFile(notes, 'utf8') })
    } catch {
      // No notes.md — not a pattern dir.
    }
  }
  return out
}

const REFERENCE = resolve(ROOT, 'reference')

let file
try {
  file = buildReferenceClips({
    notes: await readNotes(REFERENCE),
    manifest: JSON.parse(await readFile(resolve(REFERENCE, 'MANIFEST.json'), 'utf8')),
  })
} catch (err) {
  if (err instanceof ReferenceClipsError) {
    console.error(err.message)
    process.exit(1)
  }
  throw err
}

const serialized = serializeReferenceClips(file)
const withClip = Object.values(file.clips).filter((c) => c.clipStart !== null)
const withoutClip = Object.entries(file.clips).filter(([, c]) => c.clipStart === null)

if (!QUIET) {
  console.log(
    `reference-clips: ${Object.keys(file.sources).length} source videos, ` +
      `${Object.keys(file.clips).length} pattern dirs, ${withClip.length} with a clip range`,
  )
  for (const [slug] of withoutClip) {
    // Not a failure. A dir with no clip is a real state of the corpus and the
    // pane renders it honestly — printing it is how it stays a known one.
    console.log(`  no clip recorded: ${slug}`)
  }
  console.log(`  digest ${file.notesDigest.slice(0, 16)}`)
}

if (CHECK) {
  let onDisk: string | null = null
  try {
    onDisk = await readFile(OUT, 'utf8')
  } catch {
    onDisk = null
  }
  if (onDisk === serialized) {
    if (!QUIET) console.log(`${OUT} is current`)
    process.exit(0)
  }
  console.error(
    onDisk === null
      ? `${OUT} does not exist — run: node --conditions source tools/build-reference-clips.mts`
      : `${OUT} is STALE: it no longer matches reference/<slug>/notes.md.\n` +
        'Rebuild it: node --conditions source tools/build-reference-clips.mts',
  )
  process.exit(1)
}

await writeFile(OUT, serialized)
if (!QUIET) console.log(`wrote ${OUT}`)
