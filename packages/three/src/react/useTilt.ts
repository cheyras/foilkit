// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// useTilt — the one-card React hook, now a thin wrapper over the stage's
// tilt sources.
//
// Its public shape is unchanged: the same `mode`, the same `target` ref the
// viewer eases toward, the same `onPointerMove` / `onPointerLeave` handlers to
// spread onto the viewer container, the same `requestGyro` for iOS.
//
// What moved is the MAPPING — pointer position to -1..1, the first-reading
// gyro baseline, the 28°-per-unit scale, the reduced-motion default. That
// arithmetic is now `@foilkit/stage`, where it is per-card by construction and
// unit-tested without a browser. This hook holds one card's worth of it.
//
// Modes:
//   pointer — desktop: pointer position over the viewer maps to tilt.
//   gyro    — phone: deviceorientation, baselined to the first reading so
//             "how you hold it" is neutral. iOS 13+ needs an explicit
//             permission request from a user gesture (requestGyro).
//   manual  — sliders drive tilt; the default when prefers-reduced-motion
//             is set (no motion-driven animation), and always available.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  gyroPermissionState,
  gyroSource,
  pointerSource,
  prefersReducedMotion,
  type TiltPermission,
} from '@foilkit/stage'

export type TiltMode = 'pointer' | 'gyro' | 'manual'
export type GyroPermission = TiltPermission

export function useTilt() {
  const reducedMotion = useMemo(() => prefersReducedMotion(), [])

  const [mode, setMode] = useState<TiltMode>(reducedMotion ? 'manual' : 'pointer')
  const [gyroPermission, setGyroPermission] = useState<GyroPermission>(() => gyroPermissionState())
  const [manual, setManualState] = useState({ x: 0, y: 0 })

  // Mutable target the viewer eases toward — never a React render.
  const target = useRef({ x: 0, y: 0 })

  // No window listeners: this source is driven by the React pointer handlers
  // below, because a workbench viewer wants the pointer's position over ITS
  // box and nothing else on the page.
  const pointer = useMemo(() => pointerSource({ target: null }), [])
  const gyro = useMemo(
    () => gyroSource({ onChange: (t) => (target.current = t) }),
    [],
  )

  const setManual = useCallback((x: number, y: number) => {
    setManualState({ x, y })
    target.current = { x, y }
  }, [])

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (mode !== 'pointer') return
      const r = e.currentTarget.getBoundingClientRect()
      pointer.set!(e.clientX, e.clientY)
      target.current = pointer.tiltFor({
        id: 'viewer',
        index: 0,
        time: 0,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      })
    },
    [mode, pointer],
  )

  const onPointerLeave = useCallback(() => {
    if (mode === 'pointer') target.current = { x: 0, y: 0 }
  }, [mode])

  // Gyro listener — active only in gyro mode with permission. Attaching is
  // what re-baselines, so a phone put down and picked up starts neutral again.
  useEffect(() => {
    if (mode !== 'gyro' || gyroPermission !== 'granted') return
    gyro.attach!()
    return () => gyro.detach!()
  }, [mode, gyroPermission, gyro])

  // iOS motion-permission request — must run inside a user gesture.
  const requestGyro = useCallback(async () => {
    const res = await gyro.requestPermission!()
    setGyroPermission(res)
    if (res === 'granted') setMode('gyro')
  }, [gyro])

  const recenterGyro = useCallback(() => {
    // Detach/attach IS the recentre: the source baselines on its first reading.
    gyro.detach!()
    gyro.attach!()
  }, [gyro])

  return {
    mode,
    setMode,
    reducedMotion,
    gyroPermission,
    requestGyro,
    recenterGyro,
    manual,
    setManual,
    target,
    onPointerMove,
    onPointerLeave,
  }
}
