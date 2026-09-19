import { useQuery } from '@tanstack/react-query'
import type { TableSchema } from '@tsmyadmin/shared'
import { useState } from 'react'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { rowsQuery, type TableRef, tablesQuery } from '@/lib/queries.ts'
import { NormalizeActions } from './NormalizeActions.tsx'
import { type Hint, MIN_SAMPLE, normalizationHints, proposals } from './normalization.ts'

const t = locale.normalize
const SAMPLE_ROWS = 500

function describe(hint: Hint): string {
  switch (hint.kind) {
    case 'noPrimaryKey':
      return t.noPrimaryKey
    case 'repeatingGroup':
      return t.repeatingGroup(hint.columns.join(', '))
    case 'listValues':
      return t.listValues(hint.column, hint.count)
    case 'missingForeignKey':
      return t.missingForeignKey(hint.column, hint.table)
    case 'partialDependency':
      return t.partialDependency(hint.key, hint.column)
    case 'transitiveDependency':
      return t.transitiveDependency(hint.from, hint.column)
  }
}

const LEVEL: Record<Hint['kind'], '1' | '2' | '3' | 'fk'> = {
  noPrimaryKey: '1',
  repeatingGroup: '1',
  listValues: '1',
  partialDependency: '2',
  transitiveDependency: '3',
  missingForeignKey: 'fk',
}

function Hints({ tableRef, schema }: { tableRef: TableRef; schema: TableSchema }) {
  const tables = useQuery(tablesQuery(tableRef.db, tableRef.schema))
  const sample = useQuery(rowsQuery(tableRef, { offset: 0, limit: SAMPLE_ROWS, sort: [], filters: [] }))
  if (tables.isPending || sample.isPending) return <Spinner />
  if (sample.isError) return <ErrorBox error={sample.error} onRetry={() => void sample.refetch()} />
  const rows = sample.data.rows
  const hints = normalizationHints(
    schema,
    (tables.data ?? []).map((x) => x.name),
    { columns: sample.data.columns.map((c) => c.name), rows }
  )
  return (
    <div className="space-y-2">
      <p className="text-xs text-ink-sub">
        {rows.length < MIN_SAMPLE ? t.smallSample(rows.length, MIN_SAMPLE) : t.sampled(rows.length)}
      </p>
      {hints.length === 0 ? (
        <Notice>{t.none}</Notice>
      ) : (
        <ul className="space-y-1 text-sm text-ink" aria-label={t.title}>
          {hints.map((h) => (
            <li key={JSON.stringify(h)} className="flex gap-2">
              <span className="shrink-0 rounded bg-surface-sub px-1.5 text-xs font-medium text-ink-sub">
                {t.levels[LEVEL[h.kind]]}
              </span>
              <span>{describe(h)}</span>
            </li>
          ))}
        </ul>
      )}
      <NormalizeActions tableRef={tableRef} schema={schema} proposals={proposals(hints, schema)} />
    </div>
  )
}

/**
 * phpMyAdmin's "Normalize" as advice: what in this table's design and data looks like a first, second or third
 * normal form problem. Read-only — the changes it points at go through the usual forms and SQL preview. The rows
 * are only read once the section is opened.
 */
export function NormalizationHints({ tableRef, schema }: { tableRef: TableRef; schema: TableSchema }) {
  const [open, setOpen] = useState(false)
  return (
    <details className="rounded border border-line p-3" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer text-sm font-semibold text-ink">{t.title}</summary>
      <div className="mt-3">
        <p className="mb-2 text-xs text-ink-sub">{t.hint}</p>
        {open ? <Hints tableRef={tableRef} schema={schema} /> : null}
      </div>
    </details>
  )
}
