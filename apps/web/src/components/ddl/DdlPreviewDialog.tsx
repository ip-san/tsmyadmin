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
  'dropTables',
  'truncateTables',
])

/** Ops that destroy data with no undo: the user retypes the object name before they can run. */
function confirmName(op: DdlOp): string | null {
  switch (op.op) {
    case 'dropTable':
    case 'truncateTable':
      return op.table
    case 'dropDatabase':
      return op.name
    // Bulk ops: retyping every name is impractical, the count of tables is what the user must acknowledge.
    case 'dropTables':
    case 'truncateTables':
      return String(op.tables.length)
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
      return locale.ddl.dataLoss
    case 'dropColumn':
      return locale.ddl.columnLoss
    case 'dropDatabase':
      return locale.ddl.databaseLoss
    case 'dropTables':
    case 'truncateTables':
      return locale.ddl.bulkLoss(op.tables.length)
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
