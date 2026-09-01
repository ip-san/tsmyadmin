import type { Cell, ColumnDef, RowValues } from '@tsmyadmin/shared'
import { isBinaryCell } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { locale } from '@/config/locale.ts'
import { cellToEditable } from '@/lib/format.ts'
import { Button } from '../ui/Button.tsx'
import { ErrorBox } from '../ui/Feedback.tsx'
import { Input } from '../ui/Field.tsx'
import { Table, Td, Th, Tr } from '../ui/Table.tsx'

interface FieldState {
  text: string
  isNull: boolean
  /** insert: omit the column so the DB default applies. */
  useDefault: boolean
}

export interface RowFormProps {
  columns: ColumnDef[]
  mode: 'insert' | 'edit'
  initial?: Record<string, Cell>
  pending?: boolean
  error?: unknown
  onSubmit: (values: RowValues) => void
  onCancel?: () => void
}

function initialState(
  columns: ColumnDef[],
  mode: RowFormProps['mode'],
  initial?: Record<string, Cell>
): Record<string, FieldState> {
  const out: Record<string, FieldState> = {}
  for (const c of columns) {
    const cell = initial?.[c.name] ?? null
    const hasDefault =
      c.default !== null || c.extra.includes('auto_increment') || c.extra.includes('identity') || c.extra === 'serial'
    out[c.name] = {
      text: cellToEditable(cell),
      isNull: mode === 'edit' ? cell === null : c.nullable && !hasDefault,
      useDefault: mode === 'insert' && hasDefault,
    }
  }
  return out
}

/** Shared insert / edit form. In edit mode only changed columns are submitted. */
export function RowForm({ columns, mode, initial, pending, error, onSubmit, onCancel }: RowFormProps) {
  const [fields, setFields] = useState(() => initialState(columns, mode, initial))
  const update = (name: string, patch: Partial<FieldState>) =>
    setFields((f) => ({ ...f, [name]: { ...(f[name] as FieldState), ...patch } }))

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const values: RowValues = {}
    for (const c of columns) {
      const f = fields[c.name]
      if (!f || f.useDefault) continue
      const original = initial?.[c.name] ?? null
      if (isBinaryCell(original) && !f.isNull) continue
      const next: Cell = f.isNull ? null : f.text
      if (mode === 'edit' && !changed(original, next)) continue
      values[c.name] = next
    }
    onSubmit(values)
  }

  return (
    <form onSubmit={submit} aria-busy={pending} className="space-y-3">
      <Table>
        <thead>
          <tr>
            <Th>{locale.rows.column}</Th>
            <Th>{locale.rows.type}</Th>
            <Th>{locale.rows.setNull}</Th>
            {mode === 'insert' ? <Th>{locale.rows.useDefault}</Th> : null}
            <Th className="w-full">{locale.rows.value}</Th>
          </tr>
        </thead>
        <tbody>
          {columns.map((c) => {
            const f = fields[c.name] as FieldState
            const binary = isBinaryCell(initial?.[c.name] ?? null)
            const disabled = f.useDefault || f.isNull
            const id = `field-${c.name}`
            return (
              <Tr key={c.name}>
                <Td className="whitespace-nowrap font-medium">
                  <label htmlFor={id}>{c.name}</label>
                </Td>
                <Td className="whitespace-nowrap font-mono text-xs text-zinc-500 dark:text-zinc-400">{c.dataType}</Td>
                <Td>
                  <input
                    type="checkbox"
                    aria-label={`${c.name}: ${locale.rows.setNull}`}
                    checked={f.isNull}
                    disabled={!c.nullable && mode === 'edit'}
                    onChange={(e) => update(c.name, { isNull: e.target.checked, useDefault: false })}
                  />
                </Td>
                {mode === 'insert' ? (
                  <Td>
                    <input
                      type="checkbox"
                      aria-label={`${c.name}: ${locale.rows.useDefault}`}
                      checked={f.useDefault}
                      onChange={(e) => update(c.name, { useDefault: e.target.checked, isNull: false })}
                    />
                  </Td>
                ) : null}
                <Td>
                  {binary && !f.isNull ? (
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">{locale.rows.binaryReadOnly}</span>
                  ) : (
                    <Input
                      id={id}
                      value={f.text}
                      disabled={disabled}
                      onChange={(e) => update(c.name, { text: e.target.value })}
                      className="font-mono text-xs"
                    />
                  )}
                </Td>
              </Tr>
            )
          })}
        </tbody>
      </Table>
      {error ? <ErrorBox error={error} /> : null}
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button onClick={onCancel} disabled={pending}>
            {locale.common.cancel}
          </Button>
        ) : null}
        <Button type="submit" variant="primary" disabled={pending}>
          {mode === 'insert' ? locale.rows.insert : locale.rows.save}
        </Button>
      </div>
    </form>
  )
}

function changed(original: Cell, next: Cell): boolean {
  if (original === null || next === null) return original !== next
  if (isBinaryCell(original)) return true
  return String(original) !== String(next)
}
