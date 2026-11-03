import { useQueries } from '@tanstack/react-query'
import type { ExplainResult, RelationDef } from '@tsmyadmin/shared'
import { diagramFor, overlayUpTo } from '@/components/schema-diagram/overlay.ts'
import { SchemaDiagram } from '@/components/schema-diagram/SchemaDiagram.tsx'
import { DiagramLegend, StepNarration } from '@/components/schema-diagram/StepNarration.tsx'
import { useStepPlayer } from '@/components/schema-diagram/use-step-player.ts'
import { Notice } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale-screens.ts'
import { structureQuery } from '@/lib/queries.ts'
import type { useRowEstimates } from '@/lib/use-row-estimates.ts'
import { AssumedIndex } from './AssumedIndex.tsx'
import { IndexTrial } from './IndexTrial.tsx'
import { PlanTour } from './PlanTour.tsx'
import { PlanTree } from './PlanTree.tsx'
import { indexCandidates } from './plan-index.ts'
import { planReads, planSteps } from './plan-steps.ts'
import { triedOnTables } from './tried-indexes.ts'
import { type AssumedCompare, comparedRows } from './use-assumed-compare.ts'
import type { AssumedPlan } from './use-assumed-plan.ts'
import type { ForecastStart } from './use-forecast-start.ts'
import type { IndexTrial as Trial } from './use-index-trial.ts'

const t = locale.plan

/**
 * The plan shown (estimated, measured, with an index assumed or tried): the panels that try an index, the
 * presentation, the tree beside the tables it reads drawn and lit step by step, and the server's own words.
 */
