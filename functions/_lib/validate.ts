// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// SERVER-SIDE VALIDATION, BEFORE THE PULL REQUEST EXISTS.
//
// The non-negotiable of subtask 9, and the reason it is non-negotiable: a PR is
// a claim on a reviewer's attention. An invalid contribution that opens a PR
// costs a human a round trip to discover something a machine could have said in
// 40 milliseconds — and worse, it teaches contributors that the pipeline is a
// place where things go to be rejected rather than a place where work lands.
// So every check that CAN run before the branch is created runs before the
// branch is created, and a failure returns a list of reasons rather than a
// half-built PR.
//
// The client runs its own version of some of these (`buildMaskSubmission`,
// `provisionalDiff`). That is a courtesy, not a boundary — anybody can edit
// their own JavaScript, and this module never consults what the client
// concluded. Same rule as `writers.ts`.
//
// ── THE GLSL COMPILE GATE, AND WHY IT IS NOT IN THIS FUNCTION ──────────────
//
// The spec asked for a headless GLSL compile of the assembled shader inside the
// function, using a WASM validator "if a workable zero-native-dep option
// exists". It was evaluated and there is not one, for a reason that is about
// DIALECT rather than about size:
//
//   * foilkit's composite is GLSL ES 1.00 — `varying`, `attribute`,
//     `texture2D`, `gl_FragColor`, no `#version` directive. That is WebGL 1,
//     which is what `@foilkit/three` targets.
//   * `@webgpu/glslang` (5.1 MB, last published 2021) compiles VULKAN GLSL and
//     requires `#version 450` with layout qualifiers. It would reject every
//     shader in this repository. A validator that fails on valid input is worse
//     than no validator: the failures are indistinguishable from real ones.
//   * `naga-wasm` is unpublished on npm; naga's GLSL frontend supports ES 3.00
//     and desktop profiles, not ES 1.00.
//   * A pure-JS parser (`@shaderfrog/glsl-parser`) parses but does not
//     type-check or link, so it would not catch the failures that matter, and
//     it would be the first runtime npm dependency in a workspace whose
//     packages have none.
//
// So the split is: STRUCTURAL validation here (below), and the REAL compile in
// the `pr-evidence` GitHub Actions workflow, which renders the submitted state
// through headless Chromium on SwiftShader. That is not a fallback — it is a
// compile on the ACTUAL driver stack the renderer ships against, which is a
// stronger gate than any of the rejected WASM options would have been. It is
// slower and it lands as a PR check rather than as a submit-time refusal, and
// that trade is recorded honestly in DECISIONS.md (2026-09-05).

import { CANONICAL_H, CANONICAL_W, COMPOSITE_CONTRACT, GLOBAL_DEFAULTS, MAIN, PREAMBLE } from '@foilkit/core'
import { boundaryDistance, decodePng, iou, parseMaskVector, parsePrior, rasterizeMaskVector } from '@foilkit/forge'
import { canonicalPatternId, patternById } from '@foilkit/patterns'

/** One thing that was checked, and how it went. Shown to the contributor. */
export interface Check {
  name: string
  ok: boolean
  /** One sentence. Written for a human who is about to fix it. */
  detail: string
}

export interface ValidationResult {
  ok: boolean
  checks: Check[]
  /** The `detail` of every failed check, in order. */
  failures: string[]
}

function finish(checks: Check[]): ValidationResult {
  const failures = checks.filter((c) => !c.ok).map((c) => c.detail)
  return { ok: failures.length === 0, checks, failures }
}

const HEX64 = /^[0-9a-f]{64}$/i

