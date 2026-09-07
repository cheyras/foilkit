// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// foil/mask-corpus.ts — read the whole mask corpus, report on it, select
// exemplars, and emit the training-tuple manifest a generator lane consumes.
//
// Three jobs, one scan of data/foil-masks:
//
//  1. REPORT      counts by derivation_method, mean rule-agreement, breakdown
//                 by era/set/series, and the queue of `ai` masks awaiting
//                 human review. Feeds GET /foil-lab/masks/corpus and the CLI.
//  2. EXEMPLARS   selectExemplars() — THE sanctioned way to pick masks a
//                 generator (or the codify ritual) may learn from. It applies
//                 the anti-feedback-collapse rule from provenance.ts: only
//                 masks a HUMAN painted are eligible, `ai` is weight 0 and can
//                 never be selected at any corpus size.
//  3. TUPLES      trainingTuples() — (card art, prior mask, human mask, diff,
//                 correction metrics) with every path resolved, so a future
//                 generator lane reads a manifest instead of reverse-
//                 engineering the directory.

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AUTHORSHIP_BY_METHOD,
  DERIVATION_METHODS,
  EXEMPLAR_WEIGHT,
  PROVENANCE_TIERS,
  TIER_IS_VERIFIED,
  exemplarWeightOf,
  maskPathsIn,
  readSidecarFile,
  REVIEW_BY_METHOD,
  type Authorship,
  type DerivationMethod,
  type ExemplarRef,
  type MaskSidecarV3,
  type ProvenanceTier,
  type ReviewStatus,
} from './provenance.ts';


// The route a served mask is addressable at. A REPORT field, not a fetch: the
// corpus report is consumed by an editor that knows its own API prefix, and
// DeckPal's hardcoded `/deckscout/api/foil-lab` meant nothing outside DeckPal.
let MASK_ROUTE = '/masks';

/** Point corpus reports at this deployment's mask route. */
export function configureMaskRoute(base: string): void {
  MASK_ROUTE = base.replace(/\/+$/, '');
}

export interface CorpusEntry {
  cardId: string;
  variantId: number;
  sidecar: MaskSidecarV3;
  /** Repo-relative paths of everything on disk for this entry. */
  files: {
    mask: string;
    sidecar: string;
    prior: string | null;
    diff: string | null;
    parent: string | null;
    parentDiff: string | null;
  };
}

const REL = (cardId: string, file: string): string => `data/foil-masks/${cardId}/${file}`;

/** setId from a catalog cardId: 'base1-8' → 'base1', 'me04.5-12' → 'me04.5'. */
export function setIdOf(cardId: string): string | null {
  const i = cardId.lastIndexOf('-');
  return i > 0 ? cardId.slice(0, i) : null;
}

/** Scan data/foil-masks and return every mask that has a readable sidecar. */
export async function readCorpus(masksDir: string): Promise<CorpusEntry[]> {
  let dirs: string[] = [];
  try {
    dirs = await readdir(masksDir);
  } catch {
    return [];
  }
  const out: CorpusEntry[] = [];
  for (const cardId of dirs) {
    if (cardId === 'codified') continue; // the codification logs, not masks
    let files: string[];
    try {
      const st = await stat(join(masksDir, cardId));
      if (!st.isDirectory()) continue;
      files = await readdir(join(masksDir, cardId));
    } catch {
      continue;
    }
    for (const f of files) {
      const m = /^(\d{1,10})\.json$/.exec(f);
      if (!m) continue;
      const variantId = m[1]!;
      const sidecar = await readSidecarFile(masksDir, cardId, variantId);
      if (!sidecar) continue;
      const has = (name: string): string | null => (files.includes(name) ? REL(cardId, name) : null);
      out.push({
        cardId,
        variantId: Number(variantId),
        sidecar,
        files: {
          mask: REL(cardId, `${variantId}.png`),
          sidecar: REL(cardId, `${variantId}.json`),
          prior: has(`${variantId}.prior.png`),
          diff: has(`${variantId}.diff.png`),
          parent: has(`${variantId}.parent.png`),
          parentDiff: has(`${variantId}.parent.diff.png`),
        },
      });
    }
  }
  out.sort((a, b) => (a.cardId === b.cardId ? a.variantId - b.variantId : a.cardId < b.cardId ? -1 : 1));
  return out;
}

