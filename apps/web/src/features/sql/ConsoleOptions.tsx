import { useId } from 'react'
import { Select } from '@/components/ui/Field.tsx'
import { locale, numberLocale } from '@/config/locale.ts'
import { sharePreference } from '@/lib/account-prefs.ts'
import { writePreference } from '@/lib/preferences.ts'

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
            {n.toLocaleString(numberLocale)}
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

/** Where the safe-mode choice is kept in this browser. */
export const SAFE_MODE_PREF = 'sql.safeMode'

/** Asks before an UPDATE / DELETE with no WHERE runs. Kept in this browser and, where sessions are persistent, with the account. */
export function SafeModeOption({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex items-center gap-1 text-xs text-ink-sub" title={locale.sql.safeModeHint}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => {
          onChange(e.target.checked)
          writePreference(SAFE_MODE_PREF, e.target.checked)
          sharePreference({ sqlSafeMode: e.target.checked })
        }}
      />
      {locale.sql.safeMode}
    </label>
  )
}
