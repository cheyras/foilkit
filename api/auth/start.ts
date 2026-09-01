// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Step one of the GitHub OAuth web flow.
//
// WHY THIS FLOW AND NOT SOMETHING SMALLER. The requirement is "verify that this
// browser is cheyras, without handling a password". The three candidates were a
// shared secret in an env var (which is a password, typed into a form, and
// unshareable the moment a second writer exists), the device flow (built for
// input-constrained devices — it asks a browser user to type a code into
// another page, which is worse UX in a browser), and this. The web flow is the
// one the platform is built around, it never puts a credential in this app's
// hands, and the identity it returns is the same GitHub login the writer list
// is written against.
//
// SCOPES: NONE. The authorize URL asks for no scope at all, which still returns
// a token that can read `/user` — a public profile. This service does not need
// to act as the user, does not want their email, and cannot touch their
// repositories. The commit is made with the project's own token.

import { redirect, sendPrivateError, type FnRequest, type FnResponse } from '../_lib/http.ts'
import { safeReturnPath } from '../_lib/session.ts'
import { queryValue } from '../_lib/http.ts'

/** The public half of the OAuth app. Fails loudly — see DEPLOYMENT.md. */
function clientId(): string {
  const id = process.env.FOILKIT_OAUTH_CLIENT_ID
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('FOILKIT_OAUTH_CLIENT_ID is not set — see DEPLOYMENT.md')
  }
  return id
}

export default function handler(req: FnRequest, res: FnResponse): void {
  if (req.method !== 'GET') {
    sendPrivateError(res, 405, 'method_not_allowed', 'GET only')
    return
  }
  let id: string
  try {
    id = clientId()
  } catch (err) {
    sendPrivateError(res, 500, 'not_configured', (err as Error).message)
    return
  }

  // Where to come back to. Validated as a same-site PATH — an open redirect in
  // an OAuth callback is how a phishing page borrows a domain's credibility.
  const back = safeReturnPath(queryValue(req, 'return'))

  // GitHub echoes `state` back to the callback unchanged. It is a signed
  // round-trip of the return path rather than a CSRF nonce, because there is no
  // server-side session to bind a nonce to yet — the callback re-validates the
  // path with the same `safeReturnPath`, so a tampered state can only ever
  // redirect to another path on this site.
  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.set('client_id', id)
  url.searchParams.set('scope', '')
  url.searchParams.set('state', back)
  // No `redirect_uri`: the OAuth app's registered callback URL is the single
  // source of truth for where GitHub may send a code, and not sending one is
  // what makes that unbypassable from here.
  redirect(res, url.toString())
}
