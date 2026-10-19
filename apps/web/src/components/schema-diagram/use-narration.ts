import { useEffect, useRef, useState } from 'react'
import { localVoice, sentences } from './narration.ts'

const synthesis = () => (typeof speechSynthesis === 'undefined' ? null : speechSynthesis)

/**
 * Whether a tour is read aloud, and the voice it is read in: one the device speaks itself (`localVoice`), looked
 * for again when the browser has its voices (Chrome lists them late). Off until asked for.
 */
export function useVoice(lang: string) {
  const [asked, setAsked] = useState(false)
  const [voice, setVoice] = useState<SpeechSynthesisVoice | null>(null)
  useEffect(() => {
    const synth = synthesis()
    if (!synth) return
    // The same voice listed again is kept: a new object for it would read the scene again from the start.
    const read = () =>
      setVoice((was) => {
        const now = localVoice(synth.getVoices(), lang) ?? null
        return was && now && was.name === now.name && was.lang === now.lang ? was : now
      })
    read()
    synth.addEventListener('voiceschanged', read)
    return () => synth.removeEventListener('voiceschanged', read)
  }, [lang])
  return {
    asked,
    toggle: () => setAsked((a) => !a),
    /** The voice it is read in now: none when not asked for, or when the device has none. */
    voice: asked ? voice : null,
  }
}

/**
 * Reads `text` in `voice` a sentence at a time, from the start each time it (or `again`) changes, and calls `onEnd`
 * once it has all been read. Stops reading when the text changes, the voice is let go, or the reader leaves. `again`
 * reads the same words once more: playing from a scene already read waits on it. A voice that fails ends the words
 * after `fallbackMs` instead, as if they had been read: a tour does not rush through on a voice that fails at once.
 */
export function useSpeech(
  voice: SpeechSynthesisVoice | null,
  text: string,
  onEnd: () => void,
  { again = 0, fallbackMs }: { again?: number; fallbackMs: number }
) {
  const ended = useRef(onEnd)
  ended.current = onEnd
  // biome-ignore lint/correctness/useExhaustiveDependencies: `again` is only a reason to read once more.
  useEffect(() => {
    const synth = synthesis()
    if (!voice || !synth) return
    let stopped = false
    let fallback: ReturnType<typeof setTimeout> | undefined
    const parts = sentences(text)
    const say = (i: number) => {
      if (stopped) return
      if (i >= parts.length) {
        ended.current()
        return
      }
      const u = new SpeechSynthesisUtterance(parts[i])
      u.voice = voice
      u.lang = voice.lang
      u.onend = () => say(i + 1)
      // Cancelled is what stopping looks like; anything else is a voice that failed, and the tour goes on without it.
      u.onerror = (e) => {
        if (e.error !== 'canceled' && e.error !== 'interrupted' && !stopped)
          fallback = setTimeout(() => ended.current(), fallbackMs)
      }
      synth.speak(u)
    }
    synth.cancel()
    say(0)
    return () => {
      stopped = true
      clearTimeout(fallback)
      synth.cancel()
    }
  }, [voice, text, again, fallbackMs])
}
