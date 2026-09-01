import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { DdlOp, StatementResult } from '@tsmyadmin/shared'
import { useState } from 'react'
import { mutations } from './queries.ts'

export interface DdlFlow {
  /** Operation currently being previewed (null = dialog closed). */
  op: DdlOp | null
  sql: string[]
  previewing: boolean
  running: boolean
  error: unknown
  /** First failing statement of the last execution, if any. */
  failed: StatementResult | null
  preview: (op: DdlOp) => void
  confirm: () => void
  cancel: () => void
}

/**
 * Preview → confirm → execute flow shared by every DDL entry point.
 * Nothing runs until the user confirms the generated SQL.
 */
export function useDdlFlow(
  db: string,
  schema: string | undefined,
  onSuccess?: (op: DdlOp) => void | Promise<void>
): DdlFlow {
  const queryClient = useQueryClient()
  const [op, setOp] = useState<DdlOp | null>(null)
  const [sql, setSql] = useState<string[]>([])
  const [failed, setFailed] = useState<StatementResult | null>(null)

  const previewM = useMutation({
    mutationFn: (o: DdlOp) => mutations.previewDdl(db, schema, o),
    onSuccess: (r) => setSql(r.sql),
  })
  const runM = useMutation({
    mutationFn: () =>
      mutations.executeSql(db, { sql: sql.join(';\n'), ...(schema ? { schema } : {}), stopOnError: true }),
    onSuccess: async (results) => {
      const err = results.find((r) => r.kind === 'error')
      if (err) {
        setFailed(err)
        return
      }
      await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'session' })
      const done = op
      setOp(null)
      setSql([])
      if (done) await onSuccess?.(done)
    },
  })

  return {
    op,
    sql,
    previewing: previewM.isPending,
    running: runM.isPending,
    error: previewM.error ?? runM.error,
    failed,
    preview: (o) => {
      setOp(o)
      setSql([])
      setFailed(null)
      previewM.reset()
      runM.reset()
      previewM.mutate(o)
    },
    confirm: () => {
      if (sql.length > 0 && !runM.isPending) runM.mutate()
    },
    cancel: () => {
      setOp(null)
      setSql([])
      setFailed(null)
    },
  }
}
