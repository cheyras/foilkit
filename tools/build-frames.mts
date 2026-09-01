// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// tools/build-frames.mts — derive data/frames.json from 4a's measured survey.
//
//   node --conditions source tools/build-frames.mts \
//        --transforms tools/frame-survey/out/transforms.json \
//        [--shows tools/frame-survey/out/shows.ndjson] [--out data/frames.json]
//
// THE FRAME REGISTRY, AND WHY IT IS DERIVED RATHER THAN AUTHORED.
//
// A mask is a stencil, and a stencil only fits if the picture underneath is the
// shape it was cut for. Canonical space is the physical card (63 x 88 mm, see
// packages/core/src/card-space.json); every image source therefore has to
// declare a transform INTO that space, and the transform has to be MEASURED,
// not assumed. Subtask 4a measured it: for a sample per (host, quality, era) it
// found the bounding box of the printed card inside the frame and reported the
// per-side margin in pixels with its spread.
//
// This script turns those measurements into records. Two shapes come out:
//
//  * PURE RESAMPLE — every margin measured 0 on every sample. The whole card
//    fills the frame, so the transform is a pure scale and every fractional
//    rect in era-layouts.json carries over untouched. These fold together
//    across eras into ONE record per (host, raster).
//
//  * PER-CARD VARIABLE — the samples did not agree (4a's `inconsistent` /
//    `inset`). WOTC is the loud case: median margins 5/17.5/7.5/17.5 px L/T/R/B
//    at 600x825 with sd near 10, i.e. real border variation card to card, not
//    one framing. The registry carries the MEDIAN transform and RECORDS THE
//    SPREAD beside it. That is the honest state and it is deliberately not a
//    refit of the era rects: an average margin is not a correction, it is a
//    better guess. The fine correction is a hand mask, which is exactly why
//    vintage hand-masks earn the most (3a's leverage ranking).
//    These records are scoped to their eras, because they share a host and a
//    raster with the pure-resample ones and only the era separates them.
//
// `shows` is the printing a source's scan depicts, and it obeys the SAME rule
// as everything else in this registry: DERIVED, NEVER CLAIMED. So it is
// `unknown` on every record, because nothing has measured it.
//
// It is tempting to write `normal`: bulk catalog sources ship ONE image per card
// and 3b found no bulk source carrying variant-specific imagery (`card_variant`
// has no image column at all), so `normal` is a good EXPECTATION. But an
// expectation written into the field is exactly the claim this registry refuses
// to make anywhere else. 4a Part 3 is the reason it stays an expectation: its
// `haloDesat` sweep recorded `unknown` on all 3,493 assets — the detector was
// never calibrated on flat catalog scans, and its own control was inconsistent —
// so Part 3 ABSTAINED. A field that says `normal` on 22 of 23 records off the
// back of an abstention reads, to anything downstream, exactly like a
// measurement. `showsBasis` carries the reasoning and what would settle it.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_W, CANONICAL_H } from '@foilkit/core';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('repo root not found');
}
const ROOT = repoRoot();

const argv = process.argv.slice(2);
const arg = (n: string): string | null => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
};

const transformsPath = arg('transforms') ?? join(ROOT, 'tools/frame-survey/out/transforms.json');
const outPath = arg('out') ?? join(ROOT, 'data/frames.json');

interface Spread {
  n: number;
  mean: number;
  sd: number;
  min: number;
  max: number;
  median: number;
}
type Side = 'left' | 'top' | 'right' | 'bottom';
const SIDES: Side[] = ['left', 'top', 'right', 'bottom'];

interface Sample {
  cacheKey: string;
  /** The raster the margins were MEASURED on (the upstream original). */
  raster: [number, number];
  /** The raster the object store actually holds. */
  storeRaster: [number, number] | null;
  storeRasterAgrees: boolean;
  margins: Record<Side, number>;
  /** Margins as fractions of the measured raster — raster-independent. */
  marginsFrac: Record<Side, number>;
}

