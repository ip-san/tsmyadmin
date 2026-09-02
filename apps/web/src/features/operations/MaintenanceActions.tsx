import type { DdlOp, Dialect } from '@tsmyadmin/shared'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import type { TableRef } from '@/lib/queries.ts'

type Action = Extract<DdlOp, { op: 'maintainTable' }>['action']

/** The maintenance statements each server offers (MySQL: ANALYZE / OPTIMIZE / CHECK; PostgreSQL: ANALYZE / VACUUM). */
const ACTIONS: Record<Dialect, Action[]> = {
  mysql: ['analyze', 'optimize', 'check'],
  postgres: ['analyze', 'vacuum', 'optimize'],
}

export function MaintenanceActions({ tableRef, dialect }: { tableRef: TableRef; dialect: Dialect }) {
  const flow = useDdlFlow(tableRef.db, tableRef.schema)
  return (
    <section className="rounded border border-zinc-200 p-3 dark:border-zinc-700">
      <h2 className="mb-1 text-sm font-semibold text-zinc-700 dark:text-zinc-200">{locale.ddl.maintenanceTitle}</h2>
      <p className="mb-2 text-sm text-zinc-600 dark:text-zinc-300">{locale.ddl.maintenanceHint[dialect]}</p>
      <div className="flex flex-wrap gap-2">
        {ACTIONS[dialect].map((action) => (
          <Button
            key={action}
            aria-haspopup="dialog"
            onClick={() => flow.preview({ op: 'maintainTable', table: tableRef.table, action })}
          >
            {locale.ddl.maintenance[dialect][action]}
          </Button>
        ))}
      </div>
      <DdlPreviewDialog flow={flow} />
    </section>
  )
}
