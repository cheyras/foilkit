// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// What the pull request SAYS.
//
// A contribution PR is read by exactly one person — the maintainer — and the
// only thing that makes it cheap to review is that everything he would
// otherwise have to ask for is already in the body. So the body carries, in
// this order: what changed, what the machine checked, the licence acts, the
// contributor's own words, and the provenance numbers.
//
// ── THE DEDICATION IS THE POINT ────────────────────────────────────────────
//
// `CONTRIBUTING.md` explains at length why a DCO sign-off is not a public-domain
// dedication: the DCO certifies provenance and permission, and nothing in it
// performs the affirmative act CC0 requires. For most of this project's life it
// then promised that a GitHub App would insert the dedication automatically,
// "so that approving your own pull request *is* your assent — no checkbox, no
// opportunity to forget".
//
// This module is that App's half of it, and `CONTRIBUTING.md` now says so in
// the present tense. `CC0_DEDICATION` below is the text that file publishes,
// VERBATIM — reused rather than paraphrased, because a dedication that differs
// from the published one by a word is a dedication somebody has to litigate,
// years later, on behalf of a contributor who trusted it.
//
// `pr-body.test.ts` reads `CONTRIBUTING.md` off disk and asserts the constant
// appears in it, so the two cannot drift.
//
// The manual template stays, for pull requests opened by hand.

/**
 * The CC0 dedication, exactly as `CONTRIBUTING.md` publishes it.
 *
 * DO NOT REWRAP OR REWORD. The line breaks are the published ones; the test in
 * `pr-body.test.ts` reads `CONTRIBUTING.md` and asserts this string appears in
 * it, so an edit to either that is not an edit to both fails the suite.
 */
export const CC0_DEDICATION =
  'CC0-Dedication: I dedicate my contributions to the data in this pull request to\n' +
  'the public domain under CC0 1.0 Universal, waiving all copyright and related\n' +
  'rights worldwide to the extent permitted by law.'

/**
 * Does this change set touch data, and therefore need the dedication?
 *
 * The rule is `CONTRIBUTING.md`'s: anything under `data/`, and any
 * `*.canon.json`. Both forms are checked rather than just the first, because
 * the second is the one that survives a future reorganisation of `data/`.
 */
export function touchesData(paths: readonly string[]): boolean {
  return paths.some((p) => p.startsWith('data/') || p.endsWith('.canon.json'))
}

export interface Contributor {
  login: string
  /** GitHub's display name, when they have one. */
  name: string | null
  /** GitHub's numeric user id — the half of the noreply address that links. */
  id: number
}

/**
 * The address that links a commit to a profile without this service ever
 * handling a real one.
 *
 * `user:email` is deliberately not requested by the OAuth app, so this is the
 * only address available — and it is the right one anyway: GitHub resolves it
 * to the profile, and it is what a user who keeps their address private gets by
 * default.
 */
export function noreplyAddress(c: Contributor): string {
  return `${c.id}+${c.login}@users.noreply.github.com`
}

export function displayName(c: Contributor): string {
  // The GitHub display name is contributor-controlled free text and lands in
  // commit trailers, which are line-oriented: a newline would let a crafted
  // name inject an extra trailer, and angle brackets would confuse the
  // `Name <email>` shape GitHub parses. Strip both; fall back to the login
  // (GitHub-validated, [A-Za-z0-9-]) when nothing survives.
  const raw = (c.name ?? c.login).replace(/[\r\n<>]/g, ' ').replace(/\s+/g, ' ').trim()
  return raw.length > 0 ? raw : c.login
}

/**
 * The `Co-authored-by:` trailer.
 *
 * THIS IS THE ATTRIBUTION MECHANISM, and it is not a consolation prize. The
 * commit is authored by the App because the App is what composed it, but
 * GitHub reads this trailer and puts the contributor's avatar on the commit and
 * their name on the pull request — which is the thing that actually matters.
 * People contribute where their name shows up.
 */
export function coAuthoredBy(c: Contributor): string {
  return `Co-authored-by: ${displayName(c)} <${noreplyAddress(c)}>`
}

