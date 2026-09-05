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
//   maskUrl      a mask PNG to bind as uMaskTex ('' = the full-face rect)
//   canonFile    one canon JSON to fetch instead of <canonUrl>/<pattern>.json
//
// THE MASK PARAMETER EXISTS FOR PULL REQUEST EVIDENCE, and it is deliberately a
// mask over the BLANK BASE rather than over a card scan. AGENTS.md F2 — ship
// nothing we do not own outright — means a rendered card scan may not be
// committed anywhere, and the evidence strip is committed. The blank base is
// also the better picture: it shows how the foil behaves under tilt inside the
// region the human actually drew, with no printed ink competing for attention.
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
const MASK_URL = q.get('maskUrl') ?? ''
const CANON_FILE = q.get('canonFile') ?? ''

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
  // An explicit file wins over the directory: the evidence workflow points this
  // at the canon file the pull request PROPOSES, which is not the one on disk.
  const canonHref = CANON_FILE || (CANON_URL ? `${CANON_URL}/${pattern.id}.json` : '')
  if (canonHref) {
    try {
      const res = await fetch(canonHref)
      if (res.ok) canon = await res.json()
      else if (CANON_FILE) throw new Error(`canonFile ${CANON_FILE} -> HTTP ${res.status}`)
    } catch (err) {
      // A MISSING DIRECTORY ENTRY IS FINE — code defaults are the right
      // baseline for a recipe nobody has canon'd. A missing EXPLICIT file is
      // not: the caller asked for a specific rendering and would otherwise get
      // a different one, silently, and call it evidence.
      if (CANON_FILE) throw err
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
  // The submitted mask, when there is one. A FAILURE HERE IS FATAL rather than
  // a fallback: rendering the full-face rect instead would produce a picture
  // that looks like evidence and is not, which is the worst available outcome
  // for a file whose entire job is to be believed.
  let maskReady = MASK_URL === ''
  if (MASK_URL) {
    new THREE.TextureLoader().load(
      MASK_URL,
      (tex) => {
        // NoColorSpace for the same reason the base uses it: a ShaderMaterial
        // writes gl_FragColor raw. Only `.a` is read, but a decoded sample
        // would still be the wrong bytes.
        tex.colorSpace = THREE.NoColorSpace
        mat.uniforms.uMaskTex.value = tex
        maskReady = true
      },
      undefined,
      () => {
        window.__parityError = `mask ${MASK_URL} failed to load`
        state.textContent = window.__parityError
      },
    )
  }

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

  /**
   * DIRECT CANVAS CAPTURE, for a caller that cannot use `page.screenshot`.
   *
   * `page.screenshot` asks the BROWSER COMPOSITOR for a frame, and that turned
   * out to be the single least portable thing in this harness: on a GitHub
   * Linux runner it logs "fonts loaded" and then times out, while returning
   * fine on a Windows Chromium build. Three CI runs went into learning that,
   * and none of them were about the pixels.
   *
   * `toDataURL()` on the renderer's own canvas answers from the DRAWING BUFFER
   * instead, so there is no compositor, no font pass, no device-scale
   * negotiation and no viewport in the path at all. It must be called while
   * that buffer is still valid, which is why this is a flag the render loop
   * services rather than a function a caller invokes: `__grabNext()` arms it,
   * and the next frame captures immediately after `renderer.render()`, inside
   * the same task.
   *
   * `tools/parity/run.mjs` still screenshots. It is the moving receipt and its
   * recorded sha256s are compared against other builds, so changing how it
   * captures is a separate decision with its own control pair.
   */
  let grabArmed = false
  window.__capture = null
  window.__grabNext = () => {
    window.__capture = null
    grabArmed = true
  }

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
    u.uMaskTexOn.value = MASK_URL && mat.uniforms.uMaskTex.value ? 1 : 0
    u.uScanBase.value = 0 // blank base — the classic composite, canon truth
    renderer.render(scene, camera)
    if (grabArmed) {
      // Same task as the draw. A tick later the buffer is gone —
      // `preserveDrawingBuffer` is deliberately NOT set, because turning it on
      // would change the renderer's configuration for every consumer of this
      // page including the moving receipt.
      grabArmed = false
      window.__capture = renderer.domElement.toDataURL('image/png')
    }
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
  window.__ready = () => faceReady && maskReady
  window.__frames = () => frames
  say({
    ready: true,
    pattern: pattern.id,
    tone: TONE,
    canon: canon ? canon.savedAt : null,
    canonUniforms: canon ? Object.keys(canon.uniforms).length : 0,
    mask: MASK_URL || null,
    tilt: { x: TILT.x, y: TILT.y },
    cardAspect: CARD_ASPECT,
    host: { w, h },
    cardRect: window.__cardRect,
  })
}

main().catch((e) => {
  window.__parityError = String(e && e.stack ? e.stack : e)
  state.textContent = window.__parityError
})
