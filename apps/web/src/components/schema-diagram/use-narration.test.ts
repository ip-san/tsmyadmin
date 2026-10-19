import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSpeech, useVoice } from './use-narration.ts'

/** A speech engine that says nothing: each utterance is kept, to be ended or failed by hand. */
class Utterance {
  voice: unknown = null
  lang = ''
  onend: (() => void) | null = null
  onerror: ((e: { error: string }) => void) | null = null
  constructor(readonly text: string) {}
}
let spoken: Utterance[]
let voices: { name: string; lang: string; localService: boolean; default: boolean }[]
const synth = {
  getVoices: () => voices,
  speak: vi.fn((u: Utterance) => spoken.push(u)),
  cancel: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}
const voice = { name: 'own', lang: 'ja-JP', localService: true, default: false } as unknown as SpeechSynthesisVoice

beforeEach(() => {
  spoken = []
  voices = [{ name: 'own', lang: 'ja-JP', localService: true, default: false }]
  synth.speak.mockClear()
  synth.cancel.mockClear()
  vi.stubGlobal('speechSynthesis', synth)
  vi.stubGlobal('SpeechSynthesisUtterance', Utterance)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useSpeech', () => {
  it('reads a sentence at a time, and says it has ended after the last', () => {
    const onEnd = vi.fn()
    renderHook(() => useSpeech(voice, 'ひとつ。ふたつ。', onEnd, { fallbackMs: 6000 }))
    expect(spoken.map((u) => u.text)).toEqual(['ひとつ。'])
    spoken[0]?.onend?.()
    expect(spoken.map((u) => u.text)).toEqual(['ひとつ。', 'ふたつ。'])
    expect(onEnd).not.toHaveBeenCalled()
    spoken[1]?.onend?.()
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it("waits the scene's time on a voice that fails, and not at all on one that was stopped", () => {
    vi.useFakeTimers()
    const onEnd = vi.fn()
    renderHook(() => useSpeech(voice, 'ひとつ。', onEnd, { fallbackMs: 6000 }))
    spoken[0]?.onerror?.({ error: 'interrupted' })
    vi.advanceTimersByTime(10000)
    expect(onEnd).not.toHaveBeenCalled()
    spoken[0]?.onerror?.({ error: 'synthesis-failed' })
    vi.advanceTimersByTime(5999)
    expect(onEnd).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('stops reading when the voice is let go, and an end heard after that moves nothing', () => {
    vi.useFakeTimers()
    const onEnd = vi.fn()
    const { rerender } = renderHook(({ v }) => useSpeech(v, 'ひとつ。', onEnd, { fallbackMs: 6000 }), {
      initialProps: { v: voice as SpeechSynthesisVoice | null },
    })
    const first = spoken[0]
    synth.cancel.mockClear()
    rerender({ v: null })
    expect(synth.cancel).toHaveBeenCalled()
    first?.onend?.()
    first?.onerror?.({ error: 'synthesis-failed' })
    vi.advanceTimersByTime(10000)
    expect(onEnd).not.toHaveBeenCalled()
  })
})

describe('useVoice', () => {
  it('keeps the same voice when the browser lists its voices again', () => {
    const { result, rerender } = renderHook(() => useVoice('ja'))
    result.current.toggle()
    rerender()
    const was = result.current.voice
    expect(was).not.toBeNull()
    voices = [{ ...voices[0], name: 'own' } as (typeof voices)[number]]
    const listed = synth.addEventListener.mock.calls.find((c) => c[0] === 'voiceschanged')?.[1] as () => void
    listed()
    rerender()
    expect(result.current.voice).toBe(was)
  })
})
