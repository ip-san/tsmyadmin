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
  const [stopError, setStopError] = useState<unknown>(null)
  // The run going (its id), and the stop asked of it: whether the server stopped it.
  const current = useRef<string | null>(null)
  const stopAsked = useRef<Promise<boolean> | null>(null)
  // Stopped is what the server says, whatever the run answered: stopped between two statements, a script ends with no
  // error at all, and must not be taken for done (nor its follow-up run).
  const wasStopped = async () => (stopAsked.current ? await stopAsked.current : false)
  const runM = useMutation({
    mutationFn: async ({ op: o, queryId }: { op: Op; queryId: string }) => {
      try {
        const r = await config.execute(o, sql, queryId)
        return { ...r, stopped: await wasStopped() }
      } catch (err) {
        if (await wasStopped()) return { results: [], stopped: true }
        throw err
      }
    },
    onSettled: () => {
      current.current = null
      stopAsked.current = null
      setStopping(false)
    },
    onSuccess: async ({ results, rolledBack: undone, stopped: halted }, { op: o }) => {
      const err = results.find((r) => r.kind === 'error')
      setRolledBack(undone === true)
      setNotices(results.flatMap((r) => (r.kind === 'error' ? [] : (r.notices ?? []))))
      const invalidate = config.invalidate ?? isDatabaseData
      if (halted) {
        setStopped(true)
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
    stopError,
    ...(config.stop
      ? {
          stop: () => {
            const id = current.current
            const ask = config.stop
            if (!id || stopAsked.current || !ask) return
            setStopping(true)
            setStopError(null)
            const asked = ask(id).then(
              (r) => r,
              (err: unknown) => {
                if (current.current === id) setStopError(err)
                return false
              }
            )
            stopAsked.current = asked
            void asked.then((cancelled) => {
              // Not stopped (it had just ended, or the stop did not reach the server): it can be stopped again.
              if (cancelled || current.current !== id) return
              stopAsked.current = null
              setStopping(false)
            })
          },
        }
      : {}),
    preview: (o) => {
      running.current = false
      setStopped(false)
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
      setStopError(null)
      runM.mutate({ op, queryId }, { onSettled: () => (running.current = false) })
    },
    cancel: () => {
      setOp(null)
      setSql([])
      setFailed(null)
    },
  }
}
