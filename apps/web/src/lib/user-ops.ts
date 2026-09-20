import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { DdlPreviewResponse, UserInfo, UserOp, UserOpResponse, UserRef } from '@tsmyadmin/shared'
import { resetAccountPreferences } from './account-prefs.ts'
import { api, unwrap } from './api.ts'
import { useOwnAccount } from './own-account.ts'
import { type PreviewFlow, usePreviewFlow } from './preview-flow.ts'
import { mutations } from './queries.ts'

export type UserOpFlow = PreviewFlow<UserOp>

/** Account operations: masked preview from /users/preview, execution by /users/execute (server re-generates the SQL). */
export function useUserOpFlow(onSuccess?: (op: UserOp) => void | Promise<void>): UserOpFlow {
  const isMe = useOwnAccount().is
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return usePreviewFlow<UserOp>({
    preview: (op) => unwrap<DdlPreviewResponse>(api.users.preview.$post({ json: { op } })),
    execute: (op) => unwrap<UserOpResponse>(api.users.execute.$post({ json: { op } })),
    invalidate: (key) => key[0] === 'users',
    onSuccess: async (op) => {
      await onSuccess?.(op)
      // The connection pool still holds the old password: the next connection it opens would be refused. Like
      // phpMyAdmin, the account signs in again with the new one.
      if (op.op !== 'setPassword' || !isMe(op.user)) return
      await mutations.logout().catch(() => undefined)
      resetAccountPreferences()
      queryClient.clear()
      await navigate({ to: '/login', search: { passwordChanged: true } })
    },
  })
}

/** MySQL accounts are identified by name@host; PostgreSQL roles by name only. */
export const userRef = (u: UserInfo): UserRef => (u.host ? { name: u.name, host: u.host } : { name: u.name })
export const userLabel = (r: UserRef): string => (r.host ? `${r.name}@${r.host}` : r.name)
