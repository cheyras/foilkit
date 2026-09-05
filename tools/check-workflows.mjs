// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// tools/check-workflows.mjs — do the workflow files parse, and do they say the
// things a workflow in THIS repository has to say?
//
// ── WHY THIS EXISTS AND WHAT IT IS NOT ────────────────────────────────────
//
// A broken workflow does not fail — it does not RUN, and a job that never ran
// looks exactly like a job that had nothing to do. `pr-evidence.yml` is the
// render evidence AND the GLSL compile gate, so a silently inert one would let
// a shader that does not link reach `main` while every check on the pull
// request stayed green. That is the failure this file exists to make loud.
//
// IT IS NOT A YAML PARSER, AND SAYS SO. Node ships no YAML, and this repository
// ships no runtime dependencies — writing a YAML parser to check a YAML file
// would be several hundred lines of new surface to be wrong in, guarding two
// files. `actionlint` is the real check and CI runs it (`.github/workflows/ci.yml`,
// the `workflows` job); this is the offline half that runs in `pnpm test`,
// catches the errors that are decidable from the text, and — the part actionlint
// cannot do — asserts the repository-specific invariants below.
//
// The line-level checks are the ones that have actually bitten: a tab (YAML
// forbids them for indentation, and an editor will happily insert one), a
// `steps:` entry that is neither `uses` nor `run`, a job with no `runs-on`, and
// `on:` written as the YAML 1.1 boolean `true` — which is what an unquoted `on`
// key becomes in some parsers and is the single most confusing failure in this
// format.

import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, '.github', 'workflows')

const problems = []
const fail = (file, line, message) => problems.push(`${file}${line === null ? '' : `:${line}`} — ${message}`)

/** Indentation depth in spaces, or null for a blank / comment-only line. */
function indentOf(line) {
  if (line.trim().length === 0 || line.trim().startsWith('#')) return null
  return line.length - line.trimStart().length
}

