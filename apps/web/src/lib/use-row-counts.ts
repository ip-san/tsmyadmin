import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { eachLimited } from '@/lib/each-limited.ts'
import { rowCountQuery } from '@/lib/queries.ts'
import type { RowEstimates } from '@/lib/row-estimates.ts'

/** Where a presentation's rows stand: estimated until asked for, then counting, then counted (some may have failed). */
export interface RowCounts {
  /** The estimates, with the rows counted in place of those that were. */
  rows: RowEstimates | undefined
  counting: boolean
  /** Counted at least once (asked for and finished), whether or not every table could be. */
  done: boolean
  /** The tables whose count failed: they keep their estimate. */
  failed: readonly string[]
  /** Counts the tables' rows: again where already counted, and joins a count already running. */
  count: () => void
}

/**
 * The rows of a presentation's tables counted exactly (`COUNT(*)`), when asked for: it reads every row, so it never
 * runs on its own (not on focus, not when the answer ages), and counts a few tables at a time (`eachLimited`). A
 * table that cannot be counted keeps its estimate, and is named as such. Closed, a count still running starts no more
 * tables: the query reads its `signal`, so TanStack Query aborts it when its last observer goes.
 */
export function useRowCounts(
  db: string,
  schema: string | undefined,
  tables: readonly string[],
  estimates: RowEstimates | undefined
): RowCounts {
  const queryClient = useQueryClient()
  const all = useQuery({
    queryKey: ['row-counts-all', db, schema ?? '', tables],
    queryFn: ({ signal }) =>
      eachLimited(tables, (table) => queryClient.fetchQuery(rowCountQuery({ db, schema, table })), { signal }),
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  })
  const { refetch } = all
  // A press while counting joins the count running rather than starting another.
  const count = useCallback(() => void refetch({ cancelRefetch: false }), [refetch])
  const data = all.data
  const rows = useMemo(() => {
    if (!data) return estimates
    const merged = new Map(estimates)
    for (const { item, settled } of data) if (settled.ok) merged.set(item, { counted: settled.value })
    return merged
  }, [data, estimates])
  const failed = useMemo(() => (data ?? []).filter((d) => !d.settled.ok).map((d) => d.item), [data])
  return { rows, counting: all.isFetching, done: data !== undefined, failed, count }
}
