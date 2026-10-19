import { useMemo } from 'react'
import { TourDialog } from '@/components/schema-diagram/TourDialog.tsx'
import { locale } from '@/config/locale-screens.ts'
import type { RowNode } from './row-graph.ts'
import { rowTour } from './row-tour.ts'
import { refKey, useRowTour } from './use-row-tour.ts'

const t = locale.rowTour

/** A row and the rows its foreign keys join it to, told as a presentation (`TourDialog`) over the rows read. */
export function RowTour({ root, onClose }: { root: RowNode; onClose: () => void }) {
  const read = useRowTour(root)
  const drawn = useMemo(
    () =>
      read.graph
        ? rowTour(read.graph.graph, root.id, read.graph.left, (ref) => read.graph?.schemas.get(refKey(ref)))
        : undefined,
    [read.graph, root.id]
  )
  return (
    <TourDialog
      title={t.dialog(root.ref.table)}
      label={t.diagram(root.ref.table)}
      drawn={drawn}
      tones={t.tones}
      saveHint={t.saveHint}
      error={read.error === undefined ? undefined : { error: read.error, retry: read.retry }}
      onClose={onClose}
    />
  )
}
