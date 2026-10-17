import { useQuery } from '@tanstack/react-query'
import type { TableUsageReport } from '@tsmyadmin/shared'
import { DiagramLegend } from '@/components/schema-diagram/StepNarration.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale-screens.ts'
import { tableUsageQuery } from '@/lib/queries.ts'
import { unusedIndexes, usageOverlay } from './usage-overlay.ts'

const t = locale.designer.usage

/**
 * How the tables are read, while asked for: the overlay for the diagram, and what goes under it (since when the
 * counts run, the legend, the indexes never read, or why there is nothing to show).
 */
export function useUsage(db: string, schema: string | undefined, on: boolean) {
  const usage = useQuery({ ...tableUsageQuery(db, schema), enabled: on })
  if (!on) return { overlay: undefined, panel: null }
  if (usage.isPending) return { overlay: undefined, panel: <Spinner label={t.loading} /> }
  if (usage.isError) {
    return { overlay: undefined, panel: <ErrorBox error={usage.error} onRetry={() => void usage.refetch()} /> }
  }
  const report = usage.data
  if (report.status !== 'ok') return { overlay: undefined, panel: <Notice>{t[report.status]}</Notice> }
  return { overlay: usageOverlay(report), panel: <UsagePanel report={report} /> }
}

function UsagePanel({ report }: { report: TableUsageReport }) {
  const unused = unusedIndexes(report)
  return (
    <div className="space-y-2 print:hidden">
      <DiagramLegend tones={['scan', 'index']} labels={{ scan: t.scan, index: t.index }} />
      {report.since ? (
        <p className="text-xs text-ink-sub">{t.since(new Date(report.since).toLocaleString(), report.unit)}</p>
      ) : null}
      <h3 className="text-sm font-semibold text-ink">{t.unused}</h3>
      <p className="text-xs text-ink-sub">{t.unusedHint}</p>
      {unused.length === 0 ? (
        <p className="text-sm text-ink-sub">{t.unusedNone}</p>
      ) : (
        <Table aria-label={t.unused}>
          <thead>
            <tr>
              <Th>{t.table}</Th>
              <Th>{t.indexName}</Th>
            </tr>
          </thead>
          <tbody>
            {unused.map((i) => (
              <Tr key={JSON.stringify([i.table, i.index])}>
                <Td>{i.table}</Td>
                <Td className="font-mono text-xs">{i.index}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  )
}
