import { useQuery } from '@tanstack/react-query'
import type { Dialect, ServerCatalogKind } from '@tsmyadmin/shared'
import { Fragment, useDeferredValue, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Input } from '@/components/ui/Field.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { serverCatalogQuery, variablesQuery } from '@/lib/queries.ts'

const t = locale.catalog

/** Rows with any cell containing the text (case-insensitive); all of them for an empty filter. */
export function filterRows(rows: (string | null)[][], filter: string): (string | null)[][] {
  const q = filter.trim().toLowerCase()
  if (!q) return rows
  return rows.filter((r) => r.some((c) => c?.toLowerCase().includes(q)))
}

/** The server variables that belong to a storage engine: those named with its prefix (`innodb_…`, `myisam_…`). */
function EngineVariables({ engine }: { engine: string }) {
  const variables = useQuery(variablesQuery)
  if (variables.isPending) return <Spinner />
  if (variables.isError) return <ErrorBox error={variables.error} onRetry={() => void variables.refetch()} />
  const prefix = `${engine.toLowerCase()}_`
  const rows = variables.data.filter((v) => v.name.toLowerCase().startsWith(prefix))
  if (rows.length === 0) return <Notice>{t.noEngineVariables(engine)}</Notice>
  return (
    <Table aria-label={t.engineVariables(engine)}>
      <thead>
        <tr>
          <Th>{locale.server.name}</Th>
          <Th>{locale.server.value}</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((v) => (
          <Tr key={v.name}>
            <Td className="font-mono text-xs">{v.name}</Td>
            <Td className="font-mono text-xs">{v.value}</Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  )
}

/**
 * phpMyAdmin's Charsets / Engines / Plugins tabs. PostgreSQL has neither engines nor plugins, so the same places
 * show its access methods and extensions, under their own names.
 */
export function ServerCatalogPage({ kind, dialect }: { kind: ServerCatalogKind; dialect: Dialect }) {
  const catalog = useQuery(serverCatalogQuery(kind))
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  // Collations run to several hundred rows (PostgreSQL with ICU: well over a thousand).
  const deferred = useDeferredValue(filter)
  const title = t.titles[kind][dialect]
  const withVariables = kind === 'engines' && dialect === 'mysql'
  if (catalog.isPending) return <Spinner />
  if (catalog.isError) return <ErrorBox error={catalog.error} onRetry={() => void catalog.refetch()} />
  const shown = filterRows(catalog.data.rows, deferred)
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      <p className="text-xs text-ink-sub">{t.hints[kind][dialect]}</p>
      <Input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={t.filter}
        aria-label={t.filter}
        className="max-w-sm"
      />
      <output aria-live="polite" className="sr-only">
        {filter.trim() !== '' ? locale.nav.matchCount(shown.length, catalog.data.rows.length) : ''}
      </output>
      {shown.length === 0 ? (
        <Notice>{locale.server.noMatch}</Notice>
      ) : (
        <Table aria-label={title}>
          <thead>
            <tr>
              {catalog.data.columns.map((c) => (
                <Th key={c}>{t.columns[c]}</Th>
              ))}
              {withVariables ? <Th data-print-hide>{locale.ddl.actions}</Th> : null}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => {
              const engine = row[0] ?? ''
              return (
                <Fragment key={JSON.stringify(row)}>
                  <Tr>
                    {row.map((cell, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: columns are fixed per kind; the position is the column
                      <Td key={i} className={i === 0 ? 'font-mono text-xs' : 'text-xs'}>
                        {cell ?? ''}
                      </Td>
                    ))}
                    {withVariables ? (
                      <Td data-print-hide>
                        <Button
                          size="sm"
                          aria-expanded={open === engine}
                          aria-label={`${engine}: ${t.showVariables}`}
                          onClick={() => setOpen(open === engine ? null : engine)}
                        >
                          {t.showVariables}
                        </Button>
                      </Td>
                    ) : null}
                  </Tr>
                  {withVariables && open === engine ? (
                    <Tr>
                      <Td colSpan={row.length + 1}>
                        <EngineVariables engine={engine} />
                      </Td>
                    </Tr>
                  ) : null}
                </Fragment>
              )
            })}
          </tbody>
        </Table>
      )}
    </section>
  )
}
