import type { BrowseOptions } from '@tsmyadmin/shared'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { Th } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { cn } from '@/lib/cn.ts'
import { nextSort } from './sort.ts'

export interface SortHeaderProps {
  column: { name: string; dataType: string }
  sort: BrowseOptions['sort']
  onSort: (sort: string | undefined) => void
}

/** Sortable column header: click cycles asc → desc → none, shift-click adds the column to a multi-column sort. */
export function SortHeader({ column, sort, onSort }: SortHeaderProps) {
  const index = sort.findIndex((s) => s.column === column.name)
  const entry = index === -1 ? undefined : sort[index]
  const dir = entry?.direction
  return (
    <Th aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}>
      <button
        type="button"
        className={cn('inline-flex items-center gap-1 hover:underline', entry && 'text-blue-700 dark:text-blue-300')}
        onClick={(e) => onSort(nextSort(sort, column.name, e.shiftKey))}
        title={`${
          dir === 'asc' ? locale.browse.sortDesc : dir === 'desc' ? locale.browse.clearSort : locale.browse.sortAsc
        }${locale.browse.multiSortHint}`}
      >
        {column.name}
        {dir === 'asc' ? (
          <ArrowUp className="size-3" aria-hidden />
        ) : dir === 'desc' ? (
          <ArrowDown className="size-3" aria-hidden />
        ) : null}
        {entry && sort.length > 1 ? (
          <span className="text-[10px] tabular-nums">
            <span aria-hidden>{index + 1}</span>
            <span className="sr-only">{locale.browse.sortOrder(index + 1)}</span>
          </span>
        ) : null}
      </button>
      <span className="ml-1 font-normal text-zinc-600 dark:text-zinc-400">{column.dataType}</span>
    </Th>
  )
}
