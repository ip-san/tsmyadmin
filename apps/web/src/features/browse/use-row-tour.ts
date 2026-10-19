import { useQueryClient } from '@tanstack/react-query'
import type { TableSchema } from '@tsmyadmin/shared'
import { useEffect, useState } from 'react'
import { rowsQuery, structureQuery, type TableRef } from '@/lib/queries.ts'
import { expandGraph, type RowGraph, type RowNode, rowSteps } from './row-graph.ts'
import { ROWS_DRAWN, trimReferring } from './row-tour.ts'

/** One key per table, whichever namespace it is in. */
export const refKey = (ref: TableRef) => JSON.stringify([ref.db, ref.schema ?? '', ref.table])

/**
 * The rows a row's tour is told over, read when it opens: the row's own step (`rowSteps`: what it refers to, and the
 * rows that refer to it, cut to a few per key), then from each row met, what it refers to, until `ROWS_DRAWN`. One
 * page is read at a time. `retry` reads again after a failure.
 */
export function useRowTour(root: RowNode) {
  const queryClient = useQueryClient()
  const [read, setRead] = useState<
    { graph: RowGraph; left: Map<string, number>; schemas: Map<string, TableSchema> } | { error: unknown } | null
  >(null)
  const [attempt, setAttempt] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is only a reason to read again.
  useEffect(() => {
    let gone = false
    const pagesOf = async (steps: ReturnType<typeof rowSteps>) => {
      const pages = []
      for (const s of steps) pages.push(await queryClient.fetchQuery(rowsQuery(s.ref, s.options)))
      return pages
    }
    const walk = async () => {
      const start: RowGraph = { nodes: new Map([[root.id, root]]), arrows: [], more: [], expanded: new Set() }
      const steps = rowSteps(root)
      const first = trimReferring(expandGraph(start, root.id, steps, await pagesOf(steps)), root.id)
      let graph = first.graph
      for (const id of [...graph.nodes.keys()].filter((x) => x !== root.id)) {
        if (gone || graph.nodes.size >= ROWS_DRAWN) break
        const node = graph.nodes.get(id)
        if (!node) continue
        // Only what it refers to: the rows that refer to a row met would be the whole table again.
        const out = rowSteps(node).filter((s) => s.direction === 'out')
        graph = expandGraph(graph, id, out, await pagesOf(out))
      }
      // The definitions the design is read from, a table at a time. One that cannot be read is told without.
      const schemas = new Map<string, TableSchema>()
      for (const node of graph.nodes.values()) {
        const key = refKey(node.ref)
        if (gone || schemas.has(key)) continue
        const schema = await queryClient.fetchQuery(structureQuery(node.ref)).catch(() => undefined)
        if (schema) schemas.set(key, schema)
      }
      return { graph, left: first.left, schemas }
    }
    setRead(null)
    walk().then(
      (done) => {
        if (!gone) setRead(done)
      },
      (error: unknown) => {
        if (!gone) setRead({ error })
      }
    )
    return () => {
      gone = true
    }
  }, [root, queryClient, attempt])
  return {
    graph: read && 'graph' in read ? read : undefined,
    error: read && 'error' in read ? read.error : undefined,
    retry: () => setAttempt((n) => n + 1),
  }
}
