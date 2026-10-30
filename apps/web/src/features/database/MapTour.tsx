import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { drawnRelations } from '@/components/schema-diagram/layout.ts'
import { diagramFor } from '@/components/schema-diagram/overlay.ts'
import { TourDialog } from '@/components/schema-diagram/TourDialog.tsx'
import { locale } from '@/config/locale-screens.ts'
import { namespaceOf } from '@/lib/home-namespace.ts'
import { foreignKeysQuery, tablesQuery } from '@/lib/queries.ts'
import { useDialect } from '@/lib/session.ts'
import { useRowEstimates } from '@/lib/use-row-estimates.ts'
import type { DatabaseMap } from './database-map.ts'
import type { JoinEnds } from './JoinPath.tsx'
import { joinPaths } from './join-path.ts'
import { tourScenes } from './map-tour.ts'

const t = locale.mapTour

/**
 * The map told as a presentation (`TourDialog`): every table drawn once, and the scenes of `tourScenes` over it,
 * with the way between the two tables chosen on the map when there is one.
 */
export function MapTour({
  db,
  schema,
  map,
  ends,
  onClose,
}: {
  db: string
  schema: string | undefined
  map: DatabaseMap
  ends: JoinEnds
  onClose: () => void
}) {
  const dialect = useDialect()
  const tables = useQuery(tablesQuery(db, schema))
  const keys = useQuery(foreignKeysQuery(db, schema))
  // The estimated rows add the tables with the most rows: it waits for them, and goes on without them.
  const estimates = useRowEstimates(db, schema)
  const name = schema ?? db
  // By name: the route gives a new object each render, and the layout of every table is not made again for it.
  const { from, to } = ends
  const drawn = useMemo(() => {
    if (!tables.data || !keys.data || estimates.pending) return undefined
    const names = tables.data.filter((x) => x.kind === 'table').map((x) => x.name)
    // The tables drawn only: a materialized view or a sequence has an estimate too (PostgreSQL), and no box.
    const rows = estimates.rows && new Map([...estimates.rows].filter(([x]) => names.includes(x)))
    const relations = drawnRelations(keys.data, dialect, namespaceOf(db, schema), names)
    const found = from && to && from !== to ? joinPaths(relations, from, to).paths[0] : undefined
    const path = from && to && found ? { from, to, hops: found } : undefined
    return {
      diagram: diagramFor(names, relations),
      scenes: tourScenes({ name, map, relations, path, rows }),
    }
  }, [tables.data, keys.data, estimates.pending, estimates.rows, dialect, db, schema, from, to, name, map])
  const failed = tables.isError ? tables : keys.isError ? keys : undefined
  return (
    <TourDialog
      title={t.dialog(name)}
      label={t.diagram(name)}
      drawn={drawn}
      tones={t.tones}
      saveHint={t.saveHint}
      error={failed ? { error: failed.error, retry: () => void failed.refetch() } : undefined}
      onClose={onClose}
    />
  )
}
