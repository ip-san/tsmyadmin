import type { DdlOp, ExplainResult } from '@tsmyadmin/shared'
import { useRef, useState } from 'react'
import { type DdlFlow, useDdlFlow } from '@/lib/ddl.ts'
import { analyzePlan } from '@/lib/queries.ts'
import type { IndexCandidate } from './plan-index.ts'
import { forgetTried, rememberTried } from './tried-indexes.ts'

export interface IndexTrial {
  /** The preview → confirm → run of creating the index, and of dropping it again. */
  flow: DdlFlow
  /** The index made to try, until it is dropped again. */
  tried: IndexCandidate | null
  /** The statement measured again once the index was made; null until then. */
  after: ExplainResult | null
  measuring: boolean
  /** Why measuring again failed (the index is there all the same). */
  error: unknown
  /** Previews creating this index. */
  start: (c: IndexCandidate) => void
  /** Measures the statement again (after a failure, or to see a second run). */
  measure: () => Promise<void>
  /** Previews dropping the index tried. */
  undo: () => void
}

/**
 * Trying an index: it is created through the preview (the dialog says the statement will be measured again), then
 * the statement is run and measured once more, beside the run before. Dropping it again goes through the preview
 * too, and puts the comparison away. Measuring is guarded against a second press (`useRef`: the state is a render
 * late).
 */
export function useIndexTrial(db: string, schema: string | undefined, sql: string, scope: string): IndexTrial {
  const [tried, setTried] = useState<IndexCandidate | null>(null)
  const [after, setAfter] = useState<ExplainResult | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const running = useRef(false)
  const pending = useRef<IndexCandidate | null>(null)
  const measure = async () => {
    if (running.current) return
    running.current = true
    setMeasuring(true)
    setError(null)
    try {
      setAfter(await analyzePlan(db, schema, sql))
    } catch (err) {
      setError(err)
    } finally {
      running.current = false
      setMeasuring(false)
    }
  }
  const flow = useDdlFlow(db, schema, (op: DdlOp) => {
    // The index made is the one previewed: matched by name, never a candidate of an earlier preview.
    if (op.op === 'addIndex' && pending.current?.name === op.name) {
      const made = pending.current
      setTried(made)
      setAfter(null)
      // Remembered until dropped: the SQL tab offers to drop it once this view is closed.
      rememberTried(scope, { db, schema: schema ?? null, table: made.table, name: made.name, columns: made.columns })
      // Not awaited: the structure and the plan are read again meanwhile.
      void measure()
    } else if (op.op === 'dropIndex') {
      forgetTried(scope, { db, schema: schema ?? null, table: op.table, name: op.name, columns: [] })
      setTried(null)
      setAfter(null)
      setError(null)
    }
  })
  return {
    flow,
    tried,
    after,
    measuring,
    error,
    start: (c) => {
      pending.current = c
      flow.preview({ op: 'addIndex', table: c.table, name: c.name, columns: c.columns, unique: false })
    },
    measure,
    undo: () => {
      if (tried) flow.preview({ op: 'dropIndex', table: tried.table, name: tried.name })
    },
  }
}
