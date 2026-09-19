import { useQuery } from '@tanstack/react-query'
import type { ColumnDef, ColumnTransform, Dialect, ForeignKeyDef, RowFunction } from '@tsmyadmin/shared'
import { ROW_FUNCTIONS_WITH_ARG, rowFunctionsFor } from '@tsmyadmin/shared'
import { useState } from 'react'
import { locale } from '@/config/locale.ts'
import { rowsQuery, sessionQuery } from '@/lib/queries.ts'
import { inputProblem } from '../cells/transform-text.ts'
import { Input, Select, Textarea } from '../ui/Field.tsx'

/**
 * Largest file taken into a binary column from the form. A row travels as JSON in a request of at most 1 MB, and
 * base64 makes a file a third larger: 512 KB leaves room for the rest of the row (RowForm also checks a row's files
 * together, for a table with several binary columns).
 */
export const MAX_UPLOAD_BYTES = 512 * 1024
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
  input,
  checkInput = true,
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
  /** The column's input transformation: a pattern to match, or an editor that checks what is typed. */
  input?: ColumnTransform | undefined
  /** Whether to judge the value against `input` (false for an edit value that is still what it was). */
  checkInput?: boolean
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
  // What is typed is checked as it is typed; a value that is NULL, left to the default, a function's or a file's is not.
  const typed = !(f.isNull || f.useDefault || f.fn !== '' || f.file !== null)
  const problem = input && typed && checkInput ? inputProblem(input, f.text) : null
  const problemText =
    problem === null
      ? ''
      : problem === 'pattern'
        ? input?.message || locale.rows.patternMismatch
        : problem === 'json'
          ? locale.rows.invalidJson
          : locale.rows.invalidXml
  const editor = input !== undefined && ['json-input', 'xml-input', 'sql-input'].includes(input.kind)
  // The browser's own form validation stops the submit and says why, which is what a required field does too.
  const checked = (el: HTMLInputElement | HTMLTextAreaElement | null) => el?.setCustomValidity(problemText)
  const problemId = `${id}-problem`
  const described = [describedBy, problemText ? problemId : undefined].filter(Boolean).join(' ') || undefined
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
        ) : editor || MULTILINE.test(c.dataType) ? (
          <Textarea
            id={id}
            ref={checked}
            aria-describedby={described}
            aria-invalid={problemText !== ''}
            value={shown}
            disabled={!takesArg || f.file !== null}
            rows={Math.min(12, Math.max(editor ? 4 : 2, f.text.split('\n').length))}
            onChange={(e) => takeOver(e.target.value)}
            placeholder={f.useDefault && c.default !== null ? c.default : undefined}
            className="font-mono text-xs"
          />
        ) : (
          <Input
            id={id}
            ref={checked}
            aria-describedby={described}
            aria-invalid={problemText !== ''}
            value={f.file ? f.file.name : shown}
            disabled={!takesArg || f.file !== null}
            list={listId}
            onChange={(e) => takeOver(e.target.value)}
            placeholder={f.useDefault && c.default !== null ? c.default : undefined}
            className="font-mono text-xs"
          />
        )}
        {listId && fk ? <FkOptions id={listId} fk={fk} /> : null}
        {problemText ? (
          <p id={problemId} className="mt-1 text-xs text-red-700 dark:text-red-300">
            {problemText}
          </p>
        ) : null}
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
