import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { RelationDef, SnapshotDiff } from '@tsmyadmin/shared'
import { useEffect } from 'react'
import { DiagramLegend } from '@/components/schema-diagram/StepNarration.tsx'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale-screens.ts'
import { foreignKeysQuery, snapshotDiffQuery, tablesQuery } from '@/lib/queries.ts'
import { compareDiagram } from './compare-overlay.ts'

const t = locale.designer.compare

/**
 * The Designer laid over a snapshot (`compare` is its id, from the Snapshots page): the tables and keys to draw,
 * the overlay, and what goes above the diagram. Without `compare` the diagram is the database as it is.
 */
export function useCompare(db: string, schema: string | undefined, compare: string | undefined) {
  const diff = useQuery({ ...snapshotDiffQuery(db, schema, compare ?? ''), enabled: compare !== undefined })
  const queryClient = useQueryClient()
  // A migration runs outside this page: the tables and keys it knows may be older than the comparison.
  useEffect(() => {
    if (compare === undefined) return
    void queryClient.invalidateQueries({ queryKey: tablesQuery(db, schema).queryKey })
    void queryClient.invalidateQueries({ queryKey: foreignKeysQuery(db, schema).queryKey })
  }, [queryClient, db, schema, compare])
  const shape = (tables: string[], relations: RelationDef[]) =>
    diff.data ? compareDiagram(diff.data, tables, relations) : { tables, relations, overlay: undefined }
  if (compare === undefined) return { shape, panel: null }
  if (diff.isPending) return { shape, panel: <Spinner label={t.loading} /> }
  if (diff.isError) return { shape, panel: <ErrorBox error={diff.error} onRetry={() => void diff.refetch()} /> }
  return { shape, panel: <ComparePanel db={db} schema={schema} diff={diff.data} /> }
}

/** What is being compared, the counts, the legend, and the tables of each kind by name (what the colours say). */
function ComparePanel({ db, schema, diff }: { db: string; schema: string | undefined; diff: SnapshotDiff }) {
  const kinds = [
    [t.added, diff.added],
    [t.removed, diff.removed],
    [t.changed, diff.changed],
  ] as const
  return (
    <section aria-label={t.title(diff.snapshot.name)} className="space-y-1 rounded border border-line p-2 print:hidden">
      <div className="flex flex-wrap items-baseline gap-3">
        <p className="text-sm font-semibold text-ink">{t.title(diff.snapshot.name)}</p>
        <Link to="/db/$db/designer" params={{ db }} search={{ schema }} className="text-sm text-brand underline">
          {t.stop}
        </Link>
      </div>
      <p className="text-xs text-ink-sub">{t.summary(diff.added.length, diff.removed.length, diff.changed.length)}</p>
      <DiagramLegend
        tones={['index', 'blocked', 'nullify']}
        labels={{ index: t.added, blocked: t.removed, nullify: t.changed }}
      />
      <ul className="text-xs text-ink">
        {kinds.map(([kind, entries]) =>
          entries.length > 0 ? (
            <li key={kind}>
              {t.list(
                kind,
                entries.map((e) => e.name)
              )}
            </li>
          ) : null
        )}
      </ul>
      <p className="text-xs text-ink-sub">{t.othersOff}</p>
    </section>
  )
}
