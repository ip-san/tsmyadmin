import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { sessionStore } from '@/lib/console-draft.ts'
import { readPreference, writePreference } from '@/lib/preferences.ts'

/** The editor text of a console, kept as a draft so it survives leaving the page and a session-expiry round trip. */
export function useConsoleDraft(key: string, initialSql: string): [string, (next: string) => void] {
  const [text, setTextState] = useState(() => readPreference(key, z.string(), initialSql, sessionStore()))
  // Draft writes are debounced: a multi-MB pasted script would otherwise be serialised on every keystroke.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestText = useRef(text)
  const setText = (next: string) => {
    setTextState(next)
    latestText.current = next
    if (pending.current !== null) clearTimeout(pending.current)
    pending.current = setTimeout(() => {
      pending.current = null
      writePreference(key, latestText.current, sessionStore())
    }, 300)
  }
  useEffect(() => {
    // Flush a pending draft when the console unmounts or the document is left / reloaded.
    const flushDraft = () => {
      if (pending.current === null) return
      clearTimeout(pending.current)
      pending.current = null
      writePreference(key, latestText.current, sessionStore())
    }
    window.addEventListener('pagehide', flushDraft)
    return () => {
      window.removeEventListener('pagehide', flushDraft)
      flushDraft()
    }
  }, [key])
  return [text, setText]
}
