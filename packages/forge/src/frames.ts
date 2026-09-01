// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// foil/frames.ts — the frame registry, and the rule for resolving one.
//
// Canonical space is the physical card (packages/patterns/src/card-space.json:
// 63 x 88 mm at 8 px/mm = 504 x 704). A mask is authored ONCE, in that space,
// and transformed out to whatever image it is drawn over. Every image source
// therefore declares a transform INTO canonical space, measured by subtask 4a
// and recorded in `data/frames.json`.
//
// THE RULE THIS MODULE ENFORCES: the frame a scan sits in is DERIVED, never
// claimed — from the asset's recorded provenance plus the file's own raster
// dimensions. Same rule as `derivation_method`: the state is something the
// system measured. A file matching no record resolves to `unknown`, and an
// unknown frame is EXCLUDED FROM MASK AUTHORING until a record exists. A
// silently wrong-frame mask is worse than a blocked one: the block is a
// question, the wrong mask is a stencil cut for the wrong picture that nobody
// notices until it is in the corpus.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_H, CANONICAL_W } from '@foilkit/core';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('repo root not found');
}

/**
 * Where the frame registry lives.
 *
 * Resolved LAZILY, and overridable by `FOILKIT_FRAMES_FILE`, for one concrete
 * reason: a serverless function has no repository checkout. The hosted editor's
 * write endpoint runs `writeMaskRecord` — which gates on the frame registry —
 * inside a Vercel function whose bundle contains no `pnpm-workspace.yaml`, so
 * the walk below finds nothing and used to THROW AT IMPORT TIME, before any
 * caller could hand over a path.
 *
 * The env var does not weaken the gate. A mask whose raster matches no record
 * still refuses to save; this only says which registry file to read, and the
 * function points it at a copy fetched from the repository it is about to
 * commit to, so the registry and the corpus are the same generation.
 */
let framesFileCache: string | null = null;
export function framesFile(): string {
  if (framesFileCache !== null) return framesFileCache;
  framesFileCache = process.env.FOILKIT_FRAMES_FILE ?? join(repoRoot(), 'data', 'frames.json');
  return framesFileCache;
}

/** Row-major 3x3, SOURCE pixel coords -> CANONICAL pixel coords. */
export type Homography = [[number, number, number], [number, number, number], [number, number, number]];

/**
 * What printing a source's scan depicts. Recorded, never gated on.
 *
 * `unknown` is the value every record carries today, and it means NO CLAIM —
 * not "probably normal" and emphatically not "probably reverse". 4a Part 3
 * swept the store for it and ABSTAINED (the detector was never calibrated on
 * flat catalog scans), so nothing has measured this for any source. The
 * compositor rule that follows from that: only a MEASURED `reverse` may
 * suppress an overlay; `unknown` suppresses nothing.
 */
export type ShowsPrinting = 'normal' | 'reverse' | 'holo' | 'unknown';

export interface FrameRecord {
  id: string;
  raster: [number, number];
  toCanonical: Homography;
  /**
   * TRUE when 4a's samples for this framing did NOT agree: the margins differ
   * card to card, so `toCanonical` is the MEDIAN and not a measurement of any
   * one card. WOTC at 600x825 is the loud case — medians 5/17.5/7.5/17.5 px
   * L/T/R/B at sd around 10, i.e. real per-card border variation.
   *
   * The flag exists so a consumer cannot trust the matrix blindly, and it is a
   * FIELD rather than only prose so the check can be mechanical. It does NOT
   * block mask authoring: the median is the best available registration and a
   * hand mask is precisely the fine correction that fixes the residual, which
   * is why these eras top 3a's leverage ranking. `margins` carries the spread.
   */
  perCardVariance?: true;
  shows: ShowsPrinting;
  showsBasis?: string;
  detect: {
    /** Host of image_asset.source_url this record covers. */
    host?: string;
    /** Set when the record covers assets with NO recorded provenance. */
    sourceUrlNull?: boolean;
    raster: [number, number];
    /** When present, this record only covers these eras (see $doc). */
    eras?: string[];
  };
  measuredOn: string;
  /** Samples behind this record — the ones actually AT `raster`, see mixedStoreRasters. */
  n: number;
  /**
   * Set when 4a's samples for this group did not all sit at the same STORE
   * raster. That is the second cause of an `inconsistent` verdict and it is
   * invisible in the margin spread, so such a group can look flat and tight
   * and yet not be one framing. When present, `n` counts only the samples at
   * this record's own raster; the rest belong to the record for theirs.
   */
  mixedStoreRasters?: { raster: [number, number]; n: number }[];
  verdict: string;
  margins?: {
    median: [number, number, number, number];
    sd: [number, number, number, number];
    medianFrac?: [number, number, number, number];
    rescaledFromSourceRaster?: boolean;
  };
  note?: string;
}

