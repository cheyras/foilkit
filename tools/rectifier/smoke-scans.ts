// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The citation half of the real-scan smoke test. This file ships; the pixels it
// names do not (AGENTS.md F2).

import { join, resolve } from 'node:path';

export interface SmokeScan {
  /** Local filename under the download directory. */
  file: string;
  url: string;
  /** What the scan is, for the reader of a failing test. */
  note: string;
  /** The raster TCGdex publishes at this path, as observed 2026-08-31. */
  expectedRaster: [number, number];
}

/**
 * Two scans, chosen for exactly one reason each: they are a real catalog
 * framing rather than something this repository generated, and there are two of
 * them so the test can prove the rectifier is deterministic across inputs
 * rather than lucky on one.
 *
 * Source: TCGdex (assets.tcgdex.net), the catalog CDN. Requested as PNG — see
 * `fetch-smoke-scans.ts` for why not WebP.
 */
export const SMOKE_SCANS: readonly SmokeScan[] = [
  {
    file: 'base1-4.png',
    url: 'https://assets.tcgdex.net/en/base/base1/4/high.png',
    note: 'Base Set 4 — a WOTC-era window holo, the era the frame model is least sure about',
    expectedRaster: [600, 825],
  },
  {
    file: 'base1-2.png',
    url: 'https://assets.tcgdex.net/en/base/base1/2/high.png',
    note: 'Base Set 2 — a second card from the same set, so the framing is comparable',
    expectedRaster: [600, 825],
  },
];

/** Where the fetched scans live. Gitignored via the `reference-media/` rule. */
export function smokeScanDir(fromDir: string): string {
  return resolve(fromDir, '..', '..', 'reference-media', 'rectifier-smoke');
}

export function smokeScanPath(fromDir: string, file: string): string {
  return join(smokeScanDir(fromDir), file);
}