// ── THE FORGED-PROVENANCE GATE (#10) ───────────────────────────────────────
//
// Every field a submission may NOT carry, because the server derives it.
//
// The pre-#10 list was implicit and enforced by omission: `submitMask` reads
// `cardId`, `png`, `prior`, `derivation`, `seed`, `conflict`, `comment` and
// nothing else, so anything else in the body was simply ignored. Ignoring is
// safe and it is also SILENT, and #10 adds two fields where silence is the
// wrong answer:
//
//   * `verification` decides EXEMPLAR WEIGHT. A submission carrying one is not
//     a confused client, it is an attempt to grant its own mask ground-truth
//     status, and the pipeline should say so out loud rather than drop it on
//     the floor and open a pull request that looks fine.
//   * `author` is the record of WHO. The App composes it from the session it
//     already verified; a body that also supplies one is either stale client
//     code or a claim to be somebody else, and both deserve a named refusal.
//
// The older derived labels are in the list too — `derivation_method`,
// `authorship`, `reviewStatus`, `provenanceTier`, `exemplarWeight`. They were
// already unforgeable (forge re-derives all five from pixels and from the tier
// rules) so this changes no outcome for them; it changes the FEEDBACK, from
// "your claim was quietly discarded" to "this pipeline does not accept claims,
// here is the one that was rejected". `apps/editor/src/staging/staging.test.ts`
// already asserts a staged session carries none of them, so a submission that
// trips this check did not come from this editor.
export const CLIENT_MAY_NOT_CLAIM: readonly string[] = [
  'author',
  'verification',
  'verifiedBy',
  'provenanceTier',
  'derivation_method',
  'authorship',
  'reviewStatus',
  'exemplarWeight',
]

/**
 * Every forbidden key anywhere in the submitted JSON, by path.
 *
 * DEEP, not top-level. The interesting shape is not `{ verification: … }` at
 * the root — a client that wanted to lie would nest it where it looks like it
 * belongs, inside `prior`, inside `card`, inside `seed`. Depth and breadth are
 * bounded so a pathological body cannot turn this into the expensive part of
 * the request; the body ceiling upstream is the real limit.
 */
export function claimedProvenanceKeys(body: unknown, maxNodes = 4096): string[] {
  const found: string[] = []
  const forbidden = new Set(CLIENT_MAY_NOT_CLAIM)
  const stack: { node: unknown; path: string }[] = [{ node: body, path: '' }]
  let seen = 0
  while (stack.length > 0 && seen < maxNodes) {
    const { node, path } = stack.pop()!
    seen++
    if (Array.isArray(node)) {
      for (const [i, v] of node.entries()) stack.push({ node: v, path: `${path}[${i}]` })
      continue
    }
    if (typeof node !== 'object' || node === null) continue
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const here = path === '' ? k : `${path}.${k}`
      if (forbidden.has(k)) found.push(here)
      stack.push({ node: v, path: here })
    }
  }
  return found.sort()
}

/**
 * The check itself. Shared by both submission kinds, because the rule is about
 * the pipeline rather than about masks: nothing a contributor sends may name
 * its own provenance, in either corpus.
 */
export function checkNoClaimedProvenance(body: unknown): Check {
  const claimed = claimedProvenanceKeys(body)
  return {
    name: 'no-claimed-provenance',
    ok: claimed.length === 0,
    detail:
      claimed.length === 0
        ? 'the submission claims no provenance — authorship and verification are recorded server-side.'
        : `this submission carries ${claimed.join(', ')}, and a submission may not name its own provenance. ` +
          'Authorship is recorded from your signed-in identity when the App composes the commit, and verification ' +
          'is an act of someone holding the writer capability — neither is something a request body may assert.',
  }
}

// ── Masks ──────────────────────────────────────────────────────────────────

/**
 * The upper bound on mask coverage.
 *
 * A mask that says "the whole card is foil" is not a measurement — it is what
 * the renderer already does for free when `uMaskTexOn` is 0, and committing one
 * adds a file that changes nothing while claiming a human looked. The real
 * corpus runs 0.157 to 0.537 coverage; 0.98 is far outside anything a human
 * would draw and inside nothing that would be rejected by accident.
 */
export const MAX_COVERAGE = 0.98

