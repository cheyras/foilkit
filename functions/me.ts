// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Who is looking, and may they write?
//
// SIGNED OUT IS A 200, not a 401. Read on this site is fully public and staging
// needs no account, so "nobody is signed in" is the ordinary state of the
// ordinary visitor — answering it with an error would put a red line in every
// contributor's console for doing nothing wrong. The editor reads `login: null`
// and offers the staging path, which is the normal path.
//
// The `writer` field here is the SAME derivation the write endpoints use, so
// the UI and the server cannot disagree about what a save will do. It is still
// not the security boundary: `functions/mask.ts` re-checks before it commits.

import { headerValue, sendPrivateError, sendPrivateJson, type FnRequest, type FnResponse } from './_lib/http.ts'
import { refuseIfUnconfigured, sessionConfig } from './_lib/config.ts'
import { COOKIE_NAME, readCookie, verifySession } from './_lib/session.ts'
import { isWriter, WRITERS } from './_lib/writers.ts'

export default function handler(req: FnRequest, res: FnResponse): void {
  if (req.method !== 'GET') {
    sendPrivateError(res, 405, 'method_not_allowed', 'GET only')
    return
  }
  // A missing signing secret is a deployment fault, not a signed-out user, and
  // collapsing the two would make it invisible. 503 with the variable named.
  if (refuseIfUnconfigured(res, sessionConfig())) return

  const claims = verifySession(readCookie(headerValue(req, 'cookie') ?? undefined, COOKIE_NAME))

  if (claims === null) {
    sendPrivateJson(res, 200, {
      login: null,
      writer: false,
      // Published deliberately: the list is a fact about the project, not a
      // secret, and a contributor should be able to see who can merge without
      // asking. It is also how the editor explains the two save paths.
      writers: WRITERS,
    })
    return
  }

  sendPrivateJson(res, 200, {
    login: claims.login,
    name: claims.name,
    avatarUrl: claims.avatarUrl,
    writer: isWriter(claims.login),
    writers: WRITERS,
  })
}