interface Group {
  id: string;
  bucket: string;
  host: string;
  quality: string;
  era: string;
  /** THE STORE RASTER — what a cached file's header reports, so what detect keys on. */
  raster: [number, number];
  n: number;
  verdict: 'pure-resample' | 'inset' | 'inconsistent' | string;
  marginSpread: Record<Side, Spread>;
  /**
   * DELIBERATELY NOT READ. 4a leaves this null on any group whose verdict is
   * `inconsistent`, and on the merged registry records it populates it from an
   * arbitrary first-seen era. A transform a consumer cannot tell apart from a
   * measured one is worse than no transform, so this script recomputes every
   * matrix from the per-side medians below and never touches this field.
   */
  toCanonical?: unknown;
  samples?: Sample[];
}
interface Survey {
  generatedAt: string;
  canonical: { width: number; height: number };
  groups: Group[];
}

const survey = JSON.parse(readFileSync(transformsPath, 'utf8')) as Survey;

if (survey.canonical.width !== CANONICAL_W || survey.canonical.height !== CANONICAL_H) {
  throw new Error(
    `the survey measured against ${survey.canonical.width}x${survey.canonical.height} but canonical space is ` +
      `${CANONICAL_W}x${CANONICAL_H} — re-run 4a before rebuilding the registry`,
  );
}

const measuredOn = survey.generatedAt.slice(0, 10);

/** Row-major 3x3 affine taking SOURCE pixel coords to CANONICAL pixel coords. */
type Homography = [[number, number, number], [number, number, number], [number, number, number]];

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Per-side margins for a group, expressed in STORE-RASTER pixels.
 *
 * Measured FRACTIONALLY and converted, not read as pixels, because 4a measured
 * against each asset's UPSTREAM original and the object store does not always
 * hold that raster: every images.pokemontcg.io `high` bucket is a 600x837 (or
 * 600x838) aspect-preserving downscale of a 734x1024 source PNG. A fraction is
 * invariant under that downscale; a pixel count is not. Every such group
 * happens to measure 0 on all four sides today, so this changes no number in
 * the current registry — it stops the next non-zero one being silently wrong.
 */
function marginsInStorePx(g: Group): { px: Record<Side, number>; frac: Record<Side, number>; rescaled: boolean } {
  const frac = {} as Record<Side, number>;
  const px = {} as Record<Side, number>;
  const samples = g.samples ?? [];
  const rescaled = samples.some((s) => s.storeRasterAgrees === false);
  for (const side of SIDES) {
    const dim = side === 'left' || side === 'right' ? g.raster[0] : g.raster[1];
    const fs = samples.map((s) => s.marginsFrac?.[side]).filter((v): v is number => typeof v === 'number');
    if (!rescaled) {
      // 4a measured on the raster the store holds, so its pixel median is
      // EXACT. Prefer it: round-tripping through a 5-dp fraction would add
      // digits of noise to a number that has none.
      px[side] = g.marginSpread[side].median;
      frac[side] = px[side] / dim;
    } else {
      frac[side] = fs.length ? median(fs) : g.marginSpread[side].median / dim;
      px[side] = Number((frac[side] * dim).toFixed(4));
    }
  }
  return { px, frac, rescaled };
}

/**
 * The printed card occupies [l, w-r] x [t, h-b] of the source frame. Map that
 * box onto the full canonical raster. A pure resample has all margins 0 and
 * degenerates to a plain scale with no translation, which is what makes a
 * fractional rect invariant under it.
 */
function toCanonical(raster: [number, number], m: { l: number; t: number; r: number; b: number }): Homography {
  const spanX = raster[0] - m.l - m.r;
  const spanY = raster[1] - m.t - m.b;
  if (!(spanX > 0) || !(spanY > 0)) throw new Error(`degenerate span for ${raster.join('x')}`);
  const sx = CANONICAL_W / spanX;
  const sy = CANONICAL_H / spanY;
  // Round the translation term to zero when it is one: -0 * s is -0, and a
  // signed zero in committed JSON is noise a reader has to explain away.
  const tx = m.l === 0 ? 0 : -m.l * sx;
  const ty = m.t === 0 ? 0 : -m.t * sy;
  return [
    [sx, 0, tx],
    [0, sy, ty],
    [0, 0, 1],
  ];
}

