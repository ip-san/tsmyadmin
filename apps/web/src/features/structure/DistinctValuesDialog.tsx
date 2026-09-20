import { useQuery } from '@tanstack/react-query'
import { CellValue } from '@/components/cells/CellValue.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale, numberLocale } from '@/config/locale.ts'
import { distinctValuesQuery, type TableRef } from '@/lib/queries.ts'

const t = locale.table.distinct

/** phpMyAdmin's "Show distinct values": what one column holds, and how many rows hold each value. */
export function DistinctValuesDialog({
  tableRef,
  column,
  onClose,
}: {
  tableRef: TableRef
  column: string | null
  onClose: () => void
}) {
  const found = useQuery({ ...distinctValuesQuery(tableRef, column ?? ''), enabled: column !== null })
  return (
    <Dialog open={column !== null} title={column ? t.title(column) : ''} onClose={onClose}>
      {found.isPending ? <Spinner /> : null}
      {found.isError ? <ErrorBox error={found.error} onRetry={() => void found.refetch()} /> : null}
      {found.data ? (
        <div className="space-y-2">
          {found.data.values.length === 0 ? (
            <Notice>{t.none}</Notice>
          ) : (
            <Table aria-label={column ? t.title(column) : ''}>
              <thead>
                <tr>
                  <Th>{locale.rows.value}</Th>
                  <Th className="text-right">{t.count}</Th>
                </tr>
              </thead>
              <tbody>
                {found.data.values.map((v) => (
                  <Tr key={JSON.stringify(v.value)}>
                    <Td className="max-w-xs font-mono text-xs">
                      <CellValue cell={v.value} />
                    </Td>
                    <Td className="text-right tabular-nums">{v.count.toLocaleString(numberLocale)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
          {found.data.truncated ? (
            <p className="text-xs text-ink-sub">{t.truncated(found.data.values.length)}</p>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  )
}
