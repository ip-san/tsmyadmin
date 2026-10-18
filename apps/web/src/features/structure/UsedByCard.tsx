import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Card } from '@/components/ui/Card.tsx'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale-screens.ts'
import { dependencyGraph, dependencyId, dependencyLabel, dependentsOf } from '@/lib/dependencies.ts'
import { dependenciesQuery, type TableRef, tablesQuery, triggersQuery } from '@/lib/queries.ts'

const t = locale.dependencies

/**
 * The views, routines and triggers a change to this table (or view) reaches (directly, or through views on it),
 * with a link to the whole diagram. Where the server keeps no catalog of what views use (MariaDB), only the
 * triggers; where the triggers cannot be listed, what views use, and why the triggers are missing.
 */
export function UsedByCard({ tableRef, view = false }: { tableRef: TableRef; view?: boolean }) {
  const { db, schema, table } = tableRef
  const report = useQuery(dependenciesQuery(db, schema))
  const triggers = useQuery(triggersQuery(db, schema))
  const tables = useQuery(tablesQuery(db, schema))
  // Held before the checks below narrow the query: a failed list of triggers is said, not a reason to say nothing.
  const triggerError = triggers.isError ? triggers.error : null
  const retryTriggers = () => void triggers.refetch()
  const body = () => {
    if (report.isPending || triggers.isPending) return <Spinner />
    if (report.isError) return <ErrorBox error={report.error} onRetry={() => void report.refetch()} />
    const reached = dependentsOf(
      dependencyGraph(
        report.data.objects,
        triggers.data ?? [],
        (tables.data ?? []).filter((x) => x.kind !== 'table' && x.kind !== 'sequence').map((x) => x.name)
      ),
      dependencyId(view ? 'view' : 'table', table)
    )
    return (
      <div className="space-y-1 p-3 text-sm">
        {reached.length === 0 ? (
          // Not "nothing" when the triggers could not be read: one may be on it.
          triggerError ? null : (
            <p className="text-ink-sub">{t.usedByNone}</p>
          )
        ) : (
          <ul className="list-disc pl-5 text-ink">
            {reached.map((n) => (
              <li key={n.id}>{dependencyLabel(n)}</li>
            ))}
          </ul>
        )}
        {/* Without the triggers (not allowed to list them, say), what views use is still listed. */}
        {triggerError ? <ErrorBox error={triggerError} onRetry={retryTriggers} /> : null}
        {report.data.status === 'unsupported' ? <p className="text-xs text-ink-sub">{t.unsupported}</p> : null}
        <p className="text-xs text-ink-sub">{t.routineNote}</p>
        <Link to="/db/$db/dependencies" params={{ db }} search={{ schema }} className="text-brand underline">
          {t.openAll}
        </Link>
      </div>
    )
  }
  return (
    <Card title={t.usedBy} bleed>
      {body()}
    </Card>
  )
}
