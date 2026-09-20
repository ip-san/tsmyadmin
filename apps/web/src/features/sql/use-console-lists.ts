import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Dialect } from '@tsmyadmin/shared'
import { useRef, useState } from 'react'
import { mutations, sqlHistoryQuery } from '@/lib/queries.ts'
import { historyLimit } from '@/lib/settings.ts'
import { clearHistory, forServer, type HistoryEntry, loadHistory, pushHistory, withEntry } from './history.ts'
import { useSavedQueries } from './use-saved-queries.ts'
import { useSharedQueries } from './use-shared-queries.ts'

/**
 * What the SQL console keeps besides the editor text: the history, the bookmarks and the bookmarks shared with the
 * server. Each lives with the account where the session store is persistent, and in this browser where it is not.
 */
export function useConsoleLists({
  scope,
  db,
  schema,
  dialect,
  user,
  host,
  onServer,
}: {
  scope: string
  db: string
  schema?: string | undefined
  dialect: Dialect
  user: string
  host: string
  onServer: boolean
}) {
  const queryClient = useQueryClient()
  // With a persistent session store the history belongs to the account (and follows it to another browser); without
  // one it is this browser's.
  const serverHistory = useQuery({ ...sqlHistoryQuery, enabled: onServer })
  const [localHistory, setLocalHistory] = useState<HistoryEntry[]>(() => (onServer ? [] : loadHistory(scope)))
  const history = onServer ? (serverHistory.data?.entries ?? []) : localHistory
  const historyNow = useRef(history)
  historyNow.current = history
  // With the account, the query cache is the list: a run is put in it at once, and the server (which adds to its own
  // list, so another browser's runs are not overwritten) is asked again afterwards.
  const record = (entry: HistoryEntry) => {
    if (!onServer) return setLocalHistory(pushHistory(scope, entry))
    queryClient.setQueryData(sqlHistoryQuery.queryKey, { entries: withEntry(historyNow.current, entry) })
    void mutations
      .addSqlHistory(forServer(entry), historyLimit())
      .catch(() => undefined)
      .finally(() => queryClient.invalidateQueries({ queryKey: sqlHistoryQuery.queryKey }))
  }
  const clear = () => {
    clearHistory(scope)
    setLocalHistory([])
    if (onServer) {
      queryClient.setQueryData(sqlHistoryQuery.queryKey, { entries: [] })
      void mutations.clearSqlHistory().catch(() => undefined)
    }
  }
  return {
    onServer,
    history,
    record,
    clear,
    saved: useSavedQueries(scope, onServer),
    shared: useSharedQueries(onServer),
    bookmarkContext: { db, schema, user, host, dialect },
  }
}
