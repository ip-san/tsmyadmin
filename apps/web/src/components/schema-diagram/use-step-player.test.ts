import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useStepPlayer } from './use-step-player.ts'

function reduceMotion(on: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: on && query.includes('reduce'), media: query }))
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useStepPlayer', () => {
  it('plays from the first step and stops at the last', () => {
    vi.useFakeTimers()
    reduceMotion(false)
    const { result } = renderHook(() => useStepPlayer(3, 100))
    expect(result.current).toMatchObject({ index: 0, playing: true })
    act(() => vi.advanceTimersByTime(100))
    expect(result.current.index).toBe(1)
    act(() => vi.advanceTimersByTime(100))
    act(() => vi.advanceTimersByTime(100))
    expect(result.current).toMatchObject({ index: 2, playing: false })
  })

  it('shows the whole picture and waits, for a reader who asked for less motion', () => {
    vi.useFakeTimers()
    reduceMotion(true)
    const { result } = renderHook(() => useStepPlayer(3, 100))
    expect(result.current).toMatchObject({ index: 2, playing: false })
    act(() => vi.advanceTimersByTime(1000))
    expect(result.current.index).toBe(2)
  })

  it('stops playing when moved by hand, and stays within the steps', () => {
    reduceMotion(false)
    const { result } = renderHook(() => useStepPlayer(3))
    act(() => result.current.next())
    expect(result.current).toMatchObject({ index: 1, playing: false })
    act(() => result.current.last())
    act(() => result.current.next())
    expect(result.current.index).toBe(2)
    act(() => result.current.first())
    act(() => result.current.prev())
    expect(result.current.index).toBe(0)
  })

  it('plays again from the start once at the end', () => {
    reduceMotion(true)
    const { result } = renderHook(() => useStepPlayer(3))
    act(() => result.current.play())
    expect(result.current).toMatchObject({ index: 0, playing: true })
  })

  it('starts over when the steps change', () => {
    reduceMotion(true)
    const { result, rerender } = renderHook(({ n }) => useStepPlayer(n), { initialProps: { n: 2 } })
    expect(result.current.index).toBe(1)
    rerender({ n: 5 })
    expect(result.current.index).toBe(4)
  })

  it('waits at the first step of a story told from its beginning, for a reader who asked for less motion', () => {
    vi.useFakeTimers()
    reduceMotion(true)
    const { result, rerender } = renderHook(({ n }) => useStepPlayer(n, 100, { still: 'first' }), {
      initialProps: { n: 3 },
    })
    expect(result.current).toMatchObject({ index: 0, playing: false })
    act(() => vi.advanceTimersByTime(1000))
    expect(result.current.index).toBe(0)
    rerender({ n: 4 })
    expect(result.current).toMatchObject({ index: 0, playing: false })
  })

  it('has nothing to play with a single step', () => {
    reduceMotion(false)
    const { result } = renderHook(() => useStepPlayer(1))
    expect(result.current).toMatchObject({ index: 0, playing: false })
  })
})
