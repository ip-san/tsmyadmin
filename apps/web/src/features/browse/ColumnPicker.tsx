import { Columns3 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale.ts'

export interface ColumnPickerProps {
  columns: string[]
  /** null = all visible */
  visible: string[] | null
  onChange: (visible: string[]) => void
}

/** Toggle list of grid columns (state lives in the URL, so a shared link reproduces the view). */
export function ColumnPicker({ columns, visible, onChange }: ColumnPickerProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const shown = new Set(visible ?? columns)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
  const toggle = (name: string) => {
    const next = columns.filter((c) => (c === name ? !shown.has(c) : shown.has(c)))
    if (next.length > 0) onChange(next)
  }
  return (
    <div ref={ref} className="relative">
      <Button size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="true">
        <Columns3 className="size-3.5" aria-hidden />
        {locale.browse.columnsShown(shown.size, columns.length)}
      </Button>
      {open ? (
        <div
          role="group"
          aria-label={locale.browse.columns}
          className="absolute left-0 z-10 mt-1 max-h-72 w-56 overflow-auto rounded border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
        >
          <div className="mb-1 flex gap-2 text-xs">
            <button
              type="button"
              className="text-blue-700 hover:underline dark:text-blue-300"
              onClick={() => onChange(columns)}
            >
              {locale.browse.columnsAll}
            </button>
            <button
              type="button"
              className="text-blue-700 hover:underline dark:text-blue-300"
              onClick={() => onChange(columns.slice(0, 1))}
            >
              {locale.browse.columnsNone}
            </button>
          </div>
          {columns.map((c) => (
            <label key={c} className="flex items-center gap-2 px-1 py-0.5 text-sm">
              <input type="checkbox" checked={shown.has(c)} onChange={() => toggle(c)} />
              <span className="truncate">{c}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  )
}
