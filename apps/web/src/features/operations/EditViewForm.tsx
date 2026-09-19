import { useQuery } from '@tanstack/react-query'
import { ViewForm } from '@/components/ddl/ViewForm.tsx'
import { parseViewDefinition } from '@/components/ddl/view-definition.ts'
import { locale } from '@/config/locale.ts'
import type { useDdlFlow } from '@/lib/ddl.ts'
import { createStatementQuery, sessionQuery, type TableRef } from '@/lib/queries.ts'

/** phpMyAdmin's view "Edit": the current definition read back into the view form, saved as CREATE OR REPLACE. */
export function EditViewForm({ tableRef, flow }: { tableRef: TableRef; flow: ReturnType<typeof useDdlFlow> }) {
  const dialect = useQuery(sessionQuery).data?.dialect ?? 'mysql'
  const statement = useQuery(createStatementQuery(tableRef))
  if (!statement.data) return null
  const parsed = parseViewDefinition(statement.data.definition ?? '')
  if (!parsed) return <p className="text-sm text-ink-sub">{locale.create.view.unreadable}</p>
  return (
    <section className="rounded border border-line p-3">
      <h3 className="mb-2 text-sm font-semibold text-ink">{locale.create.view.editTitle}</h3>
      <ViewForm dialect={dialect} onSubmit={flow.preview} initial={parsed} fixedName={tableRef.table} />
    </section>
  )
}
