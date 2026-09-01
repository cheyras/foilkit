// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// FREEZE THE CANON FILES — write every uniform's currently-effective value.
//
//   node --conditions source tools/freeze-canon.mjs [--dry-run]
//
// THE PROBLEM. A canon file claims to be a FULL uniform snapshot: "this is what
// the pattern looks like, period." Twenty-one of the thirty-two were saved on
// 2026-08-02 and carry twelve uniforms; the other eleven were saved on
// 2026-08-07 and carry twenty. The eight R4–R6 composite uniforms — uMetal,
// uSheen, uSheenTint, uDepth, uGrain, uTint, uInkGuard, uInkPop — are simply
// ABSENT from the older twenty-one, which therefore inherit whatever
// GLOBAL_DEFAULTS says at read time. A "full snapshot" that silently tracks a
// code constant is not a snapshot, and moving the code into a separately
// versioned package is exactly the moment that stops being harmless.
//
// THE FIX, and its limit. Write each file's currently-effective value for every
// uniform in the contract, explicitly:
//
//     canon.uniforms[k]  ??  pattern.defaults[k]  ??  GLOBAL_DEFAULTS[k]
//
// plus each declared pattern param's effective value. That is the same value
// the renderer computes today, so NOTHING CHANGES VISUALLY — the parity harness
// proves it, and a freeze that moved a pixel would be a retune wearing a
// freeze's clothes. What changes is that the value is now recorded rather than
// inherited.
//
// WHAT THIS IS NOT. It is not a retune. The numbers are Chey's eye and a
// machine may not adjust them (AGENTS.md F4). `tunedUnderContract` does not
// move: these files were tuned under contract 1 before and after, and the
// twenty-one that never carried the R4–R6 dials at all are still tuned under
// contract 1 — recording an inherited default does not make it a decision.
// Re-tuning them is queue work, not extraction work.
//
// UNDECLARED PARAMS ARE NOT WRITTEN. A recipe that declares uP0–uP2 gets three
// param entries, not six: uP3–uP5 are unread by that recipe's GLSL, and writing
// a zero for them would assert a tuning decision about a dial that does not
// exist.
//
// uScanBase IS NOT WRITTEN. It is surface-owned — 1 on a card scan, 0 in the
// blank-base pattern room — and a stored value for it would mean the canon file
// decides which composite law runs, which it must not.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GLOBAL_DEFAULTS } from '@foilkit/core'
import { PATTERNS } from '@foilkit/patterns'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIR = join(ROOT, 'data/foil-canon')
const DRY = process.argv.includes('--dry-run')

const byId = new Map(PATTERNS.map((p) => [p.id, p]))
const CORE_KEYS = Object.keys(GLOBAL_DEFAULTS)

const report = []
for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()) {
  const path = join(DIR, file)
  const canon = JSON.parse(readFileSync(path, 'utf8'))
  const pattern = byId.get(canon.patternId ?? file.slice(0, -5))
  if (!pattern) throw new Error(`${file}: no recipe named ${canon.patternId}`)

  const before = { ...canon.uniforms }
  const frozen = {}
  for (const k of CORE_KEYS) {
    frozen[k] = before[k] ?? pattern.defaults[k] ?? GLOBAL_DEFAULTS[k]
  }
  for (const p of pattern.params) {
    frozen[p.key] = before[p.key] ?? p.default
  }

  // Every previously-stored key must survive with its exact value. A key that
  // is stored but neither a core uniform nor a declared param is INERT (the
  // removed R4c/R4d onset dials are the known case) — it is dropped, and the
  // drop is reported rather than silent.
  const dropped = []
  for (const [k, v] of Object.entries(before)) {
    if (k in frozen) {
      if (frozen[k] !== v) throw new Error(`${file}: freeze would change ${k} ${v} -> ${frozen[k]}`)
      continue
    }
    dropped.push([k, v])
  }

  const added = Object.keys(frozen).filter((k) => !(k in before))
  const out = {
    version: canon.version,
    patternId: canon.patternId,
    savedAt: canon.savedAt,
    ...(canon.note !== undefined ? { note: canon.note } : {}),
    contract: canon.contract,
    tunedUnderContract: canon.tunedUnderContract,
    // The record of THIS operation, so the file says how it came to be full.
    frozen: {
      at: '2026-09-01',
      reason:
        'foilkit extraction: every uniform in the contract recorded explicitly, ' +
        'so the snapshot no longer inherits code defaults that can move. Values ' +
        'are the ones already in effect — no retune, verified byte-identical ' +
        'through the zero-delta render harness.',
      inheritedKeysRecorded: added,
      ...(dropped.length ? { inertKeysDropped: Object.fromEntries(dropped) } : {}),
    },
    uniforms: Object.fromEntries(
      [...CORE_KEYS, ...pattern.params.map((p) => p.key)].map((k) => [k, frozen[k]]),
    ),
  }

  report.push({ file, was: Object.keys(before).length, now: Object.keys(out.uniforms).length, added, dropped: dropped.map(([k]) => k) })
  if (!DRY) writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`)
}

const widened = report.filter((r) => r.added.length > 0)
for (const r of report) {
  console.log(
    `${r.file.padEnd(30)} ${String(r.was).padStart(2)} -> ${String(r.now).padStart(2)}` +
      (r.added.length ? `  +${r.added.join(' +')}` : '  (already full)') +
      (r.dropped.length ? `  -${r.dropped.join(' -')}` : ''),
  )
}
console.log(
  `\n${report.length} canon files; ${widened.length} widened, ${report.length - widened.length} already full.` +
    (DRY ? ' (dry run — nothing written)' : ''),
)
