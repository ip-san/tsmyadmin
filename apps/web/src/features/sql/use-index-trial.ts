import type { DdlOp, ExplainResult } from '@tsmyadmin/shared'
import { useRef, useState } from 'react'
import { type DdlFlow, useDdlFlow } from '@/lib/ddl.ts'
import type { Forecast } from './plan-forecast.ts'
import type { IndexCandidate } from './plan-index.ts'
import { forgetTried, rememberTried } from './tried-indexes.ts'
import { useStoppableAnalyze } from './use-stoppable-analyze.ts'

export interface IndexTrial {
  /** The preview → confirm → run of creating the index, and of dropping it again. */
  flow: DdlFlow
  /** The index made to try, until it is dropped again. */
  tried: IndexCandidate | null
  /** What trying it without building it said, where it was built from there; null otherwise. */
  forecast: Forecast | null
  /** The statement measured again once the index was made; null until then. */
  after: ExplainResult | null
  measuring: boolean
  /** A stop was asked of measuring again, which has not ended yet. */
  stopping: boolean
  /** Measuring again was stopped on a press (the index is there all the same). */
  stopped: boolean
  /** Why measuring again failed, or why a stop did not reach the server (the index is there all the same). */
  error: unknown
  /** Previews creating this index; with what trying it without building it said, to set the run beside. */
  start: (c: IndexCandidate, forecast?: Forecast) => void
  /** Measures the statement again (after a failure, or to see a second run). */
  measure: () => Promise<void>
  /** Stops measuring again. */
  stop: () => void
  /** Previews dropping the index tried. */
  undo: () => void
  /** Made (and dropped) without stopping writes to the table: on unless turned off. */
  online: boolean
  setOnline: (online: boolean) => void
  /** Previews dropping an index a build left unusable (it is never the one tried). */
  dropLeftover: (table: string, name: string) => void
}

/**
 * Trying an index: it is created through the preview (the dialog says the statement will be measured again), then
 * the statement is run and measured once more, beside the run before. Dropping it again goes through the preview
 * too, and puts the comparison away. Measuring is stoppable, and guarded against a second press (`useStoppableAnalyze`; the state is a render
 * late).
 */
export function useIndexTrial(db: string, schema: string | undefined, sql: string, scope: string): IndexTrial {
  const [tried, setTried] = useState<IndexCandidate | null>(null)
  const [forecast, setForecast] = useState<Forecast | null>(null)
  const [after, setAfter] = useState<ExplainResult | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [stopped, setStopped] = useState(false)
  // On by default: the reason to try an index on a server is that it is close to production.
  const [online, setOnline] = useState(true)
  // How the index tried was made: it is dropped the same way.
  const [triedOnline, setTriedOnline] = useState(true)
  const pending = useRef<{ candidate: IndexCandidate; online: boolean; forecast: Forecast | null } | null>(null)
  const remember = (made: IndexCandidate, how: boolean) =>
    rememberTried(scope, {
      db,
      schema: schema ?? null,
      table: made.table,
      name: made.name,
      columns: made.columns,
      online: how,
    })
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
  const flow = useDdlFlow(
    db,
    schema,
    (op: DdlOp) => {
      // The index made is the one previewed: matched by name, never a candidate of an earlier preview.
      if (op.op === 'addIndex' && pending.current?.candidate.name === op.name) {
        const { candidate: made, online: how, forecast: said } = pending.current
        setTried(made)
        setForecast(said)
        setTriedOnline(how)
        setAfter(null)
        // Remembered until dropped: the SQL tab offers to drop it once this view is closed.
        remember(made, how)
        // Not awaited: the structure and the plan are read again meanwhile.
        void measure()
      } else if (op.op === 'dropIndex') {
        forgetTried(scope, { db, schema: schema ?? null, table: op.table, name: op.name, columns: [] })
        // A leftover dropped is not the index tried, which stays.
        if (tried?.table === op.table && tried.name === op.name) {
          setTried(null)
          setForecast(null)
          setAfter(null)
          setError(null)
          setStopped(false)
        }
      }
    }
    // A build that failed part way is not remembered: the name may be another's index (made meanwhile). What a failed
    // build left is read from the server instead (the tables' unusable indexes), here and in the table's Structure.
  )
  return {
    flow,
    tried,
    forecast,
    after,
    measuring: analyze.running,
    stopping: analyze.stopping,
    stopped,
    error: error ?? analyze.stopError,
    start: (c, said) => {
      pending.current = { candidate: c, online, forecast: said ?? null }
      flow.preview({ op: 'addIndex', table: c.table, name: c.name, columns: c.columns, unique: false, online })
    },
    measure,
    stop: analyze.stop,
    undo: () => {
      if (tried) flow.preview({ op: 'dropIndex', table: tried.table, name: tried.name, online: triedOnline })
    },
    online,
    setOnline,
    // Only PostgreSQL leaves one, and dropping it concurrently never stops writes.
    dropLeftover: (table, name) => flow.preview({ op: 'dropIndex', table, name, online: true }),
  }
}
