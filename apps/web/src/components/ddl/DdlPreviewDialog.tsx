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
  'dropDatabases',
  // Not data loss, but every application still using the old name breaks: confirmed by retyping it.
  'renameDatabase',
  'dropEvent',
  'dropTables',
  'truncateTables',
  // Rewrites values in place: nothing is dropped, but the old values are gone.
  'replaceInColumn',
  'dropPartition',
  'truncatePartition',
  // Definitions only, but what calls them breaks: the run button is red, as for an index or a key.
  'dropRoutine',
  'dropTrigger',
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
    // One database is confirmed by its name; several by the server they are on (set by the caller).
    case 'dropDatabases':
      return op.names.length === 1 ? (op.names[0] ?? null) : bulkName
    case 'copyTable':
      return op.dropExisting ? op.newName : null
    // A partition's rows go with it: confirmed by the partition's name.
    case 'dropPartition':
    case 'truncatePartition':
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
    case 'dropPartition':
    case 'truncatePartition':
      return locale.ddl.partitionLoss
    case 'copyTable':
      return op.dropExisting ? locale.ddl.copyReplaceLoss : null
    case 'splitTable':
    case 'moveRepeatingGroup':
      return op.dropMoved ? locale.ddl.normalizeLoss : null
    case 'dropDatabase':
    case 'dropDatabases':
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
      // A copy that first drops a table of the new name loses that table.
      destructive={(op) =>
        DESTRUCTIVE.has(op.op) ||
        (op.op === 'copyTable' && op.dropExisting === true) ||
        ((op.op === 'splitTable' || op.op === 'moveRepeatingGroup') && op.dropMoved)
      }
      confirmName={(op) => confirmName(op, bulkConfirmName)}
      lossWarning={(op) => lossWarning(op, session.dialect)}
      hint={locale.ddl.previewHint}
      successMessage={(op) => locale.ddl.executed(opTitle(op))}
    />
  )
}