export interface MaskCandidate {
  png: Buffer
  /** What the client says the raster is. Checked against the pixels. */
  width: number
  height: number
  /**
   * The pen geometry the submission wants committed beside its pixels, RAW off
   * the request body. Absent or null for a brush contribution, which is the
   * normal case and is checked to be exactly as it was before this existed.
   */
  vector?: unknown
  prior: unknown
  derivation: { startedFrom?: unknown; parent?: unknown }
  seed: {
    parentSha256: string | null
    resolvedFrom: { cardId: string; variantId: number } | null
  }
  /**
   * The conflict state the contributor was SHOWN, and whether they acted on it.
   * `kind` is `detectMaskConflict`'s answer; `acknowledged` is true when the
   * contributor chose keep-mine with the conflict on screen.
   */
  conflict: { kind: string; acknowledged: boolean }
  /**
   * The RAW submitted body, for the forged-provenance gate. Passed whole and
   * on purpose: the check is about what the client SENT, and a body already
   * narrowed to the fields this function reads would have thrown away the
   * evidence of everything it did not.
   */
  body?: unknown
}

export interface MaskValidation extends ValidationResult {
  /** Foil coverage of the submitted alpha, 0..1. Goes in the PR body. */
  coverage: number
  /** True when this submission supersedes upstream the contributor was shown. */
  supersede: boolean
  /** How well the submitted vector describes the submitted pixels. Null with no vector. */
  vectorAgreement: VectorAgreement | null
}

// ── THE CHECK THAT MAKES THE READABLE DIFF HONEST ──────────────────────────
//
// A pen-authored contribution commits TWO artifacts for one mask: the PNG, and
// `<variantId>.paths.json` beside it. The second one exists so a reviewer can
// read the change — "this anchor moved 3px in" instead of "Binary files
// differ" — and the instant a reviewer can read it, they will believe it.
//
// So the pair has to be true, and the only way to know is to MAKE THE PIXELS
// FROM THE PATHS AND LOOK. That is AGENTS.md F3 in its most literal form:
// derived server-side from the artifact, never taken from what the caller
// asserted. Skip it and the pipeline accepts, commits and renders a legible,
// confident, WRONG description of a mask — which is strictly worse than the
// binary blob it replaced, because the blob at least did not mislead anybody.
//
// ── WHY NOT BYTE EQUALITY ──────────────────────────────────────────────────
//
// Because the two sides are legitimately allowed to differ, and the difference
// is antialiasing. The contributor's PNG comes off a browser canvas; this side
// comes off `rasterizePolygons`. Both compute analytic coverage, both are
// correct, and both put something near 0.5 on the pixels the true boundary
// passes through — so along every edge there is a band of pixels where the two
// land on opposite sides of the 128 threshold. That band is REAL AGREEMENT
// rendered by two honest rasterisers, and a check that called it a lie would
// fail every correct submission, which is the failure mode that gets a check
// deleted rather than fixed.
//
// ── THE TWO NUMBERS, AND WHY IT TAKES TWO ──────────────────────────────────
//
//   * IoU is an AREA measure and it is the backstop. It answers "is this the
//     same region at all", and it is the one that cannot be fooled by geometry
//     that is locally plausible everywhere and globally somewhere else.
//   * Boundary p95 is a LOCALITY measure, and it is there because IoU dilutes.
//     Drag one anchor of a 2000px boundary 40px sideways and the area changes
//     by a fraction of a percent — an IoU floor loose enough to tolerate
//     antialiasing would not notice. The distance from each boundary pixel to
//     the nearest boundary pixel of the other mask does notice, because that
//     displacement is 40px wherever it happens at all.
//
// Neither number is a quality score and neither is claiming the vector is
// GOOD. The question is only "do these paths describe these pixels", and the
// bar is set where two rasterisers of the same geometry sit comfortably inside
// it and any actual geometric edit sits far outside — measured, in
// `validate.test.ts`, rather than asserted here.
//
// ── WHAT IT DOES NOT CATCH, said out loud ──────────────────────────────────
//
// A displacement confined to a small enough fraction of the boundary passes
// p95 by definition, and costs too little area to move IoU. This check is not
// a proof that the paths are the ONLY way to get these pixels; it is a proof
// that they are A way to get them, to within a pixel or two, everywhere. That
// is the property a reviewer actually relies on when they read the diff.

/** The measured agreement between a submitted vector and the pixels beside it. */
export interface VectorAgreement {
  /** Intersection over union of the two foil regions, 0..1. */
  iou: number
  /** Mean, 95th-percentile and worst boundary displacement, px. */
  boundaryMean: number
  boundaryP95: number
  boundaryMax: number
}