const SHOWS_BASIS =
  'NOT MEASURED — so not claimed. 4a Part 3 swept haloDesat over all 3,493 assets and recorded `unknown` on every ' +
  'one: the detector was never calibrated on flat catalog scans and its own control came back inconsistent, so ' +
  'Part 3 abstained rather than reporting a printing. The EXPECTATION is `normal` (a bulk catalog source ships one ' +
  'image per card and subtask 3b found none shipping variant-specific imagery), but an expectation written into ' +
  'this field is indistinguishable downstream from a measurement, which is the one thing this registry does not ' +
  'do. What would settle it: a haloDesat calibration on TAG-BLOCK-CROPPED scans, where the reverse-holo sheet is ' +
  'visible against ink that is flat on every printing. Until then: unknown, and unknown means NO CLAIM — never ' +
  '"probably reverse". Only a MEASURED `reverse` may suppress a compositor overlay.';

interface FrameRecord {
  id: string;
  raster: [number, number];
  toCanonical: Homography;
  /**
   * TRUE when the samples in this group did NOT agree — the margins differ card
   * to card, so `toCanonical` is a MEDIAN and not a measurement of any one
   * card. A consumer must not treat it as exact. Recorded as a flag and not
   * only as prose so the check can be mechanical.
   */
  perCardVariance?: true;
  shows: 'normal' | 'reverse' | 'holo' | 'unknown';
  showsBasis: string;
  detect: { host?: string; sourceUrlNull?: boolean; raster: [number, number]; eras?: string[] };
  measuredOn: string;
  n: number;
  /**
   * Set when 4a's samples for this group did NOT all sit at the same STORE
   * raster — i.e. the group is not one framing, and `n` counts only the samples
   * that are actually at this record's raster.
   */
  mixedStoreRasters?: { raster: [number, number]; n: number }[];
  verdict: string;
  /** Per-side margins as measured: STORE-raster px and raster-independent fractions. */
  margins?: {
    median: [number, number, number, number];
    sd: [number, number, number, number];
    medianFrac: [number, number, number, number];
    /** True when 4a measured on an upstream raster the store does not hold. */
    rescaledFromSourceRaster: boolean;
  };
  note?: string;
}

const pureByKey = new Map<string, { host: string; raster: [number, number]; n: number; eras: string[] }>();
const variable: FrameRecord[] = [];

