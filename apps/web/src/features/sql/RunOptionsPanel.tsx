import type { Dialect } from '@tsmyadmin/shared'
import { Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { findParameters, isValidDelimiter, type RunOptions } from '@/lib/sql-prepare.ts'

const t = locale.sql.runOptions

/**
 * phpMyAdmin's SQL options beyond the statement: its delimiter, whether to keep what it does (a transaction that
 * is rolled back when the script ends), foreign key checks, and values for the `:name` placeholders it holds.
 */
export function RunOptionsPanel({
  dialect,
  text,
  options,
  onChange,
}: {
  dialect: Dialect
  text: string
  options: RunOptions
  onChange: (next: RunOptions) => void
}) {
  const names = findParameters(text)
  const delimiterOk = isValidDelimiter(options.delimiter)
  return (
    <details className="rounded border border-line px-3 py-2 text-sm print:hidden">
      <summary className="cursor-pointer text-xs font-medium text-ink">
        {t.title}
        {names.length > 0 ? ` (${t.parameterCount(names.length)})` : ''}
      </summary>
      <div className="mt-2 flex flex-wrap items-end gap-x-6 gap-y-2">
        {dialect === 'mysql' ? (
          <label className="flex items-center gap-1 text-xs text-ink-sub" title={t.delimiterHint}>
            {t.delimiter}
            <Input
              value={options.delimiter}
              onChange={(e) => onChange({ ...options, delimiter: e.target.value })}
              aria-invalid={!delimiterOk}
              className="w-20 py-1 font-mono"
              autoComplete="off"
            />
          </label>
        ) : null}
        <label className="flex items-center gap-1 text-xs text-ink-sub" title={t.rollbackHint[dialect]}>
          <input
            type="checkbox"
            checked={options.rollback}
            onChange={(e) => onChange({ ...options, rollback: e.target.checked })}
          />
          {t.rollback}
        </label>
        <label className="flex items-center gap-1 text-xs text-ink-sub" title={t.foreignKeyChecksHint[dialect]}>
          <input
            type="checkbox"
            checked={options.foreignKeyChecks}
            onChange={(e) => onChange({ ...options, foreignKeyChecks: e.target.checked })}
          />
          {t.foreignKeyChecks}
        </label>
      </div>
      {names.length > 0 ? (
        <fieldset className="mt-3 space-y-1">
          <legend className="text-xs text-ink-sub">{t.parameters}</legend>
          {names.map((name) => {
            const value = options.values[name]
            return (
              <div key={name} className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1 text-xs text-ink">
                  <span className="font-mono">:{name}</span>
                  <Input
                    value={value ?? ''}
                    disabled={value === null}
                    onChange={(e) => onChange({ ...options, values: { ...options.values, [name]: e.target.value } })}
                    className="w-56 py-1 font-mono"
                    autoComplete="off"
                    aria-label={t.valueOf(name)}
                  />
                </label>
                <label className="flex items-center gap-1 text-xs text-ink-sub">
                  <input
                    type="checkbox"
                    checked={value === null}
                    onChange={(e) =>
                      onChange({ ...options, values: { ...options.values, [name]: e.target.checked ? null : '' } })
                    }
                  />
                  NULL
                </label>
              </div>
            )
          })}
        </fieldset>
      ) : null}
    </details>
  )
}
