import { useQuery } from '@tanstack/react-query'
import { useRef } from 'react'
import { tablesQuery } from '@/lib/queries.ts'
import { type RowEstimates, rowEstimates } from '@/lib/row-estimates.ts'

/**
 * The tables' estimated rows as they were when first read, for a presentation: pending until the list is read (or
 * cannot be), then kept, so a read again under an open presentation (InnoDB's estimates move between reads) does not
 * change its words. `rows` is undefined where the list could not be read: the presentation goes on without them.
 */
export function useRowEstimates(db: string, schema: string | undefined): { pending: boolean; rows?: RowEstimates } {
  const list = useQuery(tablesQuery(db, schema))
  const kept = useRef<{ rows?: RowEstimates } | null>(null)
  if (kept.current === null && !list.isPending) kept.current = list.data ? { rows: rowEstimates(list.data) } : {}
  return kept.current ? { pending: false, ...kept.current } : { pending: true }
}
