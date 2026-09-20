import type { BrowseOptions } from '@tsmyadmin/shared'
import { Th } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { SortHeader } from './SortHeader.tsx'

interface GridHeadProps {
  columns: { name: string; dataType: string }[]
  sort: BrowseOptions['sort']
  onSort: (sort: string | undefined) => void
  editable: boolean
  allSelected: boolean
  selectableCount: number
  onToggleAll: () => void
}

export function GridHead({
  columns,
  sort,
  onSort,
  editable,
  allSelected,
  selectableCount,
  onToggleAll,
}: GridHeadProps) {
  return (
    <thead>
      <tr>
        {editable ? (
          <Th className="w-16" data-print-hide>
            <input
              type="checkbox"
              aria-label={locale.browse.selectAll}
              checked={allSelected}
              onChange={onToggleAll}
              disabled={selectableCount === 0}
            />
          </Th>
        ) : null}
        {columns.map((c) => (
          <SortHeader key={c.name} column={c} sort={sort} onSort={onSort} />
        ))}
      </tr>
    </thead>
  )
}

/** The column names again in the middle of a long page (the setting "repeat the header every N rows"); for the eye only. */
export function RepeatedHeader({ columns, editable }: { columns: { name: string }[]; editable: boolean }) {
  return (
    <tr data-repeated-header>
      {editable ? <Th aria-hidden="true" data-print-hide /> : null}
      {columns.map((c) => (
        <Th key={c.name} aria-hidden="true">
          {c.name}
        </Th>
      ))}
    </tr>
  )
}
