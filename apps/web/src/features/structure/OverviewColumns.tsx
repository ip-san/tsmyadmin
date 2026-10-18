import { useQuery } from '@tanstack/react-query'
import type { ColumnDef } from '@tsmyadmin/shared'
import { useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale-screens.ts'
import { columnProfileQuery, type TableRef } from '@/lib/queries.ts'
import { columnNotes } from './column-notes.ts'
import { DistinctValuesDialog } from './DistinctValuesDialog.tsx'

const t = locale.overview

/**
 * Each column with what its values are like in a sample of the first rows: the share that is NULL (as a bar and
 * a number), how many values differ, and a mark on what stands out. The values themselves open in the dialog the
 * structure tab uses.
 */
export function OverviewColumns({
  tableRef,
  columns,
  read,
}: {
  tableRef: TableRef
  columns: readonly ColumnDef[]
  /** Whether the rows may be read: a view's only once asked (`TableOverview` holds the question). */
  read: boolean
}) {
  const profile = useQuery({ ...columnProfileQuery(tableRef), enabled: read })
  const [values, setValues] = useState<string | null>(null)
  if (!read) return null
  if (profile.isPending) return <Spinner label={t.profiling} />
  if (profile.isError) return <ErrorBox error={profile.error} onRetry={() => void profile.refetch()} />
  const p = profile.data
  const notes = columnNotes(p)
  const byName = new Map(p.columns.map((c) => [c.column, c]))
  return (
    <div className="space-y-2">
      <p className="text-xs text-ink-sub">{p.capped ? t.sampleCapped(p.sampled) : t.sampleAll(p.sampled)}</p>
      <Table aria-label={t.columnsTable}>
        <thead>
          <tr>
            <Th>{t.column}</Th>
            <Th>{t.type}</Th>
            <Th>{t.nullShare}</Th>
            <Th className="text-right">{t.distinct}</Th>
            <Th>{t.note}</Th>
            <Th className="print:hidden">{locale.ddl.actions}</Th>
          </tr>
        </thead>
        <tbody>
          {columns.map((c) => {
            const counted = byName.get(c.name)
            const share = counted && p.sampled > 0 ? counted.nulls / p.sampled : null
            const note = notes.get(c.name)
            return (
              <Tr key={c.name}>
                <Td className="font-medium">{c.name}</Td>
                <Td className="font-mono text-xs">{c.dataType}</Td>
                <Td>
                  {share === null ? (
                    '—'
                  ) : (
                    <span className="flex items-center gap-2">
                      <meter
                        min={0}
                        max={1}
                        value={share}
                        aria-label={t.nullShareOf(c.name)}
                        aria-valuetext={t.percent(share)}
                        className="h-2 w-24"
                      />
                      <span className="tabular-nums text-xs">{t.percent(share)}</span>
                    </span>
                  )}
                </Td>
                <Td className="text-right tabular-nums">
                  {counted?.distinct === null || counted === undefined
                    ? '—'
                    : counted.prefix
                      ? t.atLeast(counted.distinct)
                      : t.count(counted.distinct)}
                </Td>
                <Td className="text-xs text-ink-sub">{note ? t.notes[note] : null}</Td>
                <Td className="print:hidden">
                  <Button
                    size="sm"
                    aria-haspopup="dialog"
                    aria-label={t.valuesOf(c.name)}
                    onClick={() => setValues(c.name)}
                  >
                    {t.values}
                  </Button>
                </Td>
              </Tr>
            )
          })}
        </tbody>
      </Table>
      {p.omitted > 0 ? <p className="text-xs text-ink-sub">{t.omitted(p.omitted)}</p> : null}
      <DistinctValuesDialog tableRef={tableRef} column={values} onClose={() => setValues(null)} />
    </div>
  )
}