/** The DCO trailer. See `signOffCaveat` for the honest footnote. */
export function signedOffBy(c: Contributor): string {
  return `Signed-off-by: ${displayName(c)} <${noreplyAddress(c)}>`
}

/**
 * The sentence that keeps the sign-off honest.
 *
 * The DCO asks for "a real name and a reachable address". What this service has
 * is a GitHub display name and a `users.noreply` address, because it never
 * requested the `user:email` scope and does not want to. That is a genuine
 * narrowing of what the sign-off certifies, and hiding it would make the
 * trailer worth less than saying so does.
 */
export const SIGN_OFF_CAVEAT =
  'The sign-off above was composed by the foilkit contribution App from the GitHub identity that ' +
  'authorised this submission. This service never requests the `user:email` scope, so the address ' +
  'is GitHub’s `users.noreply` form for that account rather than a private one.'

export interface MaskPrBody {
  kind: 'mask'
  contributor: Contributor
  cardId: string
  variantId: number
  cardName: string | null
  /** Repository paths this PR writes. */
  paths: readonly string[]
  /** The contributor's note about their own work. Becomes the body's lead. */
  comment: string
  checks: readonly { name: string; ok: boolean; detail: string }[]
  /** Foil coverage of the submitted alpha, 0..1. */
  coverage: number
  /** The PROVISIONAL agreement the client computed, when it sent one. */
  provisional: { agreement: number; addedPx: number; removedPx: number; unchangedPx: number } | null
  /** What forge decided server-side, once the write actually ran. */
  measured: { derivationMethod: string; agreement: number | null; correctionAgreement: number | null } | null
  seed: {
    startedFrom: string
    parent: { cardId: string; variantId: number } | null
    resolvedFrom: { cardId: string; variantId: number } | null
    parentSha256: string | null
    seededAt: string
  }
  conflict: { kind: string; acknowledged: boolean; detail: string }
  branch: string
}

export interface CanonPrBody {
  kind: 'canon'
  contributor: Contributor
  patternId: string
  paths: readonly string[]
  comment: string
  note: string
  checks: readonly { name: string; ok: boolean; detail: string }[]
  /** Which uniforms moved, and by how much. */
  moved: readonly { key: string; from: number | null; to: number }[]
  contract: number
  seedContract: number | null
  conflict: { kind: string; acknowledged: boolean; detail: string }
  branch: string
}

export type PrBodyInput = MaskPrBody | CanonPrBody

function checkList(checks: readonly { ok: boolean; detail: string }[]): string {
  return checks.map((c) => `- ${c.ok ? '✅' : '❌'} ${c.detail}`).join('\n')
}

function refLabel(r: { cardId: string; variantId: number } | null): string {
  return r === null ? 'nothing' : `\`${r.cardId}/${r.variantId}\``
}

function conflictSection(conflict: { kind: string; acknowledged: boolean; detail: string }): string {
  if (conflict.kind === 'none') {
    return (
      '### Conflict status: **fresh**\n\n' +
      'Upstream is exactly what it was when this session was seeded, so this change applies to the\n' +
      'state its author was actually looking at.'
    )
  }
  return (
    '### Conflict status: **supersede**\n\n' +
    `Upstream moved while this session was open (\`${conflict.kind}\`), and the contributor chose to keep\n` +
    'their own work with the conflict on screen. Nothing was merged automatically — two people painting\n' +
    'the same alpha channel have no lines to merge — so this pull request **replaces** what is upstream\n' +
    'rather than building on it.\n\n' +
    `> ${conflict.detail}`
  )
}

/**
 * The heading line, which is also the pull request title.
 *
 * Takes only the fields it reads rather than a whole `PrBodyInput`, so the
 * title can be computed before the body's numbers exist — and so a caller does
 * not have to fabricate a body just to name the pull request.
 */
export type PrTitleInput =
  | { kind: 'mask'; cardId: string; variantId: number; cardName: string | null }
  | { kind: 'canon'; patternId: string }

