import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CellValue } from '@/components/cells/CellValue.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { tablesQuery } from '@/lib/queries.ts'

export function TablesList({ db, schema }: { db: string; schema?: string | undefined }) {
  const tables = useQuery(tablesQuery(db, schema))
  if (tables.isPending) return <Spinner />
  if (tables.isError) return <ErrorBox error={tables.error} onRetry={() => void tables.refetch()} />
  if (tables.data.length === 0) return <Notice>{locale.database.noTables}</Notice>
  const search = schema ? { schema } : {}
  const link = 'text-blue-700 hover:underline dark:text-blue-300'
  // PostgreSQL has no storage engine: the column would be a row of dashes.
  const hasEngine = tables.data.some((t) => t.engine !== null)
  return (
    <Table>
      <thead>
        <tr>
          <Th>{locale.database.table}</Th>
          <Th>{locale.database.kind}</Th>
          <Th className="text-right">{locale.database.rowEstimate}</Th>
          {hasEngine ? <Th>{locale.database.engine}</Th> : null}
          <Th>{locale.database.comment}</Th>
          <Th>{locale.database.actions}</Th>
        </tr>
      </thead>
      <tbody>
        {tables.data.map((t) => (
          <Tr key={t.name}>
            <Td>
              <Link
                to="/db/$db/table/$table"
                params={{ db, table: t.name }}
                search={search}
                className={`font-medium ${link}`}
              >
                {t.name}
              </Link>
            </Td>
            <Td>{locale.database.kinds[t.kind]}</Td>
            <Td className="text-right tabular-nums">
              {t.rowEstimate === null ? '–' : t.rowEstimate.toLocaleString('ja-JP')}
            </Td>
            {hasEngine ? <Td>{t.engine ?? '–'}</Td> : null}
            <Td className="max-w-xs">
              <CellValue cell={t.comment ?? ''} />
            </Td>
            <Td>
              <span className="flex gap-2 text-xs">
                <Link to="/db/$db/table/$table" params={{ db, table: t.name }} search={search} className={link}>
                  {locale.tabs.browse}
                </Link>
                <Link
                  to="/db/$db/table/$table/structure"
                  params={{ db, table: t.name }}
                  search={search}
                  className={link}
                >
                  {locale.tabs.structure}
                </Link>
                <Link to="/db/$db/table/$table/search" params={{ db, table: t.name }} search={search} className={link}>
                  {locale.tabs.search}
                </Link>
                <Link to="/db/$db/table/$table/insert" params={{ db, table: t.name }} search={search} className={link}>
                  {locale.tabs.insert}
                </Link>
              </span>
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  )
}
