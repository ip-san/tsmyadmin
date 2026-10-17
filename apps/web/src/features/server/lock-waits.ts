import type { ConnectionUsage, LockWait, ProcessInfo } from '@tsmyadmin/shared'

/** From this share of max_connections on, the page warns that new connections will soon be refused. */
const NEAR_LIMIT = 0.8

/** The connection count as a whole percentage of max_connections, or null when there is no maximum to compare. */
export function usagePercent(usage: ConnectionUsage): number | null {
  if (usage.max === null || usage.max <= 0) return null
  return Math.round((usage.current / usage.max) * 100)
}

export function isNearLimit(usage: ConnectionUsage): boolean {
  return usage.max !== null && usage.max > 0 && usage.current >= usage.max * NEAR_LIMIT
}

/** The blocking session in the shape the process kill dialog shows (it has no host; its statement is the last one). */
export function blockerAsProcess(wait: LockWait): ProcessInfo {
  const b = wait.blocking
  return {
    id: b.id,
    user: b.user,
    host: null,
    database: b.database,
    state: b.state,
    timeSec: b.transactionSec,
    query: b.query,
    self: false,
  }
}
