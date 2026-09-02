import { useEffect, useRef } from 'react'
import { locale } from '@/config/locale.ts'

/** Browser tab title: "<parts> – tsmyadmin" (most specific part first), restored to the app name on unmount. */
export function formatDocumentTitle(parts: (string | undefined)[]): string {
  const specific = parts.filter((p): p is string => !!p && p.trim() !== '')
  return specific.length === 0 ? locale.app.name : `${specific.join(' – ')} – ${locale.app.name}`
}

/**
 * Titles of the mounted layouts, innermost last. Nested layouts (database → table) each register their own;
 * the most specific one wins regardless of effect order, and unmounting a child restores the parent's title.
 */
const stack: { id: symbol; depth: number; title: string }[] = []
let nextDepth = 0

function apply(): void {
  // Parents render before children, so the render-time depth counter orders entries outer → inner.
  const innermost = [...stack].sort((a, b) => a.depth - b.depth).at(-1)
  document.title = innermost?.title ?? locale.app.name
}

export function useDocumentTitle(...parts: (string | undefined)[]): void {
  const title = formatDocumentTitle(parts)
  const entry = useRef<{ id: symbol; depth: number } | null>(null)
  if (entry.current === null) entry.current = { id: Symbol('title'), depth: nextDepth++ }
  const { id, depth } = entry.current
  useEffect(() => {
    const existing = stack.findIndex((e) => e.id === id)
    if (existing === -1) stack.push({ id, depth, title })
    else stack[existing] = { id, depth, title }
    apply()
    return () => {
      const i = stack.findIndex((e) => e.id === id)
      if (i !== -1) stack.splice(i, 1)
      apply()
    }
  }, [id, depth, title])
}
