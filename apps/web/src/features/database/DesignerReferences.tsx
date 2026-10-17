import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { referenceCheckQuery } from '@/lib/queries.ts'
import { checkAll, referenceOverlay, type TableCheck } from './reference-overlay.ts'

const NONE: ReadonlyMap<string, TableCheck> = new Map()

/**
 * The reference check of every table with a foreign key, once asked for: it reads whole tables, so it never runs on
 * its own (not on focus, not when the answer ages), and runs a few tables at a time (`checkAll`). Each press is a
 * check of its own (`run`), so pressing again checks again. One that times out leaves the others' answers standing.
 */
export function useReferences(
  db: string,
  schema: string | undefined,
  tables: readonly string[],
  { on, run }: { on: boolean; run: number }
) {
  const queryClient = useQueryClient()
  const all = useQuery({
    queryKey: ['references-all', db, schema ?? '', tables, run],
    queryFn: ({ signal }) =>
      checkAll(
        tables,
        (table) => queryClient.fetchQuery({ ...referenceCheckQuery({ db, schema, table }), staleTime: 0 }),
        {
          signal,
        }
      ),
    enabled: on,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  // Turned off, a check still running is stopped: a disabled query keeps its observer, so its signal would not
  // abort on its own, and the tables not yet started would still be read in full.
  useEffect(() => {
    if (!on) void queryClient.cancelQueries({ queryKey: ['references-all', db, schema ?? ''] })
  }, [on, queryClient, db, schema])
  const checks = on ? (all.data ?? NONE) : NONE
  return {
    checks,
    checking: on && all.isFetching,
    overlay: on && all.data ? referenceOverlay(all.data) : undefined,
  }
}
