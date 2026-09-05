// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// tools/pr-evidence.mjs — what a contribution pull request changed, rendered.
//
// Reads the list of files a pull request touches, works out which of them are
// reviewable RENDERINGS rather than text, renders a tilt sweep for each, and
// writes the markdown that goes in the comment.
//
// ── WHY A SCRIPT AND NOT TEN LINES OF YAML ────────────────────────────────
//
// Three of the steps below have a wrong answer that YAML would take silently:
//
//   1. WHICH RECIPE. A mask is evidence about a card, and a card renders
//      through whichever recipe the assignment corpus gives it —
//      `data/foil-pattern-cards.json`, which is committed. Guessing `cosmos`
//      would produce a picture of the right MASK through the wrong FOIL, which
//      is worse than no picture because it looks like one.
//   2. WHICH FILES. `15.png` is a mask; `15.diff.png`, `15.prior.png` and
//      `15.parent.png` are artifacts OF that mask and must not each spawn their
//      own render.
//   3. THE SERVER. The parity host needs a static server, and starting one in
//      one workflow step and using it in the next is a race the runner does not
//      owe anybody (ci.yml already says so about the acceptance job). It is
//      started and stopped here, in one process.
//
// Usage:
//   node --conditions source tools/pr-evidence.mjs \
//     --out .evidence --pr 42 --changed-from <file-with-one-path-per-line>
//
//   node --conditions source tools/pr-evidence.mjs --out .evidence --pr 42 \
//     data/foil-masks/base1-4/15.png data/foil-canon/cosmos.json

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d
}
const OUT = path.resolve(arg('out', '.evidence'))
const PR = arg('pr', '0')
const PORT = Number(arg('port', '5211'))
/**
 * The ceiling on renders.
 *
 * One session is one pull request (subtask 8), so a contribution PR carries one
 * mask or one canon file and this never binds. It binds on a pull request
 * opened by hand that touched forty masks — where rendering forty tilt sweeps
 * would turn a five-minute check into an hour and produce a comment nobody
 * scrolls. The comment says what it skipped.
 */
const MAX = Number(arg('max', '4'))

const changedFrom = arg('changed-from', null)
const positional = argv.filter((a, i) => !a.startsWith('--') && !String(argv[i - 1] ?? '').startsWith('--'))
const changed =
  changedFrom !== null
    ? readFileSync(changedFrom, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
    : positional

// ── What is worth rendering ────────────────────────────────────────────────

/** `data/foil-masks/<cardId>/<variantId>.png` — the mask itself, not its artifacts. */
const MASK_RE = /^data\/foil-masks\/([^/]+)\/(\d+)\.png$/
/** `data/foil-canon/<patternId>.json`. */
const CANON_RE = /^data\/foil-canon\/([a-z0-9-]+)\.json$/

/** cardId → patternId, inverted out of the committed assignment bake. */
function patternIndex() {
  const file = path.join(ROOT, 'data', 'foil-pattern-cards.json')
  if (!existsSync(file)) return new Map()
  const json = JSON.parse(readFileSync(file, 'utf8'))
  const index = new Map()
  for (const [patternId, rows] of Object.entries(json.patterns ?? {})) {
    for (const row of rows) index.set(`${row[0]}:${row[1]}`, patternId)
  }
  return index
}

function plan(paths) {
  const index = patternIndex()
  const jobs = []
  const seen = new Set()
  for (const p of paths) {
    const norm = p.replace(/\\/g, '/')
    const mask = MASK_RE.exec(norm)
    if (mask !== null) {
      const [, cardId, variantId] = mask
      const key = `mask:${cardId}:${variantId}`
      if (seen.has(key)) continue
      seen.add(key)
      const patternId = index.get(`${cardId}:${Number(variantId)}`) ?? null
      jobs.push({ kind: 'mask', cardId, variantId, patternId, file: norm })
      continue
    }
    const canon = CANON_RE.exec(norm)
    if (canon !== null) {
      const key = `canon:${canon[1]}`
      if (seen.has(key)) continue
      seen.add(key)
      jobs.push({ kind: 'canon', patternId: canon[1], file: norm })
    }
  }
  return jobs
}

// ── Running one render ─────────────────────────────────────────────────────

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', cwd: ROOT, ...options })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))))
  })
}

async function waitForServer(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`the static server never came up at ${url}`)
}

