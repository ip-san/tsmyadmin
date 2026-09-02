import { useEffect } from 'react'
import { locale } from '@/config/locale.ts'

/** Browser tab title: "<parts> – tsmyadmin" (most specific part first), restored to the app name on unmount. */
export function formatDocumentTitle(parts: (string | undefined)[]): string {
  const specific = parts.filter((p): p is string => !!p && p.trim() !== '')
  return specific.length === 0 ? locale.app.name : `${specific.join(' – ')} – ${locale.app.name}`
}

export function useDocumentTitle(...parts: (string | undefined)[]): void {
  const title = formatDocumentTitle(parts)
  useEffect(() => {
    document.title = title
    return () => {
      document.title = locale.app.name
    }
  }, [title])
}
