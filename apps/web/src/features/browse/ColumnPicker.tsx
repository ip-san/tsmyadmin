import { ArrowDown, ArrowUp, Columns3 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale.ts'

export interface ColumnPickerProps {
  columns: string[]
  /** The columns shown, in their order; null = all, in the table's order */
  visible: string[] | null
  onChange: (visible: string[]) => void
}

/**
 * The grid's columns: which show, and in what order (state lives in the URL, so a shared link reproduces the view;
 * the browse page also remembers it per table).
 */
export function ColumnPicker({ columns, visible, onChange }: ColumnPickerProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const order = visible ?? columns
  const shown = new Set(order)
  // Shown columns in their order, then the hidden ones in the table's order.
  const listed = [...order, ...columns.filter((c) => !shown.has(c))]
  useEffect(() => {
    if (!open) return
    // Closing via Escape / outside click returns focus to the trigger so keyboard users keep their place.
    const dismiss = () => {
      setOpen(false)
      triggerRef.current?.focus()
    }
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) dismiss()
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
  const toggle = (name: string) => {
    const next = shown.has(name) ? order.filter((c) => c !== name) : [...order, name]
    if (next.length > 0) onChange(next)
  }
  const move = (i: number, by: -1 | 1) => {
    const next = [...order]
    const [item] = next.splice(i, 1)
    if (item !== undefined) next.splice(i + by, 0, item)
    onChange(next)
  }
  return (
    <div ref={ref} className="relative">
      <Button ref={triggerRef} size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Columns3 className="size-3.5" aria-hidden />
        {locale.browse.columnsShown(shown.size, columns.length)}
      </Button>
      {open ? (
        <fieldset className="absolute left-0 z-10 mt-1 max-h-72 w-56 overflow-auto rounded border border-line bg-surface p-2 shadow-lg">
          <legend className="sr-only">{locale.browse.columns}</legend>
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
          {listed.map((c, i) => (
            <div key={c} className="flex items-center gap-1 px-1 py-0.5 text-sm">
              <label className="flex min-w-0 flex-1 items-center gap-2">
                <input
                  type="checkbox"
                  checked={shown.has(c)}
                  disabled={shown.has(c) && shown.size === 1}
                  onChange={() => toggle(c)}
                  autoFocus={i === 0}
                />
                <span className="truncate">{c}</span>
              </label>
              {shown.has(c) ? (
                <>
                  <button
                    type="button"
                    className="inline-flex min-h-6 min-w-6 items-center justify-center rounded text-ink-sub hover:text-ink disabled:opacity-30"
                    disabled={i === 0}
                    aria-label={locale.browse.moveLeft(c)}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp className="size-3" aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="inline-flex min-h-6 min-w-6 items-center justify-center rounded text-ink-sub hover:text-ink disabled:opacity-30"
                    disabled={i === order.length - 1}
                    aria-label={locale.browse.moveRight(c)}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown className="size-3" aria-hidden />
                  </button>
                </>
              ) : null}
            </div>
          ))}
        </fieldset>
      ) : null}
    </div>
  )
}
