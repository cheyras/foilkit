// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// tools/corpus-manifest/build.ts — the walk behind `tools/build-corpus-manifest.mts`.
//
// Split out of the CLI so it can be exercised against synthetic corpora in a
// temp dir. Everything here is PURE with respect to the root it is handed:
// `buildCorpusManifest(root)` reads `<root>/data/foil-masks`,
// `<root>/data/foil-canon` and `<root>/data/foil-windows`, and returns a value.
// It writes nothing. The CLI owns --out / --check / --quiet.
//
// No database, no network, node: builtins + @foilkit/* only. This runs on EVERY
// build of the hosted editor, so it stays a directory walk and 20-odd file
// reads.
//
// ── COUNTING UNITS (3a's, unchanged — getting these wrong inflates the
//    numbers severalfold) ───────────────────────────────────────────────────
//
//  * MASK COVERAGE counts per (cardId, scope), NOT per (cardId, variantId).
//    All variants of one cardId render the same scan — imagery is keyed per
//    card and card_variant carries none of its own — so one mask serves every
//    sibling variant whose prior.scope matches, NEWEST savedAt winning. A holo
//    (window) and a reverse (sheet) of the same card must never share one,
//    hence scope is part of the key. `maskUnits` in the manifest maps
//    "<cardId>|<scope>" to the variantId that actually answers for it, so the
//    editor resolves an alias client-side with no second request.
//  * WINDOW GEOMETRY aliases scope-agnostically: the art box is a property of
//    the scan and a sheet is the same box inverted. Counted per cardId.
//  * CROSS-CARD REUSE NEVER ALIASES. Different cardIds that reprint the same
//    illustration (Base Set 2, promo reprints) cannot be proven identical from
//    the catalog — no illustration key, illustrator+name is heuristic, pHash is
//    similarity not identity — so they stay separate rows.
//
// ── WHY THIS FAILS LOUDLY ──────────────────────────────────────────────────
//
// A mask PNG with no sidecar, a sidecar `normalizeSidecar` rejects, a canon
// file that will not parse, a canon file named for something that is not a
// pattern — each is an ERROR, not a skipped row. `readCorpus` skips silently by
// design (it is a reader, and a damaged corpus must still be readable), which
// is exactly why this builder re-walks the directory and cross-checks: a
// silently skipped mask would under-report coverage, and the contribution
// filters would then hide work that is already done. A failed build is the
// cheaper failure.
//
// The ONE tolerated absence is a missing `data/foil-windows` — a checkout may
// carry no window corpus at all, and `readEvidence()` in build-pattern-cards
// already tolerates it the same way.

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readCorpus } from '@foilkit/forge'
import { PATTERNS, canonicalPatternId } from '@foilkit/patterns'

/** Emitted verbatim into the manifest — read this before comparing any number. */
export const COUNTING_UNITS = {
  maskCoverage:
    '(cardId, scope) — one mask serves every sibling variant of the card at that scope, newest savedAt wins',
  windowGeometry: 'cardId — scope-agnostic; a sheet is the same art box inverted',
  crossCardReuse: 'never aliased — reprints of one illustration under different cardIds stay separate rows',
  maskRecords: 'one row per mask file on disk, before any aliasing — maskRecords >= maskUnits by construction',
  uncanonedPatterns:
    "implemented pattern ids (PATTERNS, excluding 'none') with no data/foil-canon/<id>.json — DERIVED, never " +
    'hardcoded; absence is the datum #11 builds its queue on',
  generatedAt:
    'the NEWEST savedAt the corpus itself carries, NOT a clock reading — a wall-clock stamp would make this file ' +
    'differ on every build and turn --check into noise',
} as const

/** One mask record, in the docs/HOSTED-EDITOR.md §3 shape. */
export interface ManifestMask {
  variantId: number
  scope: string
  eraId: string
  method: string
  reviewStatus: string
  /** sidecar.diff.agreement when present, null otherwise (per §3). */
  agreement: number | null
  savedAt: string
  frame: string
  width: number
  height: number
  /** sha256 of the mask PNG BYTES — the pixels, not the JSON's claim about them. */
  sha256: string
}

