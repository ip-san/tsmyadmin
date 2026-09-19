import type { TransformKind } from '@tsmyadmin/shared'
import { TransformKindSchema } from '@tsmyadmin/shared'
import { type FormEvent, useId, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Card } from '@/components/ui/Card.tsx'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { useColumnTransforms } from '@/lib/column-transforms.ts'
import type { TableRef } from '@/lib/queries.ts'

const t = locale.transform

/**
 * phpMyAdmin's browser transformations for this table: how a column shows in Browse — a binary value as its
 * image, a value as a link, JSON indented. One per column; display only.
 */
export function TransformsCard({ tableRef, columns }: { tableRef: TableRef; columns: string[] }) {
  const id = useId()
  const list = useColumnTransforms(tableRef)
  const [chosen, setChosen] = useState('')
  const [kind, setKind] = useState<TransformKind>('link')
  const [template, setTemplate] = useState('')
  const column = columns.includes(chosen) ? chosen : (columns[0] ?? '')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!column) return
    list.save(column, {
      database: tableRef.db,
      ...(tableRef.schema ? { schema: tableRef.schema } : {}),
      table: tableRef.table,
      column,
      kind,
      ...(kind === 'link' && template.trim() ? { template: template.trim() } : {}),
    })
    setTemplate('')
  }
  return (
    <Card title={t.title}>
      <p className="mb-2 text-xs text-ink-sub">{t.hint}</p>
      {list.error ? <ErrorBox error={list.error} className="mb-2" /> : null}
      {list.entries.length === 0 ? (
        <p className="mb-3 text-sm text-ink-sub">{t.none}</p>
      ) : (
        <ul className="mb-3 space-y-1 text-sm text-ink" aria-label={t.title}>
          {list.entries.map((x) => (
            <li key={x.column} className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{x.column}</span>
              <span className="text-ink-sub">→ {t.kinds[x.kind]}</span>
              {x.template ? <span className="break-all font-mono text-xs text-ink-sub">{x.template}</span> : null}
              <Button size="sm" onClick={() => list.remove(x)} aria-label={t.clear(x.column)}>
                {locale.common.delete}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <Field id={`${id}-column`} label={t.column}>
          <Select id={`${id}-column`} value={column} onChange={(e) => setChosen(e.target.value)}>
            {columns.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={`${id}-kind`} label={t.kind}>
          <Select
            id={`${id}-kind`}
            value={kind}
            onChange={(e) => setKind(TransformKindSchema.catch('link').parse(e.target.value))}
          >
            {TransformKindSchema.options.map((k) => (
              <option key={k} value={k}>
                {t.kinds[k]}
              </option>
            ))}
          </Select>
        </Field>
        {kind === 'link' ? (
          <Field id={`${id}-template`} label={t.template}>
            <Input
              id={`${id}-template`}
              type="url"
              pattern="https?://.+"
              placeholder="https://example.com/items/{value}"
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              className="w-96 max-w-full font-mono"
            />
          </Field>
        ) : null}
        <Button type="submit" variant="primary" disabled={!column}>
          {t.set}
        </Button>
      </form>
    </Card>
  )
}
