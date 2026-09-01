import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'

export interface IndexFormProps {
  table: string
  columns: string[]
  onSubmit: (values: { name: string; columns: string[]; unique: boolean }) => void
  onCancel: () => void
}

export function IndexForm({ table, columns, onSubmit, onCancel }: IndexFormProps) {
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [unique, setUnique] = useState(false)
  const suggested = selected.length > 0 ? `idx_${table}_${selected.join('_')}` : ''
  const finalName = name.trim() || suggested
  const toggle = (c: string) => setSelected((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (selected.length === 0 || finalName === '') return
    onSubmit({ name: finalName, columns: selected, unique })
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <Field id="idx-name" label={locale.ddl.indexName}>
        <Input
          id="idx-name"
          value={name}
          placeholder={suggested}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
        />
      </Field>
      <fieldset>
        <legend className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-300">{locale.ddl.indexColumns}</legend>
        <div className="flex flex-wrap gap-3 text-sm">
          {columns.map((c) => (
            <label key={c} className="flex items-center gap-1">
              <input type="checkbox" checked={selected.includes(c)} onChange={() => toggle(c)} />
              {c}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center gap-1 text-sm">
        <input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} />
        {locale.ddl.unique}
      </label>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{locale.common.cancel}</Button>
        <Button type="submit" variant="primary" disabled={selected.length === 0 || finalName === ''}>
          {locale.ddl.submit}
        </Button>
      </div>
    </form>
  )
}
