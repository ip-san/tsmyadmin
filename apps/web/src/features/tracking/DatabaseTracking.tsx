import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Card } from '@/components/ui/Card.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale, numberLocale } from '@/config/locale.ts'
import { databaseTrackingQuery } from '@/lib/queries.ts'

const t = locale.tracking

/** phpMyAdmin's database-level Tracking: every tracked table, its latest version and what it records. */
export function DatabaseTracking({ db, schema }: { db: string; schema: string | undefined }) {
  const list = useQuery(databaseTrackingQuery(db, schema))
  if (list.isPending) return <Spinner />
  if (list.isError) return <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
  return (
    <Card title={t.tables} bleed>
      {list.data.length === 0 ? (
        <Notice>{t.noTables}</Notice>
      ) : (
        <Table aria-label={t.tables}>
          <thead>
            <tr>
              <Th>{locale.table.name}</Th>
              <Th>{t.latest}</Th>
              <Th>{t.recordedAt}</Th>
              <Th>{t.kinds}</Th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((row) => (
              <Tr key={row.table}>
                <Td>
                  <Link
                    to="/db/$db/table/$table/tracking"
                    params={{ db, table: row.table }}
                    search={schema ? { schema } : {}}
                    className="text-blue-700 underline dark:text-blue-300"
                  >
                    {row.table}
                  </Link>
                </Td>
                <Td className="tabular-nums">{t.versionLabel(row.latest)}</Td>
                <Td className="text-xs tabular-nums">{new Date(row.at).toLocaleString(numberLocale)}</Td>
                <Td className="text-xs">{row.kinds.map((k) => t.kindNames[k]).join(', ')}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  )
}
