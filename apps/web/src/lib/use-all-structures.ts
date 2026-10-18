import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { TableSchema } from '@tsmyadmin/shared'
import { eachLimited } from './each-limited.ts'
import { structureQuery } from './queries.ts'

/**
 * How long the definitions of a namespace's tables are kept before they are read again: a change made in this tool
 * refreshes everything at once (`invalidateDatabaseData`), so this is only about changes made elsewhere.
 */
export const DEFINITIONS_STALE_MS = 5 * 60_000

/** The definitions read, by table, and the tables that could not be read (a view this account cannot see, say). */
export interface AllStructures {
  byName: ReadonlyMap<string, TableSchema>
  failed: readonly string[]
}

/**
 * The definition of every one of `names`, read a few at a time (`eachLimited`): a database of hundreds of tables
 * must not send hundreds of requests at once, here or on any screen that reads them all (the metadata search, the
 * Designer's columns and candidates, the data dictionary). One table that fails leaves the others' standing, and
 * reading again reads only the ones that failed (the others are kept as long as this is).
 */
export function useAllStructures(
  db: string,
  schema: string | undefined,
  names: readonly string[],
  { enabled = true }: { enabled?: boolean } = {}
) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: ['all-structures', db, schema ?? '', names],
    queryFn: async ({ signal }): Promise<AllStructures> => {
      const done = await eachLimited(
        names,
        (table) =>
          queryClient.fetchQuery({ ...structureQuery({ db, schema, table }), staleTime: DEFINITIONS_STALE_MS }),
        { signal }
      )
      return {
        byName: new Map(done.flatMap(({ item, settled }) => (settled.ok ? [[item, settled.value] as const] : []))),
        failed: done.flatMap(({ item, settled }) => (settled.ok ? [] : [item])),
      }
    },
    enabled: enabled && names.length > 0,
    staleTime: DEFINITIONS_STALE_MS,
  })
}
