import type { Dialect } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { type ColumnFormValues, EMPTY_COLUMN, TYPE_SUGGESTIONS, validateColumn } from '@/lib/column-spec.ts'

export interface ColumnFormProps {
  dialect: Dialect
  initial?: ColumnFormValues
  /** Existing column names, for the MySQL AFTER selector (omit to hide). */
  positions?: string[]
  onSubmit: (values: ColumnFormValues, after: string | undefined) => void
  onCancel: () => void
}

export function ColumnForm({ dialect, initial = EMPTY_COLUMN, positions, onSubmit, onCancel }: ColumnFormProps) {
  const [v, setV] = useState<ColumnFormValues>(initial)
  const [after, setAfter] = useState('')
  const set = (patch: Partial<ColumnFormValues>) => setV((cur) => ({ ...cur, ...patch }))
  const invalid = validateColumn(v)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (invalid) return
    onSubmit(v, after || undefined)
  }
  return (
    <form onSubmit={submit} className="space-y-3">
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
          <Input
            id="col-type"
            list="col-type-suggestions"
            value={v.dataType}
            onChange={(e) => set({ dataType: e.target.value })}
            required
            className="font-mono"
          />
          <datalist id="col-type-suggestions" aria-label={locale.ddl.typeSuggestions}>
            {TYPE_SUGGESTIONS[dialect].map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </Field>
        <Field id="col-default-kind" label={locale.ddl.default}>
          <div className="flex gap-2">
            <Select
              id="col-default-kind"
              value={v.defaultKind}
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
              disabled={v.defaultKind === 'none'}
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
              <option value="">{locale.ddl.afterLast}</option>
              {positions.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
      </div>
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={v.nullable} onChange={(e) => set({ nullable: e.target.checked })} />
          {locale.ddl.nullable}
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={v.autoIncrement} onChange={(e) => set({ autoIncrement: e.target.checked })} />
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
