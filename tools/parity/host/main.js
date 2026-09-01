// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The pattern room — one recipe, on a blank card base, deterministically.
//
// This is the minimal host page the frame-stepped zero-delta harness drives.
// It reproduces exactly the render DeckPal's canon lab produced, and nothing
// else: no sliders, no reference clip, no fetch to an API. Everything the
// render depends on is a URL parameter, which is the whole point — the SAME
// page can be pointed at foilkit's packages or at any other build of the same
// modules, so a pixel difference is a difference in the CODE and not in the
// page around it.
//
// Parameters (all optional):
//   pattern      recipe id                              (default cosmos)
//   tone         black | dark | silver | white          (default dark)
//   tiltx tilty  the parked tilt target, -1..1          (default 0.35 / -0.2)
//   maxTilt      max card rotation in degrees at |1|    (default 16)
//   shaderUrl    module exporting CARD_ASPECT + GLOBAL_DEFAULTS
//   materialUrl  module exporting buildFoilMaterial
//   patternsUrl  module exporting PATTERNS + patternById
//   canonUrl     directory serving <patternId>.json canon snapshots ('' = none)
//
// WHY IT LOOKS LIKE THIS. Every deviation from the canon lab's viewer is a
// pixel difference, so there are none: same PerspectiveCamera(32) and the same
// 1.16-margin fit, the same PlaneGeometry(1, CARD_ASPECT, 12, 16), the same
// renderer flags, the same 0.12-per-frame tilt easing, the same 8x8 flat tone
// base through TextureLoader, the same full-face mask (rect [0,0,1,1] at the
// card's own corner radius, feather 0.008) and uScanBase 0 — the blank-base
// path, where the classic composite runs unchanged and renders are bit-
// identical run to run.
//
// The harness stubs requestAnimationFrame and freezes performance.now BEFORE
// this module executes, so the loop below is stepped rather than animated.

import * as THREE from 'three'

const q = new URLSearchParams(location.search)
const PATTERN = q.get('pattern') ?? 'cosmos'
const TONE = q.get('tone') ?? 'dark'
const TILT = { x: Number(q.get('tiltx') ?? '0.35'), y: Number(q.get('tilty') ?? '-0.2') }
const MAX_TILT_DEG = Number(q.get('maxTilt') ?? '16')

const SHADER_URL = q.get('shaderUrl') ?? '/packages/core/dist/shader.js'
const MATERIAL_URL = q.get('materialUrl') ?? '/packages/three/dist/material.js'
const PATTERNS_URL = q.get('patternsUrl') ?? '/packages/patterns/dist/patterns.js'
const CANON_URL = q.get('canonUrl') ?? '/data/foil-canon'

// The canon lab's four blank bases. Foil is screen-blended, so a dark base
// shows the pattern purely; the white base previews how foil dies over light
// ink. NOTE uArtGate gates on face luminance — on white, an art-gated pattern
// goes dark by design.
const TONES = { black: '#000000', dark: '#171921', silver: '#8a8f99', white: '#f2f2f2' }

const state = document.getElementById('state')
const say = (o) => {
  window.__parity = { ...(window.__parity ?? {}), ...o }
  state.textContent = JSON.stringify(window.__parity, null, 1)
}

function toneUrl(tone) {
  const c = document.createElement('canvas')
  c.width = c.height = 8
  const ctx = c.getContext('2d')
  ctx.fillStyle = TONES[tone] ?? TONES.dark
  ctx.fillRect(0, 0, 8, 8)
  return c.toDataURL('image/png')
}

/**
 * Layer 1 + layer 2 of the canon model: the recipe's code seed, overlaid with
 * its canon snapshot when one exists. Deliberately inlined rather than
 * imported, so the page needs only THREE modules from the build under test and
 * the arithmetic is provably the same on both sides of a comparison.
 */
function canonBaseline(pattern, globalDefaults, canon) {
  const u = { ...globalDefaults }
  for (const [k, v] of Object.entries(pattern.defaults)) u[k] = v
  for (const p of pattern.params) u[p.key] = p.default
  if (canon) for (const [k, v] of Object.entries(canon.uniforms)) u[k] = v
  return u
}