// ── Exemplar selection (anti-feedback-collapse enforced HERE) ──────────────

export interface ExemplarQuery {
  /** Restrict to one era (the layout family a generator targets). */
  eraId?: string | null;
  /** Restrict to one scope — a window mask must never teach a sheet mask. */
  scope?: string | null;
  /** Cap the number returned (highest weight, then newest). */
  limit?: number;
}

export interface ExemplarSelection {
  chosen: (CorpusEntry & { weight: number })[];
  /** Every mask considered and thrown out, with the reason — auditable. */
  rejected: {
    cardId: string;
    variantId: number;
    method: DerivationMethod;
    tier: ProvenanceTier;
    /**
     * WHICH RULE threw it out, as a value rather than as prose. Callers need to
     * tell them apart and were otherwise going to grep the reason string:
     *
     *   `method` — 0 in every tier (`ai`, `layout-flatten`). Unpromotable.
     *   `tier`   — the method would carry weight; only verification is missing.
     *              THIS is the pool's pending capacity, one review per record.
     *   `filter` — a fine mask for a different era or scope. Not about merit.
     */
    kind: 'method' | 'tier' | 'filter';
    reason: string;
  }[];
}

/**
 * Pick the masks a generator may learn from.
 *
 * THE SAFEGUARD: `exemplarWeightOf(sidecar) > 0` is the only gate that admits a
 * mask, and it is now read off a table keyed by (method × TIER):
 *
 *   * `ai` (unreviewed machine output) and `layout-flatten` (a rect the machine
 *     already knows) are 0 in every tier. So a generator can never train on its
 *     own unreviewed output — not by configuration, not by accident, not at
 *     n=1000. That is the original anti-feedback-collapse rule, untouched.
 *   * Everything outside the `owner-verified` tier is 0 as well. A merged
 *     contribution is ACCEPTED — it is in the corpus, it is served, it renders
 *     — and that is a strictly weaker claim than "the rule for a whole era may
 *     be derived from this". Merge is acceptance; verification is exemplar
 *     grade; only the second buys weight. It is one owner action away
 *     (`verifyMaskRecord`), and until then the mask is cited in `rejected` with
 *     its tier rather than silently dropped.
 *
 * `ai-corrected` at 0.6 survives inside the verified tier for the original
 * reason: a human painted those pixels, but anchored by what the AI proposed,
 * so pure human masks outrank it.
 */
export function selectExemplars(corpus: CorpusEntry[], q: ExemplarQuery = {}): ExemplarSelection {
  const chosen: (CorpusEntry & { weight: number })[] = [];
  const rejected: ExemplarSelection['rejected'] = [];
  for (const e of corpus) {
    const method = e.sidecar.derivation_method;
    const tier = e.sidecar.provenanceTier;
    const weight = exemplarWeightOf(e.sidecar);
    if (weight <= 0) {
      rejected.push({
        cardId: e.cardId,
        variantId: e.variantId,
        method,
        tier,
        kind: EXEMPLAR_WEIGHT[method] === 0 ? 'method' : 'tier',
        // THE METHOD REASON COMES FIRST when there is one, and that ordering is
        // load-bearing rather than cosmetic. `ai` and `layout-flatten` are 0 in
        // every tier — verifying one would buy nothing — so "unreviewed machine
        // output" is both the sharper answer and the actionable one. Leading
        // with the tier would report an `ai` mask as "not verified yet", which
        // reads as an invitation to verify it.
        reason:
          EXEMPLAR_WEIGHT[method] === 0
            ? method === 'ai'
              ? 'unreviewed machine output — never an exemplar (anti-feedback-collapse)'
              : 'machine-rasterized geometry — teaches only the rect the generator already has'
            : tier === 'contributor'
              ? `contributor-authored${authorOf(e)} and not yet owner-verified — merge is acceptance, not exemplar grade`
              : 'no human attribution recorded (a v5 record with no author) — never an exemplar',
      });
      continue;
    }
    if (q.eraId && e.sidecar.prior?.eraId !== q.eraId) {
      rejected.push({ cardId: e.cardId, variantId: e.variantId, method, tier, kind: 'filter', reason: `era ${String(e.sidecar.prior?.eraId)} != ${q.eraId}` });
      continue;
    }
    if (q.scope && e.sidecar.prior?.scope !== q.scope) {
      rejected.push({ cardId: e.cardId, variantId: e.variantId, method, tier, kind: 'filter', reason: `scope ${String(e.sidecar.prior?.scope)} != ${q.scope}` });
      continue;
    }
    chosen.push({ ...e, weight });
  }
  chosen.sort((a, b) => (b.weight - a.weight) || (a.sidecar.savedAt < b.sidecar.savedAt ? 1 : -1));
  return { chosen: q.limit ? chosen.slice(0, q.limit) : chosen, rejected };
}

