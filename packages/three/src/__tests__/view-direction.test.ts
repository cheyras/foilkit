// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen

import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import type { FoilPattern } from '@foilkit/core'
import { buildFoilMaterial } from '../material.ts'
import { tangentViewDirection } from '../view-direction.ts'

const close = (actual: THREE.Vector3, expected: THREE.Vector3, epsilon = 1e-10) => {
  assert.ok(actual.distanceTo(expected) < epsilon, `${actual.toArray()} != ${expected.toArray()}`)
}

test('normal incidence and signed perspective yaw/pitch use card-local axes', () => {
  const surface = new THREE.Object3D()
  const camera = new THREE.PerspectiveCamera()
  camera.position.set(0, 0, 4)
  close(tangentViewDirection(camera, surface), new THREE.Vector3(0, 0, 1))
  camera.position.set(2, -1, 4)
  close(tangentViewDirection(camera, surface), new THREE.Vector3(2, -1, 4).normalize())
})

test('reflections preserve transformed UV x, UV y, and front-normal signs', () => {
  const camera = new THREE.PerspectiveCamera()
  const cases: Array<[THREE.Vector3, THREE.Vector3, THREE.Vector3]> = [
    [new THREE.Vector3(-2, 3, 1), new THREE.Vector3(1, 0, 1), new THREE.Vector3(-1, 0, 1)],
    [new THREE.Vector3(2, -3, 1), new THREE.Vector3(0, 1, 1), new THREE.Vector3(0, -1, 1)],
    [new THREE.Vector3(2, 3, -1), new THREE.Vector3(1, 0, 1), new THREE.Vector3(1, 0, -1)],
    [new THREE.Vector3(-2, -3, -1), new THREE.Vector3(1, 1, 1), new THREE.Vector3(-1, -1, -1)],
  ]
  for (const [scale, cameraPosition, expected] of cases) {
    const surface = new THREE.Object3D()
    surface.scale.copy(scale)
    camera.position.copy(cameraPosition)
    close(tangentViewDirection(camera, surface), expected.normalize())
  }
})

test('positive nonuniform scale does not skew a direction', () => {
  const surface = new THREE.Object3D()
  surface.position.set(3, -2, 1)
  surface.rotation.y = Math.PI / 2
  surface.scale.set(7, 0.2, 3)
  const camera = new THREE.PerspectiveCamera()
  camera.position.set(7, -2, 1)
  close(tangentViewDirection(camera, surface), new THREE.Vector3(0, 0, 1))
})

test('parent nonuniform scale plus child rotation uses documented Gram-Schmidt frame', () => {
  const parent = new THREE.Object3D()
  parent.scale.set(2, 3, 0.5)
  const surface = new THREE.Object3D()
  surface.rotation.set(0.31, -0.47, 0.23)
  parent.add(surface)
  const camera = new THREE.PerspectiveCamera()
  camera.position.set(3, -2, 5)
  parent.updateWorldMatrix(true, true)

  const ray = camera.position.clone().sub(surface.getWorldPosition(new THREE.Vector3())).normalize()
  const x = new THREE.Vector3().setFromMatrixColumn(surface.matrixWorld, 0)
  const y = new THREE.Vector3().setFromMatrixColumn(surface.matrixWorld, 1)
  const n = new THREE.Vector3(0, 0, 1).applyMatrix3(new THREE.Matrix3().getNormalMatrix(surface.matrixWorld)).normalize()
  x.addScaledVector(n, -x.dot(n)).normalize()
  const b = new THREE.Vector3().crossVectors(n, x).normalize()
  if (b.dot(y) < 0) b.negate()
  close(tangentViewDirection(camera, surface), new THREE.Vector3(ray.dot(x), ray.dot(b), ray.dot(n)).normalize())
})

test('orthographic rays are parallel while perspective rays point to camera', () => {
  const surface = new THREE.Object3D()
  surface.position.set(5, 0, 0)
  const orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1)
  orthographic.position.set(0, 0, 4)
  orthographic.lookAt(0, 0, 0)
  close(tangentViewDirection(orthographic, surface), new THREE.Vector3(0, 0, 1))
  const perspective = new THREE.PerspectiveCamera()
  perspective.position.copy(orthographic.position)
  close(tangentViewDirection(perspective, surface), new THREE.Vector3(-5, 0, 4).normalize())
})

test('coincident, singular, and non-finite transforms fall back to finite front', () => {
  const surface = new THREE.Object3D()
  const camera = new THREE.PerspectiveCamera()
  close(tangentViewDirection(camera, surface), new THREE.Vector3(0, 0, 1))
  camera.position.set(0, 0, 2)
  surface.scale.set(0, 1, 1)
  close(tangentViewDirection(camera, surface), new THREE.Vector3(0, 0, 1))
  surface.scale.set(1, 1, 1)
  camera.position.set(Number.NaN, 0, 1)
  close(tangentViewDirection(camera, surface), new THREE.Vector3(0, 0, 1))
})

const pattern: FoilPattern = {
  id: 'material-view-test', label: 'Material view test', taxonomy: 'test', family: 'field', usedOn: 'test', implemented: true,
  defaults: {}, params: [], glsl: 'vec3 foilPattern(vec2 uv, vec2 tilt) { return vec3(tilt, 0.0); }\n',
}

test('material option is isolated and no-argument API remains legacy', () => {
  const legacy = buildFoilMaterial(pattern)
  const opted = buildFoilMaterial(pattern, { viewDirection: true })
  assert.equal(legacy.uniforms.uViewDirection, undefined)
  assert.ok(opted.uniforms.uViewDirection.value instanceof THREE.Vector3)
  assert.notEqual(legacy.fragmentShader, opted.fragmentShader)
  legacy.dispose(); opted.dispose()
})
