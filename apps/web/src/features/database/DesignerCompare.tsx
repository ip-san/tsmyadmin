import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { RelationDef } from '@tsmyadmin/shared'
import { useEffect } from 'react'
import { DiagramLegend } from '@/components/schema-diagram/StepNarration.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
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
  const stop = (
    <Link to="/db/$db/designer" params={{ db }} search={{ schema }} className="text-sm text-brand underline">
      {t.stop}
    </Link>
  )
  if (compare === undefined) return { shape, panel: null }
  if (diff.isPending) return { shape, panel: <Spinner label={t.loading} /> }
  if (diff.isError) return { shape, panel: <ErrorBox error={diff.error} /> }
  const d = diff.data
  return {
    shape,
    panel: (
      <section aria-label={t.title(d.snapshot.name)} className="space-y-1 rounded border border-line p-2 print:hidden">
        <div className="flex flex-wrap items-baseline gap-3">
          <p className="text-sm font-semibold text-ink">{t.title(d.snapshot.name)}</p>
          {stop}
        </div>
        <p className="text-xs text-ink-sub">{t.summary(d.added.length, d.removed.length, d.changed.length)}</p>
        <DiagramLegend
          tones={['index', 'blocked', 'nullify']}
          labels={{ index: t.added, blocked: t.removed, nullify: t.changed }}
        />
        {d.shape === null && d.removed.length > 0 ? <Notice>{t.noShape}</Notice> : null}
      </section>
    ),
  }
}
