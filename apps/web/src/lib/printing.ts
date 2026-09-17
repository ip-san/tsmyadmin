import { useSyncExternalStore } from 'react'

/**
 * Whether the page is being printed (or shown in print preview), for components that render a window of a long
 * list and must lay out every row for paper.
 *
 * Kept outside React so the Print button can switch it on synchronously before calling `window.print()`, and off
 * again when that returns (print() blocks until the dialog closes). A print the browser starts itself (Ctrl+P) is
 * seen through beforeprint / afterprint (Safari) and the print media query (Chrome).
 */
let printing = false
const listeners = new Set<() => void>()

export function setPrinting(value: boolean): void {
  if (printing === value) return
  printing = value
  for (const l of listeners) l()
}

let attached = false
function attach() {
  if (attached || typeof window === 'undefined') return
  attached = true
  window.addEventListener('beforeprint', () => setPrinting(true))
  window.addEventListener('afterprint', () => setPrinting(false))
  // jsdom (component tests) has no matchMedia.
  if (typeof window.matchMedia === 'function') {
    window.matchMedia('print').addEventListener('change', (e) => setPrinting(e.matches))
  }
}

function subscribe(listener: () => void) {
  attach()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePrinting(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => printing,
    () => false
  )
}
