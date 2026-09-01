import type { Cell } from '@tsmyadmin/shared'
import { type KeyboardEvent, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { cellToEditable } from '@/lib/format.ts'

export interface CellEditorProps {
  column: string
  initial: Cell
  pending?: boolean
  onSave: (value: Cell) => void
  onCancel: () => void
}

/** Inline editor for one cell: Enter saves, Esc cancels, checkbox sets NULL. */
export function CellEditor({ column, initial, pending, onSave, onCancel }: CellEditorProps) {
  const [text, setText] = useState(() => cellToEditable(initial))
  const [isNull, setIsNull] = useState(initial === null)
  const save = () => onSave(isNull ? null : text)
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      save()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }
  return (
    <div className="flex min-w-48 flex-col gap-1" aria-busy={pending}>
      <Input
        autoFocus
        aria-label={`${column}: ${locale.browse.editCell}`}
        value={text}
        disabled={isNull || pending}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        className="font-mono text-xs"
      />
      <div className="flex items-center gap-2 text-xs">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={isNull} onChange={(e) => setIsNull(e.target.checked)} onKeyDown={onKeyDown} />
          {locale.browse.setNull}
        </label>
        <span className="text-zinc-400 dark:text-zinc-500">{locale.browse.editHint}</span>
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
