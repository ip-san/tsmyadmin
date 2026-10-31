import { useQueries, useQuery } from '@tanstack/react-query'
import type { ExplainResult, PlanNode, RelationDef } from '@tsmyadmin/shared'
import { diagramFor, overlayUpTo } from '@/components/schema-diagram/overlay.ts'
import { SchemaDiagram } from '@/components/schema-diagram/SchemaDiagram.tsx'
import { DiagramLegend, StepNarration } from '@/components/schema-diagram/StepNarration.tsx'
import { useStepPlayer } from '@/components/schema-diagram/use-step-player.ts'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale-screens.ts'
import { explainQuery, foreignKeysQuery, structureQuery } from '@/lib/queries.ts'
import { useRowEstimates } from '@/lib/use-row-estimates.ts'
import { IndexTrial } from './IndexTrial.tsx'
import { MeasurePlan } from './MeasurePlan.tsx'
import { PlanTour } from './PlanTour.tsx'
import { indexCandidates } from './plan-index.ts'
import { misestimate } from './plan-measure.ts'
import { planReads, planSteps } from './plan-steps.ts'
import { type IndexTrial as Trial, useIndexTrial } from './use-index-trial.ts'
import { useMeasuredPlan } from './use-measured-plan.ts'

const t = locale.plan

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
  onClose,
}: {
  db: string
  schema?: string | undefined
  sql: string
  onClose: () => void
}) {
  const plan = useQuery(explainQuery(db, schema, sql))
  const relations = useQuery(foreignKeysQuery(db, schema))
  const measure = useMeasuredPlan(db, schema, sql)
  const trial = useIndexTrial(db, schema, sql)
  return (
    <section aria-label={t.title} className="space-y-3 rounded border border-line bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">{t.title}</h3>
        <Button size="sm" onClick={onClose}>
          {t.close}
        </Button>
      </div>
      {plan.isPending || relations.isPending ? (
        <Spinner label={t.loading} />
      ) : plan.isError ? (
        <ErrorBox error={plan.error} />
      ) : relations.isError ? (
        <ErrorBox error={relations.error} onRetry={() => void relations.refetch()} />
      ) : (
        <>
          {/* While an index is tried, the run before stays the one it is compared with: measured again there. */}
          {trial.tried ? null : <MeasurePlan measure={measure} />}
          <PlanStory
            db={db}
            schema={schema}
            result={trial.after ?? measure.result ?? plan.data}
            relations={relations.data}
            trial={measure.result ? { state: trial, before: measure.result } : null}
          />
        </>
      )}
    </section>
  )
}

function PlanStory({
  db,
  schema,
  result,
  relations,
  trial,
}: {
  db: string
  schema?: string | undefined
  result: ExplainResult
  relations: readonly RelationDef[]
  /** An index to try, offered once the statement was measured (the run before). */
  trial: { state: Trial; before: ExplainResult } | null
}) {
  const reads = planReads(result.plan)
  const tables = [...new Set(reads.map((r) => r.node.table))]
  // PostgreSQL names an index but not its columns: the tables' structure has them.
  const structures = useQueries({ queries: tables.map((table) => structureQuery({ db, schema, table })) })
  const indexColumns = (table: string, index: string) =>
    structures[tables.indexOf(table)]?.data?.indexes.find((i) => i.name === index)?.columns ?? []
  const steps = planSteps(reads, indexColumns)
  // The presentation says each table's size: it waits for the list, and goes on without it if it cannot be read.
  const estimates = useRowEstimates(db, schema)
  const player = useStepPlayer(steps.length)
  const extra = new Map<string, string[]>()
  for (const c of steps.flatMap((s) => s.columns ?? [])) extra.set(c.table, [...(extra.get(c.table) ?? []), c.column])
  const diagram = diagramFor(tables, relations, extra)
  const current = reads[player.index]?.path
  const shapeOf = (table: string) => {
    const s = structures[tables.indexOf(table)]?.data
    return s ? { columns: s.columns.map((c) => c.name), indexes: s.indexes } : undefined
  }
  return (
    <div className="space-y-3">
      {trial ? (
        <IndexTrial
          trial={trial.state}
          before={trial.before}
          candidates={indexCandidates(trial.before.plan, shapeOf)}
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
            trial?.state.after && trial.state.tried ? { before: trial.before, index: trial.state.tried } : undefined
          }
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
      <p className="text-xs text-ink-sub">{result.measured ? t.notesMeasured : t.notes}</p>
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

/** The tree as the server gave it; the node read at the current step is marked. */
function PlanTree({ node, path, current }: { node: PlanNode; path: string; current: string | undefined }) {
  const here = path === current
  const ms = node.actual?.ms ?? null
  // A step far off its estimate is marked in the tree too, where the eye goes first.
  const off = misestimate(node)
  const facts = [
    node.table ? `${node.table}${node.alias ? ` ${node.alias}` : ''}` : null,
    node.index ? `[${node.index}]` : null,
    node.estRows === null ? null : t.rows(Math.round(node.estRows)),
    node.actual ? t.actual(node.actual.rows, node.actual.loops, ms === null ? null : t.duration(ms)) : null,
    off ? t.off(off.factor, off.more) : null,
  ].filter(Boolean)
  return (
    <li className="ml-3 border-l border-line pl-2">
      <span
        aria-current={here ? 'step' : undefined}
        className={`inline-block rounded px-1 ${here ? 'bg-row-hover font-semibold text-ink' : 'text-ink'}`}
      >
        {node.op}
        {facts.length > 0 ? <span className="text-ink-sub"> — {facts.join(' · ')}</span> : null}
      </span>
      {node.detail ? <div className="break-all text-ink-sub">{node.detail}</div> : null}
      {node.children.length > 0 ? (
        <ul>
          {node.children.map((c, i) => (
            <PlanTree key={`${path}.${i}`} node={c} path={`${path}.${i}`} current={current} />
          ))}
        </ul>
      ) : null}
    </li>
  )
}
