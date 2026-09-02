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
  return op.op === 'dropTable' && op.kind !== 'table' ? locale.ddl.dropViewTitle : locale.ddl.titles[op.op]
}

/** Which destructive ops lose stored data (a dropped view, index, key or event loses only its definition). */
function lossWarning(op: DdlOp): string | null {
  switch (op.op) {
    case 'dropTable':
      return op.kind === 'table' ? locale.ddl.dataLoss : null
    case 'truncateTable':
    case 'dropColumn':
      return locale.ddl.dataLoss
    case 'dropDatabase':
      return locale.ddl.databaseLoss
    default:
      return null
  }
}

export function DdlPreviewDialog({ flow }: { flow: DdlFlow }) {
  return (
    <PreviewDialog
      flow={flow}
      title={opTitle}
      destructive={(op) => DESTRUCTIVE.has(op.op)}
      confirmName={confirmName}
      lossWarning={lossWarning}
      hint={locale.ddl.previewHint}
      successMessage={(op) => locale.ddl.executed(opTitle(op))}
    />
  )
}
