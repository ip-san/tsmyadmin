import { useEffect, useState } from 'react'

/** How long a step stays before the next, while playing. */
const STEP_MS = 1400

const reducedMotion = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Walking through the steps of a story: it plays from the first on its own, one step every `STEP_MS`, and stops at
 * the last. A reader who has asked for less motion is shown the last step (the whole picture) and moves by hand.
 * New steps (`count` changes) start the walk again.
 */
export function useStepPlayer(count: number, stepMs = STEP_MS) {
  const [state, setState] = useState(() => start(count))
  const [seen, setSeen] = useState(count)
  if (seen !== count) {
    setSeen(count)
    setState(start(count))
  }
  const { index, playing } = state

  useEffect(() => {
    if (!playing) return
    if (index >= count - 1) {
      setState((s) => ({ ...s, playing: false }))
      return
    }
    const timer = setTimeout(() => setState((s) => ({ ...s, index: s.index + 1 })), stepMs)
    return () => clearTimeout(timer)
  }, [playing, index, count, stepMs])

  const go = (to: number) => setState({ index: Math.min(Math.max(to, 0), Math.max(count - 1, 0)), playing: false })
  return {
    index,
    playing,
    // Play from the start again once the end is reached, rather than doing nothing.
    play: () => setState((s) => ({ index: s.index >= count - 1 ? 0 : s.index, playing: count > 1 })),
    pause: () => setState((s) => ({ ...s, playing: false })),
    first: () => go(0),
    prev: () => go(index - 1),
    next: () => go(index + 1),
    last: () => go(count - 1),
    goTo: go,
  }
}

function start(count: number): { index: number; playing: boolean } {
  if (count <= 1 || reducedMotion()) return { index: Math.max(count - 1, 0), playing: false }
  return { index: 0, playing: true }
}
