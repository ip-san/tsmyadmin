import { useEffect, useRef, useState } from 'react'
import { between, easeInOut, type Rect } from './camera.ts'

/** How long the camera takes to move from one frame to the next. */
const MOVE_MS = 900

const reducedMotion = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * The frame shown, moving to `target` whenever it changes: eased over `ms`, one animation frame at a time, from
 * wherever the camera was (a move cut short starts the next from where it stopped). A reader who has asked for less
 * motion is shown the new frame at once.
 */
export function useCamera(target: Rect, ms = MOVE_MS): Rect {
  const [shown, setShown] = useState(target)
  const current = useRef(target)
  current.current = shown
  const { x, y, width, height } = target
  useEffect(() => {
    const to = { x, y, width, height }
    const from = current.current
    if (reducedMotion() || typeof requestAnimationFrame !== 'function') {
      setShown(to)
      return
    }
    let frame = 0
    let start: number | undefined
    const step = (now: number) => {
      start ??= now
      const k = Math.min((now - start) / ms, 1)
      setShown(between(from, to, easeInOut(k)))
      if (k < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [x, y, width, height, ms])
  return shown
}
