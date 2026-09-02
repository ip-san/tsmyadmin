import type { UserOp } from '@tsmyadmin/shared'
import { locale } from '@/config/locale.ts'
import type { UserOpFlow } from '@/lib/user-ops.ts'
import { PreviewDialog } from './PreviewDialog.tsx'

const DESTRUCTIVE = new Set<UserOp['op']>(['dropUser', 'revokeAll'])

export function UserOpPreviewDialog({ flow }: { flow: UserOpFlow }) {
  return (
    <PreviewDialog
      flow={flow}
      title={(op) => locale.users.ops[op.op]}
      destructive={(op) => DESTRUCTIVE.has(op.op)}
      confirmName={(op) => (op.op === 'dropUser' ? op.user.name : null)}
      hint={locale.users.previewHint}
    />
  )
}
