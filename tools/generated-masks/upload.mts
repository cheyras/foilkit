// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// tools/generated-masks/upload.mts — push staged, content-addressed objects to
// the generated-mask bucket. Objects are immutable (the name IS the sha256), so
// an object that already exists is skipped, never overwritten.
//
//   FOILKIT_MASKS_URL=<supabase project url> FOILKIT_MASKS_KEY=<service key> \
//     node --conditions source tools/generated-masks/upload.mts --objects <dir> [--dry-run]
//
// Credentials come from the environment only, are never printed, and are never
// written anywhere. The bucket named in data/generated-masks/store.json must
// already exist and be public-read (provisioning it is a maintainer action,
// AGENTS.md F6). Nothing in git changes when this runs.

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StoreConfig } from './index.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const objects = argv[argv.indexOf('--objects') + 1]
const dry = argv.includes('--dry-run')
if (!argv.includes('--objects') || !objects) {
  console.error('usage: upload.mts --objects <dir> [--dry-run]')
  process.exit(2)
}
const store = JSON.parse(await readFile(path.join(ROOT, 'data/generated-masks/store.json'), 'utf8')) as StoreConfig
const base = process.env.FOILKIT_MASKS_URL?.replace(/\/$/, '')
const key = process.env.FOILKIT_MASKS_KEY
if (!dry && (!base || !key)) {
  console.error('FOILKIT_MASKS_URL and FOILKIT_MASKS_KEY must be set (or pass --dry-run)')
  process.exit(2)
}

const files: string[] = []
for (const layer of ['foil', 'etch']) {
  try {
    for (const f of await readdir(path.join(objects, layer))) if (/^[0-9a-f]{64}\.png$/.test(f)) files.push(`${layer}/${f}`)
  } catch { /* layer absent */ }
}
let up = 0, skip = 0, fail = 0
const auth = { Authorization: `Bearer ${key}`, apikey: key ?? '' }
const one = async (rel: string): Promise<void> => {
  if (dry) { up++; return }
  const head = await fetch(`${base}/storage/v1/object/public/${store.bucket}/${rel}`, { method: 'HEAD' })
  if (head.ok) { skip++; return }
  const res = await fetch(`${base}/storage/v1/object/${store.bucket}/${rel}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'image/png', 'x-upsert': 'false', 'Cache-Control': 'public, max-age=31536000, immutable' },
    body: await readFile(path.join(objects, rel)),
  })
  if (res.ok || res.status === 409) up++
  else { fail++; console.error(`${rel}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`) }
}
for (let i = 0; i < files.length; i += 8) await Promise.all(files.slice(i, i + 8).map(one))
console.log(`${dry ? 'would upload' : 'uploaded'} ${up}, already present ${skip}, failed ${fail} (of ${files.length})`)
if (!dry && base) console.log(`public base: ${base}/storage/v1/object/public/${store.bucket}`)
process.exit(fail ? 1 : 0)
