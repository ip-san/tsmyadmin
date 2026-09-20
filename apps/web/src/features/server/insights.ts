import type { Dialect, KeyValue } from '@tsmyadmin/shared'

type TrafficKey =
  | 'bytesReceived'
  | 'bytesSent'
  | 'connections'
  | 'abortedClients'
  | 'abortedConnects'
  | 'questions'
  | 'threadsConnected'
  | 'threadsRunning'
  | 'maxUsedConnections'
  | 'transactions'
  | 'rollbacks'
  | 'activeConnections'
  | 'maxConnections'
  | 'tempBytes'
  | 'databaseSize'

export interface Figure {
  key: TrafficKey
  value: number
  kind: 'count' | 'bytes'
  /** Per hour of uptime, for totals since start; null for a current value. */
  perHour: number | null
}

const numbers = (items: readonly KeyValue[]) =>
  new Map(
    items.flatMap((i) =>
      Number.isFinite(Number(i.value)) && i.value.trim() !== '' ? [[i.name, Number(i.value)] as const] : []
    )
  )

/** phpMyAdmin's Status "Traffic" and connection figures, from the server's own counters. */
export function traffic(dialect: Dialect, status: readonly KeyValue[], uptimeSec: number | null): Figure[] {
  const n = numbers(status)
  const hours = uptimeSec !== null && uptimeSec >= 60 ? uptimeSec / 3600 : null
  const total = (key: TrafficKey, name: string, kind: Figure['kind'] = 'count'): Figure[] => {
    const value = n.get(name)
    return value === undefined ? [] : [{ key, value, kind, perHour: hours === null ? null : value / hours }]
  }
  const current = (key: TrafficKey, name: string, kind: Figure['kind'] = 'count'): Figure[] => {
    const value = n.get(name)
    return value === undefined ? [] : [{ key, value, kind, perHour: null }]
  }
  if (dialect === 'mysql')
    return [
      ...total('bytesReceived', 'Bytes_received', 'bytes'),
      ...total('bytesSent', 'Bytes_sent', 'bytes'),
      ...total('connections', 'Connections'),
      ...total('abortedClients', 'Aborted_clients'),
      ...total('abortedConnects', 'Aborted_connects'),
      ...total('questions', 'Questions'),
      ...current('threadsConnected', 'Threads_connected'),
      ...current('threadsRunning', 'Threads_running'),
      ...current('maxUsedConnections', 'Max_used_connections'),
    ]
  const commit = n.get('xact_commit')
  const rollback = n.get('xact_rollback')
  return [
    ...(commit !== undefined && rollback !== undefined
      ? [
          {
            key: 'transactions' as const,
            value: commit + rollback,
            kind: 'count' as const,
            perHour: hours === null ? null : (commit + rollback) / hours,
          },
        ]
      : []),
    ...total('rollbacks', 'xact_rollback'),
    ...current('connections', 'total_connections'),
    ...current('activeConnections', 'active_connections'),
    ...current('maxConnections', 'max_connections'),
    ...total('tempBytes', 'temp_bytes', 'bytes'),
    ...current('databaseSize', 'database_size_bytes', 'bytes'),
  ]
}

export interface StatementCount {
  name: string
  count: number
  /** Of all the statements listed for the server. */
  share: number
}

const PG_ROW_COUNTERS: Record<string, string> = {
  tup_returned: 'returned',
  tup_fetched: 'fetched',
  tup_inserted: 'inserted',
  tup_updated: 'updated',
  tup_deleted: 'deleted',
}

/**
 * How many statements of each kind the server has run (MySQL `Com_*`), or how many rows of each kind the current
 * database has touched (PostgreSQL keeps no per-statement counters without an extension). Largest first.
 */
export function queryStatistics(dialect: Dialect, status: readonly KeyValue[], limit = 12): StatementCount[] {
  const n = numbers(status)
  const rows: { name: string; count: number }[] = []
  for (const [name, count] of n) {
    if (dialect === 'mysql') {
      if (name.startsWith('Com_') && count > 0) rows.push({ name: name.slice(4), count })
    } else if (PG_ROW_COUNTERS[name] && count > 0) rows.push({ name: PG_ROW_COUNTERS[name], count })
  }
  const sum = rows.reduce((s, r) => s + r.count, 0)
  return rows
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((r) => ({ ...r, share: sum === 0 ? 0 : r.count / sum }))
}

/** A status variable's group: MySQL names lead with it (`Handler_…`, `Innodb_…`); PostgreSQL's are one list. */
export function statusCategory(dialect: Dialect, name: string): string {
  if (dialect !== 'mysql') return ''
  const i = name.indexOf('_')
  return i > 0 ? name.slice(0, i) : name
}

/** When the server started, from its uptime; null when the uptime is unknown. */
export function startedAt(uptimeSec: number | null, now = Date.now()): Date | null {
  return uptimeSec === null ? null : new Date(now - uptimeSec * 1000)
}
