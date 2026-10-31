import type { DdlOp, ExplainResult } from '@tsmyadmin/shared'
import { useRef, useState } from 'react'
import { type DdlFlow, useDdlFlow } from '@/lib/ddl.ts'
import type { IndexCandidate } from './plan-index.ts'
import { forgetTried, rememberTried } from './tried-indexes.ts'
import { useStoppableAnalyze } from './use-stoppable-analyze.ts'

export interface IndexTrial {
  /** The preview → confirm → run of creating the index, and of dropping it again. */
  flow: DdlFlow
  /** The index made to try, until it is dropped again. */
  tried: IndexCandidate | null
  /** The statement measured again once the index was made; null until then. */
  after: ExplainResult | null
  measuring: boolean
  /** A stop was asked of measuring again, which has not ended yet. */
  stopping: boolean
  /** Measuring again was stopped on a press (the index is there all the same). */
  stopped: boolean
  /** Why measuring again failed, or why a stop did not reach the server (the index is there all the same). */
  error: unknown
  /** Previews creating this index. */
  start: (c: IndexCandidate) => void
  /** Measures the statement again (after a failure, or to see a second run). */
  measure: () => Promise<void>
  /** Stops measuring again. */
  stop: () => void
  /** Previews dropping the index tried. */
  undo: () => void
}

/**
 * Trying an index: it is created through the preview (the dialog says the statement will be measured again), then
 * the statement is run and measured once more, beside the run before. Dropping it again goes through the preview
 * too, and puts the comparison away. Measuring is stoppable, and guarded against a second press (`useStoppableAnalyze`; the state is a render
 * late).
 */
export function useIndexTrial(db: string, schema: string | undefined, sql: string, scope: string): IndexTrial {
  const [tried, setTried] = useState<IndexCandidate | null>(null)
  const [after, setAfter] = useState<ExplainResult | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [stopped, setStopped] = useState(false)
  const pending = useRef<IndexCandidate | null>(null)
  // Stoppable as the first run is: a large table may take its whole time limit again.
  const analyze = useStoppableAnalyze(db, schema, sql)
  const measure = async () => {
    if (analyze.busy()) return
    // What the last run said is put away as this one starts.
    setError(null)
    setStopped(false)
    const outcome = await analyze.run()
    if (outcome === null) return
    if (outcome.kind === 'done') setAfter(outcome.result)
    else if (outcome.kind === 'stopped') setStopped(true)
    else setError(outcome.error)
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
      setStopped(false)
    }
  })
  return {
    flow,
    tried,
    after,
    measuring: analyze.running,
    stopping: analyze.stopping,
    stopped,
    error: error ?? analyze.stopError,
    start: (c) => {
      pending.current = c
      flow.preview({ op: 'addIndex', table: c.table, name: c.name, columns: c.columns, unique: false })
    },
    measure,
    stop: analyze.stop,
    undo: () => {
      if (tried) flow.preview({ op: 'dropIndex', table: tried.table, name: tried.name })
    },
  }
}
