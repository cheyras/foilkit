// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// sha256 over the bytes a session pins itself to.
//
// `correction.parent.sha256` already exists server-side and pins the exact
// parent bytes. Stash the same number at seed time and staleness becomes a byte
// comparison rather than a heuristic — which is the whole reason conflict
// detection here is trustworthy and the reason it is never a merge.
//
// WebCrypto only: no dependency, present in every browser this editor targets
// and in Node ≥ 20, so the same function is what the tests exercise. It
// requires a secure context in the browser — the site is https, and localhost
// counts, so there is no third case.

/** Hex sha256 of raw bytes. */
export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  // BufferSource wants a real ArrayBuffer view; a Uint8Array over a larger
  // buffer would hash the wrong window, so slice to exactly this view.
  const view = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice()
  const digest = await crypto.subtle.digest('SHA-256', view as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Hex sha256 of a UTF-8 string. Used for the canon session's uniform snapshot. */
export async function sha256Text(text: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(text))
}

/**
 * The bytes inside a `data:image/png;base64,…` URL.
 *
 * Throws rather than returning null on a malformed input: a session whose PNG
 * cannot be decoded is a session that cannot be submitted, and finding that out
 * at submit time — after the human has done the work — is the worst moment.
 */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',')
  if (comma < 0 || !dataUrl.startsWith('data:')) throw new Error('not a data: URL')
  const meta = dataUrl.slice(5, comma)
  if (!meta.includes(';base64')) throw new Error('data: URL is not base64')
  const b64 = dataUrl.slice(comma + 1)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** sha256 of a PNG data URL — the form a staged mask is held in. */
export async function sha256DataUrl(dataUrl: string): Promise<string> {
  return sha256Bytes(dataUrlToBytes(dataUrl))
}

/**
 * A canon file is JSON, not pixels, so its pin is a hash over a CANONICAL
 * serialisation: keys sorted, numbers as JSON writes them. Two files that
 * differ only in key order are the same canon and must not read as a conflict.
 */
export function canonicalUniforms(uniforms: Record<string, number>): string {
  const keys = Object.keys(uniforms).sort()
  return JSON.stringify(keys.map((k) => [k, uniforms[k]]))
}

export async function sha256Uniforms(uniforms: Record<string, number>): Promise<string> {
  return sha256Text(canonicalUniforms(uniforms))
}