/**
 * IoU floor.
 *
 * Two rasterisers drawing the same geometry disagree only in the antialiasing
 * band along the boundary — for a canonical mask that is a few hundred pixels
 * out of ~350,000, i.e. an IoU well above 0.999. The floor is set two orders of
 * magnitude looser than that, because the thing being bounded is "same region",
 * not "same rasteriser", and because a contributor who nudged a handle by half
 * a pixel while the canvas was already committed should not be refused.
 * `validate.test.ts` measures both sides of it.
 */
export const VECTOR_AGREEMENT_MIN_IOU = 0.98

/**
 * Boundary displacement ceiling, px, at the 95th percentile.
 *
 * 2px is the same order as every other spatial tolerance in this repository —
 * `line-snap` may nudge a hand-drawn line ~2px and no further, `edge-trace`
 * enforces a hard 5px corridor, and `countPaintedOver`'s seam tolerance is one
 * pixel of antialiasing band. A vector whose boundary sits further than two
 * pixels from the pixels it claims to describe, across more than 5% of that
 * boundary, is not describing them.
 */
export const VECTOR_AGREEMENT_MAX_BOUNDARY_P95_PX = 2

/** alpha >= 128 is foil, the same threshold every other measure in the corpus uses. */
const FOIL = 128

/**
 * Rasterise the submitted vector and prove it agrees with the submitted pixels.
 *
 * Exported because BOTH write paths owe the corpus this. `functions/mask.ts`
 * calls it before a direct write for the same reason `contribute.ts` calls it
 * before opening a pull request: the artifact that lands in `data/` must not
 * lie, and which HTTP route it came through has nothing to do with that.
 */
export function checkVectorAgreesWithPixels(
  img: { width: number; height: number; rgba: Uint8Array } | null,
  vector: unknown,
): { check: Check; agreement: VectorAgreement | null } {
  const name = 'vector-agrees-with-pixels'
  if (vector === undefined || vector === null) {
    return {
      check: {
        name,
        ok: true,
        detail: 'no vector paths were submitted; the mask PNG is the whole artifact.',
      },
      agreement: null,
    }
  }
  if (img === null) {
    // FAILS CLOSED. The submission is already refused for the PNG, and the
    // alternative — passing a vector check that never looked at any pixels —
    // would put an "ok" beside a mask nobody could decode.
    return {
      check: {
        name,
        ok: false,
        detail: 'the submitted vector could not be checked, because the mask PNG did not decode — there are no pixels to compare it against.',
      },
      agreement: null,
    }
  }

  let parsed: ReturnType<typeof parseMaskVector>
  try {
    parsed = parseMaskVector(vector)
  } catch (err) {
    return {
      check: { name, ok: false, detail: `the submitted vector is not a readable path list: ${(err as Error).message}` },
      agreement: null,
    }
  }

  // The raster the paths are drawn in must be the raster the mask is drawn in.
  // Scaling would be arithmetically easy and is refused on purpose: the numbers
  // in the committed diff are the numbers a reviewer argues about, and paths
  // silently rescaled on the way in would put a file in the tree whose
  // coordinates nobody chose.
  if (parsed.space.width !== img.width || parsed.space.height !== img.height) {
    return {
      check: {
        name,
        ok: false,
        detail:
          `the vector declares a ${parsed.space.width}×${parsed.space.height} space and the mask pixels are ` +
          `${img.width}×${img.height}; paths are committed in the raster they were drawn in, not rescaled into it.`,
      },
      agreement: null,
    }
  }

  const drawn = rasterizeMaskVector(parsed, img.width, img.height)
  const submitted = new Uint8Array(img.width * img.height)
  for (let i = 0; i < submitted.length; i++) submitted[i] = img.rgba[i * 4 + 3]!

  const overlap = iou(drawn, submitted)
  const b = boundaryDistance(drawn, submitted, img.width, img.height)
  const agreement: VectorAgreement = {
    iou: overlap,
    boundaryMean: b.mean,
    boundaryP95: b.p95,
    boundaryMax: b.max,
  }

  const areaOk = overlap >= VECTOR_AGREEMENT_MIN_IOU
  const edgeOk = b.p95 <= VECTOR_AGREEMENT_MAX_BOUNDARY_P95_PX
  const measured = `IoU ${overlap.toFixed(4)}, boundary p95 ${b.p95.toFixed(2)}px (mean ${b.mean.toFixed(2)}px, max ${b.max.toFixed(2)}px)`
  return {
    check: {
      name,
      ok: areaOk && edgeOk,
      detail:
        areaOk && edgeOk
          ? `the submitted paths rasterise to the submitted pixels — ${measured}.`
          : `the submitted paths do not describe the submitted pixels: ${measured}, against a floor of IoU ` +
            `${VECTOR_AGREEMENT_MIN_IOU} and a ceiling of ${VECTOR_AGREEMENT_MAX_BOUNDARY_P95_PX}px at the 95th percentile. ` +
            'The pull request would show a path diff that a reviewer could read and that does not match the mask ' +
            'being committed. Re-export the mask from the same geometry, or submit it without the paths.',
    },
    agreement,
  }
}

