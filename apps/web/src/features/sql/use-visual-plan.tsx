import { lazy, Suspense, useState } from 'react'
import { Spinner } from '@/components/ui/Feedback.tsx'

// Loaded when asked for: most statements are run, not drawn.
const PlanView = lazy(() => import('./PlanView.tsx').then((m) => ({ default: m.PlanView })))

/** The statement whose plan is drawn in the SQL tab (one at a time), and the panel that draws it. */
export function useVisualPlan(db: string, schema: string | undefined) {
  const [sql, setSql] = useState<string | null>(null)
  const panel =
    sql === null ? null : (
      <Suspense fallback={<Spinner />}>
        {/* A new statement is a new view: what was measured of the last one is not shown under this one. */}
        <PlanView
          key={`${db}\0${schema ?? ''}\0${sql}`}
          db={db}
          schema={schema}
          sql={sql}
          onClose={() => setSql(null)}
        />
      </Suspense>
    )
  return { show: setSql, panel }
}
