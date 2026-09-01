// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Running the authoring stack where there is no working tree.
//
// `writeMaskRecord` is the single write path for every mask in this project —
// the foil-lab PUT route and every generator go through it, which is what makes
// "every write path stamps honestly" structural rather than a promise. It reads
// and writes a DIRECTORY, because it was written for a checkout.
//
// A Vercel function has no checkout. So the shape here is:
//
//   1. materialise the two or three directories the write touches into /tmp,
//      from the repository head, over the GitHub API
//   2. run `writeMaskRecord` against that tree, unchanged
//   3. diff the tree against what was downloaded
//   4. commit exactly what changed
//
// It is deliberately NOT a reimplementation. The whole point of routing a
// hosted save through the same function is that `derivation_method` is decided
// by diffing saved pixels against what the declared seed rasterizes to — the
// rule the corpus's honesty rests on — and a second implementation of that is a
// second place for it to be wrong.

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { listDir, readBlob, readFileAt, type CommitChange, type RepoFile, type RepoRef } from './github.ts'

export const MASKS_PREFIX = 'data/foil-masks'
export const WINDOWS_PREFIX = 'data/foil-windows'
export const CANON_PREFIX = 'data/foil-canon'

/**
 * A card id is a path segment. Anything that could climb out of the corpus
 * directory is refused before it reaches the filesystem — the tree under /tmp
 * is short-lived, but the COMMIT PATH built from it is not, and a `..` there
 * would write outside `data/`.
 */
const CARD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const PATTERN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export function assertCardId(cardId: unknown): string {
  if (typeof cardId !== 'string' || !CARD_ID.test(cardId) || cardId.includes('..')) {
    throw new BadRequest('cardId must be a plain catalog id')
  }
  return cardId
}

export function assertVariantId(variantId: unknown): number {
  // `Number(null)` and `Number('')` are both 0, which is a valid variant id —
  // so a missing parameter would quietly become variant 0 and write to the
  // wrong file. Accept only a number or a string of digits.
  let n: number
  if (typeof variantId === 'number') n = variantId
  else if (typeof variantId === 'string' && /^[0-9]{1,10}$/.test(variantId)) n = Number(variantId)
  else throw new BadRequest('variantId must be a non-negative integer')
  if (!Number.isInteger(n) || n < 0 || n > 2 ** 31) throw new BadRequest('variantId must be a non-negative integer')
  return n
}

export function assertPatternId(patternId: unknown): string {
  if (typeof patternId !== 'string' || !PATTERN_ID.test(patternId)) {
    throw new BadRequest('patternId must be a plain recipe id')
  }
  return patternId
}

export class BadRequest extends Error {}

/** `data:image/png;base64,…` → bytes, with a size ceiling. */
export function pngFromDataUrl(value: unknown, maxBytes = 4 * 1024 * 1024): Buffer {
  if (typeof value !== 'string' || !value.startsWith('data:image/png;base64,')) {
    throw new BadRequest('png must be a data:image/png;base64 URL')
  }
  const buf = Buffer.from(value.slice('data:image/png;base64,'.length), 'base64')
  if (buf.length === 0) throw new BadRequest('png decoded to zero bytes')
  if (buf.length > maxBytes) throw new BadRequest(`png is ${buf.length} bytes, over the ${maxBytes} ceiling`)
  // A canonical mask is a PNG. Check the magic rather than trusting the prefix.
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new BadRequest('png is not a PNG')
  return buf
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

export interface Workspace {
  /** Absolute path to the /tmp root that stands in for the repository. */
  root: string
  /** Absolute path to the mask corpus inside it. */
  masksDir: string
  /** repoPath → sha256 of the bytes as they were downloaded. */
  before: Map<string, string>
}

/**
 * Build a /tmp tree containing everything this write needs to read.
 *
 * `dirs` are repository-relative directory paths. Everything in each one is
 * downloaded; the corpus keeps a handful of small files per card, so this is
 * two or three requests and a few tens of kilobytes.
 */
export async function materialise(ref: RepoRef, dirs: string[]): Promise<Workspace> {
  const root = mkdtempSync(join(tmpdir(), 'foilkit-'))
  const before = new Map<string, string>()

  // The frame registry, which `writeMaskRecord` gates on. Fetched from the SAME
  // commit as the corpus, so the registry and the pixels it authorises are one
  // generation — a bundled copy would drift the moment #4's numbers move.
  const frames = await readFileAt(ref, 'data/frames.json')
  if (frames === null) throw new Error('data/frames.json is missing from the repository head')
  mkdirSync(join(root, 'data'), { recursive: true })
  writeFileSync(join(root, 'data', 'frames.json'), frames)
  process.env.FOILKIT_FRAMES_FILE = join(root, 'data', 'frames.json')

  for (const dir of new Set(dirs)) {
    let files: RepoFile[]
    files = await listDir(ref, dir)
    for (const f of files) {
      const bytes = await readBlob(ref, f.sha)
      const abs = join(root, f.path)
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, bytes)
      before.set(f.path, sha256(bytes))
    }
  }

  return { root, masksDir: join(root, MASKS_PREFIX), before }
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) walk(abs, out)
    else out.push(abs)
  }
  return out
}

/**
 * What changed in the workspace.
 *
 * Only ADDED and MODIFIED files become commit entries. A file that came down
 * and went back up unchanged is not a change, and including it would make every
 * commit look like it rewrote the card's whole directory — which would make the
 * history useless for exactly the question it exists to answer.
 *
 * Deletions are NOT inferred here. `writeMaskRecord` removes stale artifacts
 * (an old `.parent.png` when a save stops being a correction), so the caller
 * passes the paths it wants removed explicitly — inferring them would let a
 * failed download turn into a silent deletion.
 */
export function changesIn(ws: Workspace, scope: string): CommitChange[] {
  const changes: CommitChange[] = []
  for (const abs of walk(join(ws.root, scope))) {
    const repoPath = relative(ws.root, abs).split(sep).join('/')
    const bytes = readFileSync(abs)
    if (ws.before.get(repoPath) === sha256(bytes)) continue
    changes.push({ path: repoPath, content: bytes })
  }
  return changes
}

/** Repository paths that were downloaded under `scope` and are gone from disk. */
export function deletionsIn(ws: Workspace, scope: string): CommitChange[] {
  const present = new Set(
    walk(join(ws.root, scope)).map((abs) => relative(ws.root, abs).split(sep).join('/')),
  )
  const out: CommitChange[] = []
  for (const repoPath of ws.before.keys()) {
    if (!repoPath.startsWith(`${scope}/`)) continue
    if (!present.has(repoPath)) out.push({ path: repoPath, content: null })
  }
  return out
}
