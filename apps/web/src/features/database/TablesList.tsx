import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { CellValue } from '@/components/cells/CellValue.tsx'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import { sessionQuery, tablesQuery } from '@/lib/queries.ts'
import { TableBulkBar } from './TableBulkBar.tsx'
import { tableTotals } from './table-totals.ts'

export function TablesList({ db, schema }: { db: string; schema?: string | undefined }) {
  const tables = useQuery(tablesQuery(db, schema))
  const dialect = useQuery(sessionQuery).data?.dialect ?? 'mysql'
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
  const totals = tableTotals(tables.data)
  return (
    <div className="space-y-3">
      {/* Always mounted: a live region that appears together with its text announces nothing. */}
      <output aria-live="polite" className="sr-only">
        {chosen.length > 0 ? locale.ddl.bulkSelected(chosen.length) : ''}
      </output>
      <DdlPreviewDialog flow={flow} bulkConfirmName={db} />
      <Table>
        <thead>
          <tr>
            <Th>
              <input
                type="checkbox"
                aria-label={locale.browse.selectAll}
                checked={allChecked}
                ref={(el) => {
                  if (el) el.indeterminate = chosen.length > 0 && !allChecked
                }}
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
        <tfoot>
          <tr className="font-semibold">
            <Td />
            <th scope="row" colSpan={2} className="border-b border-line px-2 py-1 text-left text-ink">
              {locale.database.total(totals.count)}
            </th>
            <Td className="text-right tabular-nums">
              {totals.rows === null ? '–' : totals.rows.toLocaleString('ja-JP')}
            </Td>
            <Td className="whitespace-nowrap text-right tabular-nums">
              {totals.bytes === null ? '–' : locale.common.bytes(totals.bytes)}
            </Td>
            {/* engine (MySQL only), comment, actions */}
            <Td colSpan={hasEngine ? 3 : 2} />
          </tr>
        </tfoot>
      </Table>
      {/* Below the table, next to the last checkbox in tab order (phpMyAdmin's "With selected" position). */}
      {chosen.length > 0 ? (
        <TableBulkBar db={db} schema={schema} dialect={dialect} chosen={chosen} onPreview={flow.preview} />
      ) : null}
    </div>
  )
}
