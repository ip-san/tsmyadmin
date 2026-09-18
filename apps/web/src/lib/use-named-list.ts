import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

interface Options<TItem extends { id: string; name: string }, TBody> {
  onServer: boolean
  /** The server-side list; only fetched in server mode. */
  query: { queryKey: readonly unknown[]; queryFn: () => Promise<TItem[]> }
  saveOnServer: (name: string, body: TBody) => Promise<TItem[]>
  removeOnServer: (id: string) => Promise<TItem[]>
  /** The same three operations against this browser's own storage. */
  local: {
    load: () => TItem[]
    save: (name: string, body: TBody) => TItem[]
    remove: (name: string) => TItem[]
  }
}

/**
 * A list of named things kept wherever this deployment keeps them: with the account when the session store is
 * persistent (so they follow the user between browsers), otherwise in this browser. Both lists are addressed by
 * name from the UI — the server rows carry an id because the name is inside the sealed payload and cannot be
 * looked up in SQL.
 */
export interface NamedList<TItem, TBody> {
  entries: TItem[]
  /** True when the list is kept with the account rather than in this browser. */
  onServer: boolean
  /**
   * The last write to have failed, and only while it is still the last to have settled: a 5xx, a network error
   * or UNSUPPORTED (a 401 is already handled globally by the MutationCache in main.tsx). Without it a failed
   * save would simply do nothing on screen. Always null in browser mode, where nothing here ever runs.
   */
  error: Error | null
  save: (name: string, body: TBody) => void
  remove: (name: string) => void
}

export function useNamedList<TItem extends { id: string; name: string }, TBody>(
  options: Options<TItem, TBody>
): NamedList<TItem, TBody> {
  const queryClient = useQueryClient()
  const [local, setLocal] = useState<TItem[]>(() => options.local.load())
  const server = useQuery({
    queryKey: options.query.queryKey,
    queryFn: options.query.queryFn,
    enabled: options.onServer,
  })
  const entries = options.onServer ? (server.data ?? []) : local
  // Held here rather than read off the mutations, because what matters is which write *settled* last, not
  // which was submitted last: a slow save that fails after a quick delete has succeeded is still a failure the
  // user has to see, and a mutation keeps its own error until it is fired again.
  const [writeError, setWriteError] = useState<Error | null>(null)
  // The mutations return the new list, so the cache is set from the response rather than refetched.
  const onSuccess = (list: TItem[]) => {
    setWriteError(null)
    queryClient.setQueryData(options.query.queryKey, list)
  }
  const onError = (failure: Error) => setWriteError(failure)
  const saveMutation = useMutation({
    mutationFn: ({ name, body }: { name: string; body: TBody }) => options.saveOnServer(name, body),
    onSuccess,
    onError,
  })
  const removeMutation = useMutation({ mutationFn: options.removeOnServer, onSuccess, onError })
  return {
    entries,
    onServer: options.onServer,
    error: server.error ?? writeError,
    save: (name, body) => {
      if (options.onServer) saveMutation.mutate({ name, body })
      else setLocal(options.local.save(name, body))
    },
    remove: (name) => {
      if (!options.onServer) {
        setLocal(options.local.remove(name))
        return
      }
      const entry = entries.find((e) => e.name === name)
      if (entry) removeMutation.mutate(entry.id)
    },
  }
}
