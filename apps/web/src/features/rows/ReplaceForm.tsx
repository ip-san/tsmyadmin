import { useQuery } from '@tanstack/react-query'
import { isGeneratedColumn, isViewKind } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import { structureQuery, type TableRef } from '@/lib/queries.ts'

const t = locale.replace

/** Text columns: REPLACE works on strings, and a generated column cannot be written to. */
export function replaceableColumns(columns: { name: string; dataType: string; extra: string }[]): string[] {
  return columns.filter((c) => !isGeneratedColumn(c.extra) && /char|text/i.test(c.dataType)).map((c) => c.name)
}

/**
 * phpMyAdmin's "Find and replace": every occurrence of a text in one column, through the SQL preview. Only rows
 * the replacement actually changes are updated (the preview shows the statement and its condition).
 */
export function ReplaceForm({ tableRef }: { tableRef: TableRef }) {
  const structure = useQuery(structureQuery(tableRef))
  const flow = useDdlFlow(tableRef.db, tableRef.schema)
  const [column, setColumn] = useState('')
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const columns = replaceableColumns(structure.data?.columns ?? [])
  const target = columns.includes(column) ? column : (columns[0] ?? '')
  // Views are left out: whether one takes the UPDATE depends on its definition, and a table is what it is for.
  if (!structure.data || isViewKind(structure.data.kind) || columns.length === 0) return null
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (target && find) flow.preview({ op: 'replaceInColumn', table: tableRef.table, column: target, find, replace })
  }
  return (
    <section className="mt-6 rounded border border-line p-3">
      <h2 className="mb-1 text-sm font-semibold text-ink">{t.title}</h2>
      <p className="mb-2 text-xs text-ink-sub">{t.hint}</p>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <Field id="replace-column" label={t.column}>
          <Select id="replace-column" value={target} onChange={(e) => setColumn(e.target.value)}>
            {columns.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="replace-find" label={t.find}>
          <Input id="replace-find" value={find} onChange={(e) => setFind(e.target.value)} required />
        </Field>
        <Field id="replace-with" label={t.with}>
          <Input id="replace-with" value={replace} onChange={(e) => setReplace(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" disabled={!find} aria-haspopup="dialog">
          {locale.create.review}
        </Button>
      </form>
      <DdlPreviewDialog flow={flow} />
    </section>
  )
}
