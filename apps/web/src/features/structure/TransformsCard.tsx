import type { TransformKind } from '@tsmyadmin/shared'
import { DISPLAY_TRANSFORMS, INPUT_TRANSFORMS, TransformKindSchema } from '@tsmyadmin/shared'
import { type FormEvent, useId, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Card } from '@/components/ui/Card.tsx'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { Field, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { useColumnTransforms } from '@/lib/column-transforms.ts'
import type { TableRef } from '@/lib/queries.ts'
import { TransformFields } from './TransformFields.tsx'
import { describeOptions, EMPTY_PARAMS, type TransformParams, transformOptions } from './transform-params.ts'

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
  const [params, setParams] = useState<TransformParams>(EMPTY_PARAMS)
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
      ...transformOptions(kind, params),
    })
    setParams(EMPTY_PARAMS)
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
              {describeOptions(x) ? (
                <span className="break-all font-mono text-xs text-ink-sub">{describeOptions(x)}</span>
              ) : null}
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
            {[
              [t.groupDisplay, DISPLAY_TRANSFORMS],
              [t.groupInput, INPUT_TRANSFORMS],
            ].map(([group, kinds]) => (
              <optgroup key={group as string} label={group as string}>
                {(kinds as readonly TransformKind[]).map((k) => (
                  <option key={k} value={k}>
                    {t.kinds[k]}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
        <TransformFields
          id={id}
          kind={kind}
          params={params}
          onChange={(patch) => setParams((p) => ({ ...p, ...patch }))}
        />
        <Button type="submit" variant="primary" disabled={!column}>
          {t.set}
        </Button>
      </form>
    </Card>
  )
}
