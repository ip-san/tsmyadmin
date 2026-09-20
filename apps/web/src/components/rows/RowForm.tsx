import type { Cell, ColumnDef, ColumnTransform, ForeignKeyDef, RowValues } from '@tsmyadmin/shared'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { locale } from '@/config/locale.ts'
import { cellToEditable, isOpaqueCell } from '@/lib/format.ts'
import { inputMessage } from '../cells/transform-text.ts'
import { Button } from '../ui/Button.tsx'
import { ErrorBox } from '../ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '../ui/Table.tsx'
import { type FieldState, MAX_UPLOAD_BYTES, RowField } from './RowField.tsx'
import { computed, initialField, initialState, isGenerated, type RowState, writtenValue } from './row-form-state.ts'

/** A row's files together, as base64: under the 1 MB request body with room for the rest of the row. */
const ROW_FILES_MAX = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3)

export interface RowFormProps {
  columns: ColumnDef[]
  mode: 'insert' | 'edit'
  /** Edit: the current row. Insert: values to prefill (duplicate row); generated columns still use their default. */
  initial?: Record<string, Cell>
  /** Edit several rows at once: their current values, one section each (takes the place of `initial`). */
  initialRows?: Record<string, Cell>[]
  /** The table's foreign keys, to suggest the referenced values. */
  foreignKeys?: ForeignKeyDef[]
  /** Input transformations by column: a pattern the value must match, or an editor that checks JSON / XML. */
  inputTransforms?: ReadonlyMap<string, ColumnTransform>
  /** Insert: how many rows the form holds (phpMyAdmin's "Continue insertion with N rows"). */
  rowCount?: number
  pending?: boolean
  error?: unknown
  /**
   * The first row's values, and every row to write: in insert mode with several rows, the rows beyond the first
   * that were left untouched are not included; editing several rows gives one entry per row, in order, empty where
   * nothing changed.
   */
  onSubmit: (values: RowValues, rows: RowValues[]) => void
  /** Insert: shows the statement for the rows written so far instead of running it (they go through the same checks). */
  onPreview?: (rows: RowValues[]) => void
  onCancel?: () => void
}

