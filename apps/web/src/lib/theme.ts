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

/** Sets the theme (the account's, at login) and tells every mounted toggle. */
export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // ignore
  }
  applyTheme(theme)
  for (const l of listeners) l()
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
    setTheme(read() === 'dark' ? 'light' : 'dark')
  }, [])
  return [theme, toggle]
}