function checkFile(name) {
  const text = readFileSync(join(DIR, name), 'utf8')
  const lines = text.split('\n')

  // ── SPDX, like every other file in this repository (contract F1) ────────
  if (!/^#\s*SPDX-License-Identifier:\s*MIT\s*$/m.test(lines.slice(0, 5).join('\n'))) {
    fail(name, 1, 'no SPDX-License-Identifier header in the first five lines')
  }

  // ── Structure, line by line ────────────────────────────────────────────
  let sawOn = false
  let sawJobs = false
  const topLevelKeys = new Set()

  lines.forEach((raw, i) => {
    const n = i + 1
    if (/^\s*\t/.test(raw) || /^[^#]*\t/.test(raw.split('#')[0] ?? '')) {
      // Only indentation matters, but a tab anywhere outside a comment or a
      // quoted string is very likely a mistake and is cheap to refuse.
      if (/^\s*\t/.test(raw)) fail(name, n, 'a tab in the indentation — YAML forbids it')
    }
    if (/\s+$/.test(raw) && raw.trim().length > 0) fail(name, n, 'trailing whitespace')

    const indent = indentOf(raw)
    if (indent === 0) {
      const key = raw.split(':')[0]?.trim()
      if (key !== undefined && key.length > 0) {
        if (topLevelKeys.has(key)) fail(name, n, `duplicate top-level key \`${key}\``)
        topLevelKeys.add(key)
      }
      if (/^on:/.test(raw)) sawOn = true
      // `on` unquoted is a YAML 1.1 boolean in some readers, and a workflow
      // whose trigger key parsed as `true` never runs and never says why.
      if (/^(true|True|"on"|'on'):/.test(raw)) {
        fail(name, n, 'the trigger key must be written `on:` — a quoted or boolean form is a workflow that never runs')
      }
      if (/^jobs:/.test(raw)) sawJobs = true
    }
  })

  if (!sawOn) fail(name, null, 'no `on:` trigger — this workflow can never run')
  if (!sawJobs) fail(name, null, 'no `jobs:` block')
  if (!/^permissions:/m.test(text)) {
    // Not a style rule. The default token permission set is repository-wide,
    // and a workflow that does not narrow it is a workflow whose blast radius
    // nobody wrote down.
    fail(name, null, 'no top-level `permissions:` — declare what this workflow may do')
  }

  // ── Every job has a runner, and every step does something ──────────────
  const jobsAt = lines.findIndex((l) => /^jobs:/.test(l))
  if (jobsAt >= 0) {
    let job = null
    let jobLine = 0
    let jobHasRunsOn = false
    let jobHasSteps = false
    const closeJob = () => {
      if (job === null) return
      if (!jobHasRunsOn) fail(name, jobLine, `job \`${job}\` has no runs-on`)
      if (!jobHasSteps) fail(name, jobLine, `job \`${job}\` has no steps`)
    }
    for (let i = jobsAt + 1; i < lines.length; i++) {
      const raw = lines[i]
      const indent = indentOf(raw)
      if (indent === null) continue
      if (indent === 0) break // out of `jobs:`
      if (indent === 2 && /^\s{2}[A-Za-z0-9_-]+:\s*$/.test(raw)) {
        closeJob()
        job = raw.trim().replace(/:$/, '')
        jobLine = i + 1
        jobHasRunsOn = false
        jobHasSteps = false
        continue
      }
      if (indent === 4 && /^\s{4}runs-on:/.test(raw)) jobHasRunsOn = true
      if (indent === 4 && /^\s{4}steps:/.test(raw)) jobHasSteps = true
    }
    closeJob()
  }

  // Every `- ` item inside a steps block eventually reaching `uses` or `run`.
  const stepBlocks = [...text.matchAll(/^( +)steps:\n/gm)]
  for (const m of stepBlocks) {
    const start = m.index + m[0].length
    const body = text.slice(start)
    const stepIndent = m[1].length + 2
    const stepRe = new RegExp(`^ {${stepIndent}}- `, 'gm')
    const items = []
    let match
    while ((match = stepRe.exec(body)) !== null) items.push(match.index)
    items.forEach((at, k) => {
      const end = k + 1 < items.length ? items[k + 1] : body.length
      const chunk = body.slice(at, end)
      // Stop at the next thing that dedents out of the steps list.
      const stop = chunk.search(new RegExp(`^ {0,${stepIndent - 1}}\\S`, 'm'))
      const step = stop > 0 ? chunk.slice(0, stop) : chunk
      if (!/\b(uses|run):/.test(step)) {
        const line = text.slice(0, start + at).split('\n').length
        fail(name, line, 'a step with neither `uses:` nor `run:`')
      }
    })
  }

  // ── Repository-specific invariants ─────────────────────────────────────
  //
  // Against the file WITH ITS COMMENTS STRIPPED. These workflows explain their
  // own decisions at length, and a check that fired on the sentence "this must
  // never use pull_request_target" would be a check that punishes writing the
  // reason down.
  const code = lines
    .map((l) => (l.trim().startsWith('#') ? '' : l))
    .join('\n')
  if (name === 'pr-evidence.yml') {
    // `pull_request_target` runs with the BASE repository's secrets against a
    // fork's code, which is the classic way a public repository gets its token
    // stolen. This job needs no secrets to render and must never use it.
    if (/pull_request_target/.test(code)) {
      fail(name, null, 'pull_request_target — this job renders untrusted code and must stay on pull_request')
    }
    // The two write steps must be guarded on a same-repo head. If either guard
    // is dropped, a fork pull request starts trying to push to this repository.
    const guards = (code.match(/head\.repo\.full_name == github\.repository/g) ?? []).length
    if (guards < 2) {
      fail(name, null, 'the push and comment steps must both be guarded on a same-repository head')
    }
    if (!/PW_ROOT/.test(code)) {
      fail(name, null, 'Playwright must be reached through PW_ROOT — it is not a repository dependency')
    }
  }
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
if (files.length === 0) {
  console.error(`no workflow files in ${DIR}`)
  process.exit(2)
}
for (const f of files.sort()) checkFile(f)

console.log(`check-workflows: ${files.length} workflow file(s)`)
for (const f of files.sort()) console.log(`  ${f}`)
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error(
    '\nThis is the offline half. `actionlint` in CI is the real parser; if this passed and that ' +
      'failed, trust that one.',
  )
  process.exit(1)
}
console.log('\nok — structure, SPDX, permissions, and the pr-evidence safety guards')

// ── The real parser, when this machine happens to have it ──────────────────
//
// Opportunistic, and NEVER a failure when it is absent. actionlint is a Go
// binary with no npm package, so requiring it here would make `pnpm run
// workflows` depend on a download; CI runs it unconditionally in its own job,
// and that is the gate.
//
// When it IS on PATH, running it closes the exact gap that produced the one
// finding this file could never have made: actionlint shells every `run:` block
// out to shellcheck, and shellcheck caught an unused loop variable in ci.yml
// that no amount of line-matching would have seen.
// `ACTIONLINT` overrides the binary, which is what Windows needs: Node's spawn
// does not apply PATHEXT, so a bare `actionlint` never resolves `actionlint.exe`
// there. No `shell: true` — passing args through a shell is a deprecated,
// unescaped concatenation, and buying a Windows convenience with an injection
// shape is not a trade this repository makes.
const ACTIONLINT = process.env.ACTIONLINT ?? 'actionlint'
const probe = spawnSync(ACTIONLINT, ['-version'], { encoding: 'utf8' })
if (probe.error === undefined && probe.status === 0) {
  const lint = spawnSync(ACTIONLINT, [], { cwd: ROOT, stdio: 'inherit' })
  if (lint.status !== 0) {
    console.error('\nactionlint disagreed — trust it over the checks above.')
    process.exit(1)
  }
  console.log(`actionlint ${String(probe.stdout).split('\n')[0].trim()}: clean`)
} else {
  console.log(
    'actionlint was not found — CI runs it in its own job, which is the gate. For the same check\n' +
      'locally (including shellcheck over every `run:` block, which is what caught SC2034 in ci.yml),\n' +
      'install github.com/rhysd/actionlint and put it on PATH, or set ACTIONLINT=<path to the binary>.',
  )
}
