import type { Dialect } from '@tsmyadmin/shared'
import { locale } from '@/config/locale.ts'
import { defaultArgs, joinType, retypeName, splitType, TYPE_GROUPS, TYPE_NAMES } from '@/lib/column-spec.ts'
import { Input, Select } from './Field.tsx'

export interface TypeInputProps {
  dialect: Dialect
  value: string
  onChange: (dataType: string) => void
  /** Id of the type dropdown, for a visible `<label>`. */
  id?: string
  /** Accessible name of the type dropdown when there is no visible label. */
  label?: string
  /** Suffix for the arguments field's accessible name (a row number), so several rows stay distinguishable. */
  labelSuffix?: string
  required?: boolean
  /** A narrow arguments field, for a table cell. */
  compact?: boolean
}

/** A data type as a dropdown of names plus a field for what follows the name (length, values, attributes). */
export function TypeInput({ dialect, value, onChange, id, label, labelSuffix, required, compact }: TypeInputProps) {
  const { base, rest } = splitType(dialect, value)
  const names = TYPE_NAMES[dialect]
  const suffix = labelSuffix ? ` ${labelSuffix}` : ''
  return (
    <div className="flex gap-2">
      <Select
        id={id}
        aria-label={label ? `${label}${suffix}` : undefined}
        value={base}
        onChange={(e) => onChange(retypeName(dialect, value, e.target.value))}
        required={required}
        className="w-auto min-w-28 font-mono"
      >
        <option value="" disabled={base !== ''}>
          {locale.ddl.typeSelect}
        </option>
        {base !== '' && !names.includes(base) ? <option value={base}>{base}</option> : null}
        {TYPE_GROUPS[dialect].map((g) => (
          <optgroup key={g.key} label={locale.ddl.typeGroups[g.key]}>
            {g.names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>
      <Input
        aria-label={`${locale.ddl.typeArguments}${suffix}`}
        value={rest}
        onChange={(e) => onChange(joinType(base, e.target.value))}
        placeholder={defaultArgs(base) || undefined}
        autoComplete="off"
        spellCheck={false}
        className={compact ? 'w-28 min-w-0 font-mono' : 'min-w-24 font-mono'}
      />
    </div>
  )
}