/** ` by @login`, when the record names one. Goes in the rejection reason. */
function authorOf(e: CorpusEntry): string {
  const login = e.sidecar.author?.login;
  return typeof login === 'string' && login.length > 0 ? ` by @${login}` : '';
}

export function toExemplarRefs(sel: ExemplarSelection): ExemplarRef[] {
  return sel.chosen.map((e) => ({
    cardId: e.cardId,
    variantId: e.variantId,
    savedAt: e.sidecar.savedAt ?? null,
    method: e.sidecar.derivation_method,
    tier: e.sidecar.provenanceTier,
    weight: e.weight,
  }));
}

// ── Report ─────────────────────────────────────────────────────────────────

interface Bucket {
  n: number;
  byMethod: Partial<Record<DerivationMethod, number>>;
  meanAgreement: number | null;
}

function bucket(entries: CorpusEntry[]): Bucket {
  const byMethod: Partial<Record<DerivationMethod, number>> = {};
  let sum = 0;
  let count = 0;
  for (const e of entries) {
    const m = e.sidecar.derivation_method;
    byMethod[m] = (byMethod[m] ?? 0) + 1;
    if (typeof e.sidecar.diff?.agreement === 'number') {
      sum += e.sidecar.diff.agreement;
      count++;
    }
  }
  return { n: entries.length, byMethod, meanAgreement: count ? Number((sum / count).toFixed(4)) : null };
}

function groupBy(entries: CorpusEntry[], key: (e: CorpusEntry) => string | null): Record<string, Bucket> {
  const groups = new Map<string, CorpusEntry[]>();
  for (const e of entries) {
    const k = key(e) ?? 'unknown';
    const list = groups.get(k);
    if (list) list.push(e);
    else groups.set(k, [e]);
  }
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, bucket(v)]));
}

export interface AwaitingReview {
  cardId: string;
  variantId: number;
  savedAt: string;
  generator: { name: string; version: number; runId: string; modelId: string | null } | null;
  confidence: number | null;
  exemplars: number;
  /** Rule-vs-mask agreement, so a reviewer can triage the worst first. */
  agreement: number | null;
  maskUrl: string;
  /**
   * Set when this proposal REPLACED a mask a human had painted — review that
   * first, and note the one-line undo. null when it created a mask from nothing.
   */
  superseded: { method: DerivationMethod; agreement: number; changedFraction: number; runId: string; archiveDir: string } | null;
}

/**
 * A contributor mask that would carry weight if a writer verified it.
 *
 * A SECOND QUEUE, deliberately distinct from `awaitingReview`. That one is "a
 * machine proposed this and no human has looked"; this one is "a human painted
 * this, it was good enough to merge, and no writer has said it is good enough
 * to derive a rule from". Different question, different actor, different act —
 * and folding them together would make the review queue look like a backlog of
 * suspect work rather than what it is.
 */
export interface AwaitingVerification {
  cardId: string;
  variantId: number;
  savedAt: string;
  method: DerivationMethod;
  tier: ProvenanceTier;
  /** The contributor, when the record names one. */
  author: { login: string; id: number | null } | null;
  eraId: string | null;
  scope: string | null;
  /** Rule-vs-mask agreement — triage signal, exactly as in the review queue. */
  agreement: number | null;
  /** What verifying it would be worth: the weight it would then carry. */
  weightIfVerified: number;
  maskUrl: string;
}

