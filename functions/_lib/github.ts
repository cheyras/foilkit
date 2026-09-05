// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The GitHub side of a direct write.
//
// A direct write is a COMMIT, not a file save. The old workbench wrote into a
// working tree because it was a single-user dev tool; the hosted editor has no
// working tree, so the equivalent is the git data API — blobs, a tree, a
// commit, a fast-forward ref update. One commit per save, which keeps the
// history readable as "here is what one human changed about one card".
//
// THE ATTRIBUTION SPLIT, stated because it is a real limitation rather than an
// oversight: the commit is made with the PROJECT'S token, so GitHub records
// that account as the COMMITTER. The signed-in user is recorded as the AUTHOR,
// which is the field that means "whose work is this" and the one every log view
// shows by default.
//
// THE CONTRIBUTION PATH DOES NOT HAVE THIS PROBLEM, and it is worth knowing
// which module you are reading. `functions/contribute.ts` commits as a GitHub
// App with a `Co-authored-by:` trailer, which puts the contributor's avatar on
// the commit and their name on the pull request. This split is what remains on
// the DIRECT write, where the committer is the project's own account and the
// author is the maintainer — which is an accurate description of what happened.

export interface RepoRef {
  owner: string
  repo: string
  branch: string
  /**
   * The token every READ in this module should use.
   *
   * Absent means "the project's own PAT", which is what the direct-write path
   * wants. The CONTRIBUTION path sets it to a one-hour GitHub App installation
   * token, because a deployment can have the App configured and no PAT at all —
   * and because falling back to the PAT would let a contribution read the
   * repository with the maintainer's credential. Reads are threaded rather than
   * duplicated: `materialise` builds the same /tmp tree either way.
   *
   * WRITES ARE NOT THREADED THROUGH HERE. `commitChanges` fast-forwards `main`
   * and stays on `repoToken()` deliberately; a contribution commits through
   * `pr.ts`, which takes its token as an explicit argument on every call.
   */
  token?: string
}

export class GithubError extends Error {
  // A plain field rather than a parameter property: Node's type stripping runs
  // this file as-is, and parameter properties are the one TypeScript feature
  // that erasure cannot express.
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export class MissingToken extends Error {}

/** The project's own token. Fails loudly — see DEPLOYMENT.md. */
export function repoToken(): string {
  const t = process.env.FOILKIT_GITHUB_TOKEN
  if (typeof t !== 'string' || t.length === 0) {
    throw new MissingToken('FOILKIT_GITHUB_TOKEN is not set — see DEPLOYMENT.md')
  }
  return t
}

export function repoRef(): RepoRef {
  const slug = process.env.FOILKIT_REPO ?? 'cheyras/foilkit'
  const [owner, repo] = slug.split('/')
  if (!owner || !repo) throw new Error(`FOILKIT_REPO must be owner/repo, got ${JSON.stringify(slug)}`)
  return { owner, repo, branch: process.env.FOILKIT_BRANCH ?? 'main' }
}

const API = 'https://api.github.com'

async function gh<T>(
  path: string,
  init: { method?: string; body?: unknown; token?: string; accept?: string } = {},
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      accept: init.accept ?? 'application/vnd.github+json',
      authorization: `Bearer ${init.token ?? repoToken()}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'foilkit-editor (+https://github.com/cheyras/foilkit)',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    // Never echo the token; the message is the API's own, truncated.
    throw new GithubError(`GitHub ${init.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`, res.status)
  }
  return (await res.json()) as T
}

// ── Identity ───────────────────────────────────────────────────────────────

export interface GithubUser {
  login: string
  name: string | null
  avatar_url: string | null
  id: number
}

/** Who does THIS user access token belong to? Used once, at sign-in. */
export async function whoAmI(userToken: string): Promise<GithubUser> {
  return gh<GithubUser>('/user', { token: userToken })
}

// ── Reading the corpus as it is right now ─────────────────────────────────

export interface RepoFile {
  path: string
  sha: string
  size: number
}

/**
 * List one directory at the head of the branch.
 *
 * Returns [] for a directory that does not exist — a card with no mask yet is
 * the common case and is not an error.
 */
export async function listDir(ref: RepoRef, dirPath: string): Promise<RepoFile[]> {
  try {
    const rows = await gh<{ path: string; sha: string; size: number; type: string }[]>(
      `/repos/${ref.owner}/${ref.repo}/contents/${encodeURI(dirPath)}?ref=${encodeURIComponent(ref.branch)}`,
      { token: ref.token },
    )
    return rows.filter((r) => r.type === 'file').map((r) => ({ path: r.path, sha: r.sha, size: r.size }))
  } catch (err) {
    if (err instanceof GithubError && err.status === 404) return []
    throw err
  }
}

/** Raw bytes of one blob. */
export async function readBlob(ref: RepoRef, sha: string): Promise<Buffer> {
  const res = await fetch(`${API}/repos/${ref.owner}/${ref.repo}/git/blobs/${sha}`, {
    headers: {
      accept: 'application/vnd.github.raw',
      authorization: `Bearer ${ref.token ?? repoToken()}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'foilkit-editor (+https://github.com/cheyras/foilkit)',
    },
  })
  if (!res.ok) throw new GithubError(`blob ${sha} → ${res.status}`, res.status)
  return Buffer.from(await res.arrayBuffer())
}

