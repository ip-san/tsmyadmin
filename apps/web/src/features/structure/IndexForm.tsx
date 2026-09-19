import type { Dialect } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'

type Kind = 'index' | 'unique' | 'fulltext' | 'spatial'
type Method = 'btree' | 'hash' | 'gin' | 'gist' | 'brin' | 'spgist'

export interface IndexValues {
  name: string
  columns: string[]
  unique: boolean
  kind: Kind
  method?: Method
  lengths?: Record<string, number>
}

const KINDS: Record<Dialect, Kind[]> = {
  mysql: ['index', 'unique', 'fulltext', 'spatial'],
  postgres: ['index', 'unique'],
}
const METHODS: Record<Dialect, Method[]> = {
  mysql: ['btree', 'hash'],
  postgres: ['btree', 'hash', 'gin', 'gist', 'brin', 'spgist'],
}

export interface IndexFormProps {
  table: string
  dialect: Dialect
  columns: string[]
  /** Editing an index, or starting from ticked columns (and a kind). */
  initial?: Partial<IndexValues>
  onSubmit: (values: IndexValues) => void
  onCancel: () => void
}

/**
 * An index: its columns, kind (MySQL also FULLTEXT / SPATIAL), access method and — on MySQL — how many leading
 * characters of a column to index. The same form edits an existing index.
 */
export function IndexForm({ table, dialect, columns, initial, onSubmit, onCancel }: IndexFormProps) {
  const t = locale.ddl.index
  const [name, setName] = useState(initial?.name ?? '')
  const [selected, setSelected] = useState<string[]>(initial?.columns ?? [])
  const [kind, setKind] = useState<Kind>(initial?.kind ?? (initial?.unique ? 'unique' : 'index'))
  const [method, setMethod] = useState<Method | ''>(initial?.method ?? '')
  const [lengths, setLengths] = useState<Record<string, number>>(initial?.lengths ?? {})
  const suggested = selected.length > 0 ? `idx_${table}_${selected.join('_')}` : ''
  const finalName = name.trim() || suggested
  const toggle = (c: string) => setSelected((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]))
  // FULLTEXT / SPATIAL take neither a method nor prefix lengths on MySQL.
  const plain = kind === 'index' || kind === 'unique'
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (selected.length === 0 || finalName === '') return
    const kept = Object.fromEntries(Object.entries(lengths).filter(([c, n]) => selected.includes(c) && n > 0))
    onSubmit({
      name: finalName,
      columns: selected,
      unique: kind === 'unique',
      kind,
      ...(method && plain ? { method } : {}),
      ...(dialect === 'mysql' && plain && Object.keys(kept).length > 0 ? { lengths: kept } : {}),
    })
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
        <legend className="mb-1 text-xs font-medium text-ink-sub">{locale.ddl.indexColumns}</legend>
        <div className="flex flex-wrap gap-3 text-sm">
          {columns.map((c) => (
            <label key={c} className="flex items-center gap-1">
              <input type="checkbox" checked={selected.includes(c)} onChange={() => toggle(c)} />
              {c}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-3">
        <Field id="idx-kind" label={t.kind}>
          <Select id="idx-kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {KINDS[dialect].map((k) => (
              <option key={k} value={k}>
                {t.kinds[k]}
              </option>
            ))}
          </Select>
        </Field>
        {plain ? (
          <Field id="idx-method" label={t.method}>
            <Select id="idx-method" value={method} onChange={(e) => setMethod(e.target.value as Method | '')}>
              <option value="">{t.defaultMethod}</option>
              {METHODS[dialect].map((m) => (
                <option key={m} value={m}>
                  {m.toUpperCase()}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
      </div>
      {dialect === 'mysql' && plain && selected.length > 0 ? (
        <fieldset className="flex flex-wrap gap-3">
          <legend className="mb-1 text-xs font-medium text-ink-sub">{t.lengths}</legend>
          {selected.map((c) => (
            <Field key={c} id={`idx-len-${c}`} label={c}>
              <Input
                id={`idx-len-${c}`}
                type="number"
                min={1}
                max={3072}
                value={lengths[c] ?? ''}
                onChange={(e) => setLengths((l) => ({ ...l, [c]: Number(e.target.value) }))}
                className="w-24"
              />
            </Field>
          ))}
        </fieldset>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{locale.common.cancel}</Button>
        <Button type="submit" variant="primary" disabled={selected.length === 0 || finalName === ''}>
          {locale.ddl.submit}
        </Button>
      </div>
    </form>
  )
}
