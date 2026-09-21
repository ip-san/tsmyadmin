import type { DdlOp, Dialect, PartitionMethod } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'

const t = locale.partitions

/** What a bound looks like for this method on this server, as the form's example. */
export function boundExample(dialect: Dialect, method: PartitionMethod | null): string {
  if (dialect === 'postgres')
    return method === 'list'
      ? "FOR VALUES IN ('a', 'b')"
      : method === 'hash'
        ? 'FOR VALUES WITH (MODULUS 4, REMAINDER 0)'
        : 'FOR VALUES FROM (0) TO (100)'
  return method === 'list' ? 'VALUES IN (1, 2)' : method === 'range' ? 'VALUES LESS THAN (100)' : ''
}

type Row = { name: string; bound: string }

/** MySQL: partition an existing table — RANGE / LIST with each partition's bound, HASH / KEY by a count. */
export function PartitionTableForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (op: Omit<Extract<DdlOp, { op: 'partitionTable' }>, 'op' | 'table'>) => void
  onCancel: () => void
}) {
  const [method, setMethod] = useState<PartitionMethod>('range')
  const [expression, setExpression] = useState('')
  const [rows, setRows] = useState<Row[]>([{ name: 'p0', bound: '' }])
  const [count, setCount] = useState(4)
  const listed = method === 'range' || method === 'list'
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const partitions = rows
      .filter((r) => r.name.trim() !== '')
      .map((r) => ({ name: r.name.trim(), bound: r.bound.trim() }))
    if (!expression.trim() || (listed && partitions.length === 0)) return
    onSubmit({
      method,
      expression: expression.trim(),
      partitions: listed ? partitions : [],
      ...(listed ? {} : { count }),
    })
  }
  const set = (i: number, patch: Partial<Row>) =>
    setRows((all) => all.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <Field id="part-method" label={t.method}>
          <Select id="part-method" value={method} onChange={(e) => setMethod(e.target.value as PartitionMethod)}>
            {(['range', 'list', 'hash', 'key'] as const).map((m) => (
              <option key={m} value={m}>
                {m.toUpperCase()}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="part-expr" label={t.expression} hint={t.expressionHint}>
          <Input
            id="part-expr"
            value={expression}
            onChange={(e) => setExpression(e.target.value)}
            className="font-mono"
            required
          />
        </Field>
      </div>
      {listed ? (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-medium text-ink-sub">{t.partitions}</legend>
          {rows.map((r, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <Field id={`part-name-${i}`} label={t.nameOf(i + 1)}>
                <Input
                  id={`part-name-${i}`}
                  value={r.name}
                  onChange={(e) => set(i, { name: e.target.value })}
                  className="w-32"
                />
              </Field>
              <Field id={`part-bound-${i}`} label={t.boundOf(i + 1)}>
                <Input
                  id={`part-bound-${i}`}
                  value={r.bound}
                  placeholder={boundExample('mysql', method)}
                  onChange={(e) => set(i, { bound: e.target.value })}
                  className="w-72 font-mono"
                />
              </Field>
            </div>
          ))}
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setRows((all) => [...all, { name: `p${all.length}`, bound: '' }])}>
              {t.addRow}
            </Button>
            <Button size="sm" disabled={rows.length === 1} onClick={() => setRows((all) => all.slice(0, -1))}>
              {t.removeRow}
            </Button>
          </div>
        </fieldset>
      ) : (
        <Field id="part-count" label={t.count}>
          <Input
            id="part-count"
            type="number"
            min={1}
            max={1024}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="w-24"
          />
        </Field>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{locale.common.cancel}</Button>
        <Button type="submit" variant="primary" disabled={!expression.trim()}>
          {locale.ddl.submit}
        </Button>
      </div>
    </form>
  )
}

/** One more partition: its name and its bound as the server spells it. */
export function AddPartitionForm({
  example,
  onSubmit,
  onCancel,
}: {
  example: string
  onSubmit: (p: Row) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [bound, setBound] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (name.trim()) onSubmit({ name: name.trim(), bound: bound.trim() })
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <Field id="add-part-name" label={t.name}>
        <Input id="add-part-name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="off" />
      </Field>
      <Field id="add-part-bound" label={t.bound} hint={t.boundHint}>
        <Input
          id="add-part-bound"
          value={bound}
          placeholder={example}
          onChange={(e) => setBound(e.target.value)}
          className="font-mono"
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{locale.common.cancel}</Button>
        <Button type="submit" variant="primary" disabled={!name.trim()}>
          {locale.ddl.submit}
        </Button>
      </div>
    </form>
  )
}
