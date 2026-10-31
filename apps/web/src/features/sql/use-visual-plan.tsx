import { lazy, Suspense, useState } from 'react'
import { Spinner } from '@/components/ui/Feedback.tsx'
import { useTriedIndexes } from './tried-indexes.ts'

// Loaded when asked for: most statements are run, not drawn.
const PlanView = lazy(() => import('./PlanView.tsx').then((m) => ({ default: m.PlanView })))
const TriedIndexes = lazy(() => import('./TriedIndexes.tsx').then((m) => ({ default: m.TriedIndexes })))

/**
 * The statement whose plan is drawn in the SQL tab (one at a time), and the panel that draws it. With no plan open,
 * the indexes tried from a plan and not dropped yet (`scope`: the server, `dialect.host.port`).
 */
export function useVisualPlan(db: string, schema: string | undefined, scope: string) {
  const [sql, setSql] = useState<string | null>(null)
  const tried = useTriedIndexes(scope, db, schema).length > 0
  const panel =
    sql === null ? (
      tried ? (
        <Suspense fallback={null}>
          <TriedIndexes scope={scope} db={db} schema={schema} />
        </Suspense>
      ) : null
    ) : (
      <Suspense fallback={<Spinner />}>
        {/* A new statement is a new view: what was measured of the last one is not shown under this one. */}
        <PlanView
          key={`${db}\0${schema ?? ''}\0${sql}`}
          db={db}
          schema={schema}
          sql={sql}
          scope={scope}
          onClose={() => setSql(null)}
        />
      </Suspense>
    )
  return { show: setSql, panel }
}