async function main() {
  const jobs = plan(changed)
  mkdirSync(OUT, { recursive: true })

  if (jobs.length === 0) {
    writeFileSync(path.join(OUT, 'comment.md'), '')
    writeFileSync(
      path.join(OUT, 'manifest.json'),
      `${JSON.stringify({ pr: PR, rendered: [], skipped: [], reason: 'nothing renderable changed' }, null, 2)}\n`,
    )
    console.log('nothing renderable in this pull request — no evidence to render')
    return
  }

  const rendered = []
  const skipped = jobs.slice(MAX).map((j) => j.file)

  const server = spawn(process.execPath, ['tools/parity/serve.mjs', '--port', String(PORT)], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: false,
  })
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/`)

    for (const job of jobs.slice(0, MAX)) {
      if (job.kind === 'mask' && job.patternId === null) {
        // Honest rather than a default. Rendering an unassigned card through
        // `cosmos` would be a picture of the right mask through the wrong foil,
        // which is worse than no picture because it looks like one.
        skipped.push(`${job.file} (no recipe assignment for ${job.cardId}/${job.variantId})`)
        continue
      }
      const name = job.kind === 'mask' ? `${job.cardId}-${job.variantId}` : `canon-${job.patternId}`
      const strip = path.join(OUT, `${name}.png`)
      const meta = path.join(OUT, `${name}.json`)
      const args = [
        '--conditions',
        'source',
        'tools/parity/tilt-strip.mjs',
        '--url',
        `http://127.0.0.1:${PORT}`,
        '--pattern',
        job.patternId,
        '--out',
        strip,
        '--meta',
        meta,
      ]
      if (job.kind === 'mask') args.push('--mask', `/${job.file}`)
      if (job.kind === 'canon') args.push('--canonFile', `/${job.file}`)

      console.log(`\nrendering ${job.kind} ${name} through ${job.patternId}`)
      await run(process.execPath, args)
      rendered.push({ ...job, name, strip: path.basename(strip), meta: JSON.parse(readFileSync(meta, 'utf8')) })
    }
  } finally {
    server.kill()
  }

  writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify({ pr: PR, rendered, skipped }, null, 2)}\n`)
  writeFileSync(path.join(OUT, 'comment.md'), comment(rendered, skipped))
  console.log(`\n${rendered.length} strip(s) -> ${OUT}`)
}

/**
 * The comment body.
 *
 * The image URL is left as a `{{BASE}}` placeholder rather than built here: the
 * workflow knows where it pushed the file and this script does not, and a
 * script that guessed a raw.githubusercontent URL would be silently wrong the
 * day the evidence path moves.
 */
function comment(rendered, skipped) {
  const lines = [
    '<!-- foilkit-pr-evidence -->',
    '## Render evidence',
    '',
    'An **8-frame tilt sweep** of what this pull request proposes, rendered through the frame-stepped',
    'zero-delta harness on headless Chromium + SwiftShader. Left to right, the card rotates through the',
    'full tilt range: `−1, −0.7, −0.35, −0.1, +0.1, +0.35, +0.7, +1`.',
    '',
    'This is also the **compile gate**. The shader is assembled and linked by a real GL driver here — the',
    'submit endpoint can only check the assembled source structurally, so a recipe that does not compile,',
    'or a canon file naming a uniform its recipe never declared, fails on this job rather than on merge.',
    '',
  ]
  for (const r of rendered) {
    lines.push(
      r.kind === 'mask'
        ? `### \`${r.cardId}\` variant ${r.variantId} — recipe \`${r.patternId}\``
        : `### canon \`${r.patternId}\``,
    )
    lines.push('')
    lines.push(`![tilt sweep]({{BASE}}/${r.strip})`)
    lines.push('')
    lines.push(
      `<sub>${r.meta.strip.width}×${r.meta.strip.height} · ${r.meta.framesPerStep} stepped frames per angle · ` +
        `max tilt ${r.meta.maxTiltDeg}° · sha256 \`${r.meta.sha256.slice(0, 16)}…\`</sub>`,
    )
    lines.push('')
  }
  if (skipped.length > 0) {
    lines.push('<details><summary>Not rendered</summary>', '')
    for (const s of skipped) lines.push(`- \`${s}\``)
    lines.push('')
    lines.push('</details>', '')
  }
  lines.push(
    '<sub>Rendered on the **blank card base**, never on a card scan — AGENTS.md F2, the standing ownership',
    'rule, means no third-party pixels are committed anywhere, and this strip is committed. It is also the',
    'better picture: it shows how the foil behaves inside the region under review with no printed ink',
    'competing for attention.</sub>',
    '',
    '<sub>The strips live on the orphan `pr-evidence` branch and never merge into `main`.</sub>',
  )
  return `${lines.join('\n')}\n`
}

await main()
