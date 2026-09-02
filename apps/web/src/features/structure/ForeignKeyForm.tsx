import { useQuery } from '@tanstack/react-query'
import { type FkAction, FkActionSchema } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { structureQuery, type TableRef, tablesQuery } from '@/lib/queries.ts'

interface ForeignKeyValues {
  name: string
  columns: string[]
  refTable: string
  refColumns: string[]
  onUpdate?: FkAction
  onDelete?: FkAction
}

export interface ForeignKeyFormProps {
  tableRef: TableRef
  columns: string[]
  onSubmit: (values: ForeignKeyValues) => void
  onCancel: () => void
}

/** Foreign key to another table of the same namespace: local columns ↔ referenced columns, pairwise in order. */
export function ForeignKeyForm({ tableRef, columns, onSubmit, onCancel }: ForeignKeyFormProps) {
  const tables = useQuery(tablesQuery(tableRef.db, tableRef.schema))
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [refTable, setRefTable] = useState('')
  const [refSelected, setRefSelected] = useState<string[]>([])
  const [onUpdate, setOnUpdate] = useState<FkAction | ''>('')
  const [onDelete, setOnDelete] = useState<FkAction | ''>('')
  const ref = useQuery({ ...structureQuery({ ...tableRef, table: refTable }), enabled: refTable !== '' })
  const suggested = selected.length > 0 ? `fk_${tableRef.table}_${selected.join('_')}` : ''
  const finalName = name.trim() || suggested
  const toggle = (list: string[], set: (v: string[]) => void, c: string) =>
    set(list.includes(c) ? list.filter((x) => x !== c) : [...list, c])
  const valid = selected.length > 0 && refTable !== '' && refSelected.length === selected.length && finalName !== ''
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!valid) return
    onSubmit({
      name: finalName,
      columns: selected,
      refTable,
      refColumns: refSelected,
      ...(onUpdate ? { onUpdate } : {}),
      ...(onDelete ? { onDelete } : {}),
    })
  }
  const actionSelect = (id: string, label: string, value: FkAction | '', set: (v: FkAction | '') => void) => (
    <Field id={id} label={label}>
      <Select id={id} value={value} onChange={(e) => set(e.target.value as FkAction | '')}>
        <option value="">{locale.ddl.fkDefaultAction}</option>
        {FkActionSchema.options.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </Select>
    </Field>
  )
  return (
    <form onSubmit={submit} className="space-y-3">
      <Notice>{locale.ddl.fkHint}</Notice>
      <Field id="fk-name" label={locale.ddl.fkName}>
        <Input
          id="fk-name"
          value={name}
          placeholder={suggested}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
        />
      </Field>
      <fieldset>
        <legend className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-300">{locale.ddl.fkColumns}</legend>
        <div className="flex flex-wrap gap-3 text-sm">
          {columns.map((c) => (
            <label key={c} className="flex items-center gap-1">
              <input type="checkbox" checked={selected.includes(c)} onChange={() => toggle(selected, setSelected, c)} />
              {c}
            </label>
          ))}
        </div>
      </fieldset>
      <Field id="fk-ref-table" label={locale.ddl.fkRefTable}>
        <Select
          id="fk-ref-table"
          value={refTable}
          onChange={(e) => {
            setRefTable(e.target.value)
            setRefSelected([])
          }}
        >
          <option value="">—</option>
          {(tables.data ?? [])
            .filter((t) => t.kind === 'table')
            .map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
        </Select>
      </Field>
      {refTable !== '' ? (
        <fieldset>
          <legend className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-300">
            {locale.ddl.fkRefColumns}
          </legend>
          {ref.isPending ? (
            <Spinner />
          ) : (
            <div className="flex flex-wrap gap-3 text-sm">
              {(ref.data?.columns ?? []).map((c) => (
                <label key={c.name} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={refSelected.includes(c.name)}
                    onChange={() => toggle(refSelected, setRefSelected, c.name)}
                  />
                  {c.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        {actionSelect('fk-on-update', locale.ddl.fkOnUpdate, onUpdate, setOnUpdate)}
        {actionSelect('fk-on-delete', locale.ddl.fkOnDelete, onDelete, setOnDelete)}
      </div>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{locale.common.cancel}</Button>
        <Button type="submit" variant="primary" disabled={!valid}>
          {locale.ddl.submit}
        </Button>
      </div>
    </form>
  )
}
