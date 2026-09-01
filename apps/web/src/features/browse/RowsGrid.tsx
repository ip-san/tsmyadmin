import { useQuery } from '@tanstack/react-query'
import type { BrowseOptions, BrowseResult } from '@tsmyadmin/shared'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { cn } from '@/lib/cn.ts'
import { rowsQuery, type TableRef } from '@/lib/queries.ts'
import { CellValue } from './CellValue.tsx'
import { Pagination } from './Pagination.tsx'

export interface RowsGridProps {
  tableRef: TableRef
  options: BrowseOptions
  page: number
  onChange: (patch: { page?: number; limit?: number; sort?: string | undefined }) => void
}

function nextSort(current: BrowseOptions['sort'], column: string): string | undefined {
  const cur = current[0]
  if (!cur || cur.column !== column) return `${column}:asc`
  if (cur.direction === 'asc') return `${column}:desc`
  return undefined
}

/** Data columns exclude the hidden key column (PG ctid) appended by the adapter. */
export function visibleColumns(result: BrowseResult): BrowseResult['columns'] {
  return result.keyKind === 'ctid' ? result.columns.slice(0, -1) : result.columns
}

export function RowsGrid({ tableRef, options, page, onChange }: RowsGridProps) {
  const rows = useQuery(rowsQuery(tableRef, options))
  if (rows.isPending) return <Spinner />
  if (rows.isError) return <ErrorBox error={rows.error} />
  const data = rows.data
  const columns = visibleColumns(data)
  const sort = options.sort[0]
  return (
    <div className="space-y-2" aria-busy={rows.isFetching}>
      <Pagination page={page} limit={options.limit} total={data.total} shown={data.rows.length} onChange={onChange} />
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{locale.browse.keyHint[data.keyKind]}</p>
      {data.rows.length === 0 ? (
        <Notice>{locale.browse.noRows}</Notice>
      ) : (
        <Table aria-label={tableRef.table}>
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sort?.column === c.name
                const dir = active ? sort?.direction : undefined
                return (
                  <Th key={c.name} aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}>
                    <button
                      type="button"
                      className={cn(
                        'inline-flex items-center gap-1 hover:underline',
                        active && 'text-blue-700 dark:text-blue-300'
                      )}
                      onClick={() => onChange({ sort: nextSort(options.sort, c.name), page: 1 })}
                      title={
                        dir === 'asc'
                          ? locale.browse.sortDesc
                          : dir === 'desc'
                            ? locale.browse.clearSort
                            : locale.browse.sortAsc
                      }
                    >
                      {c.name}
                      {dir === 'asc' ? (
                        <ArrowUp className="size-3" aria-hidden />
                      ) : dir === 'desc' ? (
                        <ArrowDown className="size-3" aria-hidden />
                      ) : null}
                    </button>
                    <span className="ml-1 font-normal text-zinc-400 dark:text-zinc-500">{c.dataType}</span>
                  </Th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, i) => (
              <Tr key={i}>
                {columns.map((c, j) => (
                  <Td key={c.name} className="max-w-md font-mono text-xs">
                    <CellValue cell={row[j] ?? null} />
                  </Td>
                ))}
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  )
}
