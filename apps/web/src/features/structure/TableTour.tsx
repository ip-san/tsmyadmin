import { useQuery } from '@tanstack/react-query'
import type { TableSchema } from '@tsmyadmin/shared'
import { useMemo } from 'react'
import { CountRows } from '@/components/schema-diagram/CountRows.tsx'
import { drawnRelations } from '@/components/schema-diagram/layout.ts'
import { neighbourhood } from '@/components/schema-diagram/neighbourhood.ts'
import { diagramFor } from '@/components/schema-diagram/overlay.ts'
import { TourDialog } from '@/components/schema-diagram/TourDialog.tsx'
import { locale } from '@/config/locale-screens.ts'
import { homeNamespace, namespaceOf } from '@/lib/home-namespace.ts'
import { foreignKeysQuery, type TableRef } from '@/lib/queries.ts'
import { useDialect } from '@/lib/session.ts'
import { tableRole } from '@/lib/table-role.ts'
import { useRowCounts } from '@/lib/use-row-counts.ts'
import { useRowEstimates } from '@/lib/use-row-estimates.ts'
import { TOUR_HOPS, tableTourScenes } from './table-tour.ts'

const t = locale.tableTour

/**
 * One table told as a presentation (`TourDialog`): it and the tables up to two keys away, drawn once, with every
 * column of its own box listed, and the scenes of `tableTourScenes` over them.
 */
export function TableTour({
  tableRef,
  schema,
  onClose,
}: {
  tableRef: TableRef
  schema: TableSchema
  onClose: () => void
}) {
  const { db, schema: space, table } = tableRef
  const dialect = useDialect()
  const keys = useQuery(foreignKeysQuery(db, space))
  // The estimated rows add to what it says: it waits for them, and goes on without them if they cannot be read.
  const estimates = useRowEstimates(db, space)
  // The tables drawn: this one and those up to two keys away.
  const around = useMemo(() => {
    if (!keys.data) return undefined
    const names = [...new Set(keys.data.flatMap((k) => [k.table, k.refTable]).concat(table))]
    const relations = drawnRelations(keys.data, dialect, namespaceOf(db, space), names)
    return { names, relations, reach: [...neighbourhood(names, relations, table, TOUR_HOPS)] }
  }, [keys.data, dialect, db, space, table])
  // Counted when asked for, in place of the estimates.
  const counts = useRowCounts(db, space, around?.reach ?? [table], estimates.rows)
  const drawn = useMemo(() => {
    if (!around || estimates.pending) return undefined
    const guess = tableRole(schema, homeNamespace(dialect, namespaceOf(db, space)))
    const all = new Map([[table, schema.columns.map((c) => c.name)]])
    return {
      diagram: diagramFor(around.reach, around.relations, all),
      scenes: tableTourScenes({
        schema,
        guess,
        relations: around.relations,
        tables: around.names,
        ...(counts.rows ? { rows: counts.rows } : {}),
      }),
    }
  }, [around, estimates.pending, counts.rows, dialect, db, space, table, schema])
  return (
    <TourDialog
      title={t.dialog(table)}
      label={t.diagram(table)}
      drawn={drawn}
      tones={t.tones}
      saveHint={t.saveHint}
      controls={<CountRows counts={counts} tables={around?.reach.length ?? 1} />}
      error={keys.isError ? { error: keys.error, retry: () => void keys.refetch() } : undefined}
      onClose={onClose}
    />
  )
}