for (const g of survey.groups) {
  const { px, frac, rescaled } = marginsInStorePx(g);
  const m = { l: px.left, t: px.top, r: px.right, b: px.bottom };
  const sd: [number, number, number, number] = [
    g.marginSpread.left.sd,
    g.marginSpread.top.sd,
    g.marginSpread.right.sd,
    g.marginSpread.bottom.sd,
  ];
  const flat = m.l === 0 && m.t === 0 && m.r === 0 && m.b === 0;
  const tight = Math.max(...sd) < 1;

  // A group is not ONE framing unless every sample sits at the same STORE
  // raster. 4a's `inconsistent` verdict covers both causes — margins that
  // disagree AND rasters that disagree — and the second is invisible in the
  // margin spread, so a raster-mixed group can look flat and tight and fold
  // into a pure-resample record it does not belong in. Counted here rather
  // than inferred from the verdict so the split is in the record as data.
  const rasterCounts = new Map<string, number>();
  for (const s of g.samples ?? []) {
    if (!s.storeRaster) continue;
    const k = s.storeRaster.join('x');
    rasterCounts.set(k, (rasterCounts.get(k) ?? 0) + 1);
  }
  const groupKey = g.raster.join('x');
  const rasterUniform = rasterCounts.size <= 1;
  const mixedStoreRasters = rasterUniform
    ? undefined
    : [...rasterCounts.entries()]
        .map(([k, n]) => ({ raster: k.split('x').map(Number) as [number, number], n }))
        .sort((a, b) => b.n - a.n || (a.raster[1] - b.raster[1]));
  // With mixed rasters, `n` may only count the samples this record's raster
  // actually covers. The others belong to whatever record holds THEIR raster.
  const nAtRaster = rasterUniform ? g.n : (rasterCounts.get(groupKey) ?? 0);

  if (rasterUniform && (g.verdict === 'pure-resample' || (flat && tight))) {
    // Folds into the host+raster record: identical transform, no era needed.
    // Note the gate is BOTH conditions on a non-pure verdict — a group whose
    // medians are 0 but whose samples disagreed does NOT fold.
    const key = `${g.host}|${g.raster.join('x')}`;
    const acc = pureByKey.get(key) ?? { host: g.host, raster: g.raster, n: 0, eras: [] };
    acc.n += g.n;
    if (!acc.eras.includes(g.era)) acc.eras.push(g.era);
    pureByKey.set(key, acc);
    continue;
  }

  variable.push({
    id: `${g.host}-${g.raster.join('x')}-${g.era}`,
    raster: g.raster,
    toCanonical: toCanonical(g.raster, m),
    perCardVariance: true,
    shows: 'unknown',
    showsBasis: SHOWS_BASIS,
    detect: { host: g.host, raster: g.raster, eras: [g.era] },
    measuredOn,
    n: nAtRaster,
    ...(mixedStoreRasters ? { mixedStoreRasters } : {}),
    verdict: g.verdict,
    margins: {
      median: [m.l, m.t, m.r, m.b],
      sd,
      medianFrac: [frac.left, frac.top, frac.right, frac.bottom].map((v) => Number(v.toFixed(6))) as [
        number,
        number,
        number,
        number,
      ],
      rescaledFromSourceRaster: rescaled,
    },
    note: mixedStoreRasters
      ? `MIXED STORE RASTERS — 4a's verdict here is \`${g.verdict}\`, and the cause is the RASTER, not the margins: ` +
        `its ${g.n} samples measured 0 px of margin on all four sides with sd 0, but they do not share one store ` +
        `raster (${mixedStoreRasters.map((r) => `${r.n} at ${r.raster.join('x')}`).join(', ')}). So this is not one ` +
        `framing. \`n\` is ${nAtRaster}, the samples actually at ${groupKey}; the rest are covered by the record for ` +
        'THEIR raster. The transform is a pure scale and is exact for the samples it covers — `perCardVariance` is ' +
        'set because the GROUP is not one framing, which is the fact a consumer must not lose, and it is what stops ' +
        'this group folding into the unscoped pure-resample record and inflating its n.'
      : `PER-CARD VARIABLE — 4a's samples did not agree (verdict ${g.verdict}, max sd ${Math.max(...sd).toFixed(1)} px). ` +
        'toCanonical is the MEDIAN transform, not a measurement of any one card, and `perCardVariance` says so in a ' +
        'field rather than only in prose. The era rects are deliberately NOT refit by it: an average margin is a ' +
        'better guess, not a correction, and swapping a stated uncertainty for a hidden one is the wrong trade. The ' +
        'fine correction is a hand mask — which is why vintage hand-masks earn the most in 3a\'s leverage ranking.',
  });
}

const pure: FrameRecord[] = [...pureByKey.values()]
  .map((p) => ({
    id: `${p.host}-${p.raster.join('x')}`,
    raster: p.raster,
    toCanonical: toCanonical(p.raster, { l: 0, t: 0, r: 0, b: 0 }),
    shows: 'unknown' as const,
    showsBasis: SHOWS_BASIS,
    detect: { host: p.host, raster: p.raster },
    measuredOn,
    n: p.n,
    verdict: 'pure-resample',
    note:
      `every margin measured 0 px on all ${p.n} samples across eras ${p.eras.sort().join(', ')} — the whole card ` +
      'fills the frame, so every fractional rect in era-layouts.json carries over unchanged and only cardAspect moves.',
  }))
  .sort((a, b) => (a.id < b.id ? -1 : 1));

variable.sort((a, b) => (a.id < b.id ? -1 : 1));

// The canonical frame itself: a rectified scan, an editor export, a community
// capture promoted to canonical. Identity transform by construction — subtask
// 14's promotion path is "add a record with an identity transform", so the
// record it promotes TO has to exist first.
const canonical: FrameRecord = {
  id: 'canonical',
  raster: [CANONICAL_W, CANONICAL_H],
  toCanonical: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  shows: 'unknown',
  showsBasis:
    'a rectified image carries whatever printing it was shot from; the capture records it, not the frame. (Every ' +
    'other record is `unknown` too, and for a different reason — see SHOWS_BASIS: nothing has measured it.)',
  detect: { raster: [CANONICAL_W, CANONICAL_H] },
  measuredOn,
  n: 0,
  verdict: 'identity',
  note: 'canonical space itself — 63x88 mm at 8 px/mm. Anything already in this raster needs no transform.',
};

