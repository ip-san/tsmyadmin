import { useRouteContext } from '@tanstack/react-router'
import type { UserOp } from '@tsmyadmin/shared'
import { locale } from '@/config/locale.ts'
import { useOwnAccount } from '@/lib/own-account.ts'
import type { UserOpFlow } from '@/lib/user-ops.ts'
import { PreviewDialog } from './PreviewDialog.tsx'

const DESTRUCTIVE = new Set<UserOp['op']>(['dropUser', 'dropUsers', 'revokeAll'])
const WITH_PASSWORD = new Set<UserOp['op']>(['createUser', 'setPassword', 'copyUser'])
/** Locking or renaming the account you are logged in as ends your access the same way dropping it does. */
const LOCKS_OUT = (op: UserOp) => (op.op === 'lockUser' && op.locked) || op.op === 'renameUser'

export function UserOpPreviewDialog({ flow }: { flow: UserOpFlow }) {
  const { session } = useRouteContext({ from: '/_app' })
  const isMe = useOwnAccount().is
  const self = (op: UserOp) => (op.op === 'dropUsers' ? op.users.some(isMe) : isMe(op.user))
  return (
    <PreviewDialog
      flow={flow}
      title={(op) => locale.users.ops[op.op]}
      destructive={(op) => DESTRUCTIVE.has(op.op) || LOCKS_OUT(op)}
      // Dropping the account you are logged in as, or revoking its own privileges, is confirmed by name.
      // Several accounts at once are confirmed by the server's host, like dropping several databases.
      confirmName={(op) =>
        op.op === 'dropUsers'
          ? session.host
          : op.op === 'dropUser' || (op.op === 'revokeAll' && self(op))
            ? op.user.name
            : null
      }
      lossWarning={(op) => ((DESTRUCTIVE.has(op.op) || LOCKS_OUT(op)) && self(op) ? locale.users.selfWarning : null)}
      hint={
        flow.op?.op === 'setPassword' && self(flow.op)
          ? locale.users.ownPasswordHint
          : WITH_PASSWORD.has(flow.op?.op ?? 'dropUser')
            ? locale.users.previewHint
            : locale.ddl.previewHint
      }
      successMessage={(op) => locale.ddl.executed(locale.users.ops[op.op])}
    />
  )
}
