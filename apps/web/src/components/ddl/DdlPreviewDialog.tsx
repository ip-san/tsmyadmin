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
function confirmName(op: DdlOp, bulkName: string | null): string | null {
  switch (op.op) {
    case 'dropTable':
    case 'truncateTable':
      return op.table
    case 'dropDatabase':
      return op.name
    // Bulk ops: one table is confirmed by its name; several by the database they live in (set by the caller).
    case 'dropTables':
    case 'truncateTables':
      return op.tables.length === 1 ? (op.tables[0] ?? null) : bulkName
    default:
      return null
  }
}

function opTitle(op: DdlOp): string {
  if (op.op === 'dropTable' && op.kind === 'sequence') return locale.ddl.dropSequenceTitle
  return op.op === 'dropTable' && op.kind !== 'table' ? locale.ddl.dropViewTitle : locale.ddl.titles[op.op]
}

/** Which destructive ops lose stored data (a dropped view, index, key or event loses only its definition). */
function lossWarning(op: DdlOp): string | null {
  switch (op.op) {
    case 'dropTable':
      return op.kind === 'table' ? locale.ddl.dataLoss : op.kind === 'sequence' ? locale.ddl.sequenceLoss : null
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

export function DdlPreviewDialog({ flow, bulkConfirmName = null }: { flow: DdlFlow; bulkConfirmName?: string | null }) {
  return (
    <PreviewDialog
      flow={flow}
      title={opTitle}
      destructive={(op) => DESTRUCTIVE.has(op.op)}
      confirmName={(op) => confirmName(op, bulkConfirmName)}
      lossWarning={lossWarning}
      hint={locale.ddl.previewHint}
      successMessage={(op) => locale.ddl.executed(opTitle(op))}
    />
  )
}