export interface CorpusReport {
  generatedAt: string;
  total: number;
  byMethod: Record<DerivationMethod, number>;
  byAuthorship: Record<string, number>;
  byReviewStatus: Record<string, number>;
  /** #10: counts by provenance tier — how much of the corpus carries weight. */
  byTier: Record<ProvenanceTier, number>;
  /** Contributor logins the corpus names, with how many records each authored. */
  byAuthor: Record<string, number>;
  /** Mean of diff.agreement (rule vs saved mask) across the whole corpus. */
  meanAgreement: number | null;
  byEra: Record<string, Bucket>;
  bySet: Record<string, Bucket>;
  bySeries: Record<string, Bucket>;
  byScope: Record<string, Bucket>;
  /** How many masks a generator is currently allowed to learn from. */
  exemplarsAvailable: { total: number; byEra: Record<string, number>; byScope: Record<string, number> };
  /** `ai` masks no human has touched — the review queue. */
  awaitingReview: AwaitingReview[];
  /** Human masks no WRITER has verified — the promotion queue (#10). */
  awaitingVerification: AwaitingVerification[];
  /** Every human correction of a machine mask — the training signal so far. */
  corrections: {
    n: number;
    meanAgreementVsParent: number | null;
    meanChangedFraction: number | null;
    entries: {
      cardId: string;
      variantId: number;
      savedAt: string;
      parentMethod: DerivationMethod;
      generator: string | null;
      agreement: number;
      changedFraction: number;
      addedPx: number;
      removedPx: number;
    }[];
  };
  /** Sidecar schema versions on disk — proves v2 files still load. */
  bySidecarVersion: Record<string, number>;
}