export interface ManifestCanon {
  exists: true
  contract: number | null
  savedAt: string | null
  uniforms: number
}

export interface CorpusManifest {
  version: 1
  generatedAt: string
  countingUnits: typeof COUNTING_UNITS
  counts: {
    maskRecords: number
    maskCards: number
    maskUnits: number
    windowFiles: number
    windowCards: number
    canonFiles: number
    patterns: number
    uncanonedPatterns: number
  }
  /** cardId → variantId → record. */
  masks: Record<string, Record<string, ManifestMask>>
  /** "<cardId>|<scope>" → the variantId that answers for the whole unit. */
  maskUnits: Record<string, number>
  /** cardId → variantIds with a window geometry file. */
  windows: Record<string, number[]>
  /** canonical pattern id → what its canon file records. */
  canon: Record<string, ManifestCanon>
  /** Implemented patterns with NO canon file, sorted. Absence is the point. */
  uncanoned: string[]
  /** Every implemented recipe id, sorted — 'none' included, so counts.patterns === PATTERNS.length. */
  patterns: string[]
}

/** What the CLI prints. Not part of the artifact. */
export interface BuildReport {
  manifest: CorpusManifest
  /** Mask card dirs walked, excluding `codified`. */
  maskDirsWalked: number
  /** True when `data/foil-windows` is absent entirely (the tolerated absence). */
  windowsDirAbsent: boolean
}

/** Thrown for every condition in "WHY THIS FAILS LOUDLY". Always names the file. */
export class CorpusManifestError extends Error {
  override readonly name = 'CorpusManifestError'
}

// A function DECLARATION, not a const arrow: only a declaration (or an
// explicitly annotated name) lets TypeScript treat `fail(...)` as
// control-flow-terminating, which is what makes the narrowing below sound.
function fail(msg: string): never {
  throw new CorpusManifestError(msg)
}

