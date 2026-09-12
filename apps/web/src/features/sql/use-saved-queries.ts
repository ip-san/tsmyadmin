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
   * The last write to have failed, and only while it is still the last to have settled: a 5xx, a network error
   * or UNSUPPORTED (a 401 is already handled globally by the MutationCache in main.tsx). Without it a failed
   * save would simply do nothing on screen. Always null in browser mode, where nothing here ever runs.
   */
  error: Error | null
  save: (name: string, sql: string) => void
  remove: (name: string) => void
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
  // Held here rather than read off the mutations, because what matters is which write *settled* last, not
  // which was submitted last: a slow save that fails after a quick delete has succeeded is still a failure the
  // user has to see, and a mutation keeps its own error until it is fired again.
  const [writeError, setWriteError] = useState<Error | null>(null)
  // The mutations return the new list, so the cache is set from the response rather than refetched.
  const onSuccess = (list: SavedQuery[]) => {
    setWriteError(null)
    queryClient.setQueryData(savedQueriesQuery.queryKey, list)
  }
  const onError = (failure: Error) => setWriteError(failure)
  const saveMutation = useMutation({
    mutationFn: ({ name, sql }: { name: string; sql: string }) => mutations.saveQuery(name, sql),
    onSuccess,
    onError,
  })
  const removeMutation = useMutation({
    mutationFn: (id: string) => mutations.deleteSavedQuery(id),
    onSuccess,
    onError,
  })
  return {
    entries,
    onServer,
    error: server.error ?? writeError,
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
