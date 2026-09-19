import { useRouteContext } from '@tanstack/react-router'
import type { DdlOp, Dialect } from '@tsmyadmin/shared'
import { locale } from '@/config/locale.ts'
import type { DdlFlow } from '@/lib/ddl.ts'
import { PreviewDialog } from './PreviewDialog.tsx'

const DESTRUCTIVE = new Set<DdlOp['op']>([
  'dropTable',
  'truncateTable',
  'dropColumn',
  'dropColumns',
  'dropIndex',
  'dropForeignKey',
  'dropDatabase',
  // Not data loss, but every application still using the old name breaks: confirmed by retyping it.
  'renameDatabase',
  'dropEvent',
  'dropTables',
  'truncateTables',
  // Rewrites values in place: nothing is dropped, but the old values are gone.
  'replaceInColumn',
])

/** Ops that destroy data with no undo: the user retypes the object name before they can run. */
function confirmName(op: DdlOp, bulkName: string | null): string | null {
  switch (op.op) {
    case 'dropTable':
    case 'truncateTable':
      return op.table
    case 'dropDatabase':
    case 'renameDatabase':
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
function lossWarning(op: DdlOp, dialect: Dialect): string | null {
  switch (op.op) {
    case 'dropTable':
      return op.kind === 'table' ? locale.ddl.dataLoss : op.kind === 'sequence' ? locale.ddl.sequenceLoss : null
    case 'truncateTable':
      return locale.ddl.dataLoss
    case 'dropColumn':
    case 'dropColumns':
      return locale.ddl.columnLoss
    case 'dropDatabase':
      return dialect === 'postgres'
        ? `${locale.ddl.databaseLoss} ${locale.ddl.databaseLossForce}`
        : locale.ddl.databaseLoss
    case 'dropTables':
    case 'truncateTables':
      return locale.ddl.bulkLoss(op.tables.length)
    case 'replaceInColumn':
      return locale.ddl.replaceWarning
    case 'renameDatabase':
      return dialect === 'postgres' ? locale.databaseOps.renameWarningPostgres : locale.databaseOps.renameWarningMysql
    default:
      return null
  }
}

export function DdlPreviewDialog({ flow, bulkConfirmName = null }: { flow: DdlFlow; bulkConfirmName?: string | null }) {
  const { session } = useRouteContext({ from: '/_app' })
  return (
    <PreviewDialog
      flow={flow}
      title={opTitle}
      destructive={(op) => DESTRUCTIVE.has(op.op)}
      confirmName={(op) => confirmName(op, bulkConfirmName)}
      lossWarning={(op) => lossWarning(op, session.dialect)}
      hint={locale.ddl.previewHint}
      successMessage={(op) => locale.ddl.executed(opTitle(op))}
    />
  )
}
