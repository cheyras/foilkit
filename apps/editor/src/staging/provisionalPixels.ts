// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The one part of the provisional diff that needs a browser.
//
// `provisionalDiff.ts` is pure arithmetic and is byte-tested against forge's
// originals; it takes an alpha plane. A STAGED session holds a PNG data URL,
// and turning one into an alpha plane needs an image decode and a canvas — so
// that step lives here, alone, rather than infecting the tested module with a
// DOM dependency it does not otherwise have.
//
// EVERY FAILURE RETURNS NULL. These numbers are a courtesy in the pull request
// body — a second opinion printed beside the server's measured ones and
// labelled as such. A submission must never be blocked because a canvas was
// unavailable, an image failed to decode, or the browser tainted the context.
// The pull request simply carries one number instead of two.

import { alphaOfRgba, provisionalReport, type ProvisionalStats } from './provisionalDiff.ts'
import type { MaskSession } from './types.ts'

/** The alpha plane behind a `data:image/png` URL, or null. */
async function alphaOfDataUrl(dataUrl: string, width: number, height: number): Promise<Uint8Array | null> {
  try {
    const img = new Image()
    const loaded = new Promise<boolean>((resolve) => {
      img.onload = () => resolve(true)
      img.onerror = () => resolve(false)
    })
    img.src = dataUrl
    if (!(await loaded)) return null
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (ctx === null) return null
    ctx.drawImage(img, 0, 0, width, height)
    return alphaOfRgba(ctx.getImageData(0, 0, width, height).data, width * height)
  } catch {
    return null
  }
}

/**
 * The provisional agreement for a staged mask, against the ERA RULE.
 *
 * Against the rule rather than against the parent, deliberately: the rule
 * comparison is the one the pull request body prints, and it is the one that
 * answers "is this human improving the rule or fighting it" — which is the
 * question the codify ritual runs on. The parent comparison is the server's to
 * make, from the parent as it is on disk at write time.
 */
export async function provisionalOf(session: MaskSession): Promise<ProvisionalStats | null> {
  if (session.png === null) return null
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null
  const alpha = await alphaOfDataUrl(session.png, session.width, session.height)
  if (alpha === null) return null
  try {
    const prior = session.seed.prior
    return provisionalReport(
      alpha,
      { rect: prior.rect, radius: prior.radius, invert: prior.invert },
      session.width,
      session.height,
      null,
    ).vsRule
  } catch {
    return null
  }
}
