import { useNavigate } from '@tanstack/react-router'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import type { TableRef } from '@/lib/queries.ts'

export function TableOperations({ tableRef }: { tableRef: TableRef }) {
  const navigate = useNavigate()
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
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{locale.ddl.operationsTitle}</h2>
      <div className="flex flex-col gap-3 sm:flex-row">
        <section className="flex-1 rounded border border-zinc-200 p-3 dark:border-zinc-700">
          <p className="mb-2 text-sm text-zinc-600 dark:text-zinc-300">{locale.ddl.truncateHint}</p>
          <Button variant="danger" onClick={() => flow.preview({ op: 'truncateTable', table: tableRef.table })}>
            {locale.ddl.titles.truncateTable}
          </Button>
        </section>
        <section className="flex-1 rounded border border-red-200 p-3 dark:border-red-800">
          <p className="mb-2 text-sm text-zinc-600 dark:text-zinc-300">{locale.ddl.dropHint}</p>
          <Button variant="danger" onClick={() => flow.preview({ op: 'dropTable', table: tableRef.table })}>
            {locale.ddl.titles.dropTable}
          </Button>
        </section>
      </div>
      <DdlPreviewDialog flow={flow} />
    </div>
  )
}