/**
 * Everything that can be known about a mask submission without touching the
 * repository.
 *
 * NOTE WHAT IS NOT HERE: `derivation_method`, the agreement number and the diff
 * artifacts. Those are derived by `writeMaskRecord` against the parent AS IT IS
 * ON DISK at write time, and re-deriving them here from the client's claim
 * would be exactly the second implementation `functions/_lib/corpus.ts` exists
 * to avoid. This function decides whether a PR may be opened; forge decides
 * what the mask IS.
 */
export function validateMask(input: MaskCandidate): MaskValidation {
  const checks: Check[] = []
  let coverage = 0
  let vectorAgreement: VectorAgreement | null = null

  // 0. NOTHING CLAIMS ITS OWN PROVENANCE. First, because it is the cheapest
  //    check in the function and because a submission that fails it should be
  //    told THAT rather than told about its alpha channel.
  checks.push(checkNoClaimedProvenance(input.body ?? {}))

  // 1. It is a PNG, and it decodes.
  let img: { width: number; height: number; rgba: Uint8Array } | null = null
  try {
    img = decodePng(input.png)
    checks.push({ name: 'png-decodes', ok: true, detail: `PNG decoded (${input.png.length} bytes).` })
  } catch (err) {
    checks.push({
      name: 'png-decodes',
      ok: false,
      detail: `the mask PNG did not decode: ${(err as Error).message}`,
    })
  }

  // 2. Exactly the canonical raster. Not "about right" — the corpus was
  //    migrated to one size so a sidecar can never disagree with its pixels.
  if (img !== null) {
    const right = img.width === CANONICAL_W && img.height === CANONICAL_H
    checks.push({
      name: 'canonical-raster',
      ok: right,
      detail: right
        ? `${CANONICAL_W}×${CANONICAL_H}, the canonical raster.`
        : `the mask is ${img.width}×${img.height}; every mask in the corpus is exactly ${CANONICAL_W}×${CANONICAL_H}.`,
    })
    const declared = img.width === input.width && img.height === input.height
    checks.push({
      name: 'declared-raster-matches',
      ok: declared,
      detail: declared
        ? 'the declared width and height match the pixels.'
        : `the submission declares ${input.width}×${input.height} and the pixels are ${img.width}×${img.height}.`,
    })
  }

  // 3. ALPHA-ONLY CONTENT SANITY.
  //
  //    The content of a mask lives entirely in its alpha channel — `MAIN` reads
  //    `texture2D(uMaskTex, …).a` and nothing else. So this checks alpha and
  //    deliberately does NOT check RGB: the corpus already contains masks whose
  //    RGB varies pixel to pixel (base1-5/19.png carries 1419 distinct triples
  //    from a canvas composite), those masks render identically, and a check
  //    that rejected them would be enforcing a convention rather than a fact.
  //
  //    What IS enforced is that the alpha says something: a mask that covers
  //    nothing has no measurement in it, and a mask that covers everything is
  //    what the renderer does with no mask at all.
  if (img !== null) {
    const pixels = img.width * img.height
    let foil = 0
    for (let i = 0; i < pixels; i++) if (img.rgba[i * 4 + 3]! >= FOIL) foil++
    coverage = pixels === 0 ? 0 : foil / pixels
    const drawn = foil > 0
    checks.push({
      name: 'alpha-has-content',
      ok: drawn,
      detail: drawn
        ? `${(coverage * 100).toFixed(1)}% of the card is foil.`
        : 'the mask is entirely transparent — nothing was drawn.',
    })
    const notEverything = coverage <= MAX_COVERAGE
    checks.push({
      name: 'alpha-not-the-whole-card',
      ok: notEverything,
      detail: notEverything
        ? 'the mask distinguishes foil from non-foil.'
        : `the mask covers ${(coverage * 100).toFixed(1)}% of the card, which is what the renderer already does with no mask at all.`,
    })
  }

  // 3b. THE VECTOR DESCRIBES THESE PIXELS, or there is no vector. Measured, by
  //     rasterising the paths and comparing — never taken from the client's
  //     word that they belong together. See the block above this function.
  {
    const { check, agreement } = checkVectorAgreesWithPixels(img, input.vector)
    checks.push(check)
    vectorAgreement = agreement
  }

  // 4. The sidecar fields the client is allowed to assert.
  try {
    parsePrior(input.prior)
    checks.push({ name: 'prior-valid', ok: true, detail: 'the era-rule prior parses.' })
  } catch (err) {
    checks.push({ name: 'prior-valid', ok: false, detail: `the era-rule prior is invalid: ${(err as Error).message}` })
  }

  const startedFrom = input.derivation.startedFrom
  const startedOk = startedFrom === 'layout' || startedFrom === 'window-bake' || startedFrom === 'mask'
  checks.push({
    name: 'derivation-startedFrom',
    ok: startedOk,
    detail: startedOk
      ? `seeded from ${String(startedFrom)}.`
      : `derivation.startedFrom must be layout, window-bake or mask; got ${JSON.stringify(startedFrom)}.`,
  })

  // 5. THE PARENT SHA IS RECORDED. A session seeded from an existing mask must
  //    pin the exact bytes it started from, because that pin is the entire
  //    staleness mechanism and the only thing that makes "supersede" a
  //    measurement rather than an opinion.
  if (startedFrom === 'mask') {
    const pinned = typeof input.seed.parentSha256 === 'string' && HEX64.test(input.seed.parentSha256)
    checks.push({
      name: 'parent-sha-recorded',
      ok: pinned,
      detail: pinned
        ? `pinned to parent ${input.seed.parentSha256!.slice(0, 12)}….`
        : 'this session says it started from an existing mask but recorded no parent sha256 — it cannot be told apart from a stale one.',
    })
  } else {
    checks.push({
      name: 'parent-sha-recorded',
      ok: true,
      detail: 'seeded from a rule rather than a mask; there is no parent to pin.',
    })
  }

  // 6. NOT STALE WITHOUT ACKNOWLEDGEMENT. Upstream moving under a session is
  //    normal and is not, by itself, a refusal — but submitting into it without
  //    having been shown that it moved is. The keep-mine path sets
  //    `acknowledged`, and the PR is then flagged as a supersede.
  const conflicted = input.conflict.kind !== 'none'
  const staleOk = !conflicted || input.conflict.acknowledged
  checks.push({
    name: 'not-stale-unacknowledged',
    ok: staleOk,
    detail: !conflicted
      ? 'upstream is exactly what it was when this session was seeded.'
      : staleOk
        ? `upstream moved (${input.conflict.kind}) and the contributor chose to keep their own work — the pull request is flagged as a supersede.`
        : `upstream moved (${input.conflict.kind}) since this session was seeded. Re-open the session, look at the conflict, and choose keep-mine, take-theirs or re-trace before submitting.`,
  })

  return { ...finish(checks), coverage, supersede: conflicted && input.conflict.acknowledged, vectorAgreement }
}

