import type { KeyValue, ProcessInfo, ServerInfo } from '@tsmyadmin/shared'
import { type Conn, firstResult } from '../base.ts'
import { joinParts, str, strOrNull } from '../sql/format.ts'
import { AdapterError } from '../types.ts'

export async function pgServerInfo(conn: Conn): Promise<ServerInfo> {
  const r = firstResult(
    await conn.query(
      `SELECT current_setting('server_version'), current_user, version(),
              EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::bigint, inet_server_addr()::text, inet_server_port()`
    )
  )
  const row = r.rows[0] ?? []
  const uptime = Number(row[3])
  return {
    dialect: 'postgres',
    version: str(row[0]),
    uptimeSec: Number.isFinite(uptime) ? uptime : null,
    currentUser: str(row[1]),
    extra: { version: str(row[2]), address: str(row[4]), port: str(row[5]) },
  }
}

export async function pgListVariables(conn: Conn): Promise<KeyValue[]> {
  const r = firstResult(
    await conn.query(
      `SELECT name, COALESCE(setting, '') || COALESCE(' ' || unit, ''), short_desc FROM pg_settings ORDER BY name`
    )
  )
  return r.rows.map((row) => ({ name: str(row[0]), value: str(row[1]), description: strOrNull(row[2]) }))
}

/** pg_stat_database totals for the current database plus server-wide connection counts. */
export async function pgListStatus(conn: Conn): Promise<KeyValue[]> {
  const r = firstResult(
    await conn.query(
      `SELECT 'numbackends', numbackends::text FROM pg_stat_database WHERE datname = current_database()
       UNION ALL SELECT 'xact_commit', xact_commit::text FROM pg_stat_database WHERE datname = current_database()
       UNION ALL SELECT 'xact_rollback', xact_rollback::text FROM pg_stat_database WHERE datname = current_database()
       UNION ALL SELECT 'blks_read', blks_read::text FROM pg_stat_database WHERE datname = current_database()
       UNION ALL SELECT 'blks_hit', blks_hit::text FROM pg_stat_database WHERE datname = current_database()
       UNION ALL SELECT 'tup_returned', tup_returned::text FROM pg_stat_database WHERE datname = current_database()
       UNION ALL SELECT 'tup_fetched', tup_fetched::text FROM pg_stat_database WHERE datname = current_database()
       UNION ALL SELECT 'tup_inserted', tup_inserted::text FROM pg_stat_database WHERE datname = current_database()
       UNION ALL SELECT 'tup_updated', tup_updated::text FROM pg_stat_database WHERE datname = current_database()
       UNION ALL SELECT 'tup_deleted', tup_deleted::text FROM pg_stat_database WHERE datname = current_database()
       UNION ALL SELECT 'deadlocks', deadlocks::text FROM pg_stat_database WHERE datname = current_database()
       UNION ALL SELECT 'temp_bytes', temp_bytes::text FROM pg_stat_database WHERE datname = current_database()
       UNION ALL SELECT 'total_connections', count(*)::text FROM pg_stat_activity WHERE backend_type = 'client backend'
       UNION ALL SELECT 'active_connections', count(*)::text FROM pg_stat_activity WHERE backend_type = 'client backend' AND state = 'active'
       UNION ALL SELECT 'max_connections', current_setting('max_connections')
       UNION ALL SELECT 'database_size_bytes', pg_database_size(current_database())::text`
    )
  )
  return r.rows.map((row) => ({ name: str(row[0]), value: str(row[1]), description: null }))
}

export async function pgListProcesses(conn: Conn): Promise<ProcessInfo[]> {
  const r = firstResult(
    await conn.query(
      `SELECT pid, usename, client_addr::text, datname, state, wait_event_type,
              CASE WHEN state = 'active' THEN EXTRACT(EPOCH FROM (now() - query_start))::bigint END, left(query, 65536),
              application_name = 'tsmyadmin'
       FROM pg_stat_activity WHERE backend_type = 'client backend' ORDER BY pid`
    )
  )
  return r.rows.map((row) => ({
    id: str(row[0]),
    user: strOrNull(row[1]),
    host: strOrNull(row[2]),
    database: strOrNull(row[3]),
    // The wait event only says something while the backend is active; an idle one is just idle.
    state: str(row[4]) === 'active' ? joinParts(row[4], row[5]) : strOrNull(row[4]),
    timeSec: row[6] === null || row[6] === undefined ? null : Number(row[6]),
    query: strOrNull(row[7]),
    self: row[8] === true,
  }))
}

export async function pgKillProcess(conn: Conn, id: string): Promise<void> {
  if (!/^\d+$/.test(id)) throw new AdapterError('QUERY_FAILED', 'process id must be numeric')
  // Terminating the very backend this query runs on kills the connection mid-call: that is success, not failure.
  const own = firstResult(await conn.query('SELECT pg_backend_pid()'))
  if (String(own.rows[0]?.[0]) === id) {
    await conn.query('SELECT pg_terminate_backend($1::int)', [Number(id)]).catch(() => undefined)
    conn.discard()
    return
  }
  const r = firstResult(await conn.query('SELECT pg_terminate_backend($1::int)', [Number(id)]))
  if (r.rows[0]?.[0] !== true) throw new AdapterError('NOT_FOUND', `No such backend: ${id}`)
}
