// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// tools/migrate-corpus-frame.mts — cut the mask corpus over to canonical space.
//
//   node --conditions source tools/migrate-corpus-frame.mts --dry-run
//   node --conditions source tools/migrate-corpus-frame.mts --run-id frame-canonical-2026-09-01
//   node --conditions source tools/migrate-corpus-frame.mts --verify
//   node --conditions source tools/migrate-corpus-frame.mts --backfill-migrated-at [--dry-run]
//
// WHAT THIS IS. Every mask in data/foil-masks was authored at 490 x 674 — twice
// TCGdex's 245:337 small-size raster, which is 1.55% short of a real 63 x 88 mm
// card. 4b redefines the space as the CARD and this pass moves the corpus into
// it: 504 x 704, larger in both axes, so every mask resamples UP and nothing is
// thrown away. The transform is a 1.5% stretch in one axis on a soft-edged zone
// map the shader already reads through 0.008 UV of feather.
//
// WHAT THIS IS NOT. It is not a repaint. `derivation_method` DOES NOT MOVE — a
// `hand` mask stays `hand`, because nobody touched a brush — and neither does
// `savedAt`, because the alias rule picks the newest save per (cardId, scope)
// and re-stamping would misreport when the human worked. Each sidecar records
// the pass in its `lineage` as what it actually was: a frame migration.
//
// SAFETY. The write goes through `migrateMaskFrame` in provenance.ts, which
// reuses the SUPERSEDE ARCHIVE ROUTE rather than growing a second one: every
// artifact a mask has is copied verbatim into
// `superseded/<variantId>.<runId>/` with a sha256 per file and a manifest,
// BEFORE a single live byte is replaced, and `restoreArchive` puts the whole
// pass back byte-for-byte. `--verify` re-hashes every archive against its
// manifest without touching anything.
//
// PRE-EXISTING ARCHIVES ARE LEFT AT 490 x 674 ON PURPOSE. `superseded/*` holds
// a VERBATIM copy of bytes that were replaced, pinned by sha256 in its own
// manifest. Resampling them would make `restoreArchive`'s byte-for-byte promise
// false — an archive that no longer matches what it archived is worse than an
// archive in an old frame. A restore from one puts back a 490 x 674 mask,
// normalizeSidecar labels it `tcgdex-high` correctly from its own pixels, and
// re-running this pass migrates it. The old frame stays legible; the guarantee
// stays true.

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_H, CANONICAL_W } from '@foilkit/core';
import { CANONICAL_FRAME_ID, resolveFrame } from '@foilkit/forge';
import {
  archiveDirName,
  findArchives,
  maskPathsIn,
  migrateMaskFrame,
  readSidecarFile,
  sha256,
  type FrameMigrationResult,
} from '@foilkit/forge';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('repo root not found');
}
const ROOT = repoRoot();
const MASKS_DIR = join(ROOT, 'data/foil-masks');
const WINDOWS_DIR = join(ROOT, 'data/foil-windows');

const argv = process.argv.slice(2);
const has = (n: string): boolean => argv.includes(`--${n}`);
const arg = (n: string): string | null => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
};

const dryRun = has('dry-run');
const runId = arg('run-id') ?? `frame-canonical-${new Date().toISOString().slice(0, 10)}`;

// ── Enumerate ──────────────────────────────────────────────────────────────

interface Target {
  cardId: string;
  variantId: number;
  width: number;
  height: number;
  frame: string;
  method: string;
}

async function targets(): Promise<Target[]> {
  const out: Target[] = [];
  for (const cardId of await readdir(MASKS_DIR).catch(() => [] as string[])) {
    if (cardId === 'codified') continue;
    const st = await stat(join(MASKS_DIR, cardId)).catch(() => null);
    if (!st?.isDirectory()) continue;
    for (const f of await readdir(join(MASKS_DIR, cardId))) {
      const m = /^(\d{1,10})\.json$/.exec(f);
      if (!m) continue;
      const s = await readSidecarFile(MASKS_DIR, cardId, m[1]!);
      if (!s) continue;
      out.push({
        cardId,
        variantId: Number(m[1]),
        width: s.width,
        height: s.height,
        frame: s.frame,
        method: s.derivation_method,
      });
    }
  }
  return out.sort((a, b) => (a.cardId === b.cardId ? a.variantId - b.variantId : a.cardId < b.cardId ? -1 : 1));
}

