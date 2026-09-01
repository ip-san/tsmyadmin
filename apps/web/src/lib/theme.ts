import { useCallback, useSyncExternalStore } from 'react'

const KEY = 'tsmyadmin.theme'
type Theme = 'light' | 'dark'
const listeners = new Set<() => void>()

function read(): Theme {
  try {
    const stored = localStorage.getItem(KEY)
    if (stored === 'light' || stored === 'dark') return stored
  } catch {
    // storage unavailable
  }
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(theme: Theme = read()): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

export function useTheme(): [Theme, () => void] {
  const theme = useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    read,
    () => 'light' as Theme
  )
  const toggle = useCallback(() => {
    const next: Theme = read() === 'dark' ? 'light' : 'dark'
    try {
      localStorage.setItem(KEY, next)
    } catch {
      // ignore
    }
    applyTheme(next)
    for (const l of listeners) l()
  }, [])
  return [theme, toggle]
}
