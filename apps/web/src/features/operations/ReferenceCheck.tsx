import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale, numberLocale } from '@/config/locale.ts'
import { useOpenInDatabaseConsole } from '@/lib/open-in-console.ts'
import { referenceCheckQuery, type TableRef } from '@/lib/queries.ts'

const t = locale.ddl.referenceCheck

/**
 * phpMyAdmin's "Check referential integrity": for each foreign key of the table, the rows that name a parent which is
 * not there. Read on request (it scans the table once per key), never on page load.
 */
export function ReferenceCheck({ tableRef }: { tableRef: TableRef }) {
  const checked = useQuery({ ...referenceCheckQuery(tableRef), enabled: false })
  const openInSql = useOpenInDatabaseConsole(tableRef.db, tableRef.schema)
  return (
    <section className="space-y-2 rounded border border-line p-3">
      <p className="text-sm text-ink-sub">{t.hint}</p>
      <Button onClick={() => void checked.refetch()} disabled={checked.isFetching}>
        {t.button}
      </Button>
      {checked.isFetching ? <Spinner /> : null}
      {checked.isError ? <ErrorBox error={checked.error} /> : null}
      {checked.data && !checked.isFetching ? (
        checked.data.length === 0 ? (
          <Notice>{t.noKeys}</Notice>
        ) : (
          <Table aria-label={t.title}>
            <thead>
              <tr>
                <Th>{t.key}</Th>
                <Th>{t.references}</Th>
                <Th className="text-right">{t.orphans}</Th>
                <Th>
                  <span className="sr-only">{locale.ddl.actions}</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {checked.data.map((c) => (
                <Tr key={c.name}>
                  <Td className="font-medium">
                    {c.name} <span className="font-mono text-xs text-ink-sub">({c.columns.join(', ')})</span>
                  </Td>
                  <Td className="font-mono text-xs">
                    {c.refTable} ({c.refColumns.join(', ')})
                  </Td>
                  <Td className="text-right tabular-nums">
                    {c.orphans === 0 ? t.none : c.orphans.toLocaleString(numberLocale)}
                  </Td>
                  <Td>
                    {c.orphans > 0 ? (
                      <Button size="sm" aria-label={t.openLabel(c.name)} onClick={() => openInSql(c.sql)}>
                        {t.open}
                      </Button>
                    ) : null}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )
      ) : null}
    </section>
  )
}
