// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen

import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { PATTERNS } from '../packages/patterns/src/index.ts'
import { MAIN, PREAMBLE, VIEW_DIRECTION_PRELUDE, buildFoilShader } from '../packages/core/src/index.ts'

const outIndex = process.argv.indexOf('--out')
const baselineIndex = process.argv.indexOf('--baseline')
const out = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
const baselinePath = baselineIndex >= 0 ? process.argv[baselineIndex + 1] : undefined
if (!out || !isAbsolute(out) || !baselinePath || !isAbsolute(baselinePath)) {
  throw new Error('usage: verify-tangent-view.mts --baseline ABS_FILE --out ABS_DIR')
}
await mkdir(out, { recursive: true })

const pwRoot = process.env.PW_ROOT
if (!pwRoot) throw new Error('PW_ROOT must name a package.json with Playwright available')
const require = createRequire(pwRoot)

type RecipePayload = {
  id: string
  legacy: string
  opted: string
  uniforms: Record<string, number>
  legacyIdentity: boolean
}

type EvaluateResult<T> = T | Promise<T>

interface Page {
  goto(url: string): Promise<unknown>
  addScriptTag(options: { content: string }): Promise<unknown>
  evaluate<Result>(pageFunction: () => EvaluateResult<Result>): Promise<Awaited<Result>>
  evaluate<Arg, Result>(pageFunction: (arg: Arg) => EvaluateResult<Result>, arg: Arg): Promise<Awaited<Result>>
  screenshot(options: { path: string }): Promise<unknown>
  setViewportSize(viewport: { width: number; height: number }): Promise<void>
}

interface Browser {
  newPage(options: { viewport: { width: number; height: number } }): Promise<Page>
  close(): Promise<void>
}

interface Chromium {
  launch(options: { headless: boolean }): Promise<Browser>
}

const { chromium } = require('playwright') as { chromium: Chromium }

const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as Record<string, unknown>
const payload: RecipePayload[] = PATTERNS.map((pattern) => {
  const legacy = buildFoilShader(pattern)
  const opted = buildFoilShader(pattern, { viewDirection: true })
  const expected = baseline[pattern.id]
  return {
    id: pattern.id,
    legacy: legacy.fragmentShader,
    opted: opted.fragmentShader,
    uniforms: legacy.uniforms,
    legacyIdentity:
      legacy.fragmentShader === PREAMBLE + pattern.glsl + MAIN &&
      JSON.stringify(legacy) === JSON.stringify(expected),
  }
})
assert.equal(Object.keys(baseline).length, 45, 'immutable baseline must contain 45 recipes')
assert.equal(payload.length, 45, 'current pattern set must contain 45 recipes')
assert.equal(payload.filter((entry) => entry.legacyIdentity).length, 45, 'all default shader values must match baseline')

