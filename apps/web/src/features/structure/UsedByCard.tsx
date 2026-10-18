import { Link } from '@tanstack/react-router'
import { Card } from '@/components/ui/Card.tsx'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale-screens.ts'
import { dependencyId, dependencyLabel, dependentsOf } from '@/lib/dependencies.ts'
import type { TableRef } from '@/lib/queries.ts'
import { useDependencyGraph } from '@/lib/use-dependency-graph.ts'

const t = locale.dependencies

/**
 * The views, routines and triggers a change to this table (or view) reaches (directly, or through views on it),
 * with a link to the whole diagram. Where the server keeps no catalog of what views use (MariaDB), only the
 * triggers; where the triggers cannot be listed, what views use, and why the triggers are missing.
 */
export function UsedByCard({ tableRef, view = false }: { tableRef: TableRef; view?: boolean }) {
  const { db, schema, table } = tableRef
  const deps = useDependencyGraph(db, schema)
  const self = dependencyId(view ? 'view' : 'table', table)
  const body = () => {
    if (deps.pending) return <Spinner />
    if (deps.failed) return <ErrorBox error={deps.failed.error} onRetry={deps.failed.retry} />
    const reached = dependentsOf(deps.graph, self)
    return (
      <div className="space-y-1 p-3 text-sm">
        {reached.length === 0 ? (
          // Not "nothing" when a part could not be read: a trigger may be on it.
          deps.missing.length > 0 ? null : (
            <p className="text-ink-sub">{t.usedByNone}</p>
          )
        ) : (
          <ul className="list-disc pl-5 text-ink">
            {reached.map((n) => (
              <li key={n.id}>
                {/* A view has an overview of its own; a routine or a trigger is named only. */}
                {n.kind === 'view' ? (
                  <Link
                    to="/db/$db/table/$table/overview"
                    params={{ db, table: n.name }}
                    search={{ schema }}
                    className="text-brand underline"
                  >
                    {dependencyLabel(n)}
                  </Link>
                ) : (
                  dependencyLabel(n)
                )}
              </li>
            ))}
          </ul>
        )}
        {deps.missing.map((m, i) => (
          // At most two, in a fixed order: the place names one.
          <ErrorBox key={i} error={m.error} onRetry={m.retry} />
        ))}
        {deps.status === 'unsupported' ? <p className="text-xs text-ink-sub">{t.unsupported}</p> : null}
        <p className="text-xs text-ink-sub">{t.routineNote}</p>
        {/* The diagram opens with this one chosen, when it is in the diagram (nothing uses it otherwise). */}
        <Link
          to="/db/$db/dependencies"
          params={{ db }}
          search={{ schema, focus: deps.graph.nodes.some((n) => n.id === self) ? self : undefined }}
          className="text-brand underline"
        >
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
