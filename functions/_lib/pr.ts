// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Branch, commit, pull request — the four GitHub calls a contribution is.
//
// This is deliberately a SEPARATE module from `github.ts` rather than a set of
// options on it, and the reason is the ref update flag:
//
//   * A DIRECT WRITE fast-forwards `main` with `force: false`. If somebody
//     pushed in between, GitHub refuses and the save fails loudly. Never
//     resolve a race by picking a winner.
//
//   * A CONTRIBUTION force-updates its OWN branch. The branch belongs to one
//     session and to nobody else, re-submission is expected (fix a validation
//     complaint, submit again), and a fast-forward would fail the moment the
//     evidence workflow pushed a strip onto it. Forcing a shared branch and
//     forcing a single-session branch are different acts that happen to use the
//     same API call, and putting them in one function with a boolean is how the
//     wrong one eventually gets passed.
//
// ONE SESSION → ONE PR (subtask 8's decision). The branch name is derived from
// the session's identity and its SEED, so:
//
//   * re-submitting the same session updates the same branch and the same PR,
//   * re-seeding after a conflict (take-theirs / re-trace) produces a DIFFERENT
//     branch and a new PR — which is right, because it is different work
//     against a different parent.
//
// EVERY CALL HERE TAKES AN EXPLICIT TOKEN. `github.ts` reaches for
// `FOILKIT_GITHUB_TOKEN` internally, which is correct there and would be wrong
// here: this module runs on a one-hour installation token that the caller
// minted, and a silent fallback to the project PAT would make a contribution
// commit look like a maintainer commit.

import { createHash } from 'node:crypto'
import type { RepoRef } from './github.ts'

const API = 'https://api.github.com'

export class PrError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface GhCall {
  fetch?: FetchLike
}

async function gh<T>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown; fetch?: FetchLike } = {},
): Promise<T> {
  const fetchImpl = init.fetch ?? fetch
  const res = await fetchImpl(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'foilkit-contribute (+https://github.com/cheyras/foilkit)',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new PrError(
      `GitHub ${init.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`,
      res.status,
    )
  }
  // 204 has no body; every caller that reads one asks for a route that returns
  // JSON, so an empty 2xx becomes an empty object rather than a parse throw.
  const text = await res.text()
  return (text.length === 0 ? {} : JSON.parse(text)) as T
}

// ── Branch naming ──────────────────────────────────────────────────────────

/**
 * A git ref path segment. GitHub logins and catalog ids are already narrow, so
 * this is a belt on top of the braces `corpus.ts` already put on: anything that
 * is not `[A-Za-z0-9._-]` collapses to `-`, leading and trailing dots go (a ref
 * component may not start with `.`), and `..` cannot survive.
 */
export function refSegment(value: string): string {
  const s = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 60)
  return s.length === 0 ? 'x' : s
}

/**
 * A branch name, encoded for a URL PATH — slashes intact.
 *
 * `encodeURIComponent('contrib/octocat/x')` is `contrib%2Foctocat%2Fx`, and
 * GitHub's git-ref routes 404 on that: the ref is a path, not a parameter, and
 * `heads/contrib/octocat/x` has to arrive with its separators. Every branch
 * this module touches is nested — the direct-write path only ever names `main`,
 * which is why the same mistake was invisible in `github.ts`.
 *
 * Encoding per SEGMENT rather than not at all, because `refSegment` is what
 * guarantees the components are safe and this should not silently depend on it.
 */
export function refPath(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/')
}

/**
 * The seed discriminator in a branch name.
 *
 * Seven hex of the seed's parent sha, or `new` when there was nothing upstream
 * to seed from. This is what makes re-submission idempotent and a re-seed a new
 * PR: the seed is immutable within a session (subtask 8), so the same session
 * always lands on the same branch, and a session that was re-seeded from
 * different upstream bytes is a different branch by construction.
 */
export function seedShort(parentSha256: string | null): string {
  if (typeof parentSha256 !== 'string' || !/^[0-9a-f]{8,}$/i.test(parentSha256)) return 'new'
  return parentSha256.slice(0, 7).toLowerCase()
}

