import { useId } from 'react'
import { Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'

const MAX_ROWS_OPTIONS = [100, 1000, 10_000]

/** How many rows of each result set the console keeps. */
export function MaxRowsSelect({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const id = useId()
  return (
    <label htmlFor={id} className="ml-auto flex items-center gap-1 text-xs text-ink-sub">
      {locale.sql.maxRows}
      <Select id={id} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-auto py-1">
        {MAX_ROWS_OPTIONS.map((n) => (
          <option key={n} value={n}>
            {n.toLocaleString('ja-JP')}
          </option>
        ))}
      </Select>
    </label>
  )
}

/** Per-stage timing of each statement, on the servers that have it (MySQL / MariaDB). */
export function ProfileOption({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex items-center gap-1 text-xs text-ink-sub" title={locale.sql.profiling.hint}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {locale.sql.profiling.option}
    </label>
  )
}