export function prTitle(input: PrTitleInput): string {
  if (input.kind === 'canon') return `Canon: ${input.patternId}`
  const name = input.cardName === null ? '' : ` — ${input.cardName}`
  return `Mask: ${input.cardId}/${input.variantId}${name}`
}

/**
 * The whole body.
 *
 * Order is deliberate: the contributor's own words first (a reviewer reads the
 * human before the machine), then what the machine checked, then the licence
 * acts, then the provenance numbers, then the evidence placeholder the Actions
 * workflow replaces with a render.
 */
export function composePrBody(input: PrBodyInput): string {
  const parts: string[] = []
  const c = input.contributor

  parts.push(
    `Submitted from [foilkit.deckpal.app](https://foilkit.deckpal.app) by @${c.login}, ` +
      'composed and opened by the foilkit contribution App.',
  )

  const comment = input.comment.trim()
  if (comment.length > 0) {
    parts.push(`## What the contributor said\n\n${quote(comment)}`)
  }

  if (input.kind === 'mask') {
    parts.push(maskSummary(input))
  } else {
    parts.push(canonSummary(input))
  }

  parts.push(`## Validation\n\nRun server-side **before this branch existed**; a failure returns a refusal rather than a pull request.\n\n${checkList(input.checks)}`)

  parts.push(conflictSection(input.conflict))

  // ── The licence acts ────────────────────────────────────────────────────
  const licence: string[] = ['## Licensing']
  if (touchesData(input.paths)) {
    licence.push(
      'This pull request touches `data/`, so it carries the public-domain dedication `CONTRIBUTING.md`\n' +
        'requires. It was inserted by the App from the identity that authorised the submission — approving\n' +
        'this pull request *is* the contributor’s assent, which is exactly what the checkbox on the manual\n' +
        'template is a fallback for.',
    )
    licence.push('```\n' + CC0_DEDICATION + '\n```')
  } else {
    licence.push(
      'This pull request touches no data files, so no CC0 dedication is required — the code half of the\n' +
        'repository is MIT and a sign-off is the whole of it.',
    )
  }
  licence.push('```\n' + signedOffBy(c) + '\n```')
  licence.push(`_${SIGN_OFF_CAVEAT}_`)
  parts.push(licence.join('\n\n'))

  parts.push(
    '## Render evidence\n\n' +
      'The `pr-evidence` workflow renders this branch through the frame-stepped zero-delta harness and\n' +
      'posts an 8-frame tilt sweep as a comment below. It is the **compile gate** as well as the picture:\n' +
      'the shader is linked by a real GL driver there, which is a stronger check than anything the submit\n' +
      'endpoint can do in 40 ms.',
  )

  parts.push(`<sub>branch \`${input.branch}\` · one session, one pull request · re-submitting the same session force-updates this branch and leaves the pull request where it is.</sub>`)

  return parts.join('\n\n') + '\n'
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

function maskSummary(input: MaskPrBody): string {
  const rows: string[] = []
  rows.push(`| | |`)
  rows.push(`|---|---|`)
  rows.push(`| Card | \`${input.cardId}\` variant ${input.variantId}${input.cardName === null ? '' : ` — ${input.cardName}`} |`)
  rows.push(`| Foil coverage | ${(input.coverage * 100).toFixed(1)}% of the card |`)
  rows.push(`| Seeded from | \`${input.seed.startedFrom}\`, ${refLabel(input.seed.parent)} |`)
  rows.push(`| Which record answered | ${refLabel(input.seed.resolvedFrom)} |`)
  rows.push(
    `| Parent sha256 at seed time | ${input.seed.parentSha256 === null ? '— (no mask upstream)' : `\`${input.seed.parentSha256.slice(0, 16)}…\``} |`,
  )
  rows.push(`| Seeded at | ${input.seed.seededAt} |`)
  if (input.provisional !== null) {
    rows.push(
      `| Agreement against the era rule (provisional, client) | **${input.provisional.agreement.toFixed(4)}** — ${input.provisional.addedPx} px added, ${input.provisional.removedPx} px removed, ${input.provisional.unchangedPx} px agreed |`,
    )
  }
  if (input.measured !== null) {
    rows.push(`| Derivation method (measured, server) | \`${input.measured.derivationMethod}\` |`)
    if (input.measured.agreement !== null) {
      rows.push(`| Agreement against the era rule (measured, server) | **${input.measured.agreement.toFixed(4)}** |`)
    }
    if (input.measured.correctionAgreement !== null) {
      rows.push(`| Agreement with the parent it corrects | **${input.measured.correctionAgreement.toFixed(4)}** |`)
    }
  }

  const provisionalNote =
    input.provisional === null
      ? ''
      : '\n\nThe **provisional** number is the client’s own diff against the deterministic era rule, computed by\n' +
        'a port of forge’s rasterizer that is byte-tested against the original. It is labelled provisional\n' +
        'because the client never labels a mask: the **measured** row is `writeMaskRecord`’s answer, derived\n' +
        'server-side by diffing the saved pixels against what the declared seed actually rasterizes to.'

  const artifacts =
    '\n\n### Files in this pull request\n\n' +
    input.paths.map((p) => `- \`${p}\``).join('\n') +
    '\n\nThe `.diff.png` beside the mask is the correction picture: **green** is foil the human added to the\n' +
    'era rule, **red** is foil the rule claimed and the human erased. It is generated by the same code path\n' +
    'every mask in the corpus went through.'

  return `## The change\n\n${rows.join('\n')}${provisionalNote}${artifacts}`
}