export function maskBranchName(login: string, cardId: string, variantId: number, parentSha256: string | null): string {
  return `contrib/${refSegment(login)}/${refSegment(cardId)}-${variantId}-${seedShort(parentSha256)}`
}

export function canonBranchName(login: string, patternId: string, seedSha256: string | null): string {
  return `contrib/${refSegment(login)}/canon-${refSegment(patternId)}-${seedShort(seedSha256)}`
}

// ── The git data API, on a branch ──────────────────────────────────────────

export interface BranchState {
  /** The branch head, or null when the branch does not exist yet. */
  headSha: string | null
  /** The base branch head at the moment we looked. */
  baseSha: string
}

/** Where the branch is, and where `main` is, in two calls. */
export async function readBranch(
  ref: RepoRef,
  branch: string,
  token: string,
  call: GhCall = {},
): Promise<BranchState> {
  const base = await gh<{ object: { sha: string } }>(
    token,
    `/repos/${ref.owner}/${ref.repo}/git/ref/heads/${refPath(ref.branch)}`,
    call,
  )
  let headSha: string | null = null
  try {
    const head = await gh<{ object: { sha: string } }>(
      token,
      `/repos/${ref.owner}/${ref.repo}/git/ref/heads/${refPath(branch)}`,
      call,
    )
    headSha = head.object.sha
  } catch (err) {
    // 404 is the normal first-submission case, not an error.
    if (!(err instanceof PrError) || err.status !== 404) throw err
  }
  return { headSha, baseSha: base.object.sha }
}

export interface FileChange {
  path: string
  /** `null` DELETES the path. */
  content: Buffer | null
}

export interface CommitAuthor {
  name: string
  email: string
}

/**
 * One commit containing every change, parented on the BASE branch head.
 *
 * Parented on `main` rather than on the contribution branch's own head, and
 * that is the whole reason re-submission is clean: a second submission of the
 * same session is not "another commit on top", it is a REPLACEMENT of what the
 * session says. Building it from `main`'s tree and force-updating the branch
 * gives a PR with exactly one commit, whose diff is exactly the contribution,
 * however many times the contributor pressed Submit.
 */
export async function commitToBranch(
  ref: RepoRef,
  input: {
    branch: string
    baseSha: string
    changes: FileChange[]
    message: string
    author: CommitAuthor
    /** Present only when the branch already exists — decides create vs update. */
    branchExists: boolean
  },
  token: string,
  call: GhCall = {},
): Promise<{ commitSha: string; treeSha: string }> {
  if (input.changes.length === 0) throw new PrError('nothing to commit', 400)

  const baseCommit = await gh<{ tree: { sha: string } }>(
    token,
    `/repos/${ref.owner}/${ref.repo}/git/commits/${input.baseSha}`,
    call,
  )

  const tree: { path: string; mode: '100644'; type: 'blob'; sha: string | null }[] = []
  for (const c of input.changes) {
    if (c.content === null) {
      tree.push({ path: c.path, mode: '100644', type: 'blob', sha: null })
      continue
    }
    const blob = await gh<{ sha: string }>(token, `/repos/${ref.owner}/${ref.repo}/git/blobs`, {
      ...call,
      method: 'POST',
      // base64 for everything: half of these are PNGs, and a per-file
      // utf8-vs-binary decision is a bug waiting to be written.
      body: { content: c.content.toString('base64'), encoding: 'base64' },
    })
    tree.push({ path: c.path, mode: '100644', type: 'blob', sha: blob.sha })
  }

  const newTree = await gh<{ sha: string }>(token, `/repos/${ref.owner}/${ref.repo}/git/trees`, {
    ...call,
    method: 'POST',
    body: { base_tree: baseCommit.tree.sha, tree },
  })

  const commit = await gh<{ sha: string }>(token, `/repos/${ref.owner}/${ref.repo}/git/commits`, {
    ...call,
    method: 'POST',
    body: { message: input.message, tree: newTree.sha, parents: [input.baseSha], author: input.author },
  })

  if (input.branchExists) {
    await gh(token, `/repos/${ref.owner}/${ref.repo}/git/refs/heads/${refPath(input.branch)}`, {
      ...call,
      method: 'PATCH',
      // FORCE, and only here. See the module header: this branch belongs to one
      // session. `main` is never force-updated by anything in this repository.
      body: { sha: commit.sha, force: true },
    })
  } else {
    await gh(token, `/repos/${ref.owner}/${ref.repo}/git/refs`, {
      ...call,
      method: 'POST',
      body: { ref: `refs/heads/${input.branch}`, sha: commit.sha },
    })
  }

  return { commitSha: commit.sha, treeSha: newTree.sha }
}