/** Shared insert / edit form. In edit mode only changed columns are submitted. */
export function RowForm({
  columns,
  mode,
  initial,
  initialRows,
  foreignKeys = [],
  inputTransforms,
  rowCount = 1,
  pending,
  error,
  onSubmit,
  onPreview,
  onCancel,
}: RowFormProps) {
  const count = mode === 'insert' ? Math.max(1, rowCount) : Math.max(1, initialRows?.length ?? 1)
  /** The values a row started from: its own when editing several. */
  const startOf = (row: number) => initialRows?.[row] ?? initial
  const [rows, setRows] = useState<RowState[]>(() =>
    Array.from({ length: count }, (_, i) => initialState(columns, mode, startOf(i)))
  )
  // Inserting: rows beyond the first are written only once something in them was changed. Editing: every row
  // (only what changed in it is sent).
  const [touched, setTouched] = useState<boolean[]>(() =>
    Array.from({ length: count }, (_, i) => mode === 'edit' || i === 0)
  )
  // The count can change while the form is open: grow or shrink the rows, keeping what was typed.
  if (rows.length !== count) {
    setRows((r) => Array.from({ length: count }, (_, i) => r[i] ?? initialState(columns, mode, startOf(i))))
    setTouched((t) => Array.from({ length: count }, (_, i) => t[i] ?? i === 0))
  }
  // The structure query may refetch with a new column while the form is mounted: fall back to a fresh field.
  const fieldFor = (row: number, c: ColumnDef): FieldState => rows[row]?.[c.name] ?? initialField(c, mode, startOf(row))
  const update = (row: number, column: ColumnDef, patch: Partial<FieldState>) => {
    setRows((all) =>
      all.map((r, i) => (i === row ? { ...r, [column.name]: { ...fieldFor(row, column), ...patch } } : r))
    )
    setTouched((t) => t.map((v, i) => v || i === row))
  }
  const fks = new Map(foreignKeys.filter((fk) => fk.columns.length === 1).map((fk) => [fk.columns[0] ?? '', fk]))

  // `pending` comes from a mutation and only flips on the next render, so a double click would submit twice.
  const submitted = useRef(false)
  // Which button submitted the form: the preview button sets this, and it is read (and cleared) by `submit`.
  const previewing = useRef(false)
  useEffect(() => {
    if (!pending) submitted.current = false
  }, [pending])

  const [filesTooLarge, setFilesTooLarge] = useState(false)
  const [refused, setRefused] = useState<string[]>([])
  /** The values the column rules refuse right now (the fields check themselves a moment late; this is at once). */
  const refusals = (): string[] => {
    const out: string[] = []
    rows.forEach((_, row) => {
      for (const c of columns) {
        const rule = inputTransforms?.get(c.name)
        const f = fieldFor(row, c)
        const typed = !(f.isNull || f.useDefault || f.fn !== '' || f.file !== null)
        const changed = mode === 'insert' || f.text !== cellToEditable(startOf(row)?.[c.name] ?? null)
        const message = rule && typed && changed ? inputMessage(rule, f.text) : ''
        if (message) out.push(`${count > 1 ? locale.rows.inRow(c.name, row + 1) : c.name}: ${message}`)
      }
    })
    return out
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const preview = previewing.current
    previewing.current = false
    if ((submitted.current && !preview) || pending) return
    const refusing = refusals()
    setRefused(refusing)
    if (refusing.length > 0) return
    // Every row is its own request: its files together must fit the request body, as base64.
    const heaviest = Math.max(
      0,
      ...rows.map((r) => Object.values(r).reduce((n, f) => n + (f.file?.base64.length ?? 0), 0))
    )
    setFilesTooLarge(heaviest > ROW_FILES_MAX)
    if (heaviest > ROW_FILES_MAX) return
    if (!preview) submitted.current = true
    const all: RowValues[] = []
    rows.forEach((_, row) => {
      if (!touched[row]) return
      const values: RowValues = {}
      for (const c of columns) {
        const v = writtenValue(c, fieldFor(row, c), mode, startOf(row)?.[c.name] ?? null)
        if (v !== undefined) values[c.name] = v
      }
      all.push(values)
    })
    if (preview && onPreview) onPreview(all)
    else onSubmit(all[0] ?? {}, all)
  }

  return (
    <form onSubmit={submit} aria-busy={pending} className="space-y-3">
      {rows.map((_, row) => (
        <Table
          // biome-ignore lint/suspicious/noArrayIndexKey: the rows of the form, by position; never reordered
          key={row}
          aria-label={count > 1 ? locale.rows.rowNumber(row + 1) : undefined}
        >
          <thead>
            <tr>
              <Th>{locale.rows.column}</Th>
              <Th>{locale.rows.type}</Th>
              <Th>{locale.rows.setNull}</Th>
              {mode === 'insert' ? <Th>{locale.rows.useDefault}</Th> : null}
              <Th className="w-full">
                {count > 1 ? locale.rows.inRow(locale.rows.value, row + 1) : locale.rows.value}
              </Th>
            </tr>
          </thead>
          <tbody>
            {columns.map((c) => {
              const f = fieldFor(row, c)
              const opaque = isOpaqueCell(startOf(row)?.[c.name] ?? null)
              // Editing keeps an opaque value untouched unless a file replaces it; duplicating leaves it open.
              const locked = mode === 'edit' && opaque && !f.isNull
              const id = row === 0 ? `field-${c.name}` : `field-${row}-${c.name}`
              const label = count > 1 ? locale.rows.inRow(c.name, row + 1) : c.name
              return (
                <Tr key={c.name} data-generated={isGenerated(c) ? '' : undefined}>
                  <Td className="whitespace-nowrap font-medium">
                    {locked ? c.name : <label htmlFor={id}>{label}</label>}
                  </Td>
                  <Td className="whitespace-nowrap font-mono text-xs text-ink-sub">{c.dataType}</Td>
                  <Td>
                    <input
                      type="checkbox"
                      aria-label={`${label}: ${locale.rows.setNull}`}
                      checked={f.isNull}
                      disabled={!c.nullable || computed(c)}
                      onChange={(e) => update(row, c, { isNull: e.target.checked, useDefault: false, file: null })}
                    />
                  </Td>
                  {mode === 'insert' ? (
                    <Td>
                      <input
                        type="checkbox"
                        aria-label={`${label}: ${locale.rows.useDefault}`}
                        checked={f.useDefault || computed(c)}
                        disabled={computed(c)}
                        onChange={(e) => update(row, c, { useDefault: e.target.checked, isNull: false })}
                      />
                    </Td>
                  ) : null}
                  <Td>
                    {computed(c) ? (
                      <span className="text-xs text-ink-sub">{locale.rows.generatedReadOnly}</span>
                    ) : (
                      <RowField
                        id={id}
                        label={label}
                        column={c}
                        field={f}
                        fk={fks.get(c.name)}
                        input={inputTransforms?.get(c.name)}
                        // Editing: a value nobody touched is not judged (it may predate the rule).
                        checkInput={mode === 'insert' || f.text !== cellToEditable(startOf(row)?.[c.name] ?? null)}
                        locked={locked}
                        describedBy={opaque && mode === 'insert' ? `${id}-note` : undefined}
                        onChange={(patch) => update(row, c, patch)}
                      />
                    )}
                    {opaque && mode === 'insert' ? (
                      <span id={`${id}-note`} className="block text-xs text-ink-sub">
                        {locale.rows.opaqueNotCopied}
                      </span>
                    ) : null}
                  </Td>
                </Tr>
              )
            })}
          </tbody>
        </Table>
      ))}
      {refused.length > 0 ? (
        <ul role="alert" className="list-disc pl-5 text-sm text-red-700 dark:text-red-300">
          {refused.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
      {filesTooLarge ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {locale.rows.filesTooLarge}
        </p>
      ) : null}
      {error ? <ErrorBox error={error} /> : null}
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button onClick={onCancel} disabled={pending}>
            {locale.common.cancel}
          </Button>
        ) : null}
        {onPreview ? (
          <Button
            type="submit"
            aria-haspopup="dialog"
            disabled={pending}
            onClick={() => {
              previewing.current = true
            }}
          >
            {locale.rows.previewSql}
          </Button>
        ) : null}
        <Button type="submit" variant="primary" disabled={pending}>
          {mode === 'insert' ? locale.rows.insert : locale.rows.save}
        </Button>
      </div>
    </form>
  )
}