export function PlanStory({
  db,
  schema,
  result,
  estimate,
  assumed,
  compared,
  build,
  relations,
  trial,
  estimates,
  generic = false,
}: {
  /** Planned for any value of its parameters (`EXPLAIN (GENERIC_PLAN)`): nothing to assume an index on or run. */
  generic?: boolean
  /** The tables' estimated rows, for the presentation (`useRowEstimates`). */
  estimates: ReturnType<typeof useRowEstimates>
  db: string
  schema?: string | undefined
  result: ExplainResult
  /** The plan estimated, as it is: what an index assumed is compared with. */
  estimate: ExplainResult
  assumed: AssumedPlan
  compared: AssumedCompare
  build: ForecastStart
  relations: readonly RelationDef[]
  /** An index to try, offered once the statement was measured (the run before). */
  trial: { state: Trial; before: ExplainResult; beforeTimes: number[] } | null
}) {
  const reads = planReads(result.plan)
  const tables = [...new Set(reads.map((r) => r.node.table))]
  // PostgreSQL names an index but not its columns: the tables' structure has them.
  const structures = useQueries({ queries: tables.map((table) => structureQuery({ db, schema, table })) })
  // An index assumed is in no table's structure: its columns are the ones asked for.
  const indexColumns = (table: string, index: string) =>
    (assumed.candidate?.table === table && assumed.candidate.name === index ? assumed.candidate.columns : null) ??
    structures[tables.indexOf(table)]?.data?.indexes.find((i) => i.name === index)?.columns ??
    []
  const steps = planSteps(reads, indexColumns)
  // The plan shown has an index that is not there: said under it, and presented as an estimate beside the plan as is.
  const assuming = assumed.candidate !== null && result === assumed.result ? assumed.candidate : null
  const player = useStepPlayer(steps.length)
  const extra = new Map<string, string[]>()
  for (const c of steps.flatMap((s) => s.columns ?? [])) extra.set(c.table, [...(extra.get(c.table) ?? []), c.column])
  const diagram = diagramFor(tables, relations, extra)
  const current = reads[player.index]?.path
  const shapeOf = (table: string) => {
    const s = structures[tables.indexOf(table)]?.data
    return s
      ? { columns: s.columns.map((c) => c.name), indexes: s.indexes, unusable: s.unusableIndexes ?? [] }
      : undefined
  }
  // Indexes a build left unusable on the tables read: each costs writes and blocks its name.
  const leftovers = tables.flatMap((table) =>
    (structures[tables.indexOf(table)]?.data?.unusableIndexes ?? []).map((name) => ({ table, name }))
  )
  // Indexes tried from a plan before (in any browser: marked on the server), not the one tried now: left behind.
  const triedBefore = triedOnTables(
    tables.map((table, i) => ({
      table,
      indexes: structures[i]?.data?.indexes,
      partitioned: structures[i]?.data?.partitioned,
    })),
    trial?.state.tried ?? null
  )
  const candidates = indexCandidates(estimate.plan, shapeOf)
  // The candidates compared, once all their rows are in and of these candidates: told as a chapter of their own.
  const told = comparedRows(compared, candidates)
  return (
    <div className="space-y-3">
      {generic ? null : (
        <AssumedIndex
          assumed={assumed}
          compared={compared}
          before={estimate}
          candidates={candidates}
          // Built for real through the trial, once there is a run to compare with and nothing is tried yet.
          onBuild={trial && !trial.state.tried ? (c) => void build.start(c) : undefined}
          building={build.forecasting}
        />
      )}
      {trial ? (
        <IndexTrial
          trial={trial.state}
          build={build}
          before={trial.before}
          beforeTimes={trial.beforeTimes}
          candidates={indexCandidates(trial.before.plan, shapeOf)}
          leftovers={leftovers}
          triedBefore={triedBefore}
        />
      ) : null}
      {reads.length > 0 ? (
        <PlanTour
          plan={result.plan}
          relations={relations}
          indexColumns={indexColumns}
          rows={estimates.rows}
          measuredMs={result.measured ? result.measured.ms : undefined}
          trial={
            trial?.state.after && trial.state.tried && result === trial.state.after
              ? {
                  before: trial.before,
                  index: trial.state.tried,
                  forecast: trial.state.forecast ?? undefined,
                  runs: { before: trial.beforeTimes, after: trial.state.afterTimes },
                }
              : undefined
          }
          // Used or not as the panel above says it: by the server's own name for the index assumed.
          assumed={
            assuming
              ? { before: estimate, index: assuming, used: result.assumed?.includes(assuming.name) ?? false }
              : undefined
          }
          compare={told ? { before: estimate, rows: told } : undefined}
          ready={structures.every((s) => !s.isPending) && !estimates.pending}
        />
      ) : null}
      <div className="grid gap-3 lg:grid-cols-2">
        <figure tabIndex={0} className="min-w-0 overflow-auto">
          <figcaption className="mb-1 text-xs font-semibold text-ink-sub">{t.tree}</figcaption>
          <ul className="font-mono text-xs">
            <PlanTree node={result.plan} path="0" current={current} />
          </ul>
        </figure>
        <div className="min-w-0 space-y-2">
          {reads.length > 0 ? (
            <>
              <SchemaDiagram {...diagram} overlay={overlayUpTo(steps, player.index)} label={t.diagram} />
              <DiagramLegend tones={['index', 'scan']} />
            </>
          ) : (
            <Notice>{t.noReads}</Notice>
          )}
        </div>
      </div>
      {steps.length > 0 ? <StepNarration steps={steps} player={player} /> : null}
      <p className="text-xs text-ink-sub">
        {result.measured
          ? t.notesMeasured
          : assuming
            ? t.notesAssumed(assuming.name)
            : generic
              ? t.notesGeneric
              : t.notes}
      </p>
      <details className="text-xs">
        <summary className="cursor-pointer text-ink-sub">{t.raw}</summary>
        {result.rawTruncated ? <p className="text-ink-sub">{t.rawTruncated}</p> : null}
        <pre tabIndex={0} className="mt-1 max-h-80 overflow-auto rounded bg-surface-sub p-2 text-ink">
          {result.raw}
        </pre>
      </details>
    </div>
  )
}
