import { useQuery } from '@tanstack/react-query'
import { useRef } from 'react'
import { tablesQuery } from '@/lib/queries.ts'
import { type RowEstimates, rowEstimates } from '@/lib/row-estimates.ts'

/**
 * The tables' estimated rows as they were when first read, for a presentation: pending until the list is read (or
 * cannot be), then kept, so a read again under an open presentation (InnoDB's estimates move between reads) does not
 * change its words. `rows` is undefined where the list could not be read: the presentation goes on without them.
 * Given `since` (a time: statistics were taken again then), they are kept anew from the first list read after it.
 */
export function useRowEstimates(
  db: string,
  schema: string | undefined,
  since = 0
): { pending: boolean; rows?: RowEstimates } {
  const list = useQuery(tablesQuery(db, schema))
  // Kept for the namespace read: another one is read anew.
  const at = `${db}\0${schema ?? ''}\0${since}`
  const kept = useRef<{ at: string; rows?: RowEstimates } | null>(null)
  if (kept.current?.at !== at) kept.current = null
  const fresh = since === 0 || list.dataUpdatedAt > since || list.errorUpdatedAt > since
  if (kept.current === null && !list.isPending && fresh)
    kept.current = list.data ? { at, rows: rowEstimates(list.data) } : { at }
  return kept.current
    ? { pending: false, ...(kept.current.rows ? { rows: kept.current.rows } : {}) }
    : { pending: true }
}