// ── Canon ──────────────────────────────────────────────────────────────────

const CORE_KEYS = new Set(Object.keys(GLOBAL_DEFAULTS))
const PARAM_KEYS = new Set(['uP0', 'uP1', 'uP2', 'uP3', 'uP4', 'uP5'])

export interface CanonCandidate {
  patternId: string
  uniforms: Record<string, unknown>
  /** The contract the seed was tuned under, when the session recorded one. */
  seedContract: number | null
  conflict: { kind: string; acknowledged: boolean }
  /** The RAW submitted body, for the forged-provenance gate. See MaskCandidate. */
  body?: unknown
}

export interface CanonValidation extends ValidationResult {
  /** The assembled fragment shader's length, for the PR body. */
  glslBytes: number
  supersede: boolean
}

/**
 * Structural validation of the assembled shader.
 *
 * NOT A COMPILER — see the module header for why there is no compiler here and
 * where the real one lives. These are the failures that are decidable from the
 * text, and between them they cover every way a CANON file can break a shader
 * that would otherwise link:
 *
 *   * a uniform the canon sets that the assembled source never declares (the
 *     value would be silently dropped by every renderer — the failure mode that
 *     looks like "my tuning did nothing"),
 *   * a recipe whose GLSL does not define the one function the ABI requires,
 *   * unbalanced braces or parentheses in the concatenation,
 *   * a `#version` directive, which is illegal in ES 1.00 anywhere but line 1
 *     and which nothing in this corpus should ever emit.
 */
