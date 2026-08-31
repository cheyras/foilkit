#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Fetch the two catalog scans the real-scan smoke test runs against.
//
// AGENTS.md F2 — the standing ownership rule — is why this is a script and not
// a checked-in fixture: reference imagery is CITED, with a procedure that
// fetches it locally. The citation ships; the pixels do not. The download
// target is `reference-media/`, which `.gitignore` already covers, and
// `smoke.test.ts` SKIPS rather than fails when the files are absent, so a clone
// with no network still passes its test run.
//
// FORMAT DECISION. The task's example URL is `high.webp`. Decoding WebP without
// a dependency means writing a VP8 intra decoder — a real project, and one with
// nothing to do with homographies. TCGdex serves the same asset as `.png` and
// `.jpg` from the same path, and `png.ts` already decodes PNG, so the smoke
// test uses PNG. Nothing about the rectifier is format-aware: it takes an RGBA
// buffer. Swapping in a WebP decoder later changes only the loader.
//
//   node tools/rectifier/fetch-smoke-scans.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SMOKE_SCANS, smokeScanDir } from './smoke-scans.ts';

const OUT = smokeScanDir(dirname(fileURLToPath(import.meta.url)));

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  // Sequential on purpose. Two files is not a crawl and does not need
  // concurrency; the politeness budget for this source is 5 req/s, 2 concurrent,
  // and one request at a time is comfortably inside it.
  for (const scan of SMOKE_SCANS) {
    const res = await fetch(scan.url);
    if (!res.ok) throw new Error(`${scan.url} → HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const path = join(OUT, scan.file);
    writeFileSync(path, buf);
    console.log(`${scan.file}  ${buf.length} bytes  ← ${scan.url}`);
  }
  console.log(`\nWrote ${SMOKE_SCANS.length} scans to ${OUT}`);
  console.log('These are third-party imagery and are gitignored. Do not commit them.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
