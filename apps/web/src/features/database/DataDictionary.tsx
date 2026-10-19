import { useQueries, useQuery } from '@tanstack/react-query'
import type { TableSchema } from '@tsmyadmin/shared'
import { FileDown, Printer } from 'lucide-react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale-screens.ts'
import { downloadText, safeFilename } from '@/lib/download.ts'
import { structureQuery, tablesQuery } from '@/lib/queries.ts'
import { useAllStructures } from '@/lib/use-all-structures.ts'
import { dictionaryMarkdown, referencesOf } from './dictionary-markdown.ts'

const t = locale.dictionary

function TableEntry({ schema }: { schema: TableSchema }) {
  const refs = referencesOf(schema)
  return (
    <section className="break-inside-avoid space-y-2" aria-labelledby={`dict-${schema.name}`}>
      <h3 id={`dict-${schema.name}`} className="text-base font-semibold text-ink">
        {schema.name}
        {schema.comment ? <span className="ml-2 text-sm font-normal text-ink-sub">{schema.comment}</span> : null}
      </h3>
      <Table aria-label={schema.name}>
        <thead>
          <tr>
            <Th>{locale.table.name}</Th>
            <Th>{t.type}</Th>
            <Th>{t.nullable}</Th>
            <Th>{t.default}</Th>
            <Th>{t.references}</Th>
            <Th>{locale.database.comment}</Th>
          </tr>
        </thead>
        <tbody>
          {schema.columns.map((c) => (
            <Tr key={c.name}>
              <Td className="font-medium">
                {c.name}
                {schema.primaryKey.includes(c.name) ? (
                  <span className="ml-1 text-xs text-ink-sub">({t.primary})</span>
                ) : null}
              </Td>
              <Td className="font-mono text-xs">{c.dataType}</Td>
              <Td>{c.nullable ? locale.common.yes : locale.common.no}</Td>
              <Td className="font-mono text-xs">{c.default ?? ''}</Td>
              <Td className="font-mono text-xs">{refs.get(c.name) ?? ''}</Td>
              <Td className="text-xs">{c.comment ?? ''}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      {schema.indexes.length > 0 ? (
        <p className="text-xs text-ink-sub">
          {t.indexes}:{' '}
          {schema.indexes
            .map((i) => `${i.name} (${i.columns.join(', ')})${i.unique ? ` ${t.unique}` : ''}`)
            .join(' / ')}
        </p>
      ) : null}
    </section>
  )
}

/** phpMyAdmin's "Data dictionary": every table's columns and keys on one page, laid out for printing. */
export function DataDictionary({ db, schema }: { db: string; schema: string | undefined }) {
  const tables = useQuery(tablesQuery(db, schema))
  const names = (tables.data ?? []).filter((x) => x.kind === 'table' || x.kind === 'view').map((x) => x.name)
  const structures = useAllStructures(db, schema, names)
  // Each table as it arrives: these only watch what the reading above puts in the cache (they read nothing
  // themselves), so the page fills in a few tables at a time.
  const arrived = useQueries({
    queries: names.map((table) => ({ ...structureQuery({ db, schema, table }), enabled: false })),
  })
  const title = schema ? `${db}.${schema}` : db
  // The previous reading is shown while the list of tables changes (a table made elsewhere): not what is saved.
  const ready = structures.isPlaceholderData ? undefined : structures.data
  if (tables.isPending) return <Spinner />
  if (tables.isError) return <ErrorBox error={tables.error} onRetry={() => void tables.refetch()} />
  if (names.length === 0) return <Notice>{locale.database.noTables}</Notice>
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between print:hidden">
        <p className="text-sm text-ink-sub">{t.hint}</p>
        <div className="flex gap-2">
          {/* There while reading (and said why it waits): a keyboard user who pressed it keeps their place. */}
          <Button
            size="sm"
            aria-disabled={!ready}
            title={ready ? undefined : t.markdownHint}
            onClick={() => {
              if (!ready) return
              const schemas = names.flatMap((n) => ready.byName.get(n) ?? [])
              downloadText(
                safeFilename(`${title.slice(0, 40)}-dictionary`, 'md'),
                dictionaryMarkdown(title, schemas, ready.failed),
                'text/markdown'
              )
            }}
          >
            <FileDown className="size-3.5" aria-hidden />
            {t.markdown}
          </Button>
          <Button size="sm" onClick={() => window.print()}>
            <Printer className="size-3.5" aria-hidden />
            {t.print}
          </Button>
        </div>
      </div>
      <h2 className="text-lg font-semibold text-ink">{t.title(title)}</h2>
      {structures.isError ? <ErrorBox error={structures.error} onRetry={() => void structures.refetch()} /> : null}
      {/* One line, there from the start: how many are read, then nothing once all are (or the reading failed). */}
      <p role="status" className="text-sm text-ink-sub empty:mb-0 print:hidden">
        {ready || structures.isError ? '' : t.progress(arrived.filter((a) => a.data).length, names.length)}
      </p>
      {ready && ready.failed.length > 0 ? <Notice>{t.failed(ready.failed)}</Notice> : null}
      {arrived.map((a, i) => (a.data ? <TableEntry key={names[i]} schema={a.data} /> : null))}
    </div>
  )
}
