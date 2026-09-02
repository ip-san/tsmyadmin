import type { DdlOp } from '@tsmyadmin/shared'
import { locale } from '@/config/locale.ts'
import type { DdlFlow } from '@/lib/ddl.ts'
import { PreviewDialog } from './PreviewDialog.tsx'

const DESTRUCTIVE = new Set<DdlOp['op']>([
  'dropTable',
  'truncateTable',
  'dropColumn',
  'dropIndex',
  'dropForeignKey',
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

function opTitle(op: DdlOp): string {
  return op.op === 'dropTable' && op.kind !== 'table' ? locale.ddl.dropView : locale.ddl.titles[op.op]
}

export function DdlPreviewDialog({ flow }: { flow: DdlFlow }) {
  return (
    <PreviewDialog
      flow={flow}
      title={opTitle}
      destructive={(op) => DESTRUCTIVE.has(op.op)}
      confirmName={confirmName}
      hint={locale.ddl.previewHint}
      successMessage={(op) => `${opTitle(op)}: ${locale.ddl.executed}`}
    />
  )
}
