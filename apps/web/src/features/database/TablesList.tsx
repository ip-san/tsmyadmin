import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { encodeTableList } from '@tsmyadmin/shared'
import { useState } from 'react'
import { CellValue } from '@/components/cells/CellValue.tsx'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import { tablesQuery } from '@/lib/queries.ts'

export function TablesList({ db, schema }: { db: string; schema?: string | undefined }) {
  const tables = useQuery(tablesQuery(db, schema))
  // Bulk selection (tables only — views cannot be truncated and have their own DROP).
  const [selected, setSelected] = useState<string[]>([])
  const flow = useDdlFlow(db, schema, () => setSelected([]))
  if (tables.isPending) return <Spinner />
  if (tables.isError) return <ErrorBox error={tables.error} onRetry={() => void tables.refetch()} />
  if (tables.data.length === 0) return <Notice>{locale.database.noTables}</Notice>
  const search = schema ? { schema } : {}
  const link = 'text-blue-700 hover:underline dark:text-blue-300'
  // PostgreSQL has no storage engine: the column would be a row of dashes.
  const hasEngine = tables.data.some((t) => t.engine !== null)
  const plain = tables.data.filter((t) => t.kind === 'table').map((t) => t.name)
  const chosen = selected.filter((n) => plain.includes(n))
  const toggle = (name: string) => setSelected((s) => (s.includes(name) ? s.filter((n) => n !== name) : [...s, name]))
  const allChecked = plain.length > 0 && chosen.length === plain.length
  return (
    <div className="space-y-3">
      <DdlPreviewDialog flow={flow} bulkConfirmName={db} />
      <Table>
        <thead>
          <tr>
            <Th>
              <input
                type="checkbox"
                aria-label={locale.browse.selectAll}
                checked={allChecked}
                disabled={plain.length === 0}
                onChange={() => setSelected(allChecked ? [] : plain)}
              />
            </Th>
            <Th>{locale.database.table}</Th>
            <Th>{locale.database.kind}</Th>
            <Th className="text-right">{locale.database.rowEstimate}</Th>
            <Th className="text-right">{locale.database.size}</Th>
            {hasEngine ? <Th>{locale.database.engine}</Th> : null}
            <Th>{locale.database.comment}</Th>
            <Th>{locale.database.actions}</Th>
          </tr>
        </thead>
        <tbody>
          {tables.data.map((t) => (
            <Tr key={t.name}>
              <Td>
                {t.kind === 'table' ? (
                  <input
                    type="checkbox"
                    aria-label={locale.ddl.selectTable(t.name)}
                    checked={chosen.includes(t.name)}
                    onChange={() => toggle(t.name)}
                  />
                ) : null}
              </Td>
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
              <Td className="whitespace-nowrap">{locale.database.kinds[t.kind]}</Td>
              <Td className="text-right tabular-nums">
                {t.rowEstimate === null ? '–' : t.rowEstimate.toLocaleString('ja-JP')}
              </Td>
              <Td className="whitespace-nowrap text-right tabular-nums">
                {t.sizeBytes === null ? '–' : locale.common.bytes(t.sizeBytes)}
              </Td>
              {hasEngine ? <Td>{t.engine ?? '–'}</Td> : null}
              <Td className="max-w-xs">
                <CellValue cell={t.comment ?? ''} />
              </Td>
              <Td>
                <span className="flex gap-2 whitespace-nowrap text-xs">
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
                  <Link
                    to="/db/$db/table/$table/search"
                    params={{ db, table: t.name }}
                    search={search}
                    className={link}
                  >
                    {locale.tabs.search}
                  </Link>
                  <Link
                    to="/db/$db/table/$table/insert"
                    params={{ db, table: t.name }}
                    search={search}
                    className={link}
                  >
                    {locale.tabs.insert}
                  </Link>
                </span>
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      {/* Below the table, next to the last checkbox in tab order (phpMyAdmin's "With selected" position). */}
      {chosen.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800">
          <span aria-live="polite">{locale.ddl.bulkSelected(chosen.length)}</span>
          <Link
            to="/db/$db/export"
            params={{ db }}
            search={{ ...search, tables: encodeTableList(chosen) }}
            className={`text-xs ${link}`}
          >
            {locale.ddl.bulkExport}
          </Link>
          <Button
            size="sm"
            variant="danger"
            aria-haspopup="dialog"
            onClick={() => flow.preview({ op: 'truncateTables', tables: chosen })}
          >
            {locale.ddl.bulkTruncate}
          </Button>
          <Button
            size="sm"
            variant="danger"
            aria-haspopup="dialog"
            onClick={() => flow.preview({ op: 'dropTables', tables: chosen })}
          >
            {locale.ddl.bulkDrop}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
