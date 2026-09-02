import { useRouteContext } from '@tanstack/react-router'
import type { UserOp } from '@tsmyadmin/shared'
import { locale } from '@/config/locale.ts'
import type { UserOpFlow } from '@/lib/user-ops.ts'
import { PreviewDialog } from './PreviewDialog.tsx'

const DESTRUCTIVE = new Set<UserOp['op']>(['dropUser', 'revokeAll'])
const WITH_PASSWORD = new Set<UserOp['op']>(['createUser', 'setPassword'])

export function UserOpPreviewDialog({ flow }: { flow: UserOpFlow }) {
  const { session } = useRouteContext({ from: '/_app' })
  const self = (op: UserOp) => op.user.name === session.user
  return (
    <PreviewDialog
      flow={flow}
      title={(op) => locale.users.ops[op.op]}
      destructive={(op) => DESTRUCTIVE.has(op.op)}
      // Dropping the account you are logged in as, or revoking its own privileges, is confirmed by name.
      confirmName={(op) => (op.op === 'dropUser' || (op.op === 'revokeAll' && self(op)) ? op.user.name : null)}
      lossWarning={(op) => (DESTRUCTIVE.has(op.op) && self(op) ? locale.users.selfWarning : null)}
      hint={WITH_PASSWORD.has(flow.op?.op ?? 'dropUser') ? locale.users.previewHint : locale.ddl.previewHint}
      successMessage={(op) => locale.ddl.executed(locale.users.ops[op.op])}
    />
  )
}
