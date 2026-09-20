import type { CentralColumnBody, Dialect } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { TypeInput } from '@/components/ui/TypeInput.tsx'
import { locale } from '@/config/locale.ts'
import {
  type ColumnFormValues,
  EMPTY_COLUMN,
  fromCentralColumn,
  retypeColumn,
  validateColumn,
} from '@/lib/column-spec.ts'
import { ColumnExtras } from './ColumnExtras.tsx'

export interface ColumnFormProps {
  dialect: Dialect
  initial?: ColumnFormValues
  /** Existing column names, for the MySQL position selector (omit to hide). */
  positions?: string[]
  /** Adding a column (a key can go with it; the position defaults to the end) or changing one (it stays put). */
  mode?: 'add' | 'modify'
  /** Central columns of the database, to start a new column from (omit or empty to hide). */
  presets?: CentralColumnBody[]
  onSubmit: (values: ColumnFormValues, placement: ColumnPlacement) => void
  onCancel: () => void
}

/** Where the column goes and the key that goes with it; each part absent when not asked for. */
interface ColumnPlacement {
  first?: boolean
  after?: string
  key?: 'primary' | 'unique' | 'index'
}

export function ColumnForm({
  dialect,
  initial = EMPTY_COLUMN,
  positions,
  mode = 'add',
  presets = [],
  onSubmit,
  onCancel,
}: ColumnFormProps) {
  const [v, setV] = useState<ColumnFormValues>(initial)
  const [after, setAfter] = useState('')
  const [key, setKey] = useState<'' | 'primary' | 'unique' | 'index'>('')
  const set = (patch: Partial<ColumnFormValues>) => setV((cur) => ({ ...cur, ...patch }))
  const invalid = validateColumn(v)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (invalid) return
    onSubmit(v, {
      // Option values are `first` or `after:<column>`, so no column name can be mistaken for the other.
      ...(after === 'first' ? { first: true } : after.startsWith('after:') ? { after: after.slice(6) } : {}),
      ...(key ? { key } : {}),
    })
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      {presets.length > 0 ? (
        <Field id="col-preset" label={locale.central.preset}>
          <Select
            id="col-preset"
            defaultValue=""
            onChange={(e) => {
              const preset = presets.find((p) => p.name === e.target.value)
              setV(preset ? fromCentralColumn(preset) : initial)
            }}
          >
            <option value="">{locale.central.noPreset}</option>
            {presets.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name} ({p.dataType})
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <Field id="col-name" label={locale.ddl.columnName}>
          <Input
            id="col-name"
            value={v.name}
            onChange={(e) => set({ name: e.target.value })}
            required
            autoComplete="off"
          />
        </Field>
        <Field id="col-type" label={locale.ddl.dataType}>
          <TypeInput
            id="col-type"
            dialect={dialect}
            value={v.dataType}
            onChange={(dataType) => setV((cur) => retypeColumn(cur, initial, dataType))}
          />
        </Field>
        <Field id="col-default-kind" label={locale.ddl.default}>
          <div className="flex gap-2">
            <Select
              id="col-default-kind"
              value={v.defaultKind}
              disabled={v.generated !== null}
              onChange={(e) => set({ defaultKind: e.target.value as ColumnFormValues['defaultKind'] })}
              className="w-auto"
            >
              <option value="none">{locale.ddl.defaultNone}</option>
              <option value="literal">{locale.ddl.defaultLiteral}</option>
              <option value="expression">{locale.ddl.defaultExpression}</option>
            </Select>
            <Input
              aria-label={`${locale.ddl.default}: ${locale.rows.value}`}
              value={v.defaultValue}
              disabled={v.defaultKind === 'none' || v.generated !== null}
              onChange={(e) => set({ defaultValue: e.target.value })}
              className="font-mono"
            />
          </div>
        </Field>
        <Field id="col-comment" label={locale.ddl.comment}>
          <Input id="col-comment" value={v.comment} onChange={(e) => set({ comment: e.target.value })} />
        </Field>
        {positions && dialect === 'mysql' ? (
          <Field id="col-after" label={locale.ddl.after}>
            <Select id="col-after" value={after} onChange={(e) => setAfter(e.target.value)}>
              <option value="">{mode === 'add' ? locale.ddl.afterLast : locale.ddl.extras.keepPosition}</option>
              <option value="first">{locale.ddl.extras.first}</option>
              {positions.map((p) => (
                <option key={p} value={`after:${p}`}>
                  {p}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {mode === 'add' ? (
          <Field id="col-key" label={locale.ddl.extras.key}>
            <Select id="col-key" value={key} onChange={(e) => setKey(e.target.value as typeof key)}>
              <option value="">{locale.ddl.extras.none}</option>
              <option value="primary">PRIMARY</option>
              <option value="unique">UNIQUE</option>
              <option value="index">INDEX</option>
            </Select>
          </Field>
        ) : null}
      </div>
      <ColumnExtras dialect={dialect} v={v} set={set} />
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={v.nullable} onChange={(e) => set({ nullable: e.target.checked })} />
          {locale.ddl.nullable}
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={v.autoIncrement}
            disabled={v.generated !== null}
            onChange={(e) => set({ autoIncrement: e.target.checked })}
          />
          {locale.ddl.autoIncrement}
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{locale.common.cancel}</Button>
        <Button type="submit" variant="primary" disabled={invalid !== null}>
          {locale.ddl.submit}
        </Button>
      </div>
    </form>
  )
}
