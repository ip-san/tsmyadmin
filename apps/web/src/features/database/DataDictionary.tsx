import { useQueries, useQuery } from '@tanstack/react-query'
import type { TableSchema } from '@tsmyadmin/shared'
import { Printer } from 'lucide-react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { structureQuery, tablesQuery } from '@/lib/queries.ts'

const t = locale.dictionary

/** What a column references, as `table.column` (the first key a column takes part in). */
export function referencesOf(schema: Pick<TableSchema, 'foreignKeys'>): Map<string, string> {
  const out = new Map<string, string>()
  for (const fk of schema.foreignKeys)
    fk.columns.forEach((c, i) => {
      if (!out.has(c)) out.set(c, `${fk.refTable}.${fk.refColumns[i] ?? ''}`)
    })
  return out
}

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
  const structures = useQueries({ queries: names.map((table) => structureQuery({ db, schema, table })) })
  if (tables.isPending) return <Spinner />
  if (tables.isError) return <ErrorBox error={tables.error} onRetry={() => void tables.refetch()} />
  if (names.length === 0) return <Notice>{locale.database.noTables}</Notice>
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between print:hidden">
        <p className="text-sm text-ink-sub">{t.hint}</p>
        <Button size="sm" onClick={() => window.print()}>
          <Printer className="size-3.5" aria-hidden />
          {t.print}
        </Button>
      </div>
      <h2 className="text-lg font-semibold text-ink">{t.title(schema ? `${db}.${schema}` : db)}</h2>
      {structures.map((s, i) =>
        s.data ? (
          <TableEntry key={names[i]} schema={s.data} />
        ) : s.isError ? (
          <ErrorBox key={names[i]} error={s.error} />
        ) : (
          <Spinner key={names[i]} />
        )
      )}
    </div>
  )
}
