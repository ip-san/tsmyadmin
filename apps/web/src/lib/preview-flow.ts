import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { StatementResult } from '@tsmyadmin/shared'
import { useRef, useState } from 'react'
import { isDatabaseData } from './queries.ts'

export interface PreviewFlow<Op> {
  /** Operation currently being previewed (null = dialog closed). */
  op: Op | null
  sql: string[]
  previewing: boolean
  running: boolean
  error: unknown
  /** First failing statement of the last execution, if any. */
  failed: StatementResult | null
  /** The op that ran successfully most recently (cleared when the next preview opens) — for success feedback. */
  executed: Op | null
  /** NOTICE / WARNING lines the server raised during the last run (a "success" that granted nothing, say). */
  notices: string[]
  /** The failed run was rolled back as a whole (PostgreSQL account operations run in one transaction). */
  rolledBack: boolean
  /** Stops the run going, once however often pressed; absent where the flow cannot be stopped (`config.stop`). */
  stop?: (() => void) | undefined
  /** A stop was asked of the run, which has not ended yet. */
  stopping: boolean
  /** The last run was stopped on a press, as the server says: what ran before it stays, nothing after it ran. */
  stopped: boolean
  /** A stop was asked of the last run and its answer never came: whether it was stopped is not known. */
  stopUnclear: boolean
  /** Why the last stop did not reach the server (the run went on, and can be stopped again). */
  stopError: unknown
  preview: (op: Op) => void
  confirm: () => void
  cancel: () => void
}

export interface PreviewFlowConfig<Op> {
  preview: (op: Op) => Promise<{ sql: string[] }>
  /**
   * Runs the previewed SQL; `rolledBack` says a failure undid the statements that had already succeeded. `queryId` is
   * the run's own id, for `stop`.
   */
  execute: (op: Op, sql: string[], queryId: string) => Promise<{ results: StatementResult[]; rolledBack?: boolean }>
  /** Stops the run registered under `queryId`: whether the server stopped it (false where it had already ended). */
  stop?: (queryId: string) => Promise<boolean>
  /** Query keys to invalidate after success (default: everything but the session). */
  invalidate?: (key: readonly unknown[]) => boolean
  onSuccess?: (op: Op) => void | Promise<void>
}

/** How long an ended run waits for the answer to its stop: past it, whether it was stopped is not known. */
export const STOP_ANSWER_MS = 15_000

/** A stop asked of a run, and its answer once it came (null where the request failed). */
interface StopAsk {
  id: string
  answer: Promise<boolean | null>
  settled?: boolean | null
}

/**
 * Preview → confirm → execute. Nothing runs until the user confirms the generated SQL.
 * Shared by DDL (structure, create table, operations) and account management.
 */
