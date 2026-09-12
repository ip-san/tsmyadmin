import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SavedQuery } from '@tsmyadmin/shared'
import { useState } from 'react'
import { mutations, savedQueriesQuery } from '@/lib/queries.ts'
import { deleteSaved, loadSaved, saveQuery } from './saved-queries.ts'

export interface SavedQueries {
  entries: SavedQuery[]
  /** True when the list is kept with the account rather than in this browser. */
  onServer: boolean
  /**
   * The last failure of the server-side list, for the panel to show: a 5xx, a network error or UNSUPPORTED
   * (a 401 is already handled globally by the MutationCache in main.tsx). Without it a failed save would simply
   * do nothing on screen. Always null in browser mode, where neither the query nor the mutations ever run.
   */
  error: Error | null
  save: (name: string, sql: string) => void
  remove: (name: string) => void
}

/** Whichever of the two writes was submitted last (`submittedAt` is 0 for one that never ran). */
type Write = { submittedAt: number; error: Error | null }
function lastWrite(a: Write, b: Write): Write {
  return b.submittedAt > a.submittedAt ? b : a
}

/**
 * Bookmarked statements, from wherever this deployment keeps them: with the account when the session store is
 * persistent (so they follow the user between browsers), otherwise in this browser as they always were. Both
 * lists are addressed by name from the UI — the server rows carry an id because the name is inside the sealed
 * payload and cannot be looked up in SQL.
 */
export function useSavedQueries(scope: string, onServer: boolean): SavedQueries {
  const queryClient = useQueryClient()
  const [local, setLocal] = useState<SavedQuery[]>(() => loadSaved(scope))
  const server = useQuery({ ...savedQueriesQuery, enabled: onServer })
  const entries = onServer ? (server.data ?? []) : local
  // The mutations return the new list, so the cache is set from the response rather than refetched.
  const onSuccess = (list: SavedQuery[]) => queryClient.setQueryData(savedQueriesQuery.queryKey, list)
  const saveMutation = useMutation({
    mutationFn: ({ name, sql }: { name: string; sql: string }) => mutations.saveQuery(name, sql),
    onSuccess,
  })
  const removeMutation = useMutation({ mutationFn: (id: string) => mutations.deleteSavedQuery(id), onSuccess })
  return {
    entries,
    onServer,
    // Only the most recent write: a mutation keeps its error until it is fired again, so a failed save
    // would otherwise still be on screen after a delete had since succeeded.
    error: server.error ?? lastWrite(saveMutation, removeMutation).error,
    save: (name, sql) => {
      if (onServer) saveMutation.mutate({ name, sql })
      else setLocal(saveQuery(scope, { id: '', name, sql, at: Date.now() }))
    },
    remove: (name) => {
      if (!onServer) {
        setLocal(deleteSaved(scope, name))
        return
      }
      const entry = entries.find((q) => q.name === name)
      if (entry) removeMutation.mutate(entry.id)
    },
  }
}
