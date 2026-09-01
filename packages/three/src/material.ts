// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// @foilkit/three — the three.js binding.
//
// This is the ~60 lines of DeckPal's 752-line `foil/shader.ts` that actually
// touched THREE: the two 1×1 DataTexture fallbacks and `buildFoilMaterial`.
// Everything else — the GLSL, the uniform contract, the composite law — stayed
// in @foilkit/core, which imports nothing.
//
// Note `vertexShaderThree`: three injects `projectionMatrix`,
// `modelViewMatrix`, `position` and `uv` into every ShaderMaterial for free, so
// the shader handed to three MUST NOT declare them. Core's default
// `vertexShader` does declare them, for renderers that inject nothing. Picking
// the wrong one is a GLSL redeclaration error, which is why they are two named
// exports rather than one flag.

import * as THREE from 'three'
import { buildFoilShader, GLOBAL_DEFAULTS, type FoilPattern } from '@foilkit/core'

// 1×1 opaque white fallback so uMaskTex is always a valid sampler.
let white: THREE.DataTexture | null = null
function whiteTexture(): THREE.DataTexture {
  if (!white) {
    white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
    white.needsUpdate = true
  }
  return white
}

// 1×1 transparent fallback so uGlyphTex is always a valid sampler (uGlyphOn=0).
let transparent: THREE.DataTexture | null = null
export function transparentTexture(): THREE.DataTexture {
  if (!transparent) {
    transparent = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1)
    transparent.needsUpdate = true
  }
  return transparent
}

export function buildFoilMaterial(pattern: FoilPattern): THREE.ShaderMaterial {
  const src = buildFoilShader(pattern)
  const uniforms: Record<string, THREE.IUniform> = {
    uFace: { value: null },
    uTilt: { value: new THREE.Vector2(0, 0) },
    uTime: { value: 0 },
    uIntensity: { value: GLOBAL_DEFAULTS.uIntensity },
    uScale: { value: GLOBAL_DEFAULTS.uScale },
    uHueShift: { value: GLOBAL_DEFAULTS.uHueShift },
    uHueSpread: { value: GLOBAL_DEFAULTS.uHueSpread },
    uSat: { value: GLOBAL_DEFAULTS.uSat },
    uArtGate: { value: GLOBAL_DEFAULTS.uArtGate },
    uSpecular: { value: GLOBAL_DEFAULTS.uSpecular },
    uDarken: { value: GLOBAL_DEFAULTS.uDarken },
    uTint: { value: GLOBAL_DEFAULTS.uTint },
    uInkGuard: { value: GLOBAL_DEFAULTS.uInkGuard },
    uInkPop: { value: GLOBAL_DEFAULTS.uInkPop },
    uMetal: { value: GLOBAL_DEFAULTS.uMetal },
    uSheen: { value: GLOBAL_DEFAULTS.uSheen },
    uSheenTint: { value: GLOBAL_DEFAULTS.uSheenTint },
    uDepth: { value: GLOBAL_DEFAULTS.uDepth },
    uGrain: { value: GLOBAL_DEFAULTS.uGrain },
    uScanBase: { value: 1 }, // surface-owned: a blank-base canon render sets 0

    uMaskRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uMaskRadius: { value: 0.01 },
    uMaskFeather: { value: 0.008 },
    uMaskInvert: { value: 0 },
    uMaskView: { value: 0 },
    uMaskTex: { value: whiteTexture() },
    uMaskTexOn: { value: 0 },
    uGlyphTex: { value: transparentTexture() },
    uGlyphOn: { value: 0 },
    uGlyphCount: { value: 0 },
    uGlyphCols: { value: 1 },
    uP0: { value: 0 },
    uP1: { value: 0 },
    uP2: { value: 0 },
    uP3: { value: 0 },
    uP4: { value: 0 },
    uP5: { value: 0 },
  }
  for (const [k, v] of Object.entries(pattern.defaults)) uniforms[k]!.value = v
  for (const p of pattern.params) uniforms[p.key]!.value = p.default

  return new THREE.ShaderMaterial({
    vertexShader: src.vertexShaderThree,
    fragmentShader: src.fragmentShader,
    uniforms,
    transparent: true,
  })
}
