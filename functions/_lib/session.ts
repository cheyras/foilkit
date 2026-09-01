// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// "Is this browser cheyras?" — the smallest thing that answers it honestly.
//
// WHAT THIS IS NOT. It is not an account system, it does not store a user
// anywhere, and it never sees a password. Read on this site is fully public;
// sign-in exists at exactly two moments — a direct write, and (once #9 ships) a
// submission. So the whole identity layer is: GitHub's OAuth web flow says who
// you are once, and a signed cookie remembers that answer.
//
// THE COOKIE IS SIGNED, NOT ENCRYPTED. It carries a login and an expiry in
// plain sight, with an HMAC over both. That is the right shape: there is
// nothing secret in "you are logged in as cheyras", and the only property that
// matters is that a browser cannot write itself a different login. Encryption
// would hide a public fact and add a key-rotation problem for nothing.
//
// NO GITHUB TOKEN IS EVER PUT IN THE COOKIE. The user's access token is used
// once, server-side, to ask GitHub who they are, and then discarded. Commits
// are made with the project's own token, which never leaves the server. A token
// in a cookie is a token in every XSS report for the rest of the site's life.

import { createHmac, timingSafeEqual } from 'node:crypto'

export const COOKIE_NAME = 'foilkit_session'
/** Two weeks. Long enough not to nag; short enough that a lost laptop expires. */
export const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60

export interface SessionClaims {
  login: string
  /** GitHub's numeric user id. Carried because the commit author line uses
   *  `<id>+<login>@users.noreply.github.com`, which is the address that links a
   *  commit to a profile without this service ever handling a real one. */
  id: number
  name: string | null
  avatarUrl: string | null
  /** Unix seconds. */
  exp: number
}

export class MissingSecret extends Error {}

/**
 * The signing key.
 *
 * FAILS LOUDLY. A missing secret must not silently degrade to an unsigned
 * cookie or to "nobody is ever a writer" — one is a hole and the other is a
 * mystery. It throws, the endpoint answers 500, and `DEPLOYMENT.md` names the
 * variable.
 */
function secret(): Buffer {
  const s = process.env.FOILKIT_SESSION_SECRET
  if (typeof s !== 'string' || s.length < 32) {
    throw new MissingSecret(
      'FOILKIT_SESSION_SECRET is missing or shorter than 32 characters — see DEPLOYMENT.md',
    )
  }
  return Buffer.from(s, 'utf8')
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function unb64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

export function signSession(claims: SessionClaims): string {
  const body = b64url(Buffer.from(JSON.stringify(claims), 'utf8'))
  const mac = b64url(createHmac('sha256', secret()).update(body).digest())
  return `${body}.${mac}`
}

/**
 * Verify and decode. Returns null for every failure mode — a tampered cookie,
 * an expired one, and a malformed one are all just "not signed in", because
 * telling the browser which of those it is helps nobody but an attacker.
 */
export function verifySession(token: string | null | undefined, now = Date.now()): SessionClaims | null {
  if (typeof token !== 'string') return null
  const dot = token.indexOf('.')
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const mac = token.slice(dot + 1)
  let expected: Buffer
  try {
    expected = Buffer.from(b64url(createHmac('sha256', secret()).update(body).digest()), 'utf8')
  } catch {
    return null
  }
  const given = Buffer.from(mac, 'utf8')
  // Constant-time: a length-varying compare leaks the prefix of a valid mac.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const claims = JSON.parse(unb64url(body).toString('utf8')) as SessionClaims
    if (typeof claims.login !== 'string' || typeof claims.exp !== 'number') return null
    if (typeof claims.id !== 'number') return null
    if (claims.exp * 1000 <= now) return null
    return claims
  } catch {
    return null
  }
}

/** Parse a Cookie header. Small and permissive; only one name is ever read. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (typeof header !== 'string') return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return null
}

/**
 * The Set-Cookie value.
 *
 * `SameSite=Lax` rather than `Strict`: the OAuth callback is a cross-site
 * top-level navigation back from github.com, and `Strict` would drop the cookie
 * on exactly that hop. `Lax` still blocks it on cross-site POSTs, which is the
 * CSRF case that matters for a write endpoint.
 */
export function sessionCookie(token: string, maxAgeSeconds = SESSION_TTL_SECONDS): string {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ')
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

/**
 * Where to send the browser after sign-in.
 *
 * An open redirect in an OAuth callback is how a phishing page borrows your
 * domain's credibility, so this accepts a SAME-SITE PATH and nothing else: it
 * must start with a single `/`, and `//host` (a protocol-relative absolute URL)
 * is rejected explicitly because it looks like a path and is not one.
 */
export function safeReturnPath(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.length === 0) return '/'
  if (!value.startsWith('/') || value.startsWith('//')) return '/'
  if (value.includes('\\') || value.includes('\n') || value.includes('\r')) return '/'
  return value
}