export function checkAssembledGlsl(patternId: string, uniformNames: string[]): Check[] {
  const checks: Check[] = []
  const pattern = patternById(patternId)
  const source = PREAMBLE + pattern.glsl + MAIN

  const abi = /vec3\s+foilPattern\s*\(\s*vec2\s+\w+\s*,\s*vec2\s+\w+\s*\)/.test(pattern.glsl)
  checks.push({
    name: 'glsl-abi',
    ok: abi,
    detail: abi
      ? `${patternId} defines vec3 foilPattern(vec2, vec2).`
      : `${patternId}'s GLSL does not define vec3 foilPattern(vec2 uv, vec2 tilt), which is the whole pattern ABI.`,
  })

  const braces = balance(source, '{', '}')
  checks.push({
    name: 'glsl-braces',
    ok: braces === 0,
    detail: braces === 0 ? 'braces balance across PREAMBLE + pattern + MAIN.' : `braces do not balance (${braces > 0 ? `${braces} unclosed` : `${-braces} extra`}).`,
  })
  const parens = balance(source, '(', ')')
  checks.push({
    name: 'glsl-parens',
    ok: parens === 0,
    detail: parens === 0 ? 'parentheses balance across the assembled shader.' : `parentheses do not balance (${parens}).`,
  })

  const versioned = /^\s*#version\b/m.test(source)
  checks.push({
    name: 'glsl-no-version-directive',
    ok: !versioned,
    detail: versioned
      ? 'the assembled shader carries a #version directive; the composite is GLSL ES 1.00 and must not.'
      : 'no #version directive — GLSL ES 1.00, as the composite contract requires.',
  })

  // Every uniform the canon sets must actually be declared. Note the `uP*`
  // family can never trip this one — PREAMBLE declares uP0..uP5
  // unconditionally — so a wrong-recipe canon leaning on uP-slots is caught
  // upstream by `canon-params-declared`. What THIS check catches is a canon
  // naming a pattern-specific uniform (a `uGlyph*`, a bespoke knob) that the
  // assembled shader never declares.
  const declared = new Set<string>()
  for (const m of source.matchAll(/\buniform\s+\w+\s+(u[A-Za-z0-9]+)\s*;/g)) declared.add(m[1]!)
  const undeclared = uniformNames.filter((u) => !declared.has(u))
  checks.push({
    name: 'glsl-uniforms-declared',
    ok: undeclared.length === 0,
    detail:
      undeclared.length === 0
        ? `all ${uniformNames.length} uniforms are declared by the assembled shader.`
        : `${undeclared.join(', ')} ${undeclared.length === 1 ? 'is' : 'are'} not declared by the shader ${patternId} assembles to — the value would be dropped rather than applied.`,
  })

  return checks
}

function balance(source: string, open: string, close: string): number {
  let n = 0
  for (const ch of source) {
    if (ch === open) n++
    else if (ch === close) n--
  }
  return n
}

