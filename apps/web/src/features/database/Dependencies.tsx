import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { type GraphNode, NodeGraph } from '@/components/node-graph/NodeGraph.tsx'
import { DiagramLegend } from '@/components/schema-diagram/StepNarration.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale-screens.ts'
import { type DependencyGraph, type DependencyNode, dependencyGraph, dependentsOf } from '@/lib/dependencies.ts'
import { dependenciesQuery, triggersQuery } from '@/lib/queries.ts'

const t = locale.dependencies

/** A node as it is named in the picture and in the sentences: its kind, then its name. */
const nameOf = (n: DependencyNode) => t.named(t.kinds[n.kind], n.name)

/** The edges in words, for the list beside the picture: who uses what, each once. */
function edgeSentences(graph: DependencyGraph): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  return graph.edges.flatMap((e) => {
    const from = byId.get(e.from)
    const to = byId.get(e.to)
    if (!from || !to) return []
    return [e.kind === 'fires' ? t.fires(nameOf(from), nameOf(to)) : t.reads(nameOf(from), nameOf(to))]
  })
}

/**
 * Which views, routines and triggers use which tables, as a picture and in words: choosing a table lights what a
 * change to it reaches (directly or through views on it). Trigger bodies are not read, so a trigger is joined to
 * the table it is attached to only; MariaDB keeps no catalog of what views and routines use.
 */
export function Dependencies({ db, schema }: { db: string; schema?: string | undefined }) {
  const report = useQuery(dependenciesQuery(db, schema))
  const triggers = useQuery(triggersQuery(db, schema))
  const [chosen, setChosen] = useState('')
  if (report.isPending || triggers.isPending) return <Spinner />
  if (report.isError) return <ErrorBox error={report.error} onRetry={() => void report.refetch()} />
  if (triggers.isError) return <ErrorBox error={triggers.error} onRetry={() => void triggers.refetch()} />
  const graph = dependencyGraph(report.data.objects, triggers.data)
  const tables = graph.nodes.filter((n) => n.kind === 'table').sort((a, b) => a.name.localeCompare(b.name))
  const focus = tables.find((n) => n.id === chosen)
  const reached = focus ? dependentsOf(graph, focus.id) : []
  const lit = new Set(reached.map((n) => n.id))
  const nodes: GraphNode[] = graph.nodes.map((n) => ({
    id: n.id,
    label: nameOf(n),
    tone: n.id === focus?.id ? 'focus' : lit.has(n.id) ? 'nullify' : undefined,
  }))
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-sm font-semibold text-ink">{t.title}</h2>
        <p className="text-xs text-ink-sub">{t.hint}</p>
      </div>
      {report.data.status === 'unsupported' ? <Notice>{t.unsupported}</Notice> : null}
      {graph.edges.length === 0 ? (
        <p className="text-sm text-ink-sub">{t.none}</p>
      ) : (
        <>
          <label className="flex items-center gap-2 text-sm text-ink">
            {t.change}
            <Select value={chosen} onChange={(e) => setChosen(e.target.value)}>
              <option value="">{t.noTable}</option>
              {tables.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </Select>
          </label>
          <p role="status" className="text-sm text-ink empty:mb-0">
            {focus
              ? reached.length === 0
                ? t.reachesNone(focus.name)
                : t.reaches(focus.name, reached.map(nameOf))
              : ''}
          </p>
          <NodeGraph
            nodes={nodes}
            arrows={graph.edges.map((e) => ({ from: e.from, to: e.to }))}
            label={t.diagram}
            fadeUntoned={focus !== undefined}
          />
          <DiagramLegend tones={['focus', 'nullify']} labels={{ focus: t.legendTable, nullify: t.legendReached }} />
          <ul aria-label={t.sentences} className="list-disc space-y-0.5 pl-5 text-sm text-ink">
            {edgeSentences(graph).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <p className="text-xs text-ink-sub">{t.triggerNote}</p>
        </>
      )}
    </section>
  )
}
