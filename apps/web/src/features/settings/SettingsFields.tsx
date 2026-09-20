import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'

const t = locale.settings

export function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <fieldset id={id} className="scroll-mt-4 space-y-3 rounded border border-line p-4">
      <legend className="px-1 text-sm font-semibold text-ink">{title}</legend>
      {children}
    </fieldset>
  )
}

export function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean
  onChange: (on: boolean) => void
  children: string
}) {
  return (
    <label className="flex items-center gap-1 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  )
}

/** A whole number in a box; kept as typed while it is not a number, so a field can be emptied to be retyped. */
export function NumberField({
  id,
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  id: string
  label: string
  hint: string
  value: number
  min: number
  max: number
  onChange: (n: number) => void
}) {
  return (
    <Field id={id} label={label} hint={`${t.rangeHint(min, max)}${hint ? ` ${hint}` : ''}`}>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Math.floor(Number(e.target.value)))}
        className="w-32 tabular-nums"
      />
    </Field>
  )
}

/** One of a short list of values, by their names on screen. */
export function ChoiceField<K extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string
  label: string
  value: K
  options: Record<K, string>
  onChange: (value: K) => void
}) {
  return (
    <Field id={id} label={label}>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value as K)} className="w-auto">
        {(Object.keys(options) as K[]).map((k) => (
          <option key={k} value={k}>
            {options[k]}
          </option>
        ))}
      </Select>
    </Field>
  )
}