export function buildReport(corpus: CorpusEntry[]): CorpusReport {
  const byMethod = Object.fromEntries(DERIVATION_METHODS.map((m) => [m, 0])) as Record<DerivationMethod, number>;
  const byAuthorship: Record<string, number> = {};
  const byReviewStatus: Record<string, number> = {};
  const byTier = Object.fromEntries(PROVENANCE_TIERS.map((t) => [t, 0])) as Record<ProvenanceTier, number>;
  const byAuthor: Record<string, number> = {};
  const bySidecarVersion: Record<string, number> = {};
  let agSum = 0;
  let agCount = 0;
  const awaitingReview: AwaitingReview[] = [];
  const awaitingVerification: AwaitingVerification[] = [];
  const corrections: CorpusReport['corrections']['entries'] = [];

  for (const e of corpus) {
    const s = e.sidecar;
    byMethod[s.derivation_method]++;
    byTier[s.provenanceTier]++;
    if (s.author?.login) byAuthor[s.author.login] = (byAuthor[s.author.login] ?? 0) + 1;
    // The promotion queue: a mask whose METHOD would carry weight, held at 0
    // only because nobody with the capability has verified it. A machine mask
    // is excluded — verifying an `ai` record buys nothing, because its method
    // is 0 in the verified tier too, and offering it would be an affordance
    // that does nothing.
    if (!TIER_IS_VERIFIED[s.provenanceTier] && EXEMPLAR_WEIGHT[s.derivation_method] > 0) {
      awaitingVerification.push({
        cardId: e.cardId,
        variantId: e.variantId,
        savedAt: s.savedAt,
        method: s.derivation_method,
        tier: s.provenanceTier,
        author: s.author ? { login: s.author.login, id: s.author.id } : null,
        eraId: s.prior?.eraId ?? null,
        scope: s.prior?.scope ?? null,
        agreement: s.diff?.agreement ?? null,
        weightIfVerified: EXEMPLAR_WEIGHT[s.derivation_method],
        maskUrl: `${MASK_ROUTE}/${e.cardId}/${e.variantId}`,
      });
    }
    byAuthorship[AUTHORSHIP_BY_METHOD[s.derivation_method]] =
      (byAuthorship[AUTHORSHIP_BY_METHOD[s.derivation_method]] ?? 0) + 1;
    byReviewStatus[REVIEW_BY_METHOD[s.derivation_method]] =
      (byReviewStatus[REVIEW_BY_METHOD[s.derivation_method]] ?? 0) + 1;
    bySidecarVersion[String(s.version)] = (bySidecarVersion[String(s.version)] ?? 0) + 1;
    if (typeof s.diff?.agreement === 'number') {
      agSum += s.diff.agreement;
      agCount++;
    }
    if (s.derivation_method === 'ai') {
      const g = s.prior?.generator ?? null;
      awaitingReview.push({
        cardId: e.cardId,
        variantId: e.variantId,
        savedAt: s.savedAt,
        generator: g ? { name: g.name, version: g.version, runId: g.runId, modelId: g.modelId } : null,
        confidence: g?.confidence ?? null,
        exemplars: g?.exemplars.length ?? 0,
        agreement: s.diff?.agreement ?? null,
        maskUrl: `${MASK_ROUTE}/${e.cardId}/${e.variantId}`,
        superseded: s.supersedes
          ? {
              method: s.supersedes.parent.method,
              agreement: s.supersedes.agreement,
              changedFraction: s.supersedes.changedFraction,
              runId: s.supersedes.runId,
              archiveDir: s.supersedes.archiveDir,
            }
          : null,
      });
    }
    if (s.correction) {
      corrections.push({
        cardId: e.cardId,
        variantId: e.variantId,
        savedAt: s.savedAt,
        parentMethod: s.correction.parent.method,
        generator: s.correction.parent.generator
          ? `${s.correction.parent.generator.name}@${s.correction.parent.generator.version}`
          : null,
        agreement: s.correction.agreement,
        changedFraction: s.correction.changedFraction,
        addedPx: s.correction.addedPx,
        removedPx: s.correction.removedPx,
      });
    }
  }
  awaitingReview.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  // Highest potential weight first, then newest: what an hour of review buys.
  awaitingVerification.sort(
    (a, b) => b.weightIfVerified - a.weightIfVerified || (a.savedAt < b.savedAt ? 1 : -1),
  );

  const eligible = selectExemplars(corpus).chosen;
  const countBy = (list: typeof eligible, key: (e: (typeof eligible)[number]) => string): Record<string, number> => {
    const o: Record<string, number> = {};
    for (const e of list) o[key(e)] = (o[key(e)] ?? 0) + 1;
    return o;
  };

  const mean = (nums: number[]): number | null =>
    nums.length ? Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(4)) : null;

  return {
    generatedAt: new Date().toISOString(),
    total: corpus.length,
    byMethod,
    byAuthorship,
    byReviewStatus,
    byTier,
    byAuthor,
    meanAgreement: agCount ? Number((agSum / agCount).toFixed(4)) : null,
    byEra: groupBy(corpus, (e) => e.sidecar.prior?.eraId ?? null),
    bySet: groupBy(corpus, (e) => e.sidecar.card?.setId ?? setIdOf(e.cardId)),
    bySeries: groupBy(corpus, (e) => e.sidecar.card?.seriesSlug ?? null),
    byScope: groupBy(corpus, (e) => e.sidecar.prior?.scope ?? null),
    exemplarsAvailable: {
      total: eligible.length,
      byEra: countBy(eligible, (e) => e.sidecar.prior?.eraId ?? 'unknown'),
      byScope: countBy(eligible, (e) => e.sidecar.prior?.scope ?? 'unknown'),
    },
    awaitingReview,
    awaitingVerification,
    corrections: {
      n: corrections.length,
      meanAgreementVsParent: mean(corrections.map((c) => c.agreement)),
      meanChangedFraction: mean(corrections.map((c) => c.changedFraction)),
      entries: corrections.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1)),
    },
    bySidecarVersion,
  };
}

// ── Training tuples (the generator lane's input contract) ──────────────────

export interface TrainingTuple {
  cardId: string;
  variantId: number;
  eraId: string | null;
  scope: string | null;
  setId: string | null;
  seriesSlug: string | null;
  /** The scan the mask was drawn on. null on masks saved before v3. */
  artworkUrl: string | null;
  width: number;
  height: number;
  method: DerivationMethod;
  authorship: Authorship;
  reviewStatus: ReviewStatus;
  /** #10: the verification tier the weight below is keyed on, with the method. */
  tier: ProvenanceTier;
  /** Who authored the pixels, when the record names them. Null on v1–v4. */
  author: { login: string; id: number | null; via: string } | null;
  /** Who verified them, and when. Null until a writer has. */
  verifiedBy: { login: string; at: string } | null;
  /** Exemplar weight for (method × tier) — 0 means "do not learn from this". */
  exemplarWeight: number;
  /** The deterministic era rect this mask was scored against. */
  ruleRect: [number, number, number, number] | null;
  files: CorpusEntry['files'];
  /** Rule-vs-mask (how wrong the layout rule was). */
  ruleDiff: MaskSidecarV3['diff'] | null;
  /** Machine identity, when this mask descends from a generator run. */
  generator: MaskSidecarV3['prior']['generator'] | null;
  /**
   * THE CORRECTION TUPLE: present iff a human edited a prior mask. Gives the
   * pre-correction pixels (`files.parent`), the change map (`files.parentDiff`)
   * and the metrics — a supervised (input, target) pair with no inference.
   */
  correction: MaskSidecarV3['correction'] | null;
  lineage: MaskSidecarV3['lineage'];
}