// The authoring frame the whole pre-4b mask corpus was drawn in: 490x674, which
// is 245:337 — TCGdex's small-size aspect, doubled. It is not an image SOURCE,
// it is the raster MaskEditor used to paint in, and sidecar v4 infers it from a
// mask's own dimensions. It is registered so the migration has a named frame to
// transform FROM and so a stray 490x674 file never silently resolves to unknown.
const tcgdexHighAuthoring: FrameRecord = {
  id: 'tcgdex-high',
  raster: [490, 674],
  toCanonical: toCanonical([490, 674], { l: 0, t: 0, r: 0, b: 0 }),
  shows: 'unknown',
  showsBasis:
    'the mask AUTHORING raster is not an image source at all, so there is no printing for it to depict. `unknown` ' +
    'is the only honest value and the field is kept for shape.',
  detect: { raster: [490, 674] },
  measuredOn,
  n: 0,
  verdict: 'pure-resample',
  note:
    'the MASK AUTHORING raster used before 4b, not an image source: 490x674 is 245:337, TCGdex\'s small-size aspect. ' +
    'Every mask drawn on a tcgdex scan was painted here. Kept permanently so a pre-migration sidecar resolves to a ' +
    'real frame rather than to unknown, and so the migration has a named frame to transform FROM.',
};

const out = {
  $doc: [
    'THE FRAME REGISTRY — one record per image source, each declaring its transform into canonical space.',
    '',
    'Canonical space is the physical card: 63 x 88 mm at 8 px/mm = 504 x 704 (packages/core/src/card-space.json).',
    'A mask is authored ONCE, in canonical space, and transformed out to whatever image it is drawn over. That is',
    'what makes swapping the canonical image source a config change instead of a corpus redraw.',
    '',
    'toCanonical is a 3x3 ROW-MAJOR homography taking SOURCE PIXEL coordinates to CANONICAL PIXEL coordinates.',
    'A homography rather than an affine so 3b\'s rectifier and 14\'s community-scan pipeline plug in unchanged.',
    '',
    'RESOLUTION IS DERIVED, NEVER CLAIMED (same rule as derivation_method): from the asset\'s recorded provenance',
    '(image_asset.source_url) plus the file\'s OWN raster dimensions. A file matching no record resolves to',
    '`unknown` and is EXCLUDED from mask authoring until a record exists — a silent wrong-frame mask is worse',
    'than a blocked one. See packages/forge/src/frames.ts (resolveFrame).',
    '',
    'Records scoped by `detect.eras` win over the unscoped host+raster record for the same host and raster. That is',
    'not a tie-break convenience: 4a found groups that share a host and a raster and are genuinely two framings,',
    'and the era is the only thing separating them.',
    '',
    '`shows` is `unknown` on EVERY record, and that is the finding, not a gap someone forgot to fill. Same rule:',
    'derived, never claimed. 4a Part 3 swept the whole store and abstained — its detector was never calibrated on',
    'flat catalog scans and its own control was inconsistent — so no printing has been measured for any source.',
    '`unknown` means NO CLAIM. It must never be read as "probably reverse": only a MEASURED `reverse` may suppress',
    'a compositor overlay. `showsBasis` on each record says what would settle it.',
    '',
    'GENERATED by tools/build-frames.mts from 4a\'s tools/frame-survey/out/transforms.json. Do not hand-edit;',
    're-measure and rebuild.',
  ],
  version: 1,
  generatedAt: new Date().toISOString(),
  measuredOn,
  source: {
    survey: 'tools/frame-survey/out/transforms.json',
    surveyGeneratedAt: survey.generatedAt,
  },
  canonical: { width: CANONICAL_W, height: CANONICAL_H },
  frames: [canonical, tcgdexHighAuthoring, ...pure, ...variable],
};

writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(
  `wrote ${outPath}: ${out.frames.length} frames (${pure.length} pure-resample, ${variable.length} per-card-variable, ` +
    `+ canonical + the 490x674 authoring frame)`,
);
for (const f of out.frames) {
  const s = f.margins ? ` margins ${f.margins.median.join('/')} sd ${f.margins.sd.map((x) => x.toFixed(1)).join('/')}` : '';
  console.log(`  ${f.id.padEnd(38)} ${f.raster.join('x').padEnd(9)} n=${String(f.n).padEnd(4)} ${f.verdict}${s}`);
}