/** Directory entries, or null when the directory does not exist. */
async function readdirOrNull(dir: string): Promise<string[] | null> {
  try {
    return await readdir(dir)
  } catch {
    return null
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Read + parse a JSON file, failing loudly and by name on either step. */
async function readJson(path: string, rel: string): Promise<Record<string, unknown>> {
  const text = await readFile(path, 'utf8').catch(() => null)
  if (text === null) fail(`${rel} could not be read.`)
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch (err) {
    return fail(`${rel} will not parse as JSON: ${(err as Error).message}`)
  }
}

/** `12.json` / `12.png` — never `12.prior.png`, `12.parent.diff.png`, `superseded/`. */
const RECORD_FILE = /^(\d{1,10})\.(png|json)$/

/**
 * Normalize a timestamp to a comparable ISO string, or null when it is not one.
 * Used only to pick the corpus's newest stamp — a malformed one must not become
 * `generatedAt`, and must not throw either: the sidecar reader has already
 * vouched for the record, and a bad date is not a reason to fail a build.
 */
function isoOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = Date.parse(raw)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

export async function buildCorpusManifest(root: string): Promise<BuildReport> {
  const masksDir = join(root, 'data', 'foil-masks')
  const canonDir = join(root, 'data', 'foil-canon')
  const windowsDir = join(root, 'data', 'foil-windows')

  /** Every ISO stamp the corpus carries; the newest becomes `generatedAt`. */
  const stamps: string[] = []

  // ── Masks ────────────────────────────────────────────────────────────────
  //
  // Two passes over the same directory, on purpose. `readCorpus` is the
  // sanctioned reader — it routes every sidecar through `readSidecarFile` →
  // `normalizeSidecar(raw, readMaskPixelDims(...))`, so v1/v2/v3 records
  // migrate on read and `frame` is INFERRED from the PNG's own header rather
  // than from the width/height the JSON claims. Re-implementing that walk here
  // would fork the migration. But `readCorpus` also SKIPS whatever it cannot
  // read, so the raw directory listing is what proves nothing was skipped.
  const maskDirs = await readdirOrNull(masksDir)
  if (maskDirs === null) {
    fail(`${masksDir} does not exist — the mask corpus is not optional (only data/foil-windows may be absent).`)
  }

  const corpus = await readCorpus(masksDir)
  const byKey = new Map<string, (typeof corpus)[number]>()
  for (const e of corpus) byKey.set(`${e.cardId}/${e.variantId}`, e)

  let maskDirsWalked = 0
  const masks: Record<string, Record<string, ManifestMask>> = {}
  const maskCards = new Set<string>()
  /** (cardId, scope) → the winning record. Newest savedAt wins (COUNTING_UNITS). */
  const units = new Map<string, { variantId: number; savedAt: string }>()

  for (const cardId of [...maskDirs].sort()) {
    if (cardId === 'codified') continue // the codification logs, not masks
    if (!(await isDir(join(masksDir, cardId)))) continue
    maskDirsWalked++
    const files = (await readdirOrNull(join(masksDir, cardId))) ?? []
    /** variantId → which halves of the record are on disk. */
    const seen = new Map<string, { png: boolean; json: boolean }>()
    for (const f of files) {
      const m = RECORD_FILE.exec(f)
      if (!m) continue
      const v = m[1]!
      const slot = seen.get(v) ?? { png: false, json: false }
      if (m[2] === 'png') slot.png = true
      else slot.json = true
      seen.set(v, slot)
    }

    for (const variantId of [...seen.keys()].sort((a, b) => Number(a) - Number(b))) {
      const half = seen.get(variantId)!
      const rel = `data/foil-masks/${cardId}/${variantId}`
      if (!half.json) {
        fail(`${rel}.png has no sidecar — ${rel}.json is missing. A mask with no provenance is a finding, not a row.`)
      }
      if (!half.png) {
        fail(`${rel}.json has no mask — ${rel}.png is missing. Refusing to report a half-record as coverage.`)
      }
      const entry = byKey.get(`${cardId}/${Number(variantId)}`)
      if (!entry) {
        // readCorpus dropped it. Say WHICH of the two reasons it was, by name.
        await readJson(join(masksDir, cardId, `${variantId}.json`), `${rel}.json`)
        fail(
          `${rel}.json was rejected by normalizeSidecar — it parses, but it is not a sidecar ` +
            '(a sidecar needs a string `cardId` and numeric `width`/`height`).',
        )
      }

      const s = entry.sidecar
      const bytes = await readFile(join(masksDir, cardId, `${variantId}.png`))
      const savedAt = typeof s.savedAt === 'string' ? s.savedAt : ''
      const record: ManifestMask = {
        variantId: entry.variantId,
        // A sidecar with no prior.scope cannot be aliased safely — it keys
        // alone under 'unknown' rather than silently joining a real unit.
        scope: String(s.prior?.scope ?? 'unknown'),
        eraId: String(s.prior?.eraId ?? 'unknown'),
        method: s.derivation_method,
        reviewStatus: s.reviewStatus,
        agreement: typeof s.diff?.agreement === 'number' ? s.diff.agreement : null,
        savedAt,
        frame: s.frame,
        width: s.width,
        height: s.height,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }
      ;(masks[cardId] ??= {})[String(entry.variantId)] = record
      maskCards.add(cardId)
      const iso = isoOrNull(savedAt)
      if (iso) stamps.push(iso)

      const unitKey = `${cardId}|${record.scope}`
      const held = units.get(unitKey)
      // Newest savedAt wins; a tie falls to the LOWER variantId so the answer
      // is stable rather than dependent on directory order.
      if (
        !held ||
        record.savedAt > held.savedAt ||
        (record.savedAt === held.savedAt && record.variantId < held.variantId)
      ) {
        units.set(unitKey, { variantId: record.variantId, savedAt: record.savedAt })
      }
    }
  }

  // ── Window geometry ──────────────────────────────────────────────────────
  const windows: Record<string, number[]> = {}
  let windowFiles = 0
  const winDirs = await readdirOrNull(windowsDir)
  const windowsDirAbsent = winDirs === null
  for (const cardId of [...(winDirs ?? [])].sort()) {
    if (!(await isDir(join(windowsDir, cardId)))) continue
    const files = (await readdirOrNull(join(windowsDir, cardId))) ?? []
    const ids: number[] = []
    for (const f of [...files].sort()) {
      const m = /^(\d{1,10})\.json$/.exec(f)
      if (!m) continue
      // Parsed rather than merely counted: a corrupt geometry file counted as
      // coverage would OVER-report, which is the same lie in the other
      // direction. Nothing from the body is emitted except its savedAt.
      const parsed = await readJson(join(windowsDir, cardId, f), `data/foil-windows/${cardId}/${f}`)
      const iso = isoOrNull(parsed.savedAt)
      if (iso) stamps.push(iso)
      ids.push(Number(m[1]!))
      windowFiles++
    }
    if (ids.length === 0) continue
    windows[cardId] = ids.sort((a, b) => a - b) // per cardId — scope-agnostic
  }

  // ── Canon ────────────────────────────────────────────────────────────────
  const implemented = PATTERNS.map((p) => p.id)
  const known = new Set(implemented)
  const canon: Record<string, ManifestCanon> = {}
  let canonFiles = 0
  const canonEntries = await readdirOrNull(canonDir)
  if (canonEntries === null) fail(`${canonDir} does not exist — the canon corpus is not optional.`)
  for (const f of [...canonEntries].sort()) {
    if (!f.endsWith('.json')) continue
    const rel = `data/foil-canon/${f}`
    // MIGRATION DISCIPLINE: resolve through canonicalPatternId on read, so an
    // alias filename (sv-holo.json) can never orphan a saved canon.
    const id = canonicalPatternId(f.slice(0, -'.json'.length))
    if (!known.has(id)) {
      fail(
        `${rel} is named for '${id}', which is not an implemented pattern id. A canon nothing can render is a finding.`,
      )
    }
    if (canon[id]) {
      fail(`${rel} resolves to '${id}', which another canon file in this directory already claims.`)
    }
    const raw = await readJson(join(canonDir, f), rel)
    const iso = isoOrNull(raw.savedAt)
    if (iso) stamps.push(iso)
    canon[id] = {
      exists: true,
      contract: typeof raw.contract === 'number' ? raw.contract : null,
      savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : null,
      uniforms: Object.keys((raw.uniforms as Record<string, unknown> | undefined) ?? {}).length,
    }
    canonFiles++
  }

  // ── Absence is data ──────────────────────────────────────────────────────
  // DERIVED, never hardcoded: every implemented id that is not 'none' and has
  // no canon file. 'none' is excluded because it is the NO-FOIL recipe — it has
  // no canon by definition and never will, so counting it would report a
  // permanent structural fact as a contribution opportunity.
  const uncanoned = implemented.filter((id) => id !== 'none' && !canon[id]).sort()

  // `generatedAt` is the newest stamp the CORPUS carries, not `new Date()`.
  // See COUNTING_UNITS.generatedAt.
  const generatedAt = [...stamps].sort().at(-1) ?? '1970-01-01T00:00:00.000Z'

  const manifest: CorpusManifest = {
    version: 1,
    generatedAt,
    countingUnits: COUNTING_UNITS,
    counts: {
      maskRecords: corpus.length,
      maskCards: maskCards.size,
      maskUnits: units.size,
      windowFiles,
      windowCards: Object.keys(windows).length,
      canonFiles,
      patterns: implemented.length,
      uncanonedPatterns: uncanoned.length,
    },
    masks,
    maskUnits: Object.fromEntries([...units].map(([k, v]) => [k, v.variantId])),
    windows,
    canon,
    uncanoned,
    patterns: [...implemented].sort(),
  }

  return { manifest, maskDirsWalked, windowsDirAbsent }
}

// ── Serialization ──────────────────────────────────────────────────────────
//
// Every object's keys sorted, every array sorted where it is built, two-space
// pretty printing (this file is small and gets read by humans in diffs).
// Determinism is not cosmetic: `--check` is CI's only proof that the committed
// manifest matches the corpus, and it can only say that if the same data
// serializes to the same bytes.

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortDeep((v as Record<string, unknown>)[k])
    }
    return out
  }
  return v
}

export function serializeManifest(manifest: CorpusManifest): string {
  return JSON.stringify(sortDeep(manifest), null, 2) + '\n'
}
