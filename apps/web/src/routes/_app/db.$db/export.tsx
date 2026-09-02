import { createFileRoute } from '@tanstack/react-router'
import { decodeTableList } from '@tsmyadmin/shared'
import { z } from 'zod'
import { ExportForm } from '@/features/export/ExportForm.tsx'

export const Route = createFileRoute('/_app/db/$db/export')({
  component: DatabaseExportPage,
  /** `tables`: preselection handed over from the database structure page (encodeTableList form). */
  validateSearch: z.object({ tables: z.string().optional() }),
})

function DatabaseExportPage() {
  const { db } = Route.useParams()
  const { schema, tables } = Route.useSearch()
  return <ExportForm db={db} schema={schema} initialTables={decodeTableList(tables)} />
}
