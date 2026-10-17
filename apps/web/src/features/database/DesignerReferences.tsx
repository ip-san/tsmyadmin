import { useQuery, useQueryClient } from '@tanstack/react-query'
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
  const checks = on ? (all.data ?? NONE) : NONE
  return {
    checks,
    checking: on && all.isFetching,
    overlay: on && all.data ? referenceOverlay(all.data) : undefined,
  }
}
