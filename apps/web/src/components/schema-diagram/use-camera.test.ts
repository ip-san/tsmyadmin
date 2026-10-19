import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCamera } from './use-camera.ts'

function reduceMotion(on: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: on && query.includes('reduce'), media: query }))
}

/** Animation frames run by hand: each call to `frame(ms)` runs the callbacks waiting, at that time. */
function frames() {
  let waiting: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => waiting.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => {
    waiting = []
  })
  return (ms: number) => {
    const run = waiting
    waiting = []
    act(() => {
      for (const cb of run) cb(ms)
    })
  }
}

afterEach(() => vi.unstubAllGlobals())

const A = { x: 0, y: 0, width: 100, height: 100 }
const B = { x: 100, y: 100, width: 300, height: 300 }

describe('useCamera', () => {
  it('moves to a new frame over time, eased, and stops there', () => {
    reduceMotion(false)
    const frame = frames()
    const { result, rerender } = renderHook(({ to }) => useCamera(to, 100), { initialProps: { to: A } })
    expect(result.current).toEqual(A)
    rerender({ to: B })
    frame(0)
    expect(result.current).toEqual(A)
    frame(50)
    expect(result.current).toEqual({ x: 50, y: 50, width: 200, height: 200 })
    frame(100)
    expect(result.current).toEqual(B)
  })

  it('starts a move cut short from where the camera stopped', () => {
    reduceMotion(false)
    const frame = frames()
    const { result, rerender } = renderHook(({ to }) => useCamera(to, 100), { initialProps: { to: A } })
    rerender({ to: B })
    frame(0)
    frame(50)
    rerender({ to: A })
    frame(1000)
    frame(1100)
    expect(result.current).toEqual(A)
    rerender({ to: B })
    frame(0)
    frame(50)
    expect(result.current).toEqual({ x: 50, y: 50, width: 200, height: 200 })
  })

  it('shows the new frame at once to a reader who asked for less motion', () => {
    reduceMotion(true)
    frames()
    const { result, rerender } = renderHook(({ to }) => useCamera(to, 100), { initialProps: { to: A } })
    rerender({ to: B })
    expect(result.current).toEqual(B)
  })
})
