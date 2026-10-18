import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Card } from '@/components/ui/Card.tsx'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale-screens.ts'
import { dependencyGraph, dependencyId, dependentsOf } from '@/lib/dependencies.ts'
import { dependenciesQuery, type TableRef, triggersQuery } from '@/lib/queries.ts'

const t = locale.dependencies

/**
 * The views, routines and triggers a change to this table (or view) reaches (directly, or through views on it), with a link
 * to the whole diagram. Where the server keeps no catalog of what views use (MariaDB), only the triggers.
 */
export function UsedByCard({ tableRef, view = false }: { tableRef: TableRef; view?: boolean }) {
  const { db, schema, table } = tableRef
  const report = useQuery(dependenciesQuery(db, schema))
  const triggers = useQuery(triggersQuery(db, schema))
  const body = () => {
    if (report.isPending || triggers.isPending) return <Spinner />
    if (report.isError) return <ErrorBox error={report.error} onRetry={() => void report.refetch()} />
    if (triggers.isError) return <ErrorBox error={triggers.error} onRetry={() => void triggers.refetch()} />
    const reached = dependentsOf(
      dependencyGraph(report.data.objects, triggers.data),
      dependencyId(view ? 'view' : 'table', table)
    )
    return (
      <div className="space-y-1 p-3 text-sm">
        {reached.length === 0 ? (
          <p className="text-ink-sub">{t.usedByNone}</p>
        ) : (
          <ul className="list-disc pl-5 text-ink">
            {reached.map((n) => (
              <li key={n.id}>{t.named(t.kinds[n.kind], n.name)}</li>
            ))}
          </ul>
        )}
        {report.data.status === 'unsupported' ? <p className="text-xs text-ink-sub">{t.unsupported}</p> : null}
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
