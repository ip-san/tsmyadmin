import { useState } from 'react'
import { type GraphNode, NodeGraph } from '@/components/node-graph/NodeGraph.tsx'
import { DiagramLegend } from '@/components/schema-diagram/StepNarration.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale-screens.ts'
import { type DependencyGraph, dependencyLabel, dependentsOf } from '@/lib/dependencies.ts'
import { useDependencyGraph } from '@/lib/use-dependency-graph.ts'

const t = locale.dependencies

/** The edges in words, for the list beside the picture: who uses what, each once (those among `only`, if given). */
function edgeSentences(graph: DependencyGraph, only?: ReadonlySet<string>): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  return graph.edges.flatMap((e) => {
    const from = byId.get(e.from)
    const to = byId.get(e.to)
    if (!from || !to || (only && !(only.has(e.from) && only.has(e.to)))) return []
    const say = e.kind === 'fires' ? t.fires : t.reads
    return [say(dependencyLabel(from), dependencyLabel(to))]
  })
}

/**
 * Which views, routines and triggers use which tables and views, as a picture and in words: choosing one lights
 * what a change to it reaches (directly or through views on it), and can draw only that. Trigger bodies are not
 * read, so a trigger is joined to what it is attached to only; what a routine's body reads is known only where the
 * catalog records it; MariaDB records nothing of what views and routines use.
 */
export function Dependencies({
  db,
  schema,
  focus: start,
}: {
  db: string
  schema?: string | undefined
  /** The table or view chosen at first (a node's id), from a link. */
  focus?: string | undefined
}) {
  const deps = useDependencyGraph(db, schema)
  // The start comes from the address; choosing another is not written back (a reload starts from the link again).
  const [chosen, setChosen] = useState(start ?? '')
  const [onlyReached, setOnlyReached] = useState(false)
  if (deps.pending) return <Spinner />
  if (deps.failed) return <ErrorBox error={deps.failed.error} onRetry={deps.failed.retry} />
  const graph = deps.graph
  // What can be changed: a table, or a view (others use views too).
  const changeable = graph.nodes
    .filter((n) => n.kind === 'table' || n.kind === 'view')
    .sort((a, b) => dependencyLabel(a).localeCompare(dependencyLabel(b)))
  const focus = changeable.find((n) => n.id === chosen)
  const reached = focus ? dependentsOf(graph, focus.id) : []
  const lit = new Set(reached.map((n) => n.id))
  const kept = focus && onlyReached ? new Set([focus.id, ...lit]) : undefined
  const nodes: GraphNode[] = graph.nodes
    .filter((n) => !kept || kept.has(n.id))
    .map((n) => ({
      id: n.id,
      label: dependencyLabel(n),
      tone: n.id === focus?.id ? 'focus' : lit.has(n.id) ? 'nullify' : undefined,
    }))
  const said = focus
    ? reached.length === 0
      ? t.reachesNone(dependencyLabel(focus))
      : t.reaches(dependencyLabel(focus), reached.map(dependencyLabel))
    : ''
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-sm font-semibold text-ink">{t.title}</h2>
        <p className="text-xs text-ink-sub">{t.hint}</p>
      </div>
      {deps.status === 'unsupported' ? <Notice>{t.unsupported}</Notice> : null}
      {/* A part that could not be read (the triggers, the list of tables): the rest is drawn, and this says why. */}
      {deps.missing.map((m, i) => (
        // At most two, in a fixed order: the place names one.
        <ErrorBox key={i} error={m.error} onRetry={m.retry} />
      ))}
      {graph.edges.length === 0 ? (
        // Not "none" when the triggers could not be read: there may be some.
        deps.missing.length > 0 ? null : (
          <p className="text-sm text-ink-sub">{t.none}</p>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-ink">
              {t.change}
              <Select
                value={chosen}
                onChange={(e) => {
                  setChosen(e.target.value)
                  if (e.target.value === '') setOnlyReached(false)
                }}
              >
                <option value="">{t.noTable}</option>
                {changeable.map((n) => (
                  <option key={n.id} value={n.id}>
                    {dependencyLabel(n)}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex items-center gap-1 text-sm text-ink">
              <input
                type="checkbox"
                // Off while nothing is chosen, and so when something is chosen again.
                checked={onlyReached && focus !== undefined}
                disabled={!focus}
                onChange={(e) => setOnlyReached(e.target.checked)}
              />
              {t.onlyReached}
            </label>
          </div>
          <p role="status" className="text-sm text-ink empty:mb-0">
            {said}
          </p>
          <NodeGraph
            nodes={nodes}
            arrows={graph.edges.map((e) => ({ from: e.from, to: e.to }))}
            label={t.diagram}
            fadeUntoned={focus !== undefined}
          />
          <DiagramLegend tones={['focus', 'nullify']} labels={{ focus: t.legendTable, nullify: t.legendReached }} />
          <ul aria-label={t.sentences} className="list-disc space-y-0.5 pl-5 text-sm text-ink">
            {edgeSentences(graph, kept).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <p className="text-xs text-ink-sub">{t.triggerNote}</p>
          <p className="text-xs text-ink-sub">{t.routineNote}</p>
        </>
      )}
    </section>
  )
}
