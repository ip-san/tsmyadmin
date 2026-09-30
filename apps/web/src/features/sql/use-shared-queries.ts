import type { SharedQuery } from '@tsmyadmin/shared'
import { listSharedQueries, mutations, sharedQueriesQuery } from '@/lib/queries.ts'
import { type NamedList, useNamedList } from '@/lib/use-named-list.ts'

/** Statements bookmarked for every account of the server; the list exists only where the session store is persistent. */
export function useSharedQueries(onServer: boolean): NamedList<SharedQuery, string> {
  return useNamedList<SharedQuery, string>({
    onServer,
    query: { queryKey: sharedQueriesQuery.queryKey, queryFn: listSharedQueries },
    saveOnServer: (name, sql) => mutations.saveSharedQuery(name, sql),
    removeOnServer: (id) => mutations.deleteSharedQuery(id),
    local: { load: () => [], save: () => [], remove: () => [] },
  })
}
