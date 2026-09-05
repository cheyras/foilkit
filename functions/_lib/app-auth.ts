// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The contribution App's credentials, and the two-step dance that turns them
// into something GitHub will accept.
//
// A GitHub App does not have a token. It has a PRIVATE KEY, and the key only
// signs a short-lived JWT that says "I am app 12345". That JWT is not usable
// against the repository either — it is exchanged, once, for an INSTALLATION
// ACCESS TOKEN that expires in an hour and carries exactly the permissions the
// installation was granted (here: contents:write, pull_requests:write on
// cheyras/foilkit and nothing else).
//
// WHY THAT SHAPE IS BETTER THAN THE PAT the direct-write path uses, stated
// plainly because both now exist side by side:
//
//   * The PAT is a long-lived bearer secret belonging to a PERSON. If it leaks
//     it is valid until somebody notices. An installation token is valid for an
//     hour and is minted per request family.
//   * The App is its own actor, so a PR it opens is opened BY the app rather
//     than by the maintainer's account — which is what makes "cheyras reviews a
//     contribution" a real review instead of the maintainer approving himself.
//   * Permissions are per-repository and per-scope, declared on the App and
//     visible in its settings page. A fine-grained PAT can do that too; nothing
//     records what it was scoped to at the moment it was used.
//
// THE DEVIATION FROM THE SPEC, recorded here as well as in DECISIONS.md
// (2026-09-05): the plan said "private key in a secrets manager, not env".
// Vercel's encrypted (sensitive) environment variables ARE this deployment's
// secrets manager — the value is write-only after it is set, is never echoed by
// `vercel env ls`, and is injected into the function's process at run time. A
// second secrets service would add an outbound dependency, a second credential
// to bootstrap it with, and a new failure mode on the request path, in exchange
// for the same property. So: env, deliberately, with the rotation story that a
// key rotation is `vercel env rm` + `vercel env add` + a redeploy.
//
// NOTHING HERE IS EVER LOGGED. The key, the JWT and the installation token are
// all secrets; every error message in this file is written from the STATUS CODE
// and the variable NAME, never from the value.

import { createSign } from 'node:crypto'

/** How long the App JWT is good for. GitHub's ceiling is 10 minutes. */
const JWT_TTL_SECONDS = 540
/** Refresh an installation token this long before it actually expires. */
const TOKEN_SKEW_SECONDS = 120

export class AppAuthError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/**
 * A PEM as it survives a trip through an environment variable.
 *
 * The same key arrives in three shapes depending on how it was pasted, and all
 * three are common enough that guessing wrong is a production incident:
 *
 *   1. Real newlines — `vercel env add` from a file, or a dashboard paste.
 *   2. `\n` two-character escapes — anything that went through a JSON blob, a
 *      `.env` line, or a shell that did not quote it.
 *   3. Wrapped in quotes, because a `.env` file kept them.
 *
 * All three normalise to the same bytes here rather than at four call sites.
 * CRLF is folded too: a key pasted on Windows carries `\r\n`, and OpenSSL's PEM
 * reader is fussy about exactly that.
 */
export function normalizePem(raw: string): string {
  let s = raw.trim()
  // A quoted value keeps its quotes when the reader is a dumb `.env` splitter.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1)
  }
  s = s.replace(/\\r/g, '').replace(/\\n/g, '\n').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return s.endsWith('\n') ? s : `${s}\n`
}

export interface AppCredentials {
  appId: string
  privateKey: string
  installationId: string
}

/**
 * Read the three variables, normalised. Throws `AppAuthError` naming what is
 * missing — but the HANDLER should have refused with a 503 long before this is
 * reached (see `contributeConfig` in config.ts). This throw is the backstop for
 * a code path that forgot to check, not the user-facing message.
 */