// ── Verify: every archive still hashes to what its manifest recorded ────────

async function verifyArchives(): Promise<{ dirs: number; files: number; bad: string[] }> {
  const bad: string[] = [];
  let files = 0;
  const found = await findArchives(MASKS_DIR);
  for (const a of found) {
    for (const [name, want] of Object.entries(a.manifest.files)) {
      const buf = await readFile(join(a.dir, name)).catch(() => null);
      if (!buf) {
        bad.push(`${a.dir}/${name}: missing`);
        continue;
      }
      files++;
      const got = sha256(buf);
      if (got !== want) bad.push(`${a.dir}/${name}: ${got} != ${want}`);
    }
  }
  return { dirs: found.length, files, bad };
}

// ── Windows: fractional, so the file records the frame and nothing moves ────
//
// A window entry is a RECT IN FRACTIONS of the card face. A fraction is
// invariant under a uniform scale, so the geometry needs no transform at all
// and the only honest change is to say which space it is expressed in. It gets
// the same `frame` field masks do, and `canonical` is the right value because
// the rect describes the card and not any raster.

async function migrateWindows(apply: boolean): Promise<{ file: string; had: string | undefined }[]> {
  const done: { file: string; had: string | undefined }[] = [];
  for (const cardId of await readdir(WINDOWS_DIR).catch(() => [] as string[])) {
    const st = await stat(join(WINDOWS_DIR, cardId)).catch(() => null);
    if (!st?.isDirectory()) continue;
    for (const f of await readdir(join(WINDOWS_DIR, cardId))) {
      if (!/\.json$/.test(f)) continue;
      const p = join(WINDOWS_DIR, cardId, f);
      const raw = JSON.parse(await readFile(p, 'utf8')) as Record<string, unknown>;
      done.push({ file: `data/foil-windows/${cardId}/${f}`, had: raw.frame as string | undefined });
      if (!apply) continue;
      const next = {
        ...raw,
        version: 2,
        frame: CANONICAL_FRAME_ID,
        frameNote:
          'rect is a FRACTION of the card face and is therefore invariant under the 4b cutover — nothing moved. ' +
          'The field records which space the fraction describes: canonical (63 x 88 mm), not a raster.',
      };
      await writeFile(p, JSON.stringify(next, null, 2) + '\n', 'utf8');
    }
  }
  return done;
}

// ── Backfill: date the migration entries that predate `migratedAt` ─────────
//
// The first cutover pass wrote its lineage entry with `savedAt` carried
// forward from the human's save and nothing else, so the only entry in the
// file describing the 4b migration was stamped 2026-08-0x — which reads as
// "the migration happened in August". `migratedAt` fixes that going forward
// (provenance.ts stamps it at write time); this backfills the entries already
// on disk.
//
// The date is DERIVED, not typed in and not guessed from the run-id's name:
// the pass wrote `superseded/<variantId>.<runId>/archive.json` immediately
// before it replaced a byte, and that manifest carries `archivedAt`. That is
// the migration's own record of when it ran, to the millisecond. An entry
// whose archive is gone is REPORTED and left alone rather than given an
// invented timestamp.
//
// Nothing else in the file is touched: same key order, same values, PNG bytes
// untouched, and the archives still hash to their manifests (they hold the
// PRE-migration sidecar, which this does not edit).

