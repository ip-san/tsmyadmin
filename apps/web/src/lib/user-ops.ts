import type { StatementResult, UserOp } from '@tsmyadmin/shared'
import { api, unwrap } from './api.ts'
import { type PreviewFlow, usePreviewFlow } from './preview-flow.ts'

export type UserOpFlow = PreviewFlow<UserOp>

/** Account operations: masked preview from /users/preview, execution by /users/execute (server re-generates the SQL). */
export function useUserOpFlow(onSuccess?: (op: UserOp) => void | Promise<void>): UserOpFlow {
  return usePreviewFlow<UserOp>({
    preview: (op) => unwrap<{ sql: string[] }>(api.users.preview.$post({ json: { op } })),
    execute: (op) => unwrap<StatementResult[]>(api.users.execute.$post({ json: { op } })),
    invalidate: (key) => key[0] === 'users',
    ...(onSuccess ? { onSuccess } : {}),
  })
}
