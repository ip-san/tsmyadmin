import type { Cell } from '@tsmyadmin/shared'
import { type FocusEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Input, Textarea } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { cellToEditable } from '@/lib/format.ts'

export interface CellEditorProps {
  column: string
  initial: Cell
  /** Column type; multi-line types (text, json, …) get a textarea. */
  dataType?: string
  pending?: boolean
  /** Last save failure: focus returns to the field so the error is not read into the void. */
  error?: unknown
  onSave: (value: Cell) => void
  onCancel: () => void
}

/** Types whose values are usually multi-line (TEXT, JSON, XML, CLOB…): edited in a textarea. */
const MULTILINE = /text|json|xml|clob|character varying\(\d{4,}\)|varchar\(\d{4,}\)/i

/** Inline editor for one cell: Enter saves, Esc cancels, checkbox sets NULL, clicking elsewhere cancels. */
export function CellEditor({ column, initial, dataType, pending, error, onSave, onCancel }: CellEditorProps) {
  const [text, setText] = useState(() => cellToEditable(initial))
  const [isNull, setIsNull] = useState(initial === null)
  const wrapper = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // A failed save disables nothing permanently, but the button that had focus was disabled while pending
    // and focus fell to <body>: bring it back into the editor.
    if (error && wrapper.current && !wrapper.current.contains(document.activeElement)) {
      wrapper.current.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled]), button')?.focus()
    }
  }, [error])
  const multiline = dataType !== undefined && (MULTILINE.test(dataType) || text.includes('\n'))
  const save = () => onSave(isNull ? null : text)
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !(multiline && !(e.metaKey || e.ctrlKey))) {
      e.preventDefault()
      save()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }
  // Focus moving outside the editor (a click elsewhere in the grid) ends the edit instead of leaving a stale box.
  const onBlur = (e: FocusEvent<HTMLElement>) => {
    if (pending) return
    const next = e.relatedTarget
    if (next instanceof Node && e.currentTarget.contains(next)) return
    onCancel()
  }
  const field = {
    autoFocus: true,
    'aria-label': `${column}: ${locale.browse.editCell}`,
    value: text,
    disabled: isNull || pending,
    onKeyDown,
    className: 'font-mono text-xs',
  }
  return (
    <div ref={wrapper} className="flex min-w-48 flex-col gap-1" aria-busy={pending} onBlur={onBlur}>
      {multiline ? (
        <Textarea {...field} rows={4} onChange={(e) => setText(e.target.value)} />
      ) : (
        <Input {...field} onChange={(e) => setText(e.target.value)} />
      )}
      {/* WebKit does not focus buttons / checkboxes on mousedown, so a click here would blur (and cancel) the
          field before it lands; keeping focus where it is lets the click go through on every engine. */}
      <div className="flex items-center gap-2 text-xs" onMouseDown={(e) => e.preventDefault()}>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={isNull} onChange={(e) => setIsNull(e.target.checked)} onKeyDown={onKeyDown} />
          {locale.browse.setNull}
        </label>
        <span className="text-zinc-500 dark:text-zinc-400">
          {multiline ? locale.browse.editHintMultiline : locale.browse.editHint}
        </span>
        <Button size="sm" variant="primary" onClick={save} disabled={pending}>
          {locale.common.save}
        </Button>
        <Button size="sm" onClick={onCancel} disabled={pending}>
          {locale.common.cancel}
        </Button>
      </div>
    </div>
  )
}
