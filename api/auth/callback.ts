// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Step two: exchange the code, ask GitHub who this is, set the cookie.
//
// The user's access token exists inside this function and nowhere else. It is
// used for exactly one call — `GET /user` — and then goes out of scope. It is
// never stored, never logged, and never sent to the browser: a token in a
// cookie is a token in every XSS report for the rest of the site's life.

import { queryValue, redirect, sendPrivateError, type FnRequest, type FnResponse } from '../_lib/http.ts'
import { safeReturnPath, sessionCookie, signSession, SESSION_TTL_SECONDS } from '../_lib/session.ts'
import { whoAmI } from '../_lib/github.ts'

function oauthApp(): { id: string; secret: string } {
  const id = process.env.FOILKIT_OAUTH_CLIENT_ID
  const secret = process.env.FOILKIT_OAUTH_CLIENT_SECRET
  if (typeof id !== 'string' || id.length === 0 || typeof secret !== 'string' || secret.length === 0) {
    throw new Error('FOILKIT_OAUTH_CLIENT_ID / FOILKIT_OAUTH_CLIENT_SECRET are not set — see DEPLOYMENT.md')
  }
  return { id, secret }
}

export default async function handler(req: FnRequest, res: FnResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendPrivateError(res, 405, 'method_not_allowed', 'GET only')
    return
  }

  // GitHub sends `error` instead of `code` when the user declines. That is a
  // normal outcome, not a failure — send them back where they were.
  if (typeof queryValue(req, 'error') === 'string') {
    redirect(res, safeReturnPath(queryValue(req, 'state')))
    return
  }

  const code = queryValue(req, 'code')
  if (typeof code !== 'string' || code.length === 0) {
    sendPrivateError(res, 400, 'no_code', 'the callback was reached without an authorization code')
    return
  }

  let app: { id: string; secret: string }
  try {
    app = oauthApp()
  } catch (err) {
    sendPrivateError(res, 500, 'not_configured', (err as Error).message)
    return
  }

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: app.id, client_secret: app.secret, code }),
    })
    if (!tokenRes.ok) {
      sendPrivateError(res, 502, 'exchange_failed', `GitHub answered ${tokenRes.status} to the code exchange`)
      return
    }
    const body = (await tokenRes.json()) as { access_token?: string; error?: string }
    if (typeof body.access_token !== 'string') {
      // `body.error` is GitHub's own machine code (`bad_verification_code` and
      // friends). Safe to pass on; it contains nothing the caller supplied.
      sendPrivateError(res, 400, 'exchange_rejected', `GitHub rejected the code (${body.error ?? 'no token'})`)
      return
    }

    const user = await whoAmI(body.access_token)
    const token = signSession({
      login: user.login,
      id: user.id,
      name: user.name,
      avatarUrl: user.avatar_url,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    })
    // NOTE what is NOT recorded here: no writer decision. The cookie says who
    // you are; every write endpoint decides what that means, so revoking the
    // capability is a config change rather than a wait for cookies to expire.
    redirect(res, safeReturnPath(queryValue(req, 'state')), [sessionCookie(token)])
  } catch (err) {
    sendPrivateError(res, 502, 'sign_in_failed', (err as Error).message)
  }
}
