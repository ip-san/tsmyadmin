import { useQuery } from '@tanstack/react-query'
import type { QueryBuilderRequestInput, RelationDef, TableSchema } from '@tsmyadmin/shared'
import { Presentation } from 'lucide-react'
import { useMemo, useState } from 'react'
import { CountRows } from '@/components/schema-diagram/CountRows.tsx'
import { drawnRelations } from '@/components/schema-diagram/layout.ts'
import { TourDialog } from '@/components/schema-diagram/TourDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale-screens.ts'
import { namespaceOf } from '@/lib/home-namespace.ts'
import { queryPlanQuery } from '@/lib/queries.ts'
import { useDialect } from '@/lib/session.ts'
import { useRowCounts } from '@/lib/use-row-counts.ts'
import { useRowEstimates } from '@/lib/use-row-estimates.ts'
import { queryTour } from './query-tour.ts'

const t = locale.queryTour

/** "Present": the query as it stands, told in the order the database works it (`queryTour`), in `TourDialog`. */
export function QueryTour({
  db,
  schema,
  request,
  schemas,
  disabled,
}: {
  db: string
  schema: string | undefined
  request: QueryBuilderRequestInput
  /** The definitions of the tables chosen, as read for the form. */
  schemas: ReadonlyMap<string, TableSchema>
  disabled: boolean
}) {
  // The choices as they were when it opened: the form is behind the dialog, and does not change under it.
  const [shown, setShown] = useState<{
    request: QueryBuilderRequestInput
    schemas: ReadonlyMap<string, TableSchema>
  } | null>(null)
  return (
    <>
      <Button type="button" title={t.openHint} disabled={disabled} onClick={() => setShown({ request, schemas })}>
        <Presentation className="size-4" aria-hidden />
        {t.open}
      </Button>
      {shown ? (
        <QueryTourDialog
          db={db}
          schema={schema}
          request={shown.request}
          schemas={shown.schemas}
          onClose={() => setShown(null)}
        />
      ) : null}
    </>
  )
}

function QueryTourDialog({
  db,
  schema,
  request,
  schemas,
  onClose,
}: {
  db: string
  schema: string | undefined
  request: QueryBuilderRequestInput
  schemas: ReadonlyMap<string, TableSchema>
  onClose: () => void
}) {
  const dialect = useDialect()
  // The server joins the tables: the presentation tells its plan, not a guess at it.
  const plan = useQuery(queryPlanQuery(db, request))
  // The estimated rows add to what it says: it waits for them, and goes on without them if they cannot be read.
  const estimates = useRowEstimates(db, schema)
  // Counted when asked for, in place of the estimates.
  const counts = useRowCounts(db, schema, request.tables, estimates.rows)
  const drawn = useMemo(() => {
    if (!plan.data || estimates.pending) return undefined
    const keys: RelationDef[] = [...schemas.values()].flatMap((s) =>
      s.foreignKeys.map((k) => ({ ...k, table: s.name }))
    )
    const drawnKeys = drawnRelations(keys, dialect, namespaceOf(db, schema), request.tables)
    const rows = counts.rows
    return queryTour({ request, joins: plan.data.joins, schemas, keys: drawnKeys, ...(rows ? { rows } : {}) })
  }, [plan.data, estimates.pending, counts.rows, schemas, dialect, db, schema, request])
  return (
    <TourDialog
      title={t.dialog}
      label={t.diagram}
      drawn={drawn}
      tones={t.tones}
      saveHint={t.saveHint}
      controls={<CountRows counts={counts} tables={request.tables.length} />}
      error={plan.isError ? { error: plan.error, retry: () => void plan.refetch() } : undefined}
      onClose={onClose}
    />
  )
}
