import type { SavedQuery } from '@tsmyadmin/shared'
import { listSavedQueries, mutations, savedQueriesQuery } from '@/lib/queries.ts'
import { type NamedList, useNamedList } from '@/lib/use-named-list.ts'
import { deleteSaved, loadSaved, saveQuery } from './saved-queries.ts'

export type SavedQueries = NamedList<SavedQuery, string>

/** Bookmarked statements, from wherever this deployment keeps them (see `useNamedList`). */
export function useSavedQueries(scope: string, onServer: boolean): SavedQueries {
  return useNamedList<SavedQuery, string>({
    onServer,
    query: { queryKey: savedQueriesQuery.queryKey, queryFn: listSavedQueries },
    saveOnServer: (name, sql) => mutations.saveQuery(name, sql),
    removeOnServer: (id) => mutations.deleteSavedQuery(id),
    local: {
      load: () => loadSaved(scope),
      save: (name, sql) => saveQuery(scope, { id: '', name, sql, at: Date.now() }),
      remove: (name) => deleteSaved(scope, name),
    },
  })
}
