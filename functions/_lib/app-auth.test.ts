// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// THE CREDENTIAL DANCE, without a GitHub.
//
// Everything in `app-auth.ts` is either arithmetic on a private key or one HTTP
// call, and both of those are testable offline: the key is generated here, and
// the call is a function argument. That matters more than usual because the
// failure modes are all silent-until-production — a PEM that did not survive
// the environment, a clock skew, a cached token used past its expiry — and none
// of them are reproducible by looking at the code.
//
// The JWT is verified with `createVerify` against the PUBLIC half of the
// generated key, which is the same check GitHub performs. A test that only
// asserted the string had three dots would pass on a signature over the wrong
// bytes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createVerify, generateKeyPairSync } from 'node:crypto'

const { appJwt, appCredentials, installationToken, normalizePem, resetInstallationToken, AppAuthError } =
  await import('./app-auth.ts')

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const CREDS = { appId: '123456', privateKey, installationId: '987654' }

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
}

// ── normalizePem ───────────────────────────────────────────────────────────

test('a PEM with real newlines survives unchanged', () => {
  assert.equal(normalizePem(privateKey), privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`)
})

test('a PEM whose newlines arrived as two-character \\n escapes is restored', () => {
  const escaped = privateKey.replace(/\n/g, '\\n')
  assert.equal(normalizePem(escaped), privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`)
})

test('a PEM that kept its surrounding quotes loses them', () => {
  const quoted = `"${privateKey.replace(/\n/g, '\\n')}"`
  assert.ok(normalizePem(quoted).startsWith('-----BEGIN'))
  assert.ok(!normalizePem(quoted).includes('"'))
})

test('CRLF folds to LF — a key pasted on Windows still loads', () => {
  const crlf = privateKey.replace(/\n/g, '\r\n')
  assert.ok(!normalizePem(crlf).includes('\r'))
  // The real assertion: it still signs. A PEM reader is fussy about exactly
  // this and a string comparison would not prove it.
  assert.ok(appJwt({ ...CREDS, privateKey: normalizePem(crlf) }).split('.').length === 3)
})

test('a normalised PEM always ends in a newline', () => {
  assert.ok(normalizePem(privateKey.trim()).endsWith('\n'))
})

// ── appCredentials ─────────────────────────────────────────────────────────

test('appCredentials names every variable it did not get', () => {
  try {
    appCredentials({} as NodeJS.ProcessEnv)
    assert.fail('expected a throw')
  } catch (err) {
    assert.ok(err instanceof AppAuthError)
    assert.equal((err as { status: number }).status, 503)
    for (const name of ['FOILKIT_APP_ID', 'FOILKIT_APP_PRIVATE_KEY', 'FOILKIT_APP_INSTALLATION_ID']) {
      assert.ok((err as Error).message.includes(name), `expected the message to name ${name}`)
    }
  }
})

test('appCredentials normalises the key it reads out of the environment', () => {
  const creds = appCredentials({
    FOILKIT_APP_ID: '1',
    FOILKIT_APP_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n'),
    FOILKIT_APP_INSTALLATION_ID: '2',
  } as NodeJS.ProcessEnv)
  assert.ok(creds.privateKey.startsWith('-----BEGIN'))
  assert.ok(creds.privateKey.includes('\n'))
})

// ── appJwt ─────────────────────────────────────────────────────────────────

test('the JWT verifies against the public half of the key', () => {
  const token = appJwt(CREDS, 1_700_000_000)
  const [header, payload, signature] = token.split('.')
  const verifier = createVerify('RSA-SHA256')
  verifier.update(`${header}.${payload}`)
  assert.ok(
    verifier.verify(publicKey, Buffer.from(signature!.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
    'the signature is over the wrong bytes',
  )
})

test('the JWT says RS256 and names the app as issuer', () => {
  const [header, payload] = appJwt(CREDS, 1_700_000_000).split('.')
  assert.deepEqual(decodeSegment(header!), { alg: 'RS256', typ: 'JWT' })
  assert.equal(decodeSegment(payload!).iss, '123456')
})

test('iat is backdated 60 seconds, because a fast clock is a 401 nobody can reproduce', () => {
  const now = 1_700_000_000
  const claims = decodeSegment(appJwt(CREDS, now).split('.')[1]!)
  assert.equal(claims.iat, now - 60)
  assert.ok((claims.exp as number) > now, 'exp must be in the future')
  assert.ok((claims.exp as number) - (claims.iat as number) <= 600, "GitHub's ceiling is 10 minutes")
})

test('a private key that is not a PEM fails as a 503 naming the variable, never echoing it', () => {
  try {
    appJwt({ ...CREDS, privateKey: 'sk_this_is_not_a_pem_at_all' })
    assert.fail('expected a throw')
  } catch (err) {
    assert.ok(err instanceof AppAuthError)
    assert.equal((err as { status: number }).status, 503)
    assert.ok((err as Error).message.includes('FOILKIT_APP_PRIVATE_KEY'))
    assert.ok(
      !(err as Error).message.includes('sk_this_is_not_a_pem_at_all'),
      'the message must never contain the value',
    )
  }
})

// ── installationToken ──────────────────────────────────────────────────────

function mockFetch(responses: { status: number; body: unknown }[]): {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  calls: { url: string; init?: RequestInit }[]
} {
  const calls: { url: string; init?: RequestInit }[] = []
  let i = 0
  return {
    calls,
    fetch: async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      const r = responses[Math.min(i++, responses.length - 1)]!
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { 'content-type': 'application/json' },
      })
    },
  }
}