export interface FrameRegistry {
  version: number;
  measuredOn: string;
  canonical: { width: number; height: number };
  frames: FrameRecord[];
}

let cached: FrameRegistry | null = null;

export function loadFrames(file?: string): FrameRegistry {
  const resolved = file ?? framesFile();
  if (cached && resolved === framesFile()) return cached;
  const reg = JSON.parse(readFileSync(resolved, 'utf8')) as FrameRegistry;
  if (reg.canonical.width !== CANONICAL_W || reg.canonical.height !== CANONICAL_H) {
    throw new Error(
      `${resolved} was built against ${reg.canonical.width}x${reg.canonical.height} but canonical space is ` +
        `${CANONICAL_W}x${CANONICAL_H} — rebuild it with tools/build-frames.mts`,
    );
  }
  const ids = new Set<string>();
  for (const f of reg.frames) {
    if (ids.has(f.id)) throw new Error(`${resolved}: duplicate frame id ${f.id}`);
    ids.add(f.id);
  }
  if (resolved === framesFile()) cached = reg;
  return reg;
}

/** Test seam — drop the module-level cache. */
export function resetFrameCache(): void {
  cached = null;
}

/**
 * TEST SEAM. Install a registry for this process, e.g. one extended with a
 * synthetic framing so a unit test can author over a small raster without
 * pretending an unregistered one is fine. Never call this from app code: the
 * gate is only worth having if the registry is the committed one.
 */
export function __setFrameRegistryForTests(reg: FrameRegistry | null): void {
  cached = reg;
}

/** The id every canonical-space artifact carries. */
export const CANONICAL_FRAME_ID = 'canonical';
/** The id every pre-4b mask carries: the 490x674 authoring raster. */
export const AUTHORING_FRAME_ID = 'tcgdex-high';
/** What a file that matches no record resolves to. */
export const UNKNOWN_FRAME_ID = 'unknown';

export interface FrameQuery {
  /** image_asset.source_url, or null for the honest-blank unknown-provenance value. */
  sourceUrl?: string | null;
  /** The file's OWN dimensions, read from its header. Never taken on trust. */
  width: number;
  height: number;
  /** The layout era, when known — it is what separates two framings on one host. */
  eraId?: string | null;
}

export interface FrameResolution {
  /** The matched record, or null when nothing matched. */
  frame: FrameRecord | null;
  /** The id to STORE. `unknown` when nothing matched. */
  frameId: string;
  /** Why it resolved this way — auditable, and the message a block shows. */
  basis: string;
  /**
   * True when the matched record's transform is a MEDIAN over samples that did
   * not agree. Authoring is still allowed (see FrameRecord.perCardVariance),
   * but nothing downstream may treat the registration as exact.
   */
  perCardVariance: boolean;
}

function resolved(frame: FrameRecord, basis: string): FrameResolution {
  return { frame, frameId: frame.id, basis, perCardVariance: frame.perCardVariance === true };
}

