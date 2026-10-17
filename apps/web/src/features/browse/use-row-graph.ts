import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { rowsQuery } from '@/lib/queries.ts'
import { expandGraph, type RowGraph, type RowNode, rowSteps } from './row-graph.ts'

/**
 * The rows around a row, read one step at a time as the reader opens them. Each read is a page of the table (the
 * grid's own query), which also says the keys of that table, so the rows found can be opened in turn. One row is
 * read at a time. The graph is not put in the address: its row values stay in the page (only a link to open the
 * unread rows in their table carries the key it filters by).
 */
export function useRowGraph(root: RowNode) {
  const queryClient = useQueryClient()
  const [graph, setGraph] = useState<RowGraph>(() => ({
    nodes: new Map([[root.id, root]]),
    arrows: [],
    more: [],
    expanded: new Set(),
  }))
  const [busy, setBusy] = useState<string | null>(null)
  // The state is a render behind: two clicks in one frame would both see nothing being read.
  const reading = useRef(false)
  const [error, setError] = useState<unknown>(null)

  const expand = async (id: string) => {
    const node = graph.nodes.get(id)
    if (!node || graph.expanded.has(id) || reading.current) return
    reading.current = true
    setBusy(id)
    setError(null)
    try {
      const steps = rowSteps(node)
      const pages = await Promise.all(steps.map((s) => queryClient.fetchQuery(rowsQuery(s.ref, s.options))))
      setGraph((g) => expandGraph(g, id, steps, pages))
    } catch (err) {
      setError(err)
    } finally {
      reading.current = false
      setBusy(null)
    }
  }

  return { ...graph, busy, error, expand }
}