export function usePreviewFlow<Op>(config: PreviewFlowConfig<Op>): PreviewFlow<Op> {
  const queryClient = useQueryClient()
  const [op, setOp] = useState<Op | null>(null)
  const [sql, setSql] = useState<string[]>([])
  const [failed, setFailed] = useState<StatementResult | null>(null)
  const [executed, setExecuted] = useState<Op | null>(null)
  const [notices, setNotices] = useState<string[]>([])
  const [rolledBack, setRolledBack] = useState(false)
  // Result applied per call (below), so a superseded preview response cannot overwrite the newer op's SQL.
  const previewM = useMutation({ mutationFn: config.preview })
  // `runM.isPending` only becomes true on the next render: a second click on "execute" would run the SQL twice.
  const running = useRef(false)
  const [stopping, setStopping] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [stopUnclear, setStopUnclear] = useState(false)
  const [stopError, setStopError] = useState<unknown>(null)
  // The run going (its id); the run a stop was asked of; and the stop asked: whether the server stopped the run (null
  // where its answer did not come back).
  const current = useRef<string | null>(null)
  const askedOf = useRef<string | null>(null)
  // Kept once answered: an answer of "not stopped" that comes before the run's own is still the answer.
  const stopAsked = useRef<StopAsk | null>(null)
  // The run one of whose stops got no answer: it may have stopped it, whatever a later ask says.
  const unanswered = useRef<string | null>(null)
  const runM = useMutation({
    mutationFn: async ({ op: o, statements, queryId }: { op: Op; statements: string[]; queryId: string }) => {
      // The answer to this run's stop: null where it did not come back, or not in time.
      const answerOf = async (): Promise<boolean | null> => {
        const asked = stopAsked.current?.id === queryId ? stopAsked.current.answer : null
        if (!asked) return null
        const sure = async () => {
          const a = await asked
          return a === false && unanswered.current === queryId ? null : a
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        const late = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), STOP_ANSWER_MS)
        })
        return Promise.race([sure(), late]).finally(() => clearTimeout(timer))
      }
      try {
        const r = await config.execute(o, statements, queryId)
        if (askedOf.current !== queryId) return { ...r, halt: null }
        // Stopped is what the server says (it says so only where it cut the script short): stopped between two
        // statements, a script ends short with no error at all, and must not be taken for done (nor its follow-up
        // run). Without its answer, a script that ended with no error may be done or cut short: said as not known (a
        // stop that failed may or may not have reached the server, so it is not known either).
        const answer = await answerOf()
        const failed = r.results.some((x) => x.kind === 'error')
        return { ...r, halt: answer === true ? 'stopped' : answer === null && !failed ? 'unclear' : null }
      } catch (err) {
        if (askedOf.current === queryId && (await answerOf()) === true) return { results: [], halt: 'stopped' }
        throw err
      }
    },
    // Only its own run's: a run previewed over (and still going) must not put away the stop of the next one.
    onSettled: (_data, _err, { queryId }) => {
      if (current.current !== queryId) return
      current.current = null
      stopAsked.current = null
      setStopping(false)
    },
    onSuccess: async ({ results, rolledBack: undone, halt }, { op: o, queryId }) => {
      // A run previewed over says nothing of the stop of the run that replaced it.
      if (halt && current.current !== queryId) return
      const err = results.find((r) => r.kind === 'error')
      setRolledBack(undone === true)
      setNotices(results.flatMap((r) => (r.kind === 'error' ? [] : (r.notices ?? []))))
      const invalidate = config.invalidate ?? isDatabaseData
      if (halt) {
        if (halt === 'stopped') setStopped(true)
        else setStopUnclear(true)
        // What ran before the stop stays, and a build stopped part way can leave an index behind: read again.
        void queryClient.invalidateQueries({ predicate: (q) => invalidate(q.queryKey) })
        return
      }
      if (err) {
        setFailed(err)
        // What it left is read again: the statements before it ran, and a failed build can leave an index behind. Not
        // awaited: the failure is said (and the dialog can be closed) at once.
        void queryClient.invalidateQueries({ predicate: (q) => invalidate(q.queryKey) })
        return
      }
      setOp(null)
      setSql([])
      setExecuted(o)
      // The caller's follow-up first (a rename navigates away before the old table's structure is refetched
      // and shows a 404 for a frame); a callback that needs fresh data reads it after the invalidation resolves.
      await config.onSuccess?.(o)
      await queryClient.invalidateQueries({ predicate: (q) => invalidate(q.queryKey) })
    },
  })
  return {
    op,
    sql,
    previewing: previewM.isPending,
    running: runM.isPending,
    error: previewM.error ?? runM.error,
    failed,
    executed,
    notices,
    rolledBack,
    stopping,
    stopped,
    stopUnclear,
    stopError,
    ...(config.stop
      ? {
          stop: () => {
            const id = current.current
            const ask = config.stop
            const before = stopAsked.current
            // Once a run: asked again only where the last ask is of another run, or answered without stopping it.
            if (!id || !ask || (before?.id === id && (before.settled === undefined || before.settled === true))) return
            setStopping(true)
            setStopError(null)
            askedOf.current = id
            const answer = ask(id).then(
              (r): boolean | null => r,
              (err: unknown) => {
                if (current.current === id) setStopError(err)
                return null
              }
            )
            const asked: StopAsk = { id, answer }
            stopAsked.current = asked
            void answer.then((cancelled) => {
              asked.settled = cancelled
              if (cancelled === null) unanswered.current = id
              // Not stopped (it had just ended, or the stop did not reach the server): it can be stopped again.
              if (cancelled === true || current.current !== id) return
              setStopping(false)
            })
          },
        }
      : {}),
    preview: (o) => {
      running.current = false
      setStopped(false)
      setStopUnclear(false)
      setStopError(null)
      setOp(o)
      setSql([])
      setFailed(null)
      setExecuted(null)
      setNotices([])
      setRolledBack(false)
      previewM.reset()
      runM.reset()
      previewM.mutate(o, { onSuccess: (r) => setSql(r.sql) })
    },
    confirm: () => {
      if (op === null || sql.length === 0 || running.current || runM.isPending) return
      running.current = true
      const queryId = crypto.randomUUID()
      current.current = queryId
      stopAsked.current = null
      setStopped(false)
      setStopUnclear(false)
      setStopError(null)
      setFailed(null)
      runM.mutate({ op, statements: sql, queryId }, { onSettled: () => (running.current = false) })
    },
    cancel: () => {
      setOp(null)
      setSql([])
      setFailed(null)
      setStopped(false)
      setStopUnclear(false)
      setStopError(null)
    },
  }
}