function unresolved(basis: string): FrameResolution {
  return { frame: null, frameId: UNKNOWN_FRAME_ID, basis, perCardVariance: false };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Resolve the frame a file sits in.
 *
 * Order, most specific first — and specificity is not a convenience here. 4a
 * found groups that SHARE a host and a raster and are genuinely two framings
 * (WOTC's real per-card borders versus the modern eras' pure resamples on the
 * same TCGdex 600x825 endpoint). Only the era separates them, so an era-scoped
 * record must beat the unscoped one or every WOTC scan silently claims the
 * modern transform.
 *
 *   1. host + raster + era      (era-scoped record)
 *   2. host + raster            (unscoped record for that host)
 *   3. raster alone             (records with no host: canonical, the 490x674
 *                                authoring raster — a mask PNG has no source
 *                                URL, its raster IS its provenance)
 *   4. unknown
 *
 * A `sourceUrlNull` record matches only when the caller passes an explicit
 * null source URL, which is the honest-blank value the 2026-08-07 backfill
 * established for unknown provenance. There is no such record today (4a's
 * census gated on that bucket being empty); the branch exists so adding one
 * needs no code change.
 */
export function resolveFrame(q: FrameQuery, reg: FrameRegistry = loadFrames()): FrameResolution {
  const sameRaster = reg.frames.filter((f) => f.detect.raster[0] === q.width && f.detect.raster[1] === q.height);
  if (sameRaster.length === 0) {
    return unresolved(`no frame record has raster ${q.width}x${q.height}`);
  }

  const host = typeof q.sourceUrl === 'string' ? hostOf(q.sourceUrl) : null;

  if (host) {
    const byHost = sameRaster.filter((f) => f.detect.host === host);
    if (q.eraId) {
      const scoped = byHost.find((f) => f.detect.eras?.includes(q.eraId!));
      if (scoped) return resolved(scoped, `host ${host} + raster ${q.width}x${q.height} + era ${q.eraId}`);
    }
    const unscoped = byHost.find((f) => !f.detect.eras);
    if (unscoped) return resolved(unscoped, `host ${host} + raster ${q.width}x${q.height}`);
    if (byHost.length > 0) {
      // The host has records at this raster but all of them are era-scoped and
      // none covers this era. Guessing one would be exactly the silent
      // wrong-frame this module exists to prevent.
      return unresolved(
        `host ${host} at ${q.width}x${q.height} is covered only by era-scoped records ` +
          `(${byHost.map((f) => f.detect.eras?.join('/')).join(', ')}) and none covers era ${String(q.eraId)}`,
      );
    }
  }

  if (q.sourceUrl === null) {
    const blank = sameRaster.find((f) => f.detect.sourceUrlNull);
    if (blank) return resolved(blank, `source_url IS NULL + raster ${q.width}x${q.height}`);
  }

  // Records with no host at all are keyed on raster alone. A mask PNG has no
  // source URL — its raster IS its provenance, which is the whole point of
  // sidecar v4 inferring rather than trusting.
  const hostless = sameRaster.find((f) => !f.detect.host && !f.detect.sourceUrlNull);
  if (hostless) return resolved(hostless, `raster ${q.width}x${q.height} (no source host)`);

  return unresolved(
    `raster ${q.width}x${q.height} matches ${sameRaster.length} record(s) but none by host ` +
      `${host ?? '(none)'}${q.eraId ? ` / era ${q.eraId}` : ''}`,
  );
}

/**
 * THE AUTHORING GATE. An unknown frame is not a mask you draw carefully — it is
 * a mask you do not draw. Throws with the resolution basis so the caller can
 * say what to add to `data/frames.json` to unblock it.
 */
export function assertAuthorable(res: FrameResolution): FrameRecord {
  if (!res.frame) {
    throw new Error(
      `unknown image frame (${res.basis}) — mask authoring is blocked until data/frames.json carries a record ` +
        'for it. A mask drawn over an unregistered framing is a stencil cut for the wrong picture; add the ' +
        'record (measure it with tools/frame-survey) rather than guessing the transform.',
    );
  }
  return res.frame;
}

// ── Applying a transform ───────────────────────────────────────────────────

/** Apply a row-major 3x3 to a point. Divides through by w, so it is a real homography. */
export function applyHomography(h: Homography, x: number, y: number): [number, number] {
  const w = h[2][0] * x + h[2][1] * y + h[2][2];
  return [(h[0][0] * x + h[0][1] * y + h[0][2]) / w, (h[1][0] * x + h[1][1] * y + h[1][2]) / w];
}

/** Invert a 3x3. Used to sample the SOURCE for each canonical output pixel. */
export function invertHomography(h: Homography): Homography {
  const [[a, b, c], [d, e, f], [g, i, j]] = h;
  const A = e * j - f * i;
  const B = f * g - d * j;
  const C = d * i - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || det === 0) throw new Error('homography is singular');
  return [
    [A / det, (c * i - b * j) / det, (b * f - c * e) / det],
    [B / det, (a * j - c * g) / det, (c * d - a * f) / det],
    [C / det, (b * g - a * i) / det, (a * e - b * d) / det],
  ];
}

export function frameById(id: string, reg: FrameRegistry = loadFrames()): FrameRecord | null {
  return reg.frames.find((f) => f.id === id) ?? null;
}

/**
 * Warp a single-channel plane from a source frame into canonical space.
 *
 * The registry's whole purpose in one function: a mask is authored once, in
 * canonical space, and this is the operation that relates it to any image it is
 * drawn over. Bilinear, and inverse-mapped — for each CANONICAL output pixel it
 * asks the inverse homography which source point it came from, which is the
 * only way to fill the output without holes.
 *
 * Out-of-frame samples read 0. That is the honest answer for a framing that
 * carries margin: the source simply has no card there.
 */
export function warpAlphaToCanonical(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  toCanonicalMatrix: Homography,
  outW: number,
  outH: number,
): Uint8Array {
  const inv = invertHomography(toCanonicalMatrix);
  const out = new Uint8Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const [sx, sy] = applyHomography(inv, x + 0.5, y + 0.5);
      const fx = sx - 0.5;
      const fy = sy - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const wx = fx - x0;
      const wy = fy - y0;
      let acc = 0;
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const px = x0 + dx;
          const py = y0 + dy;
          if (px < 0 || py < 0 || px >= srcW || py >= srcH) continue;
          const w = (dx ? wx : 1 - wx) * (dy ? wy : 1 - wy);
          acc += w * src[py * srcW + px]!;
        }
      }
      out[y * outW + x] = Math.max(0, Math.min(255, Math.round(acc)));
    }
  }
  return out;
}
