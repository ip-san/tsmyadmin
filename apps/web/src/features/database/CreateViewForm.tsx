import { useQuery } from '@tanstack/react-query'
import { CreateSection } from '@/components/ddl/CreateSection.tsx'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { ViewForm } from '@/components/ddl/ViewForm.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import { sessionQuery } from '@/lib/queries.ts'

const t = locale.create

/** The create-view block under the database structure list, with its own preview. */
export function CreateViewSection({
  db,
  schema,
  initialSelect,
}: {
  db: string
  schema?: string | undefined
  /** A SELECT to start from (the SQL console's "Create view" under a result). */
  initialSelect?: string | undefined
}) {
  const flow = useDdlFlow(db, schema)
  const dialect = useQuery(sessionQuery).data?.dialect ?? 'mysql'
  return (
    <>
      <DdlPreviewDialog flow={flow} />
      <CreateSection title={t.view.title} open={initialSelect !== undefined}>
        <ViewForm key={initialSelect ?? ''} dialect={dialect} onSubmit={flow.preview} initialSelect={initialSelect} />
      </CreateSection>
    </>
  )
}
