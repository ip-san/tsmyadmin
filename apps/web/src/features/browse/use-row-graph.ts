import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { GraphArrow } from '@/components/node-graph/NodeGraph.tsx'
import { rowsQuery, type TableRef } from '@/lib/queries.ts'
import { REFERRING_SHOWN, type RowNode, type RowStep, rowNode, rowSteps } from './row-graph.ts'

/** Rows of a table that refer to a row and were not read: how many, and where to open them. */
interface MoreRows {
  id: string
  to: string
  ref: TableRef
  filters: RowStep['options']['filters']
  count: number
}

interface Graph {
  nodes: Map<string, RowNode>
  arrows: GraphArrow[]
  more: MoreRows[]
  expanded: Set<string>
}

/**
 * The rows around a row, read one step at a time as the reader opens them. Each read is a page of the table (the
 * grid's own query), which also says the keys of that table, so the rows found can be opened in turn. Nothing of
 * this is put in the address: row values stay in the page.
 */
export function useRowGraph(root: RowNode) {
  const queryClient = useQueryClient()
  const [graph, setGraph] = useState<Graph>(() => ({
    nodes: new Map([[root.id, root]]),
    arrows: [],
    more: [],
    expanded: new Set(),
  }))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)

  const expand = async (id: string) => {
    const node = graph.nodes.get(id)
    if (!node || graph.expanded.has(id) || busy) return
    setBusy(id)
    setError(null)
    try {
      const steps = rowSteps(node)
      const pages = await Promise.all(steps.map((s) => queryClient.fetchQuery(rowsQuery(s.ref, s.options))))
      setGraph((g) => {
        const nodes = new Map(g.nodes)
        const arrows = [...g.arrows]
        const more = [...g.more]
        steps.forEach((step, i) => {
          const page = pages[i]
          if (!page) return
          for (const row of page.rows) {
            const found = nodes.get(rowNode(step.ref, page, row).id) ?? rowNode(step.ref, page, row)
            nodes.set(found.id, found)
            const arrow =
              step.direction === 'out'
                ? { from: id, to: found.id, label: step.label }
                : { from: found.id, to: id, label: step.label }
            if (!arrows.some((a) => a.from === arrow.from && a.to === arrow.to && a.label === arrow.label)) {
              arrows.push(arrow)
            }
          }
          const total = page.total ?? page.rows.length
          if (step.direction === 'in' && total > REFERRING_SHOWN) {
            const moreId = JSON.stringify(['more', id, step.ref.table, step.label])
            more.push({
              id: moreId,
              to: id,
              ref: step.ref,
              filters: step.options.filters,
              count: total - page.rows.length,
            })
            arrows.push({ from: moreId, to: id, label: step.label })
          }
        })
        return { nodes, arrows, more, expanded: new Set([...g.expanded, id]) }
      })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(null)
    }
  }

  return { ...graph, busy, error, expand }
}
