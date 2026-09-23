// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen

import * as THREE from 'three'

const cameraWorld = new THREE.Vector3()
const surfaceWorld = new THREE.Vector3()
const worldDirection = new THREE.Vector3()
const tangentWorld = new THREE.Vector3()
const bitangentWorld = new THREE.Vector3()
const uvYWorld = new THREE.Vector3()
const normalWorld = new THREE.Vector3()
const normalMatrix = new THREE.Matrix3()

const finiteNonzero = (v: THREE.Vector3): boolean =>
  Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z) && v.lengthSq() >= 1e-20

/**
 * Planar-center surface-to-camera direction in a surface object's tangent space.
 * Local +x/+y follow the transformed card/UV axes and local +z is its transformed
 * front normal, including reflected transforms.
 *
 * Perspective cameras use the center-to-camera ray. Orthographic cameras use the
 * opposite of their parallel world viewing direction. For hierarchy-induced
 * shear, Gram-Schmidt preserves transformed UV x and the inverse-transpose front
 * normal; the orthogonal bitangent is signed to agree with transformed UV y.
 * Degenerate, singular, or non-finite frames/rays use the stable +z fallback.
 */
export function tangentViewDirection(
  camera: THREE.Camera,
  surface: THREE.Object3D,
  out: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 {
  camera.updateWorldMatrix(true, false)
  surface.updateWorldMatrix(true, false)

  if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
    camera.getWorldDirection(worldDirection).multiplyScalar(-1)
  } else {
    camera.getWorldPosition(cameraWorld)
    surface.getWorldPosition(surfaceWorld)
    worldDirection.subVectors(cameraWorld, surfaceWorld)
  }
  if (!finiteNonzero(worldDirection)) return out.set(0, 0, 1)
  worldDirection.normalize()

  tangentWorld.setFromMatrixColumn(surface.matrixWorld, 0)
  uvYWorld.setFromMatrixColumn(surface.matrixWorld, 1)
  normalMatrix.getNormalMatrix(surface.matrixWorld)
  normalWorld.set(0, 0, 1).applyMatrix3(normalMatrix)
  if (!finiteNonzero(tangentWorld) || !finiteNonzero(uvYWorld) || !finiteNonzero(normalWorld)) {
    return out.set(0, 0, 1)
  }

  normalWorld.normalize()
  tangentWorld.addScaledVector(normalWorld, -tangentWorld.dot(normalWorld))
  if (!finiteNonzero(tangentWorld)) return out.set(0, 0, 1)
  tangentWorld.normalize()
  bitangentWorld.crossVectors(normalWorld, tangentWorld)
  if (!finiteNonzero(bitangentWorld)) return out.set(0, 0, 1)
  bitangentWorld.normalize()
  if (bitangentWorld.dot(uvYWorld) < 0) bitangentWorld.multiplyScalar(-1)

  out.set(
    worldDirection.dot(tangentWorld),
    worldDirection.dot(bitangentWorld),
    worldDirection.dot(normalWorld),
  )
  const lengthSq = out.lengthSq()
  if (!Number.isFinite(lengthSq) || lengthSq < 1e-20) return out.set(0, 0, 1)
  out.multiplyScalar(1 / Math.sqrt(lengthSq))
  return finiteNonzero(out) ? out : out.set(0, 0, 1)
}
