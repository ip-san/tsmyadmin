import { useEffect, useState } from 'react'

/**
 * Whether the page is being printed (or shown in print preview). Chrome reports it through the print media
 * query; Safari only fires beforeprint / afterprint; both are listened to. Components that render a window of a
 * long list use it to lay out every row for paper.
 */
export function usePrinting(): boolean {
  const [printing, setPrinting] = useState(false)
  useEffect(() => {
    const on = () => setPrinting(true)
    const off = () => setPrinting(false)
    window.addEventListener('beforeprint', on)
    window.addEventListener('afterprint', off)
    // jsdom (component tests) has no matchMedia.
    const query = typeof window.matchMedia === 'function' ? window.matchMedia('print') : null
    const change = (e: MediaQueryListEvent) => setPrinting(e.matches)
    query?.addEventListener('change', change)
    return () => {
      window.removeEventListener('beforeprint', on)
      window.removeEventListener('afterprint', off)
      query?.removeEventListener('change', change)
    }
  }, [])
  return printing
}
