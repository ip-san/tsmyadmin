import { useQuery } from '@tanstack/react-query'
import type { TableStats } from '@tsmyadmin/shared'
import { Printer } from 'lucide-react'
import { Button } from '@/components/ui/Button.tsx'
import { Card } from '@/components/ui/Card.tsx'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { type TableRef, tableStatsQuery } from '@/lib/queries.ts'

const t = locale.table.stats

type Row = [label: string, value: string | null]

/** The figures the server keeps, each with its label; the ones it does not keep are left out. */
export function statsRows(s: TableStats): { space: Row[]; rows: Row[] } {
  const bytes = (n: number | null) => (n === null ? null : locale.common.bytes(n))
  const count = (n: number | null) => (n === null ? null : n.toLocaleString('ja-JP'))
  const keep = (list: Row[]) => list.filter((r) => r[1] !== null)
  return {
    space: keep([
      [t.data, bytes(s.dataBytes)],
      [t.index, bytes(s.indexBytes)],
      [t.free, bytes(s.freeBytes)],
      [t.toast, bytes(s.toastBytes)],
      [t.total, bytes(s.totalBytes)],
    ]),
    rows: keep([
      [t.rowEstimate, count(s.rowEstimate)],
      [t.avgRow, bytes(s.avgRowBytes)],
      [t.rowFormat, s.rowFormat],
      [t.createdAt, s.createdAt],
      [t.updatedAt, s.updatedAt],
      [t.checkedAt, s.checkedAt],
      [t.deadRows, count(s.deadRows)],
      [t.lastVacuum, s.lastVacuum],
      [t.lastAnalyze, s.lastAnalyze],
    ]),
  }
}

function Figures({ title, rows }: { title: string; rows: Row[] }) {
  if (rows.length === 0) return null
  return (
    <section className="min-w-56 flex-1">
      <h3 className="mb-1 text-xs font-semibold text-ink-sub">{title}</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-ink-sub">{label}</dt>
            <dd className="text-right tabular-nums text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/** phpMyAdmin's "Space usage" and "Row statistics" under the structure, with the page's print button. */
export function StatsCard({ tableRef }: { tableRef: TableRef }) {
  const stats = useQuery(tableStatsQuery(tableRef))
  return (
    <Card
      title={t.title}
      actions={
        <Button size="sm" className="print:hidden" onClick={() => window.print()}>
          <Printer className="size-3.5" aria-hidden />
          {t.print}
        </Button>
      }
    >
      {stats.isPending ? (
        <Spinner />
      ) : stats.isError ? (
        <ErrorBox error={stats.error} onRetry={() => void stats.refetch()} />
      ) : (
        <div className="flex flex-wrap gap-6">
          <Figures title={t.space} rows={statsRows(stats.data).space} />
          <Figures title={t.rowsTitle} rows={statsRows(stats.data).rows} />
        </div>
      )}
      <p className="mt-2 text-xs text-ink-sub">{t.hint}</p>
    </Card>
  )
}
