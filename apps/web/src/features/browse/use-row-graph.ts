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
  // The graph as last set, ahead of the render: a press between the end of one read and the next render must
  // build on the rows that read added, not on the graph it was rendered with.
  const latest = useRef(graph)
  const [busy, setBusy] = useState<string | null>(null)
  // The state is a render behind: two clicks in one frame would both see nothing being read.
  const reading = useRef(false)
  const [error, setError] = useState<unknown>(null)
  /** How many rows the last opening added, for the status line (null before any). */
  const [added, setAdded] = useState<number | null>(null)

  const expand = async (id: string) => {
    const before = latest.current
    const node = before.nodes.get(id)
    if (!node || before.expanded.has(id) || reading.current) return
    reading.current = true
    setBusy(id)
    setError(null)
    setAdded(null)
    try {
      const steps = rowSteps(node)
      const pages = await Promise.all(steps.map((s) => queryClient.fetchQuery(rowsQuery(s.ref, s.options))))
      // One row is read at a time, so nothing changed the graph while this one was read.
      const next = expandGraph(before, id, steps, pages)
      latest.current = next
      setGraph(next)
      setAdded(next.nodes.size - before.nodes.size)
    } catch (err) {
      setError(err)
    } finally {
      reading.current = false
      setBusy(null)
    }
  }

  return { ...graph, busy, error, added, expand }
}