test('the token exchange posts the JWT to the installation and returns the token', async () => {
  resetInstallationToken()
  const expires = new Date(Date.now() + 3600_000).toISOString()
  const m = mockFetch([{ status: 201, body: { token: 'ghs_installation', expires_at: expires } }])
  const token = await installationToken(CREDS, { fetch: m.fetch })
  assert.equal(token, 'ghs_installation')
  assert.equal(m.calls.length, 1)
  assert.equal(m.calls[0]!.url, 'https://api.github.com/app/installations/987654/access_tokens')
  assert.equal(m.calls[0]!.init?.method, 'POST')
  const auth = (m.calls[0]!.init?.headers as Record<string, string>).authorization
  assert.ok(auth.startsWith('Bearer '), 'the JWT goes in the Authorization header')
  assert.equal(auth.slice('Bearer '.length).split('.').length, 3, 'and it is a JWT, not the token')
})

test('a second call inside the hour reuses the cached token — no second round trip', async () => {
  resetInstallationToken()
  const expires = new Date(Date.now() + 3600_000).toISOString()
  const m = mockFetch([{ status: 201, body: { token: 'ghs_one', expires_at: expires } }])
  await installationToken(CREDS, { fetch: m.fetch })
  await installationToken(CREDS, { fetch: m.fetch })
  assert.equal(m.calls.length, 1, 'the cache did not hold')
})

test('a token inside its last two minutes is re-minted rather than used', async () => {
  resetInstallationToken()
  const expires = new Date(Date.now() + 90_000).toISOString()
  const m = mockFetch([
    { status: 201, body: { token: 'ghs_nearly_stale', expires_at: expires } },
    { status: 201, body: { token: 'ghs_fresh', expires_at: new Date(Date.now() + 3600_000).toISOString() } },
  ])
  assert.equal(await installationToken(CREDS, { fetch: m.fetch }), 'ghs_nearly_stale')
  assert.equal(await installationToken(CREDS, { fetch: m.fetch }), 'ghs_fresh')
  assert.equal(m.calls.length, 2)
})

test('a 401 from the exchange is a 503 — the App is misconfigured, not GitHub broken', async () => {
  resetInstallationToken()
  const m = mockFetch([{ status: 401, body: { message: 'A JSON web token could not be decoded' } }])
  await assert.rejects(
    () => installationToken(CREDS, { fetch: m.fetch }),
    (err: unknown) => {
      assert.ok(err instanceof AppAuthError)
      assert.equal((err as { status: number }).status, 503)
      assert.ok((err as Error).message.includes('FOILKIT_APP_ID'))
      return true
    },
  )
})

test('a 500 from the exchange is a 502 — GitHub is having a day, the config is fine', async () => {
  resetInstallationToken()
  const m = mockFetch([{ status: 500, body: { message: 'Server Error' } }])
  await assert.rejects(
    () => installationToken(CREDS, { fetch: m.fetch }),
    (err: unknown) => {
      assert.equal((err as { status: number }).status, 502)
      return true
    },
  )
})

test('a failed exchange never echoes the JWT back into the message', async () => {
  resetInstallationToken()
  // GitHub does sometimes reflect the credential in an error body. If it ever
  // reaches a log, the credential is in the log.
  const m = mockFetch([{ status: 401, body: { message: 'bad token', token: 'LEAKED_JWT_VALUE' } }])
  await assert.rejects(
    () => installationToken(CREDS, { fetch: m.fetch }),
    (err: unknown) => {
      assert.ok(!(err as Error).message.includes('LEAKED_JWT_VALUE'))
      return true
    },
  )
})

test('a response with no token is a 502 rather than a token of "undefined"', async () => {
  resetInstallationToken()
  const m = mockFetch([{ status: 201, body: { expires_at: new Date().toISOString() } }])
  await assert.rejects(() => installationToken(CREDS, { fetch: m.fetch }), /carried no token/)
})
