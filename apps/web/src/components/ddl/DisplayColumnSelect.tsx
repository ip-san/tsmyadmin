import { useState } from 'react'
import { Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { chooseDisplayColumn, chosenDisplayColumn } from '@/lib/display-column.ts'
import type { TableRef } from '@/lib/queries.ts'

/** This table's display column: what names its rows beside another table's foreign key values. */
export function DisplayColumnSelect({
  tableRef,
  columns,
  onChange,
}: {
  tableRef: TableRef
  columns: string[]
  onChange?: () => void
}) {
  const [chosen, setChosen] = useState(() => chosenDisplayColumn(tableRef) ?? '')
  return (
    <label className="flex items-center gap-1 text-xs text-ink-sub" title={locale.table.displayColumnHint}>
      {locale.table.displayColumn}
      <Select
        value={columns.includes(chosen) ? chosen : ''}
        onChange={(e) => {
          setChosen(e.target.value)
          chooseDisplayColumn(tableRef, e.target.value || undefined)
          onChange?.()
        }}
        className="w-auto py-1"
      >
        <option value="">{locale.table.displayColumnAuto}</option>
        {columns.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </Select>
    </label>
  )
}
