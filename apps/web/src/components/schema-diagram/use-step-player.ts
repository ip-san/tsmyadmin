import { useEffect, useState } from 'react'

/** How long a step stays before the next, while playing. */
const STEP_MS = 1400

const reducedMotion = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Walking through the steps of a story: it plays from the first on its own, one step every `STEP_MS`, and stops at
 * the last. A reader who has asked for less motion is shown the last step (the whole picture) and moves by hand.
 * New steps (`count` changes) start the walk again. A story told from its beginning (a tour, `still: 'first'`) waits
 * at its first step instead. While `hold` is set, playing waits on each step for `advance` (a voice that has finished
 * reading it) rather than for the time.
 */
export function useStepPlayer(
  count: number,
  stepMs = STEP_MS,
  { still = 'last', hold = false }: { still?: 'first' | 'last'; hold?: boolean } = {}
) {
  const [state, setState] = useState(() => start(count, still))
  const [seen, setSeen] = useState(count)
  if (seen !== count) {
    setSeen(count)
    setState(start(count, still))
  }
  const { index, playing } = state

  useEffect(() => {
    if (!playing) return
    if (index >= count - 1) {
      setState((s) => ({ ...s, playing: false }))
      return
    }
    if (hold) return
    const timer = setTimeout(() => setState((s) => ({ ...s, index: s.index + 1 })), stepMs)
    return () => clearTimeout(timer)
  }, [playing, index, count, stepMs, hold])

  const go = (to: number) => setState({ index: Math.min(Math.max(to, 0), Math.max(count - 1, 0)), playing: false })
  return {
    index,
    playing,
    // Play from the start again once the end is reached, rather than doing nothing.
    play: () => setState((s) => ({ index: s.index >= count - 1 ? 0 : s.index, playing: count > 1 })),
    pause: () => setState((s) => ({ ...s, playing: false })),
    /** The next step, while playing (and nothing when not: a step read after a move by hand stays). */
    advance: () => setState((s) => (s.playing && s.index < count - 1 ? { ...s, index: s.index + 1 } : s)),
    first: () => go(0),
    prev: () => go(index - 1),
    next: () => go(index + 1),
    last: () => go(count - 1),
    goTo: go,
  }
}

function start(count: number, still: 'first' | 'last'): { index: number; playing: boolean } {
  if (count <= 1 || reducedMotion()) return { index: still === 'first' ? 0 : Math.max(count - 1, 0), playing: false }
  return { index: 0, playing: true }
}
