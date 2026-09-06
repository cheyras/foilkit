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
import { decodePng, parsePrior } from '@foilkit/forge'
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
}

export interface MaskValidation extends ValidationResult {
  /** Foil coverage of the submitted alpha, 0..1. Goes in the PR body. */
  coverage: number
  /** True when this submission supersedes upstream the contributor was shown. */
  supersede: boolean
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
    for (let i = 0; i < pixels; i++) if (img.rgba[i * 4 + 3]! >= 128) foil++
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

  return { ...finish(checks), coverage, supersede: conflicted && input.conflict.acknowledged }
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