export interface PullRequest {
  number: number
  htmlUrl: string
  /** True when an existing PR was updated rather than a new one opened. */
  updated: boolean
}

/** The open PR for this branch, or null. */
export async function findOpenPr(
  ref: RepoRef,
  branch: string,
  token: string,
  call: GhCall = {},
): Promise<{ number: number; htmlUrl: string } | null> {
  const rows = await gh<{ number: number; html_url: string }[]>(
    token,
    `/repos/${ref.owner}/${ref.repo}/pulls?state=open&head=${encodeURIComponent(`${ref.owner}:${branch}`)}`,
    call,
  )
  const first = rows[0]
  return first === undefined ? null : { number: first.number, htmlUrl: first.html_url }
}

/**
 * Open the PR, or update the one this branch already has.
 *
 * The body is REWRITTEN on an update rather than appended to. A PR body here is
 * generated — dedication, sign-off, agreement numbers, conflict status — and it
 * describes the CURRENT state of the branch. Appending would leave the previous
 * submission's numbers sitting above the new ones, which is exactly the sort of
 * stale-but-plausible text a reviewer reads and believes.
 */
export async function openOrUpdatePr(
  ref: RepoRef,
  input: { branch: string; title: string; body: string; draft?: boolean },
  token: string,
  call: GhCall = {},
): Promise<PullRequest> {
  const existing = await findOpenPr(ref, input.branch, token, call)
  if (existing !== null) {
    await gh(token, `/repos/${ref.owner}/${ref.repo}/pulls/${existing.number}`, {
      ...call,
      method: 'PATCH',
      body: { title: input.title, body: input.body },
    })
    return { number: existing.number, htmlUrl: existing.htmlUrl, updated: true }
  }
  const created = await gh<{ number: number; html_url: string }>(token, `/repos/${ref.owner}/${ref.repo}/pulls`, {
    ...call,
    method: 'POST',
    body: {
      title: input.title,
      body: input.body,
      head: input.branch,
      base: ref.branch,
      maintainer_can_modify: true,
      ...(input.draft === true ? { draft: true } : {}),
    },
  })
  return { number: created.number, htmlUrl: created.html_url, updated: false }
}

/**
 * The App bot's own author line.
 *
 * The commit is AUTHORED by the App, not by the contributor, and that is
 * deliberate rather than a limitation: the App is what actually composed and
 * signed the commit, and claiming otherwise in the author field would be the
 * same class of untruth as a client naming its own `derivation_method`. The
 * contributor's name reaches the PR through a `Co-authored-by:` trailer, which
 * is the mechanism GitHub itself uses for exactly this and which puts their
 * avatar on the commit and their name on the PR.
 *
 * `<appSlug>[bot]` with the `<appId>+<slug>[bot]@users.noreply.github.com`
 * address is GitHub's own convention for an App's commits; using it is what
 * makes the avatar resolve to the App rather than to a gravatar blank.
 */
export function botAuthor(appSlug: string, appUserId: string): CommitAuthor {
  return {
    name: `${appSlug}[bot]`,
    email: `${appUserId}+${appSlug}[bot]@users.noreply.github.com`,
  }
}

/** A short, stable id for a session — used where a name needs a discriminator. */
export function shortHash(value: string, length = 7): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length)
}
