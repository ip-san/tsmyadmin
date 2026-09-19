import { useQuery } from '@tanstack/react-query'
import { type BrowseOptions, encodeSort } from '@tsmyadmin/shared'
import { useId } from 'react'
import { Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { structureQuery, type TableRef } from '@/lib/queries.ts'

type Sort = BrowseOptions['sort']

/** The sort an index gives, all its columns one way; expression parts (no column name) cannot be sorted by. */
export function indexSort(columns: string[], direction: 'asc' | 'desc'): Sort | null {
  if (columns.length === 0 || columns.some((c) => c.startsWith('('))) return null
  return columns.map((column) => ({ column, direction }))
}

/** phpMyAdmin's "Sort by key": the rows in the order of an index, either way. */
export function IndexSort({
  tableRef,
  sort,
  onSort,
}: {
  tableRef: TableRef
  sort: Sort
  onSort: (sort: string | undefined) => void
}) {
  const id = useId()
  const structure = useQuery(structureQuery(tableRef))
  const choices = (structure.data?.indexes ?? []).flatMap((i) =>
    (['asc', 'desc'] as const).flatMap((direction) => {
      const s = indexSort(i.columns, direction)
      return s ? [{ value: encodeSort(s), label: locale.browse.byIndex(i.name, direction === 'asc') }] : []
    })
  )
  if (choices.length === 0) return null
  const current = encodeSort(sort)
  return (
    <label htmlFor={id} className="flex items-center gap-1 text-xs text-ink-sub">
      {locale.browse.sortByKey}
      <Select
        id={id}
        value={choices.some((c) => c.value === current) ? current : ''}
        onChange={(e) => onSort(e.target.value || undefined)}
        className="w-auto py-1"
      >
        <option value="">{locale.browse.noKeySort}</option>
        {choices.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </Select>
    </label>
  )
}
