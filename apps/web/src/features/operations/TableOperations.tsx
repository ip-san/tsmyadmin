import { useNavigate } from '@tanstack/react-router'
import { isViewKind, type TableKind } from '@tsmyadmin/shared'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import type { TableRef } from '@/lib/queries.ts'
import { EditViewForm } from './EditViewForm.tsx'

/** Truncate / drop for tables; views (which cannot be truncated) get a DROP VIEW of the matching kind. */
export function TableOperations({ tableRef, kind }: { tableRef: TableRef; kind: TableKind }) {
  const navigate = useNavigate()
  const view = isViewKind(kind)
  // A MariaDB sequence is a view-like object for the UI (no rows to truncate) but is named as what it is.
  const sequence = kind === 'sequence'
  const flow = useDdlFlow(tableRef.db, tableRef.schema, async (op) => {
    if (op.op === 'dropTable') {
      await navigate({
        to: '/db/$db',
        params: { db: tableRef.db },
        search: tableRef.schema ? { schema: tableRef.schema } : {},
      })
    }
  })
  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-ink">
        {sequence
          ? locale.ddl.sequenceOperationsTitle
          : view
            ? locale.ddl.viewOperationsTitle
            : locale.ddl.operationsTitle}
      </h2>
      <div className="flex flex-col gap-3 sm:flex-row">
        {view ? null : (
          <section className="flex-1 rounded border border-line p-3">
            <p className="mb-2 text-sm text-ink-sub">{locale.ddl.truncateHint}</p>
            <Button
              variant="danger"
              aria-haspopup="dialog"
              onClick={() => flow.preview({ op: 'truncateTable', table: tableRef.table })}
            >
              {locale.ddl.truncateButton}
            </Button>
          </section>
        )}
        <section className="flex-1 rounded border border-red-200 p-3 dark:border-red-800">
          <p className="mb-2 text-sm text-ink-sub">
            {sequence ? locale.ddl.dropSequenceHint : view ? locale.ddl.dropViewHint : locale.ddl.dropHint}
          </p>
          <Button
            variant="danger"
            aria-haspopup="dialog"
            onClick={() => flow.preview({ op: 'dropTable', table: tableRef.table, kind })}
          >
            {sequence ? locale.ddl.dropSequenceButton : view ? locale.ddl.dropViewButton : locale.ddl.dropButton}
          </Button>
        </section>
      </div>
      {kind === 'view' ? <EditViewForm tableRef={tableRef} flow={flow} /> : null}
      <DdlPreviewDialog flow={flow} />
    </div>
  )
}
