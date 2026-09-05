// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// What this deployment is configured to do, checked before it tries to do it.
//
// THE RULE, and the deploy that produced it: an endpoint whose environment is
// incomplete must answer a CLEAN, NAMED 503 — never a 500, and never a boot
// crash. Those three look the same from a browser and mean completely different
// things to whoever has to fix it:
//
//   * boot crash  → the code was packaged wrong; no handler ran
//   * 500         → the code ran and hit something it did not expect
//   * 503 + name  → the code is fine and a variable is missing
//
// The first production deploy conflated all three, and the useful signal — "you
// have not set FOILKIT_GITHUB_TOKEN yet" — was indistinguishable from a
// packaging failure. So configuration is now checked FIRST, at the top of the
// handler, before a cookie is parsed or a repository is read.
//
// Read is fully public and needs no environment at all. `/api/image` in
// particular must work on a deployment with an empty environment, because the
// card scans are the thing a visitor sees before they have any reason to sign
// in. There is a test that asserts exactly that.

import { sendPrivateJson, type FnResponse } from './http.ts'

export interface MissingConfig {
  /** The env var names this endpoint needs and did not get. */
  missing: string[]
  /** One sentence naming what stops working, for the person reading the JSON. */
  what: string
}

function absent(name: string): boolean {
  const v = process.env[name]
  return typeof v !== 'string' || v.length === 0
}

/** Sign-in needs an OAuth app; nothing else does. */
export function authConfig(): MissingConfig | null {
  const missing = ['FOILKIT_OAUTH_CLIENT_ID', 'FOILKIT_OAUTH_CLIENT_SECRET'].filter(absent)
  return missing.length === 0 ? null : { missing, what: 'sign-in is not configured on this deployment' }
}

/**
 * A direct write needs a signing secret AND a repository token.
 *
 * The secret is separated out because `/api/me` needs it and the token, and a
 * deployment can legitimately have the first without the second — which is
 * exactly the state this deploy is in right now: signed-in identity works,
 * writing does not, and saying so precisely is the whole point.
 */
export function sessionConfig(): MissingConfig | null {
  const missing = ['FOILKIT_SESSION_SECRET'].filter(
    (n) => absent(n) || (process.env[n] as string).length < 32,
  )
  return missing.length === 0
    ? null
    : { missing, what: 'sign-in state cannot be verified (the secret is missing or under 32 characters)' }
}

export function writeConfig(): MissingConfig | null {
  const missing = ['FOILKIT_SESSION_SECRET', 'FOILKIT_GITHUB_TOKEN'].filter(absent)
  return missing.length === 0
    ? null
    : {
        missing,
        what:
          'direct writes are not configured on this deployment — stage the session instead; ' +
          'it is not lost, and submission opens a pull request instead',
      }
}

/**
 * Opening a pull request needs a signing secret AND the contribution App.
 *
 * A SEPARATE LADDER FROM `writeConfig`, deliberately. The two paths use
 * different credentials for different acts: a direct write commits to `main`
 * with the project's PAT, and a contribution opens a branch and a pull request
 * as the App. A deployment can legitimately have either, both or neither, and
 * every combination has a different honest answer:
 *
 *   * neither    → stage locally and export a bundle; nothing is lost
 *   * PAT only   → the maintainer writes directly; nobody else can submit
 *   * App only   → everybody submits, the maintainer included
 *
 * Naming the exact variables is what turns "Submit is broken" into "somebody
 * has not finished installing the App yet", which is a different day.
 */
export function contributeConfig(): MissingConfig | null {
  const missing = [
    'FOILKIT_SESSION_SECRET',
    'FOILKIT_APP_ID',
    'FOILKIT_APP_PRIVATE_KEY',
    'FOILKIT_APP_INSTALLATION_ID',
  ].filter(absent)
  return missing.length === 0
    ? null
    : {
        missing,
        what:
          'the contribution pipeline is not configured on this deployment — your session stays staged ' +
          'and is not lost; export it and submit once the App is installed',
      }
}

/**
 * Answer 503 and return true, or return false and let the handler continue.
 *
 * 503 rather than 500 because the service is *unavailable*, not broken, and
 * rather than 404 because the endpoint genuinely exists — a contributor whose
 * save is refused should be told which of those it is.
 */
export function refuseIfUnconfigured(res: FnResponse, cfg: MissingConfig | null): boolean {
  if (cfg === null) return false
  sendPrivateJson(res, 503, {
    error: {
      code: 'not_configured',
      message: `${cfg.what}. Missing: ${cfg.missing.join(', ')}. See DEPLOYMENT.md.`,
      missing: cfg.missing,
    },
  })
  return true
}