const stageEntry = `
import * as THREE from 'three'
import { FoilStage } from './packages/three/src/stage.ts'
import { PATTERNS } from './packages/patterns/src/index.ts'

window.runFoilStageProof = () => {
  window.IntersectionObserver = undefined
  window.ResizeObserver = undefined
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: true })
  const captures = []
  const originalRender = renderer.render.bind(renderer)
  renderer.render = (scene, camera) => {
    const mesh = scene.children.find((child) => child.isMesh)
    const material = mesh.material
    captures.push({
      materialId: material.uuid,
      hasViewDirection: Boolean(material.uniforms.uViewDirection),
      uViewDirection: material.uniforms.uViewDirection?.value.toArray() ?? null,
      uTilt: material.uniforms.uTilt.value.toArray(),
    })
    originalRender(scene, camera)
  }

  const tilt = [{ x: 0.25, y: -0.15 }, { x: -0.2, y: 0.1 }]
  const source = { id: 'proof-source', tiltFor: ({ index }) => ({ ...tilt[index] }) }
  const stage = new FoilStage({ renderer, container: document.body, tiltSource: source, autoStart: false, maxPixelRatio: 1 })
  document.body.prepend(renderer.domElement)
  renderer.domElement.id = 'stage-canvas'
  renderer.domElement.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:0'
  const pattern = PATTERNS.find((item) => item.id === 'rainbow-mirror') ?? PATTERNS[0]
  let opted = true
  const settings = (viewDirection) => ({
    uniforms: {}, maskRect: [0, 0, 1, 1], maskRadius: 0.01, maskFeather: 0.008,
    maskInvert: false, maskView: false, maskTexOn: false, maskTexVersion: 0,
    maxTiltDeg: 22, scanBase: false, viewDirection,
  })
  const cards = [...document.querySelectorAll('.proof-card')]
  stage.register(cards[0], { pattern, settings: () => settings(opted) })
  stage.register(cards[1], { pattern, settings: () => settings(false) })

  stage.frame(100)
  const first = captures.splice(0)
  opted = false
  stage.frame(200)
  const toggled = captures.splice(0)
  opted = true
  tilt[0] = { x: -0.7, y: 0.45 }
  stage.frame(300)
  const moved = captures.splice(0)
  stage.frame(400)
  const stable = captures.splice(0)

  const vecChanged = first[0].uViewDirection.some((value, i) => Math.abs(value - moved[0].uViewDirection[i]) > 1e-6)
  const tiltChanged = first[0].uTilt.some((value, i) => Math.abs(value - moved[0].uTilt[i]) > 1e-6)
  window.stepFoilStageProof = (time) => stage.frame(time)
  const result = {
    actualFoilStage: stage instanceof FoilStage,
    mixedSamePatternCards: first.length,
    sharedMaterialIsolation:
      first.length === 2 && toggled.length === 2 && moved.length === 2 && stable.length === 2 &&
      first[0].materialId !== first[1].materialId &&
      first[0].materialId === moved[0].materialId && moved[0].materialId === stable[0].materialId &&
      first[1].materialId === toggled[1].materialId && toggled[1].materialId === moved[1].materialId,
    stageOptOutRestored:
      toggled[0].materialId === toggled[1].materialId &&
      !toggled[0].hasViewDirection && !toggled[1].hasViewDirection &&
      toggled[0].uTilt.some((value, i) => Math.abs(value - toggled[1].uTilt[i]) > 1e-6),
    stageOptInVectorUpdates: vecChanged && tiltChanged,
    materialIDs: {
      optedInitial: first[0].materialId, legacyInitial: first[1].materialId,
      toggledCard: toggled[0].materialId, optedRestored: moved[0].materialId,
    },
    stageFrames: { first, toggled, moved, stable },
    stageStats: stage.stats(),
  }
  window.foilStageProof = result
  return result
}
`
const bundle = await build({
  stdin: { contents: stageEntry, resolveDir: process.cwd(), sourcefile: 'tangent-stage-proof.ts', loader: 'ts' },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
})
const stageScript = bundle.outputFiles[0]!.text