async function main() {
  const [shaderMod, materialMod, patternsMod] = await Promise.all([
    import(/* @vite-ignore */ SHADER_URL),
    import(/* @vite-ignore */ MATERIAL_URL),
    import(/* @vite-ignore */ PATTERNS_URL),
  ])
  const { CARD_ASPECT, GLOBAL_DEFAULTS } = shaderMod
  const { buildFoilMaterial } = materialMod
  const { PATTERNS, patternById } = patternsMod

  const pattern = patternById(PATTERN)

  let canon = null
  if (CANON_URL) {
    try {
      const res = await fetch(`${CANON_URL}/${pattern.id}.json`)
      if (res.ok) canon = await res.json()
    } catch {
      /* no canon file for this recipe — code defaults ARE the right baseline */
    }
  }
  const uniforms = canonBaseline(pattern, GLOBAL_DEFAULTS, canon)

  const host = document.getElementById('host')
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  host.appendChild(renderer.domElement)
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  renderer.domElement.style.display = 'block'

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 20)
  const geo = new THREE.PlaneGeometry(1, CARD_ASPECT, 12, 16)
  const mesh = new THREE.Mesh(geo)
  scene.add(mesh)

  const w = host.clientWidth
  const h = host.clientHeight
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  const fovY = (camera.fov * Math.PI) / 180
  const distH = (CARD_ASPECT / 2 / Math.tan(fovY / 2)) * 1.16
  const fovX = 2 * Math.atan(Math.tan(fovY / 2) * camera.aspect)
  const distW = (0.5 / Math.tan(fovX / 2)) * 1.16
  camera.position.z = Math.max(distH, distW)
  camera.updateProjectionMatrix()

  const mat = buildFoilMaterial(pattern)
  mesh.material = mat

  // The blank base, through the same TextureLoader path the viewer uses — a
  // data: URL is an <img> decode, a TASK and not an animation frame, so it
  // lands on its own while rAF is stubbed.
  let faceReady = false
  new THREE.TextureLoader().load(toneUrl(TONE), (tex) => {
    // NOT SRGBColorSpace: a ShaderMaterial writes gl_FragColor raw, so an
    // sRGB-decoded sample would render the scan in linear values displayed as
    // sRGB. The whole composite is authored in DISPLAY space.
    tex.colorSpace = THREE.NoColorSpace
    tex.anisotropy = 4
    mat.uniforms.uFace.value = tex
    faceReady = true
  })

  // The canon room's mask: full face, era-agnostic. maskForScope('full', …)
  // returns exactly this for every era, which is why the resolver is not in
  // this page's dependency set.
  const CORNER = 3 / 63 // era-layouts.cornerRadius, derived
  const tilt = { x: 0, y: 0 }
  const start = performance.now()
  let frames = 0

  const loop = () => {
    requestAnimationFrame(loop)
    tilt.x += (TILT.x - tilt.x) * 0.12
    tilt.y += (TILT.y - tilt.y) * 0.12
    const maxRad = (MAX_TILT_DEG * Math.PI) / 180
    mesh.rotation.y = tilt.x * maxRad
    mesh.rotation.x = -tilt.y * maxRad
    const u = mat.uniforms
    u.uTilt.value.set(tilt.x, tilt.y)
    u.uTime.value = (performance.now() - start) / 1000
    for (const [k, v] of Object.entries(uniforms)) if (u[k]) u[k].value = v
    u.uMaskRect.value.set(0, 0, 1, 1)
    u.uMaskRadius.value = CORNER
    u.uMaskFeather.value = 0.008
    u.uMaskInvert.value = 0
    u.uMaskView.value = 0
    u.uMaskTexOn.value = 0
    u.uScanBase.value = 0 // blank base — the classic composite, canon truth
    renderer.render(scene, camera)
    frames++
  }
  loop()

  // The card's on-screen rect: the exact inverse of the fit() projection above.
  const cardH = Math.min(h, w * CARD_ASPECT) / 1.16
  const cardW = cardH / CARD_ASPECT
  window.__cardRect = {
    x: (w - cardW) / 2,
    y: (h - cardH) / 2,
    width: cardW,
    height: cardH,
  }
  window.__ready = () => faceReady
  window.__frames = () => frames
  say({
    ready: true,
    pattern: pattern.id,
    tone: TONE,
    canon: canon ? canon.savedAt : null,
    canonUniforms: canon ? Object.keys(canon.uniforms).length : 0,
    cardAspect: CARD_ASPECT,
    host: { w, h },
    cardRect: window.__cardRect,
  })
}

main().catch((e) => {
  window.__parityError = String(e && e.stack ? e.stack : e)
  state.textContent = window.__parityError
})
