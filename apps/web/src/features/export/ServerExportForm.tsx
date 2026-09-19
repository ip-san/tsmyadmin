import { useQuery } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import type { ExportOptions } from '@tsmyadmin/shared'
import { Download } from 'lucide-react'
import { useId, useState } from 'react'
import { OutputFields, SqlFields } from '@/components/export/ExportOptionFields.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { databasesQuery, schemasQuery } from '@/lib/queries.ts'
import { exportDefaults } from '@/lib/settings.ts'
import { serverExportUrl } from './export-url.ts'

/** The URL carries every name: a few hundred databases would exceed what servers accept. */
const MAX_URL_LENGTH = 6000

/** One SQL dump of several databases (MySQL) or schemas (PostgreSQL), each with its own CREATE DATABASE / SCHEMA. */
export function ServerExportForm() {
  const { session } = useRouteContext({ from: '/_app' })
  const mysql = session.dialect === 'mysql'
  // PostgreSQL is connected to one database: its schemas are what a dump can span.
  const databases = useQuery({ ...databasesQuery, enabled: mysql })
  const schemas = useQuery({ ...schemasQuery(session.database ?? ''), enabled: !mysql })
  const listing = mysql ? databases : schemas
  const names = mysql ? (databases.data ?? []).map((d) => d.name) : (schemas.data ?? [])
  const [selected, setSelected] = useState<string[]>([])
  const [options, setOptions] = useState<ExportOptions>(exportDefaults)
  const set = (patch: Partial<ExportOptions>) => setOptions((o) => ({ ...o, ...patch }))
  const chosen = selected.filter((n) => names.includes(n))
  const url = serverExportUrl(chosen, options)
  const blockedReason =
    chosen.length === 0
      ? locale.export.server.nothing
      : url.length > MAX_URL_LENGTH
        ? locale.export.selectionTooLong
        : null
  const reasonId = useId()
  const toggle = (name: string) => setSelected((s) => (s.includes(name) ? s.filter((x) => x !== name) : [...s, name]))

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-ink">{locale.export.server.title}</h2>
      <p className="text-xs text-ink-sub">{locale.export.server.hint}</p>
      {listing.isPending ? (
        <Spinner />
      ) : listing.isError ? (
        <ErrorBox error={listing.error} onRetry={() => void listing.refetch()} />
      ) : (
        <fieldset>
          <legend className="mb-1 text-xs font-medium text-ink-sub">
            {mysql ? locale.export.server.databases : locale.export.server.schemas} ({chosen.length})
          </legend>
          <div className="mb-1 flex gap-2">
            <Button size="sm" onClick={() => setSelected(names)}>
              {locale.export.selectAll}
            </Button>
            <Button size="sm" onClick={() => setSelected([])}>
              {locale.export.selectNone}
            </Button>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
            {names.map((name) => (
              <label key={name} className="flex items-center gap-1">
                <input type="checkbox" checked={selected.includes(name)} onChange={() => toggle(name)} />
                {name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <SqlFields options={options} set={set} dialect={session.dialect} triggersOnly={false} server />
      <OutputFields
        options={options}
        set={set}
        filePerLabel={mysql ? locale.export.server.filePerTarget : locale.export.server.filePerSchema}
      />
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