const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#141722;color:#fff;font:14px system-ui}
main{position:relative;z-index:1;height:100%;display:flex;gap:32px;align-items:center;justify-content:center;pointer-events:none}
.proof-card{width:min(36vw,300px);aspect-ratio:63/88;border-radius:16px;box-shadow:0 20px 60px #000a;position:relative}
.label{position:absolute;left:10px;bottom:8px;padding:5px 8px;background:#000b;border-radius:5px}
</style><main><div class="proof-card"><div class="label">tangent view: opt-in</div></div><div class="proof-card"><div class="label">same pattern: legacy</div></div></main>`
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(html)
})
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const address = server.address()
if (!address || typeof address === 'string') throw new Error('loopback server did not bind')

let browser: Browser | undefined
try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  await page.goto(`http://127.0.0.1:${address.port}/`)
  await page.addScriptTag({ content: stageScript })
  const stage = await page.evaluate(() => (window as any).runFoilStageProof())

  const diagnosticFragment = `precision highp float;
${VIEW_DIRECTION_PRELUDE}
void main(){ vec2 mapped=uTilt; gl_FragColor=vec4(mapped*0.25+0.5,0.75,1.0); }`
  const measurements = await page.evaluate((input) => {
    const recipes = input.recipes
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true })!
    if (!gl) throw new Error('WebGL unavailable')
    const vertex = `precision highp float; attribute vec2 position; varying vec2 vUv; void main(){vUv=position*.5+.5;gl_Position=vec4(position,0.,1.);}`
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!
      gl.shaderSource(shader, source); gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader compile failed')
      return shader
    }
    const program = (fragment: string) => {
      const p = gl.createProgram()!
      gl.attachShader(p, compile(gl.VERTEX_SHADER, vertex))
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragment))
      gl.linkProgram(p)
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'program link failed')
      return p
    }
    const programs = recipes.map((r) => ({ id: r.id, legacy: program(r.legacy), opted: program(r.opted), uniforms: r.uniforms }))
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW)
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([55,72,96,255]))
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST)
    const draw = (p: WebGLProgram, uniforms: Record<string, number>, view: number[] | null, tilt=[0,0]) => {
      gl.useProgram(p)
      const position=gl.getAttribLocation(p,'position')
      gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0)
      for (const [name,value] of Object.entries(uniforms)) { const loc=gl.getUniformLocation(p,name); if(loc!==null) gl.uniform1f(loc,value) }
      const seed: Record<string, number[]> = {uTilt:tilt,uMaskRect:[0,0,1,1],uInkTile:[11,0,0,0]}
      for (const [name,value] of Object.entries(seed)) { const loc=gl.getUniformLocation(p,name); if(loc===null) continue; value.length===2?gl.uniform2fv(loc,value):gl.uniform4fv(loc,value) }
      if(view){const loc=gl.getUniformLocation(p,'uViewDirection');if(loc!==null)gl.uniform3fv(loc,view)}
      gl.viewport(0,0,canvas.width,canvas.height); gl.drawArrays(gl.TRIANGLE_STRIP,0,4)
      const pixels=new Uint8Array(canvas.width*canvas.height*4)
      gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels)
      return pixels
    }
    const meanDiff=(a:Uint8Array,b:Uint8Array)=>{let sum=0;for(let i=0;i<a.length;i+=4)sum+=Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]);return sum/(a.length/4*3)}
    const chosen=programs.find((p)=>p.id==='rainbow-mirror') ?? programs[0]!
    const legacy=draw(chosen.legacy,chosen.uniforms,null,[0,0])
    const opted=draw(chosen.opted,chosen.uniforms,[0.55,-0.28,1])
    const normal=draw(chosen.opted,chosen.uniforms,[0,0,1])
    const optInMeanByteDiff=meanDiff(legacy,opted)
    const normalIncidenceEquivalent=meanDiff(legacy,normal)===0

    const diagnostic=program(input.diagnosticFragment)
    const probes = [
      { name:'normal', vector:[0,0,1], expected:[128,128,191,255] },
      { name:'grazing', vector:[1,-1,0], expected:[191,64,191,255] },
      { name:'zero', vector:[0,0,0], expected:[128,128,191,255] },
      { name:'backfacing', vector:[0.25,-0.5,-1], expected:[143,96,191,255] },
    ].map((probe) => {
      const pixels=draw(diagnostic,{},probe.vector)
      const actual=[pixels[0],pixels[1],pixels[2],pixels[3]]
      const matches=actual.every((value,i)=>Math.abs(value-probe.expected[i])<=2)
      const nonclear=actual.some((value,i)=>i<3 && value!==0)
      return {...probe,actual,matches,nonclear}
    })
    return {
      compiledLegacy: programs.length,
      compiledOpted: programs.length,
      optInMeanByteDiff,
      optInDiffers: optInMeanByteDiff>0,
      normalIncidenceEquivalent,
      grazingMappingVerified: probes.every((probe)=>probe.matches&&probe.nonclear) && gl.getError()===gl.NO_ERROR,
      mappingProbes: probes,
    }
  }, { recipes: payload, diagnosticFragment })

  const proof = {
    legacyRecipesUnchanged: payload.filter((entry) => entry.legacyIdentity).length,
    optInCompiledRecipes: measurements.compiledOpted,
    desktopWidth: 1280,
    mobileWidth: 390,
    ...measurements,
    ...stage,
  }
  assert.equal(proof.legacyRecipesUnchanged, 45)
  assert.equal(proof.optInCompiledRecipes, 45)
  assert.equal(proof.compiledLegacy, 45)
  assert.ok(proof.optInDiffers)
  assert.ok(proof.grazingMappingVerified)
  assert.ok(proof.normalIncidenceEquivalent)
  assert.ok(proof.actualFoilStage)
  assert.ok(proof.mixedSamePatternCards >= 2)
  assert.ok(proof.sharedMaterialIsolation)
  assert.ok(proof.stageOptOutRestored)
  assert.ok(proof.stageOptInVectorUpdates)

  await page.screenshot({ path: join(out, 'desktop.png') })
  await page.setViewportSize({ width: 390, height: 720 })
  await page.evaluate(() => (window as any).stepFoilStageProof(500))
  await page.screenshot({ path: join(out, 'mobile.png') })
  await writeFile(join(out, 'proof.json'), JSON.stringify(proof, null, 2) + '\n')
  console.log(JSON.stringify(proof))
} finally {
  await browser?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