function canonSummary(input: CanonPrBody): string {
  const rows: string[] = []
  rows.push('| Uniform | Was | Now | Δ |')
  rows.push('|---|---:|---:|---:|')
  for (const m of input.moved) {
    const from = m.from === null ? '—' : trimNum(m.from)
    const delta = m.from === null ? '—' : trimNum(m.to - m.from)
    rows.push(`| \`${m.key}\` | ${from} | ${trimNum(m.to)} | ${delta} |`)
  }
  if (input.moved.length === 0) rows.push('| _nothing moved_ | | | |')

  const note = input.note.trim().length === 0 ? '' : `\n\nThe canon file’s own \`note\`:\n\n${quote(input.note.trim())}`

  const contractLine =
    input.seedContract !== null && input.seedContract !== input.contract
      ? `\n\n> ⚠️ This session was seeded under composite contract **${input.seedContract}** and the current law is **${input.contract}**. ` +
        'A canon file is only meaningful relative to the `main()` it was tuned against; the same numbers under a ' +
        'different law are a different rendering. Worth a look before merging.'
      : `\n\nTuned and read under composite contract **${input.contract}**.`

  return (
    `## The change\n\n\`${input.patternId}\` — a canon file is a **full uniform snapshot**, so this replaces the ` +
    `file wholesale rather than merging into it.\n\n${rows.join('\n')}${note}${contractLine}\n\n` +
    '### Files in this pull request\n\n' +
    input.paths.map((p) => `- \`${p}\``).join('\n')
  )
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * The commit message.
 *
 * Subject, body, then trailers — `Co-authored-by` is what puts the
 * contributor's face on the commit, and `Signed-off-by` is what a DCO check
 * reads. Both are trailers on the COMMIT, not just prose in the PR, because
 * that is where the tools look.
 */
export function composeCommitMessage(input: {
  subject: string
  detail?: string
  contributor: Contributor
  /** True when the change set touches `data/`. */
  data: boolean
}): string {
  const lines: string[] = [input.subject, '']
  if (input.detail !== undefined && input.detail.trim().length > 0) {
    lines.push(input.detail.trim(), '')
  }
  lines.push(
    `Submitted at foilkit.deckpal.app by @${input.contributor.login} and composed by the`,
    'foilkit contribution App.',
    '',
  )
  if (input.data) lines.push(CC0_DEDICATION, '')
  lines.push(signedOffBy(input.contributor))
  lines.push(coAuthoredBy(input.contributor))
  return lines.join('\n') + '\n'
}
