import { useQuery } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import type { ExportOptions, ExportTemplate, ExportTemplateBody, TableInfo } from '@tsmyadmin/shared'
import { EXPORT_TEMPLATE_MAX_TABLES, ExportOptionsSchema, SINGLE_TABLE_FORMATS } from '@tsmyadmin/shared'
import { Download } from 'lucide-react'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { tablesQuery } from '@/lib/queries.ts'
import { CsvFields, FormatFields, OutputFields, SqlFields } from './ExportOptionFields.tsx'
import { ExportTemplatesPanel } from './ExportTemplatesPanel.tsx'
import { applyTemplate } from './export-templates.ts'
import { exportUrl } from './export-url.ts'

/** Under the 8 KB request-line limit common to proxies and Bun's header buffer. */
const MAX_EXPORT_URL_LENGTH = 6000

export interface ExportFormProps {
  db: string
  schema?: string | undefined
  /** When set, the form exports just this table (table-level tab). */
  table?: string
  /** Tables ticked in advance (bulk action on the structure page). */
  initialTables?: string[]
}

export function ExportForm({ db, schema, table, initialTables }: ExportFormProps) {
  const { session } = useRouteContext({ from: '/_app' })
  const dialect = session.dialect
  const tables = useQuery({ ...tablesQuery(db, schema), enabled: table === undefined })
  const [selected, setSelected] = useState<string[]>(table ? [table] : (initialTables ?? []))
  const [options, setOptions] = useState<ExportOptions>(() => ExportOptionsSchema.parse({}))
  const set = (patch: Partial<ExportOptions>) => setOptions((o) => ({ ...o, ...patch }))
  const { format } = options
  /** Tables a loaded template named that are no longer there. */
  const [missing, setMissing] = useState<string[]>([])
  // Views are included: SQL dumps carry their CREATE VIEW, CSV/JSON export their rows.
  const available: TableInfo[] = table ? [] : (tables.data ?? [])
  const toggle = (name: string) => {
    // The notice belongs to the template that was loaded; touching the selection answers it.
    setMissing([])
    setSelected((s) => (s.includes(name) ? s.filter((x) => x !== name) : [...s, name]))
  }
  // A table dropped elsewhere since it was ticked must not end up in the URL (the download would just fail).
  const chosen = table ? selected : selected.filter((n) => available.some((t) => t.name === n))
  const effective = table ? [table] : chosen.length > 0 ? chosen : available.map((t) => t.name)
  // CSV is one table at a time; views are left out of the count (a DB with one table and a view still exports).
  const csvTables = table ? [table] : effective.filter((n) => available.find((t) => t.name === n)?.kind === 'table')
  const tableCount = csvTables.length
  const oneTable = SINGLE_TABLE_FORMATS.includes(format)
  // One file per table lifts the limit: each table gets a CSV of its own.
  const csvBlocked = oneTable && !options.filePerTable && tableCount !== 1
  const nothing = effective.length === 0
  const url = exportUrl({
    db,
    schema,
    // Every table ticked = the whole database (routines and events included), so no table list is sent.
    tables: table
      ? [table]
      : oneTable && !options.filePerTable
        ? csvTables
        : chosen.length === available.length
          ? []
          : chosen,
    ...options,
  })
  // The table list travels in the query string; hundreds of ticked tables would exceed what servers accept.
  const tooLong = url.length > MAX_EXPORT_URL_LENGTH
  const current: ExportTemplateBody = {
    database: db,
    ...(schema ? { schema } : {}),
    // What is ticked, not what that expands to: "every table" stays true as the database grows.
    tables: chosen,
    options,
  }
  const load = (template: ExportTemplate) => {
    const applied = applyTemplate(
      template,
      available.map((t) => t.name)
    )
    setSelected(applied.tables)
    setMissing(applied.missing)
    setOptions(template.options)
  }
  const blockedReason = csvBlocked
    ? locale.export.csvSingle
    : nothing
      ? locale.export.nothing
      : tooLong
        ? locale.export.selectionTooLong
        : null
  const reasonId = useId()

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-ink">{locale.export.title}</h2>
      {table ? null : tables.isPending ? (
        <Spinner />
      ) : tables.isError ? (
        <ErrorBox error={tables.error} onRetry={() => void tables.refetch()} />
      ) : (
        <fieldset>
          <legend className="mb-1 text-xs font-medium text-ink-sub">
            {locale.export.tables}{' '}
            <span className="font-normal text-ink-sub">
              ({chosen.length === 0 ? locale.export.allTables : chosen.length})
            </span>
          </legend>
          <div className="mb-1 flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                setMissing([])
                setSelected(available.map((t) => t.name))
              }}
            >
              {locale.export.selectAll}
            </Button>
            {/* Never disabled: a control that disables itself under the keyboard drops the focus to the page. */}
            <Button
              size="sm"
              onClick={() => {
                setMissing([])
                setSelected([])
              }}
            >
              {locale.export.selectNone}
            </Button>
          </div>
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
      <FormatFields options={options} set={set} />
      {format === 'sql' ? (
        <SqlFields
          options={options}
          set={set}
          dialect={dialect}
          triggersOnly={Boolean(table) || (chosen.length > 0 && chosen.length < available.length)}
        />
      ) : null}
      {format === 'markdown' ? <p className="text-xs text-ink-sub">{locale.export.markdownHint}</p> : null}
      {format === 'latex' || format === 'texy' || format === 'mediawiki' || format === 'html' ? (
        <p className="text-xs text-ink-sub">
          {format === 'html' ? locale.export.htmlHint : locale.export.documentHint}
        </p>
      ) : null}
      {format === 'ods' || format === 'odt' || format === 'docx' ? (
        <p className="text-xs text-ink-sub">{locale.export.officeHint}</p>
      ) : null}
      {format === 'csv' || format === 'csvExcel' ? <CsvFields options={options} set={set} /> : null}
      <OutputFields options={options} set={set} />
      {table ? null : (
        <ExportTemplatesPanel
          db={db}
          schema={schema}
          current={current}
          // A selection too long for the URL, or for a template, would be stored and then refused on the way back.
          canSave={!tooLong && chosen.length <= EXPORT_TEMPLATE_MAX_TABLES}
          onLoad={load}
        />
      )}
      {missing.length > 0 ? <Notice role="status">{locale.export.templates.missing(missing.join(', '))}</Notice> : null}
      {/* The reason a download is refused stays attached to the (focusable) control, and is announced as it appears. */}
      {blockedReason ? (
        <Notice id={reasonId} role="status">
          {blockedReason}
        </Notice>
      ) : null}
      <p className="text-xs text-ink-sub">{locale.export.snapshotNote}</p>
      {blockedReason ? (
        <Button variant="primary" aria-disabled aria-describedby={reasonId}>
          <Download className="size-4" aria-hidden />
          {locale.export.download}
        </Button>
      ) : (
        <a
          href={url}
          download
          className="inline-flex items-center gap-1 rounded-control bg-brand px-3 py-1.5 text-sm font-medium text-brand-ink hover:bg-brand-hover"
        >
          <Download className="size-4" aria-hidden />
          {locale.export.download}
        </a>
      )}
    </div>
  )
}
