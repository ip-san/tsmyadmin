import type { DdlOp } from '@tsmyadmin/shared'
import { locale } from '@/config/locale.ts'
import type { DdlFlow } from '@/lib/ddl.ts'
import { PreviewDialog } from './PreviewDialog.tsx'

const DESTRUCTIVE = new Set<DdlOp['op']>([
  'dropTable',
  'truncateTable',
  'dropColumn',
  'dropIndex',
  'dropDatabase',
  'dropEvent',
])

/** Ops that destroy data with no undo: the user retypes the object name before they can run. */
function confirmName(op: DdlOp): string | null {
  switch (op.op) {
    case 'dropTable':
    case 'truncateTable':
      return op.table
    case 'dropDatabase':
      return op.name
    default:
      return null
  }
}

export function DdlPreviewDialog({ flow }: { flow: DdlFlow }) {
  return (
    <PreviewDialog
      flow={flow}
      title={(op) => locale.ddl.titles[op.op]}
      destructive={(op) => DESTRUCTIVE.has(op.op)}
      confirmName={confirmName}
      hint={locale.ddl.previewHint}
    />
  )
}