export interface TrainingManifest {
  version: 1;
  generatedAt: string;
  /** Repo-relative root every `files.*` path is resolved against. */
  root: string;
  /** How to read a tuple — spelled out so no lane has to reverse-engineer it. */
  contract: string[];
  counts: {
    total: number;
    exemplars: number;
    corrections: number;
    unreviewedAi: number;
    awaitingVerification: number;
  };
  tuples: TrainingTuple[];
}

const CONTRACT_NOTES = [
  'files.* are repo-relative paths. Alpha channel of a mask PNG IS the mask (>=128 = foil); RGB is display tint only.',
  'artworkUrl is the card scan the human saw, served by the image service (add your host: http://127.0.0.1:3701<url> or via the api origin).',
  'ruleRect is UV y-up [x,y,w,h] of the deterministic era rect — the geometry prior a generator starts from.',
  'exemplarWeight > 0 means a generator MAY learn from this mask. 0 means it MUST NOT (unreviewed `ai`, machine-rasterized geometry, or ANY tier other than owner-verified).',
  'tier is the verification tier and it gates the weight: "owner-verified" (a writer authored or verified it) carries the method weight; "contributor" (a merged contribution nobody with the capability has verified) and "unattributed" are 0. Merge is acceptance, not exemplar grade — a contributor mask is real, correct-looking, servable data that has simply not been signed off as ground truth for rule derivation.',
  'author is WHO painted it, recorded server-side from a verified identity; verifiedBy is WHO signed off, and only a writer-capability login is honoured. Neither is ever accepted from a client.',
  'correction != null is a supervised pair: files.parent = the mask BEFORE the human, files.mask = AFTER, files.parentDiff = the change map (green added / red removed), correction.grid = where the changes concentrate.',
  'Never treat a tuple with method "ai" as ground truth — it is a proposal awaiting review.',
];

export function trainingTuples(corpus: CorpusEntry[]): TrainingManifest {
  const tuples: TrainingTuple[] = corpus.map((e) => {
    const s = e.sidecar;
    return {
      cardId: e.cardId,
      variantId: e.variantId,
      eraId: s.prior?.eraId ?? null,
      scope: s.prior?.scope ?? null,
      setId: s.card?.setId ?? setIdOf(e.cardId),
      seriesSlug: s.card?.seriesSlug ?? null,
      artworkUrl: s.artworkUrl ?? null,
      width: s.width,
      height: s.height,
      method: s.derivation_method,
      authorship: AUTHORSHIP_BY_METHOD[s.derivation_method],
      reviewStatus: REVIEW_BY_METHOD[s.derivation_method],
      tier: s.provenanceTier,
      author: s.author ? { login: s.author.login, id: s.author.id, via: s.author.via } : null,
      verifiedBy: s.verification ? { login: s.verification.verifiedBy, at: s.verification.verifiedAt } : null,
      exemplarWeight: exemplarWeightOf(s),
      ruleRect: s.prior?.rect ?? null,
      files: e.files,
      ruleDiff: s.diff ?? null,
      generator: s.prior?.generator ?? null,
      correction: s.correction ?? null,
      lineage: s.lineage ?? [],
    };
  });
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    root: '.',
    contract: CONTRACT_NOTES,
    counts: {
      total: tuples.length,
      exemplars: tuples.filter((t) => t.exemplarWeight > 0).length,
      corrections: tuples.filter((t) => t.correction).length,
      unreviewedAi: tuples.filter((t) => t.method === 'ai').length,
      /** Human work held at weight 0 pending a writer's sign-off (#10). */
      awaitingVerification: tuples.filter(
        (t) => t.exemplarWeight === 0 && EXEMPLAR_WEIGHT[t.method] > 0,
      ).length,
    },
    tuples,
  };
}

export { maskPathsIn };