async function backfillMigratedAt(apply: boolean): Promise<{ done: number; skipped: string[] }> {
  const skipped: string[] = [];
  let done = 0;
  for (const t of await targets()) {
    const paths = maskPathsIn(MASKS_DIR, t.cardId, t.variantId);
    const raw = JSON.parse(await readFile(paths.json, 'utf8')) as {
      lineage?: { frameMigration?: { runId: string }; migratedAt?: string }[];
    };
    const entries = (raw.lineage ?? []).filter((e) => e.frameMigration);
    if (entries.length === 0) continue;
    let changed = false;
    for (const e of entries) {
      if (e.migratedAt) continue;
      const runId = e.frameMigration!.runId;
      const manifestPath = join(paths.dir, archiveDirName(t.variantId, runId), 'archive.json');
      const manifest = await readFile(manifestPath, 'utf8').catch(() => null);
      if (!manifest) {
        skipped.push(`${t.cardId}/${t.variantId}: no archive for run ${runId} — leaving it undated rather than guessing`);
        continue;
      }
      const archivedAt = (JSON.parse(manifest) as { archivedAt?: string; runId?: string }).archivedAt;
      if (!archivedAt) {
        skipped.push(`${t.cardId}/${t.variantId}: archive ${runId} has no archivedAt`);
        continue;
      }
      e.migratedAt = archivedAt;
      changed = true;
      console.log(
        `  ${apply ? 'dated  ' : '[dry]  '} ${t.cardId}/${t.variantId}  ${runId}  savedAt ${String(
          (e as { savedAt?: string }).savedAt,
        )} -> migratedAt ${archivedAt}`,
      );
    }
    if (changed) {
      done++;
      if (apply) await writeFile(paths.json, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    }
  }
  return { done, skipped };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const canonical = resolveFrame({ width: CANONICAL_W, height: CANONICAL_H });
  if (canonical.frameId !== CANONICAL_FRAME_ID) {
    throw new Error(`data/frames.json has no ${CANONICAL_W}x${CANONICAL_H} canonical record (${canonical.basis})`);
  }

  if (has('backfill-migrated-at')) {
    console.log(`backfilling lineage.migratedAt from each pass's archive manifest${dryRun ? ' (DRY RUN)' : ''}`);
    const r = await backfillMigratedAt(!dryRun);
    for (const s of r.skipped) console.error(`  SKIP ${s}`);
    console.log(`${dryRun ? 'would date' : 'dated'} ${r.done} sidecar(s); ${r.skipped.length} skipped`);
    if (r.skipped.length) process.exitCode = 1;
    return;
  }

  if (has('verify')) {
    const v = await verifyArchives();
    console.log(`archives: ${v.dirs} dir(s), ${v.files} file(s) re-hashed`);
    if (v.bad.length) {
      for (const b of v.bad) console.error(`  CORRUPT ${b}`);
      process.exitCode = 1;
    } else {
      console.log('  every archived byte matches its manifest sha256');
    }
    return;
  }

  const all = await targets();
  const todo = all.filter((t) => t.width !== CANONICAL_W || t.height !== CANONICAL_H);
  console.log(`corpus: ${all.length} sidecar(s); ${todo.length} to migrate; run-id ${runId}${dryRun ? ' (DRY RUN)' : ''}`);
  for (const t of all) {
    const tag = todo.includes(t) ? 'MIGRATE' : 'skip   ';
    console.log(`  ${tag} ${t.cardId}/${t.variantId}  ${t.width}x${t.height} [${t.frame}]  ${t.method}`);
  }

  const wins = await migrateWindows(false);
  console.log(`windows: ${wins.length} file(s)${dryRun ? ' (DRY RUN)' : ''}`);

  if (dryRun) return;

  const results: FrameMigrationResult[] = [];
  for (const t of todo) {
    const r = await migrateMaskFrame({
      masksDir: MASKS_DIR,
      cardId: t.cardId,
      variantId: t.variantId,
      toFrame: CANONICAL_FRAME_ID,
      width: CANONICAL_W,
      height: CANONICAL_H,
      runId,
    });
    results.push(r);
    if (r.method !== t.method) throw new Error(`${t.cardId}/${t.variantId}: derivation_method moved — aborting`);
    const drift = r.correctionDrift
      ? `  correction agreement ${r.correctionDrift.before.toFixed(4)} -> ${r.correctionDrift.after.toFixed(4)}`
      : '';
    console.log(
      `  migrated ${r.cardId}/${r.variantId}  ${r.from.width}x${r.from.height} [${r.from.frame}] -> ` +
        `${r.to.width}x${r.to.height} [${r.to.frame}]  ${r.method}  archived ${Object.keys(r.archive).length} file(s)${drift}`,
    );
  }

  await migrateWindows(true);

  const v = await verifyArchives();
  console.log(`\narchives after the pass: ${v.dirs} dir(s), ${v.files} file(s) re-hashed`);
  if (v.bad.length) {
    for (const b of v.bad) console.error(`  CORRUPT ${b}`);
    process.exitCode = 1;
    return;
  }
  console.log('  every archived byte matches its manifest sha256');

  const after = await targets();
  const stragglers = after.filter((t) => t.width !== CANONICAL_W || t.height !== CANONICAL_H);
  console.log(
    `\n${after.length} sidecar(s), ${after.filter((t) => t.frame === CANONICAL_FRAME_ID).length} in canonical space, ` +
      `${stragglers.length} not migrated`,
  );
  if (stragglers.length) process.exitCode = 1;
}

await main();
