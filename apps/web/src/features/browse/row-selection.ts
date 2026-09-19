import { useCallback, useState } from 'react'

/** The ticked rows of a page, by index: a stable `toggle` (the rows are memoised) and a way to clear them. */
export function useRowSelection() {
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set())
  const toggle = useCallback(
    (i: number) =>
      setSelected((s) => {
        const next = new Set(s)
        if (next.has(i)) next.delete(i)
        else next.add(i)
        return next
      }),
    []
  )
  const clear = useCallback(() => setSelected(new Set()), [])
  return { selected, setSelected, toggle, clear }
}
