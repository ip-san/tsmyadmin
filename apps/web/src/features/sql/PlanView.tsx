import { useQuery } from '@tanstack/react-query'
import { capabilities, type Dialect } from '@tsmyadmin/shared'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale-screens.ts'
import { isApiError } from '@/lib/api.ts'
import { explainQuery, foreignKeysQuery } from '@/lib/queries.ts'
import { useDialect } from '@/lib/session.ts'
import { findParameters, positionalParameters } from '@/lib/sql-prepare.ts'
import { useRowEstimates } from '@/lib/use-row-estimates.ts'
import { MeasurePlan } from './MeasurePlan.tsx'
import { PlanStory } from './PlanStory.tsx'
import { useMeasureRuns } from './plan-runs.ts'
import { readRows, statsSigns } from './plan-stats.ts'
import { isLimited } from './plan-tour.ts'
import { StatsRefresh } from './StatsRefresh.tsx'
import { useAssumedCompare } from './use-assumed-compare.ts'
import { useAssumedPlan } from './use-assumed-plan.ts'
import { useForecastStart } from './use-forecast-start.ts'
import { useIndexTrial } from './use-index-trial.ts'
import { useMeasuredPlan } from './use-measured-plan.ts'
import { useStatsRefresh } from './use-stats-refresh.ts'

const t = locale.plan

/**
 * The statement planned: as it is, or, with `:name` values not given, as the server's `$1`, `$2`… planned for any
 * value (`generic`, where the server can); `missing` where it cannot be planned without them.
 */
export function plannedStatement(sql: string, dialect: Dialect): { sql: string; generic: boolean; missing: boolean } {
  if (findParameters(sql).length === 0) return { sql, generic: false, missing: false }
  return capabilities(dialect).genericPlan
    ? { sql: positionalParameters(sql), generic: true, missing: false }
    : { sql, generic: false, missing: true }
}

/**
 * The plan of one statement, estimated on the server: the tree as the server gave it, and the tables it reads drawn
 * on their own, lit in the order they are read (full reads apart from reads through an index), with the same story
 * in words. Opened from the SQL tab's EXPLAIN. Measured on a press (`MeasurePlan`): the same, with each step's rows
 * and time as they were when the statement ran.
 */
export function PlanView({
  db,
  schema,
  sql,
  scope,
  onClose,
}: {
  db: string
  schema?: string | undefined
  sql: string
  /** The server (`dialect.host.port`): the indexes tried are remembered per server. */
  scope: string
  onClose: () => void
}) {
  const statement = plannedStatement(sql, useDialect())
  const plan = useQuery({
    ...explainQuery(db, schema, statement.sql, statement.generic),
    enabled: !statement.missing,
  })
  const relations = useQuery(foreignKeysQuery(db, schema))
  const [runs, setRuns] = useMeasureRuns()
  const measure = useMeasuredPlan(db, schema, sql, runs)
  // Measured after as many times as before was (however the choice has changed since): the medians compare.
  const trial = useIndexTrial(db, schema, sql, scope, measure.times.length > 0 ? measure.times.length : runs)
  const assumed = useAssumedPlan(db, schema, sql)
  const compared = useAssumedCompare(db, schema, sql)
  // Statistics taken again: what was measured or assumed under the old ones is put away.
  const stats = useStatsRefresh(db, schema, () => {
    const had = measure.result !== null
    measure.clear()
    assumed.clear()
    return { cleared: had, planAt: plan.dataUpdatedAt }
  })
  // Nothing is measured or tried while statistics are taken: what it measured would be under neither.
  const analyzing = stats.flow.running
  // Built from here or from trying it without building it, the index keeps what the server expected of it.
  const build = useForecastStart(db, schema, sql, plan.data, assumed, compared, (c, f) => {
    if (!analyzing) trial.start(c, f)
  })
  // The presentation says each table's size: it waits for the list, and goes on without it if it cannot be read.
  const estimates = useRowEstimates(db, schema, stats.since)
  return (
    <section aria-label={t.title} className="space-y-3 rounded border border-line bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">{t.title}</h3>
        <Button size="sm" onClick={onClose}>
          {t.close}
        </Button>
      </div>
      {statement.missing ? (
        <Notice>{t.valuesNeeded}</Notice>
      ) : plan.isPending || relations.isPending ? (
        <Spinner label={t.loading} />
      ) : plan.isError ? (
        // A server before PostgreSQL 16 plans only with the values: said as such, not as a failure.
        statement.generic && isApiError(plan.error, 'UNSUPPORTED') ? (
          <Notice>{t.genericUnsupported}</Notice>
        ) : (
          <ErrorBox error={plan.error} />
        )
      ) : relations.isError ? (
        <ErrorBox error={relations.error} onRetry={() => void relations.refetch()} />
      ) : (
        <>
          {/* While an index is tried, the run before stays the one it is compared with: measured again there. */}
          {/* Planned for any value, it cannot run: there are no values to run it with. */}
          {trial.tried || statement.generic ? null : (
            <MeasurePlan
              runs={runs}
              onRuns={setRuns}
              // Measured, the run is what is shown: the plan with an index assumed is put away first.
              measure={{
                ...measure,
                run: async () => {
                  if (analyzing) return
                  assumed.clear()
                  return measure.run()
                },
              }}
            />
          )}
          {/* Kept while an index is tried (its status stays), with nothing to take: the run compared with stays. */}
          <StatsRefresh
            stats={stats}
            signs={
              trial.tried
                ? []
                : statsSigns(plan.data.plan, isLimited(plan.data.plan), measure.result?.plan ?? null, estimates.rows)
            }
            rowsNow={(table) => readRows(plan.data.plan, table)}
            // Read again after this refresh, not on any other read of the plan.
            rereading={plan.dataUpdatedAt === stats.refreshed?.planAt}
            busy={measure.step === 'running' || trial.tried !== null}
          />
          <PlanStory
            generic={statement.generic}
            estimates={estimates}
            db={db}
            schema={schema}
            // The plan with an index assumed is shown for as long as it is asked for ("back to the plan as it is").
            result={trial.after ?? assumed.result ?? measure.result ?? plan.data}
            estimate={plan.data}
            assumed={assumed}
            compared={compared}
            build={build}
            relations={relations.data}
            trial={measure.result ? { state: trial, before: measure.result, beforeTimes: measure.times } : null}
          />
        </>
      )}
    </section>
  )
}
