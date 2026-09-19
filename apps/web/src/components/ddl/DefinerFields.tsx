import type { SqlSecurity } from '@tsmyadmin/shared'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { parseDefiner } from './definer.ts'

const t = locale.create.security

/** MySQL's `DEFINER = user@host`: whose account the object runs as (blank: the account creating it). */
export function DefinerField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const invalid = parseDefiner(value) === 'invalid'
  return (
    <Field id={id} label={t.definer} hint={invalid ? t.definerInvalid : t.definerHint}>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid}
        placeholder="app@%"
        autoComplete="off"
        className="font-mono"
      />
    </Field>
  )
}

/** `SQL SECURITY` (MySQL) / `SECURITY` (PostgreSQL routines): whose privileges the object runs with. */
export function SecuritySelect({
  id,
  value,
  onChange,
}: {
  id: string
  value: SqlSecurity | ''
  onChange: (v: SqlSecurity | '') => void
}) {
  return (
    <Field id={id} label={t.sqlSecurity}>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value as SqlSecurity | '')}>
        <option value="">{t.defaultOption}</option>
        <option value="DEFINER">{t.definerOption}</option>
        <option value="INVOKER">{t.invokerOption}</option>
      </Select>
    </Field>
  )
}