/**
 * A canon submission: the composite contract, then the shader it will be read
 * through.
 *
 * The contract half is the same set of questions `tools/parity/data-receipt.mjs`
 * asks of the committed corpus, asked one file earlier. That is deliberate: a
 * contribution that would make the data receipt fail should not be able to
 * reach `main`, and the cheapest place to say so is before the PR exists.
 */
export function validateCanon(input: CanonCandidate): CanonValidation {
  const checks: Check[] = []
  // Same gate as the mask path, and for the same reason: a canon file now
  // carries a provenance block too, and it is composed from the session rather
  // than accepted from the body.
  checks.push(checkNoClaimedProvenance(input.body ?? {}))
  const patternId = canonicalPatternId(input.patternId)
  const pattern = patternById(patternId)

  const real = pattern.id === patternId
  checks.push({
    name: 'pattern-exists',
    ok: real,
    detail: real
      ? `${patternId} is an implemented recipe.`
      : `${input.patternId} names no implemented recipe — a canon file for it would be a file nothing reads.`,
  })

  // `Set<string>`, not `Set<ParamUniform>`: the keys being tested against it
  // come off a JSON body and are plain strings by construction.
  const declaredParams = new Set<string>(pattern.params.map((p) => p.key))
  const names = Object.keys(input.uniforms)

  const nonEmpty = names.length > 0
  checks.push({
    name: 'canon-not-empty',
    ok: nonEmpty,
    detail: nonEmpty ? `${names.length} uniforms.` : 'a canon file is a full uniform snapshot; this one is empty.',
  })

  const notNumbers = names.filter((k) => !Number.isFinite(Number(input.uniforms[k])))
  checks.push({
    name: 'canon-numbers-finite',
    ok: notNumbers.length === 0,
    detail:
      notNumbers.length === 0
        ? 'every uniform is a finite number.'
        : `${notNumbers.join(', ')} ${notNumbers.length === 1 ? 'is' : 'are'} not a finite number.`,
  })

  const notContract = names.filter((k) => !CORE_KEYS.has(k) && !PARAM_KEYS.has(k))
  checks.push({
    name: 'canon-contract-uniforms',
    ok: notContract.length === 0,
    detail:
      notContract.length === 0
        ? `every uniform is one the composite contract declares (contract ${COMPOSITE_CONTRACT}).`
        : `${notContract.join(', ')} ${notContract.length === 1 ? 'is' : 'are'} not a contract uniform.`,
  })

  const wrongParams = names.filter((k) => PARAM_KEYS.has(k) && !declaredParams.has(k))
  checks.push({
    name: 'canon-params-declared',
    ok: wrongParams.length === 0,
    detail:
      wrongParams.length === 0
        ? `every uP* uniform is one ${patternId} declares.`
        : `${wrongParams.join(', ')} ${wrongParams.length === 1 ? 'is' : 'are'} not declared by ${patternId}.`,
  })

  // A FULL SNAPSHOT: every core uniform and every declared param, explicitly.
  // The data receipt enforces this on the committed corpus, so a contribution
  // that inherits from code defaults would break CI on merge.
  const missing = [...CORE_KEYS, ...declaredParams].filter((k) => !(k in input.uniforms))
  checks.push({
    name: 'canon-full-snapshot',
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? 'a full snapshot — nothing is inherited from the code defaults.'
        : `still inherits ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? `, +${missing.length - 8} more` : ''} from the code defaults; a canon file is a full snapshot.`,
  })

  if (real) checks.push(...checkAssembledGlsl(patternId, names))

  const conflicted = input.conflict.kind !== 'none'
  const staleOk = !conflicted || input.conflict.acknowledged
  checks.push({
    name: 'not-stale-unacknowledged',
    ok: staleOk,
    detail: !conflicted
      ? "upstream canon is what it was when this session was seeded."
      : staleOk
        ? `upstream canon moved (${input.conflict.kind}) and the contributor chose to keep their own snapshot — the pull request is flagged as a supersede.`
        : `${patternId}'s canon changed upstream since this session was seeded. Re-open it, look at the conflict, and choose before submitting.`,
  })

  const glslBytes = real ? (PREAMBLE + pattern.glsl + MAIN).length : 0
  return { ...finish(checks), glslBytes, supersede: conflicted && input.conflict.acknowledged }
}