export function appCredentials(env: NodeJS.ProcessEnv = process.env): AppCredentials {
  const appId = env.FOILKIT_APP_ID ?? ''
  const privateKey = env.FOILKIT_APP_PRIVATE_KEY ?? ''
  const installationId = env.FOILKIT_APP_INSTALLATION_ID ?? ''
  const missing = [
    appId === '' ? 'FOILKIT_APP_ID' : null,
    privateKey === '' ? 'FOILKIT_APP_PRIVATE_KEY' : null,
    installationId === '' ? 'FOILKIT_APP_INSTALLATION_ID' : null,
  ].filter((n): n is string => n !== null)
  if (missing.length > 0) {
    throw new AppAuthError(`the contribution App is not configured. Missing: ${missing.join(', ')}`, 503)
  }
  return { appId, privateKey: normalizePem(privateKey), installationId }
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input as never)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * A signed App JWT.
 *
 * `iat` is backdated 60 seconds on purpose: GitHub rejects a token whose `iat`
 * is in ITS future, and a function host whose clock runs a few seconds fast is
 * not a hypothetical. The cost of the backdate is nothing; the cost of the
 * clock skew is a 401 that reproduces on no other machine.
 */
export function appJwt(creds: AppCredentials, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = b64url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + JWT_TTL_SECONDS, iss: creds.appId }),
  )
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  let signature: Buffer
  try {
    signature = signer.sign(creds.privateKey)
  } catch (err) {
    // The PEM did not parse. Say so WITHOUT the value — a malformed key in a
    // log is still a key.
    throw new AppAuthError(
      `FOILKIT_APP_PRIVATE_KEY did not load as a PEM private key (${(err as Error).name}). ` +
        'It must be the full PKCS#1 or PKCS#8 block including the BEGIN/END lines.',
      503,
    )
  }
  return `${header}.${payload}.${b64url(signature)}`
}

export interface InstallationToken {
  token: string
  /** Unix seconds. */
  expiresAt: number
}

/** The one cached token this warm function instance is holding, if any. */
let cached: InstallationToken | null = null

/** Drop the cache. Tests call this; nothing in the request path does. */
export function resetInstallationToken(): void {
  cached = null
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Exchange the App JWT for an installation access token.
 *
 * CACHED IN MODULE SCOPE, and that is worth a sentence. Vercel keeps a function
 * instance warm between invocations, so a contributor who submits, fixes a
 * validation complaint and submits again usually hits the same instance — and
 * minting a fresh token per submission would be two extra round trips for a
 * credential that is good for an hour. The cache is dropped
 * `TOKEN_SKEW_SECONDS` early so a token is never used inside its last two
 * minutes; a cold instance simply mints one.
 */
export async function installationToken(
  creds: AppCredentials = appCredentials(),
  deps: { fetch?: FetchLike; now?: () => number } = {},
): Promise<string> {
  const fetchImpl = deps.fetch ?? fetch
  const nowSeconds = Math.floor((deps.now?.() ?? Date.now()) / 1000)

  if (cached !== null && cached.expiresAt - TOKEN_SKEW_SECONDS > nowSeconds) return cached.token

  const jwt = appJwt(creds, nowSeconds)
  const res = await fetchImpl(`https://api.github.com/app/installations/${creds.installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${jwt}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'foilkit-contribute (+https://github.com/cheyras/foilkit)',
    },
  })
  if (!res.ok) {
    // The body of a failed token exchange can echo the JWT back. Never include
    // it — the status and GitHub's own top-level `message` are enough to act on.
    let hint = ''
    try {
      const body = (await res.json()) as { message?: string }
      if (typeof body.message === 'string') hint = `: ${body.message.slice(0, 120)}`
    } catch {
      /* an unparseable body is not more informative than the status */
    }
    throw new AppAuthError(
      `the contribution App could not mint an installation token (HTTP ${res.status}${hint}). ` +
        'Check FOILKIT_APP_ID, FOILKIT_APP_INSTALLATION_ID and that the App is still installed on the repository.',
      res.status === 401 || res.status === 404 ? 503 : 502,
    )
  }
  const body = (await res.json()) as { token?: unknown; expires_at?: unknown }
  if (typeof body.token !== 'string' || body.token.length === 0) {
    throw new AppAuthError('the installation token response carried no token', 502)
  }
  const expiresAt =
    typeof body.expires_at === 'string' && !Number.isNaN(Date.parse(body.expires_at))
      ? Math.floor(Date.parse(body.expires_at) / 1000)
      : nowSeconds + 3600
  cached = { token: body.token, expiresAt }
  return body.token
}
