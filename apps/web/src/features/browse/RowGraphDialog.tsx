import { Link } from '@tanstack/react-router'
import type { GraphNode } from '@/components/node-graph/NodeGraph.tsx'
import { NodeGraph } from '@/components/node-graph/NodeGraph.tsx'
import { DiagramLegend } from '@/components/schema-diagram/StepNarration.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale-screens.ts'
import { arrowSentences, type RowNode, rowLabel } from './row-graph.ts'
import { useRowGraph } from './use-row-graph.ts'

const t = locale.rowGraph

/**
 * A row and the rows its foreign keys join it to, opened a step at a time: a picture of the rows, and beside it the
 * same rows as a list, where each is opened and the rows not read are reached.
 */
export function RowGraphDialog({ root, onClose }: { root: RowNode; onClose: () => void }) {
  const graph = useRowGraph(root)
  const labels = new Map([...graph.nodes.values()].map((n) => [n.id, rowLabel(n)]))
  const nodes: GraphNode[] = [
    ...[...graph.nodes.values()].map((n) => ({
      id: n.id,
      label: labels.get(n.id)?.label ?? n.ref.table,
      sublabel: labels.get(n.id)?.sublabel,
      tone: n.id === root.id ? ('focus' as const) : undefined,
    })),
    ...graph.more.map((m) => ({ id: m.id, label: m.ref.table, sublabel: t.more(m.count) })),
  ]
  return (
    <Dialog
      open
      title={t.title(root.ref.table)}
      onClose={onClose}
      footer={<Button onClick={onClose}>{locale.common.close}</Button>}
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-sub">{t.hint}</p>
        <NodeGraph nodes={nodes} arrows={graph.arrows} label={t.diagram} />
        <DiagramLegend tones={['focus']} labels={{ focus: t.root }} />
        {graph.error ? <ErrorBox error={graph.error} /> : null}
        <section aria-label={t.rows}>
          <ul className="space-y-1 text-sm">
            {[...graph.nodes.values()].map((n) => (
              <RowItem
                key={n.id}
                node={n}
                label={labels.get(n.id)}
                opened={graph.expanded.has(n.id)}
                busy={graph.busy === n.id}
                waiting={graph.busy !== null}
                onExpand={() => void graph.expand(n.id)}
              />
            ))}
            {graph.more.map((m) => (
              <li key={m.id}>
                <Link
                  to="/db/$db/table/$table"
                  params={{ db: m.ref.db, table: m.ref.table }}
                  // The key's values go in the address, as a foreign key cell's link puts them: what the table page
                  // filters by. The graph's own rows stay out of it.
                  search={{ schema: m.ref.schema, filters: JSON.stringify(m.filters), page: 1 }}
                  // Every table's page is the same route: the page under the dialog stays, and so would the dialog.
                  onClick={onClose}
                  className="text-brand underline"
                >
                  {t.openMore(m.count, m.ref.table)}
                </Link>
              </li>
            ))}
          </ul>
        </section>
        <ul aria-label={t.links} className="space-y-0.5 text-xs text-ink-sub">
          {arrowSentences(graph, (id) => labels.get(id)?.label ?? id, t.refersTo).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    </Dialog>
  )
}

function RowItem({
  node,
  label,
  opened,
  busy,
  waiting,
  onExpand,
}: {
  node: RowNode
  label: { label: string; sublabel: string | undefined } | undefined
  opened: boolean
  busy: boolean
  /** Another row is being read: one at a time. */
  waiting: boolean
  onExpand: () => void
}) {
  const name = label?.label ?? node.ref.table
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span className="font-medium text-ink">{name}</span>
      {label?.sublabel ? <span className="text-ink-sub">{label.sublabel}</span> : null}
      {opened ? (
        <span className="text-xs text-ink-sub">{t.expanded}</span>
      ) : (
        <Button size="sm" onClick={onExpand} disabled={waiting} aria-label={t.expand(name)}>
          {busy ? t.reading : t.expandShort}
        </Button>
      )}
    </li>
  )
}
