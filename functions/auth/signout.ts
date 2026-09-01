// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Drop the cookie. There is no server-side session to invalidate — the cookie
// IS the session — so this is genuinely the whole operation.

import { queryValue, redirect, sendPrivateError, type FnRequest, type FnResponse } from '../_lib/http.ts'
import { clearCookie, safeReturnPath } from '../_lib/session.ts'

export default function handler(req: FnRequest, res: FnResponse): void {
  if (req.method !== 'GET' && req.method !== 'POST') {
    sendPrivateError(res, 405, 'method_not_allowed', 'GET or POST')
    return
  }
  redirect(res, safeReturnPath(queryValue(req, 'return')), [clearCookie()])
}
