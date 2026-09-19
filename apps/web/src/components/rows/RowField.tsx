import { useQuery } from '@tanstack/react-query'
import type { ColumnDef, Dialect, ForeignKeyDef, RowFunction } from '@tsmyadmin/shared'
import { ROW_FUNCTIONS_WITH_ARG, rowFunctionsFor } from '@tsmyadmin/shared'
import { useState } from 'react'
import { locale } from '@/config/locale.ts'
import { rowsQuery, sessionQuery } from '@/lib/queries.ts'
import { Input, Select, Textarea } from '../ui/Field.tsx'

/** Largest file taken into a binary column from the form: its base64 has to fit the 1 MB request body. */
const MAX_UPLOAD_BYTES = 700 * 1024
/** Values offered for a foreign key column: the first ones of the referenced column. */
const FK_OPTIONS = 200

const BINARY_TYPE = /blob|binary|bytea|^bit\b/i
/** Types whose values are usually multi-line (TEXT, JSON, XML, CLOB…): edited in a textarea. */
const MULTILINE = /text|json|xml|clob|character varying\(\d{4,}\)|varchar\(\d{4,}\)/i

export interface FieldState {
  text: string
  isNull: boolean
  /** insert: omit the column so the DB default applies. */
  useDefault: boolean
  /** Written through this function (its argument, when it takes one, is `text`). */
  fn: RowFunction | ''
  /** A file read into a binary column, as base64. */
  file: { name: string; base64: string } | null
}

const isBinaryColumn = (c: ColumnDef) => BINARY_TYPE.test(c.dataType)

/** The referenced column's first values, as suggestions for a single-column foreign key. */
function FkOptions({ id, fk }: { id: string; fk: ForeignKeyDef }) {
  const column = fk.refColumns[0] ?? ''
  const rows = useQuery(
    rowsQuery(
      { db: fk.refNamespace.database, schema: fk.refNamespace.schema, table: fk.refTable },
      { offset: 0, limit: FK_OPTIONS, sort: [{ column, direction: 'asc' }], filters: [] }
    )
  )
  const at = rows.data?.columns.findIndex((c) => c.name === column) ?? -1
  const values = at === -1 ? [] : (rows.data?.rows ?? []).map((r) => r[at]).filter((v) => typeof v !== 'object')
  return (
    <datalist id={id}>
      {values.map((v) => (
        <option key={String(v)} value={String(v)} />
      ))}
    </datalist>
  )
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/**
 * The value cell of the row form: an optional function (phpMyAdmin's "Function" column), the value — or, for a
 * binary column, a file — and for a foreign key the referenced values as suggestions.
 */
export function RowField({
  id,
  label,
  column: c,
  field: f,
  fk,
  locked,
  describedBy,
  onChange,
}: {
  id: string
  /** The column's name as the form labels it (with the row, when there are several). */
  label: string
  column: ColumnDef
  field: FieldState
  fk: ForeignKeyDef | undefined
  /** A value that cannot be edited here (binary or cut off) and is kept unless a file replaces it. */
  locked: boolean
  describedBy: string | undefined
  onChange: (patch: Partial<FieldState>) => void
}) {
  const dialect: Dialect = useQuery(sessionQuery).data?.dialect ?? 'mysql'
  const takesArg = f.fn === '' || ROW_FUNCTIONS_WITH_ARG.has(f.fn)
  const listId = fk && fk.columns.length === 1 ? `${id}-fk` : undefined
  const shown = f.isNull || f.useDefault || !takesArg ? '' : f.text
  const takeOver = (text: string) => onChange({ text, isNull: false, useDefault: false, file: null })
  const binary = isBinaryColumn(c)
  const [tooLarge, setTooLarge] = useState(false)
  return (
    <div className="flex flex-wrap items-start gap-2">
      <Select
        aria-label={`${label}: ${locale.rows.function}`}
        value={f.fn}
        onChange={(e) =>
          onChange({ fn: e.target.value as FieldState['fn'], isNull: false, useDefault: false, file: null })
        }
        className="w-auto py-1 text-xs"
      >
        <option value="">{locale.rows.noFunction}</option>
        {rowFunctionsFor(dialect).map((fn) => (
          <option key={fn} value={fn}>
            {locale.rows.functions[fn]}
          </option>
        ))}
      </Select>
      <div className="min-w-48 flex-1">
        {locked && !f.file && f.fn === '' ? (
          <span className="text-xs text-ink-sub">{locale.rows.binaryReadOnly}</span>
        ) : MULTILINE.test(c.dataType) ? (
          <Textarea
            id={id}
            aria-describedby={describedBy}
            value={shown}
            disabled={!takesArg || f.file !== null}
            rows={Math.min(12, Math.max(2, f.text.split('\n').length))}
            onChange={(e) => takeOver(e.target.value)}
            placeholder={f.useDefault && c.default !== null ? c.default : undefined}
            className="font-mono text-xs"
          />
        ) : (
          <Input
            id={id}
            aria-describedby={describedBy}
            value={f.file ? f.file.name : shown}
            disabled={!takesArg || f.file !== null}
            list={listId}
            onChange={(e) => takeOver(e.target.value)}
            placeholder={f.useDefault && c.default !== null ? c.default : undefined}
            className="font-mono text-xs"
          />
        )}
        {listId && fk ? <FkOptions id={listId} fk={fk} /> : null}
      </div>
      {binary && f.fn === '' ? (
        <label className="flex items-center gap-1 text-xs text-ink">
          <span>{locale.rows.fromFile}</span>
          <input
            type="file"
            aria-label={`${label}: ${locale.rows.fromFile}`}
            className="max-w-48 text-xs"
            onChange={async (e) => {
              const file = e.target.files?.[0]
              if (!file) return
              setTooLarge(file.size > MAX_UPLOAD_BYTES)
              if (file.size > MAX_UPLOAD_BYTES) {
                e.target.value = ''
                onChange({ file: null })
                return
              }
              onChange({ file: { name: file.name, base64: await readFile(file) }, isNull: false, useDefault: false })
            }}
          />
        </label>
      ) : null}
      {tooLarge ? (
        <p role="alert" className="w-full text-xs text-red-700 dark:text-red-300">
          {locale.rows.fileTooLarge(MAX_UPLOAD_BYTES)}
        </p>
      ) : null}
    </div>
  )
}
