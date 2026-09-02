import { useQuery } from '@tanstack/react-query'
import type { ExportFormat, TableInfo } from '@tsmyadmin/shared'
import { ExportFormatSchema } from '@tsmyadmin/shared'
import { Download } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { tablesQuery } from '@/lib/queries.ts'
import { exportUrl } from './export-url.ts'

export interface ExportFormProps {
  db: string
  schema?: string | undefined
  /** When set, the form exports just this table (table-level tab). */
  table?: string
}

export function ExportForm({ db, schema, table }: ExportFormProps) {
  const tables = useQuery({ ...tablesQuery(db, schema), enabled: table === undefined })
  const [selected, setSelected] = useState<string[]>(table ? [table] : [])
  const [format, setFormat] = useState<ExportFormat>('sql')
  const [structure, setStructure] = useState(true)
  const [dropTable, setDropTable] = useState(true)
  const [data, setData] = useState(true)
  const [bom, setBom] = useState(true)
  // Views are included: SQL dumps carry their CREATE VIEW, CSV/JSON export their rows.
  const available: TableInfo[] = table ? [] : (tables.data ?? [])
  const toggle = (name: string) => setSelected((s) => (s.includes(name) ? s.filter((x) => x !== name) : [...s, name]))
  const effective = table ? [table] : selected.length > 0 ? selected : available.map((t) => t.name)
  // CSV is one table at a time; views are left out of the count (a DB with one table and a view still exports).
  const csvTables = table ? [table] : effective.filter((n) => available.find((t) => t.name === n)?.kind === 'table')
  const tableCount = csvTables.length
  const csvBlocked = format === 'csv' && tableCount !== 1
  const nothing = effective.length === 0
  const url = exportUrl({
    db,
    schema,
    tables: table ? [table] : format === 'csv' ? csvTables : selected,
    format,
    structure,
    dropTable,
    data,
    bom,
  })

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{locale.export.title}</h2>
      {table ? null : tables.isPending ? (
        <Spinner />
      ) : tables.isError ? (
        <ErrorBox error={tables.error} onRetry={() => void tables.refetch()} />
      ) : (
        <fieldset>
          <legend className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-300">
            {locale.export.tables}{' '}
            <span className="font-normal text-zinc-500 dark:text-zinc-400">
              ({selected.length === 0 ? locale.export.allTables : selected.length})
            </span>
          </legend>
          <div className="flex flex-wrap gap-3 text-sm">
            {available.map((t) => (
              <label key={t.name} className="flex items-center gap-1">
                <input type="checkbox" checked={selected.includes(t.name)} onChange={() => toggle(t.name)} />
                {t.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <fieldset>
        <legend className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-300">{locale.export.format}</legend>
        <div className="flex gap-4 text-sm">
          {ExportFormatSchema.options.map((f) => (
            <label key={f} className="flex items-center gap-1">
              <input type="radio" name="export-format" value={f} checked={format === f} onChange={() => setFormat(f)} />
              {locale.export.formats[f]}
            </label>
          ))}
        </div>
      </fieldset>
      {format === 'sql' ? (
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={structure} onChange={(e) => setStructure(e.target.checked)} />
            {locale.export.structure}
          </label>
          <label className="ml-4 flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={dropTable}
              disabled={!structure}
              onChange={(e) => setDropTable(e.target.checked)}
            />
            {locale.export.dropTable}
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={data} onChange={(e) => setData(e.target.checked)} />
            {locale.export.data}
          </label>
        </div>
      ) : null}
      {format === 'csv' ? (
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={bom} onChange={(e) => setBom(e.target.checked)} />
          {locale.export.bom}
        </label>
      ) : null}
      {csvBlocked ? <Notice>{locale.export.csvSingle}</Notice> : null}
      {nothing ? <Notice>{locale.export.nothing}</Notice> : null}
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{locale.export.snapshotNote}</p>
      {csvBlocked || nothing ? (
        <Button variant="primary" disabled>
          <Download className="size-4" aria-hidden />
          {locale.export.download}
        </Button>
      ) : (
        <a
          href={url}
          download
          className="inline-flex items-center gap-1 rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700"
        >
          <Download className="size-4" aria-hidden />
          {locale.export.download}
        </a>
      )}
    </div>
  )
}
