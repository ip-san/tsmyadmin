import type {
  CatalogColumn,
  KeyValue,
  KillMode,
  ProcessInfo,
  ReplicationInfo,
  ServerCatalog,
  ServerCatalogKind,
  ServerInfo,
} from '@tsmyadmin/shared'
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

export async function pgKillProcess(conn: Conn, id: string, mode: KillMode = 'connection'): Promise<void> {
  if (!/^\d+$/.test(id)) throw new AdapterError('QUERY_FAILED', 'process id must be numeric')
  // pg_cancel_backend ends the running statement; pg_terminate_backend closes the connection.
  const fn = mode === 'query' ? 'pg_cancel_backend' : 'pg_terminate_backend'
  // Acting on the very backend this query runs on kills the connection mid-call: that is success, not failure.
  const own = firstResult(await conn.query('SELECT pg_backend_pid()'))
  if (String(own.rows[0]?.[0]) === id && mode === 'connection') {
    await conn.query(`SELECT ${fn}($1::int)`, [Number(id)]).catch(() => undefined)
    conn.discard()
    return
  }
  const r = firstResult(await conn.query(`SELECT ${fn}($1::int)`, [Number(id)]))
  if (r.rows[0]?.[0] !== true) throw new AdapterError('NOT_FOUND', `No such backend: ${id}`)
}

/** Every value as text (null stays null): the catalog is shown, not computed with. */
const asText = (rows: unknown[][]) => rows.map((r) => r.map((v) => (v === null || v === undefined ? null : String(v))))

/** PostgreSQL has no storage engines or plugins: its access methods and extensions are what fill those places. */
const PG_CATALOG = {
  collations: {
    columns: ['collation', 'provider', 'encoding'],
    sql: `SELECT collname,
                 CASE collprovider WHEN 'c' THEN 'libc' WHEN 'i' THEN 'icu' WHEN 'b' THEN 'builtin' ELSE 'default' END,
                 CASE WHEN collencoding < 0 THEN NULL ELSE pg_encoding_to_char(collencoding) END
          FROM pg_collation ORDER BY collname`,
  },
  engines: {
    columns: ['name', 'type'],
    sql: `SELECT amname, CASE amtype WHEN 't' THEN 'table' WHEN 'i' THEN 'index' ELSE amtype::text END
          FROM pg_am ORDER BY amname`,
  },
  plugins: {
    columns: ['name', 'version', 'installedVersion', 'comment'],
    sql: 'SELECT name, default_version, installed_version, comment FROM pg_available_extensions ORDER BY name',
  },
} satisfies Record<ServerCatalogKind, { columns: CatalogColumn[]; sql: string }>

export async function pgServerCatalog(conn: Conn, kind: ServerCatalogKind): Promise<ServerCatalog> {
  const { columns, sql } = PG_CATALOG[kind]
  return { columns, rows: asText(firstResult(await conn.query(sql)).rows) }
}

type Records = { name: string; value: string | null }[][]

const records = (r: { columns: { name: string }[]; rows: unknown[][] }): Records =>
  r.rows.map((row) => r.columns.map((c, i) => ({ name: c.name, value: row[i] == null ? null : String(row[i]) })))

/** Reading the WAL directory needs pg_monitor (or superuser); without it the part is shown as unavailable. */
async function readOrNull(conn: Conn, sql: string): Promise<Records | null> {
  try {
    return records(firstResult(await conn.query(sql)))
  } catch (err) {
    if (err instanceof AdapterError && err.code === 'PERMISSION_DENIED') return null
    throw err
  }
}

export async function pgReplicationInfo(conn: Conn): Promise<ReplicationInfo> {
  // pg_stat_* views are readable by anyone, but show the detail columns only to pg_read_all_stats.
  const source = await readOrNull(conn, 'SELECT * FROM pg_stat_wal_receiver')
  const replicas = await readOrNull(conn, 'SELECT * FROM pg_stat_replication ORDER BY application_name')
  const logs = await readOrNull(conn, 'SELECT name, size FROM pg_ls_waldir() ORDER BY name')
  const reading = (source?.length ?? 0) > 0
  const sending = (replicas?.length ?? 0) > 0
  return {
    role: reading && sending ? 'relay' : reading ? 'replica' : sending ? 'primary' : 'standalone',
    source,
    replicas,
    logs: logs?.map((r) => ({ name: r[0]?.value ?? '', size: r[1]?.value ?? null })) ?? null,
  }
}
