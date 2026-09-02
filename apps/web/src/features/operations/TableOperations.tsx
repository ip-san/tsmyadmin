import { useNavigate } from '@tanstack/react-router'
import { isViewKind, type TableKind } from '@tsmyadmin/shared'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import type { TableRef } from '@/lib/queries.ts'

/** Truncate / drop for tables; views (which cannot be truncated) get a DROP VIEW of the matching kind. */
export function TableOperations({ tableRef, kind }: { tableRef: TableRef; kind: TableKind }) {
  const navigate = useNavigate()
  const view = isViewKind(kind)
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
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
        {view ? locale.ddl.viewOperationsTitle : locale.ddl.operationsTitle}
      </h2>
      <div className="flex flex-col gap-3 sm:flex-row">
        {view ? null : (
          <section className="flex-1 rounded border border-zinc-200 p-3 dark:border-zinc-700">
            <p className="mb-2 text-sm text-zinc-600 dark:text-zinc-300">{locale.ddl.truncateHint}</p>
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
          <p className="mb-2 text-sm text-zinc-600 dark:text-zinc-300">
            {view ? locale.ddl.dropViewHint : locale.ddl.dropHint}
          </p>
          <Button
            variant="danger"
            aria-haspopup="dialog"
            onClick={() => flow.preview({ op: 'dropTable', table: tableRef.table, kind })}
          >
            {view ? locale.ddl.dropViewButton : locale.ddl.dropButton}
          </Button>
        </section>
      </div>
      <DdlPreviewDialog flow={flow} />
    </div>
  )
}