/** One file's bytes by path, or null when it is not there. */
export async function readFileAt(ref: RepoRef, filePath: string): Promise<Buffer | null> {
  try {
    const row = await gh<{ sha: string; type: string }>(
      `/repos/${ref.owner}/${ref.repo}/contents/${encodeURI(filePath)}?ref=${encodeURIComponent(ref.branch)}`,
      { token: ref.token },
    )
    if (row.type !== 'file') return null
    return await readBlob(ref, row.sha)
  } catch (err) {
    if (err instanceof GithubError && err.status === 404) return null
    throw err
  }
}

// ── Committing ─────────────────────────────────────────────────────────────

export interface CommitChange {
  path: string
  /** `null` DELETES the path. */
  content: Buffer | null
}

export interface CommitResult {
  sha: string
  url: string
  changed: string[]
}

/**
 * One commit, containing every change, fast-forwarded onto the branch head.
 *
 * `force: false` on the ref update is the important flag: if somebody else
 * pushed between the read and the write, GitHub refuses rather than discarding
 * their commit. That is the same principle as the mask conflict UI one layer
 * up — never resolve a race by silently picking a winner.
 */
export async function commitChanges(
  ref: RepoRef,
  changes: CommitChange[],
  message: string,
  author: { name: string; email: string },
): Promise<CommitResult> {
  if (changes.length === 0) throw new Error('nothing to commit')

  const head = await gh<{ object: { sha: string } }>(
    `/repos/${ref.owner}/${ref.repo}/git/ref/heads/${encodeURIComponent(ref.branch)}`,
  )
  const baseSha = head.object.sha
  const baseCommit = await gh<{ tree: { sha: string } }>(
    `/repos/${ref.owner}/${ref.repo}/git/commits/${baseSha}`,
  )

  const tree: { path: string; mode: '100644'; type: 'blob'; sha: string | null }[] = []
  for (const c of changes) {
    if (c.content === null) {
      // A null sha in a tree entry is how the git data API expresses a delete.
      tree.push({ path: c.path, mode: '100644', type: 'blob', sha: null })
      continue
    }
    const blob = await gh<{ sha: string }>(`/repos/${ref.owner}/${ref.repo}/git/blobs`, {
      method: 'POST',
      // base64 for everything, because half of these are PNGs and a
      // utf8-vs-binary decision per file is a bug waiting to be written.
      body: { content: c.content.toString('base64'), encoding: 'base64' },
    })
    tree.push({ path: c.path, mode: '100644', type: 'blob', sha: blob.sha })
  }

  const newTree = await gh<{ sha: string }>(`/repos/${ref.owner}/${ref.repo}/git/trees`, {
    method: 'POST',
    body: { base_tree: baseCommit.tree.sha, tree },
  })

  const commit = await gh<{ sha: string; html_url: string }>(`/repos/${ref.owner}/${ref.repo}/git/commits`, {
    method: 'POST',
    body: { message, tree: newTree.sha, parents: [baseSha], author },
  })

  await gh(`/repos/${ref.owner}/${ref.repo}/git/refs/heads/${encodeURIComponent(ref.branch)}`, {
    method: 'PATCH',
    body: { sha: commit.sha, force: false },
  })

  return { sha: commit.sha, url: commit.html_url, changed: changes.map((c) => c.path) }
}

/**
 * The author line for a signed-in contributor.
 *
 * GitHub's `<id>+<login>@users.noreply.github.com` form is the address a user
 * gets when they keep their real one private. Using it means the commit links
 * to their profile without this service ever handling an email address it was
 * not given — which it was not, because the `user:email` scope is deliberately
 * not requested.
 */
export function noreplyAuthor(user: GithubUser): { name: string; email: string } {
  return { name: user.name ?? user.login, email: `${user.id}+${user.login}@users.noreply.github.com` }
}
