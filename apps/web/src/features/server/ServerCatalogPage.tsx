import { useQuery } from '@tanstack/react-query'
import type { Dialect, ServerCatalogKind } from '@tsmyadmin/shared'
import { useDeferredValue, useState } from 'react'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Input } from '@/components/ui/Field.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { serverCatalogQuery } from '@/lib/queries.ts'

const t = locale.catalog

/** Rows with any cell containing the text (case-insensitive); all of them for an empty filter. */
export function filterRows(rows: (string | null)[][], filter: string): (string | null)[][] {
  const q = filter.trim().toLowerCase()
  if (!q) return rows
  return rows.filter((r) => r.some((c) => c?.toLowerCase().includes(q)))
}

/**
 * phpMyAdmin's Charsets / Engines / Plugins tabs. PostgreSQL has neither engines nor plugins, so the same places
 * show its access methods and extensions, under their own names.
 */
export function ServerCatalogPage({ kind, dialect }: { kind: ServerCatalogKind; dialect: Dialect }) {
  const catalog = useQuery(serverCatalogQuery(kind))
  const [filter, setFilter] = useState('')
  // Collations run to several hundred rows (PostgreSQL with ICU: well over a thousand).
  const deferred = useDeferredValue(filter)
  const title = t.titles[kind][dialect]
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
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <Tr key={JSON.stringify(row)}>
                {row.map((cell, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns are fixed per kind; the position is the column
                  <Td key={i} className={i === 0 ? 'font-mono text-xs' : 'text-xs'}>
                    {cell ?? ''}
                  </Td>
                ))}
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  )
}
