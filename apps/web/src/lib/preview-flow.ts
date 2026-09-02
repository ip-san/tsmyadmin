import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { StatementResult } from '@tsmyadmin/shared'
import { useState } from 'react'

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
  preview: (op: Op) => void
  confirm: () => void
  cancel: () => void
}

export interface PreviewFlowConfig<Op> {
  preview: (op: Op) => Promise<{ sql: string[] }>
  execute: (op: Op, sql: string[]) => Promise<StatementResult[]>
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
  // Result applied per call (below), so a superseded preview response cannot overwrite the newer op's SQL.
  const previewM = useMutation({ mutationFn: config.preview })
  const runM = useMutation({
    mutationFn: (o: Op) => config.execute(o, sql),
    onSuccess: async (results, o) => {
      const err = results.find((r) => r.kind === 'error')
      if (err) {
        setFailed(err)
        return
      }
      const invalidate = config.invalidate ?? ((key) => key[0] !== 'session')
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
    preview: (o) => {
      setOp(o)
      setSql([])
      setFailed(null)
      setExecuted(null)
      previewM.reset()
      runM.reset()
      previewM.mutate(o, { onSuccess: (r) => setSql(r.sql) })
    },
    confirm: () => {
      if (op !== null && sql.length > 0 && !runM.isPending) runM.mutate(op)
    },
    cancel: () => {
      setOp(null)
      setSql([])
      setFailed(null)
    },
  }
}
