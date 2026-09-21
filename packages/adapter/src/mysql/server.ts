import type {
  CatalogColumn,
  DiagnosticKind,
  DiagnosticQuery,
  DiagnosticReport,
  KeyValue,
  KillMode,
  ProcessInfo,
  ReplicationInfo,
  ServerCatalog,
  ServerCatalogKind,
  ServerInfo,
} from '@tsmyadmin/shared'
import { replicationRole } from '@tsmyadmin/shared'
import { type Conn, firstResult } from '../base.ts'
import { joinParts, str, strOrNull } from '../sql/format.ts'
import { mysqlLiteral } from '../sql/literal.ts'
import { AdapterError } from '../types.ts'

export async function mysqlServerInfo(conn: Conn): Promise<ServerInfo> {
  const r = firstResult(await conn.query('SELECT VERSION(), CURRENT_USER(), @@version_comment, @@hostname, @@port'))
  const row = r.rows[0] ?? []
  const up = firstResult(await conn.query("SHOW GLOBAL STATUS LIKE 'Uptime'"))
  const uptime = Number(up.rows[0]?.[1])
  return {
    dialect: 'mysql',
    version: str(row[0]),
    uptimeSec: Number.isFinite(uptime) ? uptime : null,
    currentUser: str(row[1]),
    extra: { version_comment: str(row[2]), hostname: str(row[3]), port: str(row[4]) },
  }
}

const pairs = (rows: unknown[][]): KeyValue[] =>
  rows.map((row) => ({ name: str(row[0]), value: str(row[1]), description: null }))

export async function mysqlListVariables(conn: Conn): Promise<KeyValue[]> {
  return pairs(firstResult(await conn.query('SHOW GLOBAL VARIABLES')).rows)
}

export async function mysqlListStatus(conn: Conn): Promise<KeyValue[]> {
  return pairs(firstResult(await conn.query('SHOW GLOBAL STATUS')).rows)
}

const PROCESSLIST = 'SELECT p.ID, p.USER, p.HOST, p.DB, p.COMMAND, p.TIME, p.STATE, LEFT(p.INFO, 65536)'
/** The tool's own connections announce themselves through a connection attribute (needs performance_schema). */
const PROCESSLIST_WITH_SELF = `${PROCESSLIST}, a.ATTR_VALUE = 'tsmyadmin'
  FROM information_schema.PROCESSLIST p
  LEFT JOIN performance_schema.session_connect_attrs a ON a.PROCESSLIST_ID = p.ID AND a.ATTR_NAME = 'program_name'
  ORDER BY p.ID`
const PROCESSLIST_PLAIN = `${PROCESSLIST}, NULL FROM information_schema.PROCESSLIST p ORDER BY p.ID`

export async function mysqlListProcesses(conn: Conn): Promise<ProcessInfo[]> {
  let r: ReturnType<typeof firstResult>
  try {
    r = firstResult(await conn.query(PROCESSLIST_WITH_SELF))
  } catch (err) {
    // No SELECT on performance_schema: the list without the self mark.
    if (!(err instanceof AdapterError && err.code === 'PERMISSION_DENIED')) throw err
    r = firstResult(await conn.query(PROCESSLIST_PLAIN))
  }
  return r.rows.map((row) => ({
    id: str(row[0]),
    user: strOrNull(row[1]),
    host: strOrNull(row[2]),
    database: strOrNull(row[3]),
    state: joinParts(row[4], row[6]),
    timeSec: row[5] === null || row[5] === undefined ? null : Number(row[5]),
    query: strOrNull(row[7]),
    self: row[8] === 1 || row[8] === true,
  }))
}

export async function mysqlKillProcess(conn: Conn, id: string, mode: KillMode = 'connection'): Promise<void> {
  if (!/^\d+$/.test(id)) throw new AdapterError('QUERY_FAILED', 'process id must be numeric')
  try {
    // `KILL QUERY` ends the statement and leaves the session; `KILL` (CONNECTION) drops the whole thing.
    await conn.query(`KILL ${mode === 'query' ? 'QUERY ' : ''}${id}`)
  } catch (err) {
    // KILL of the connection this statement runs on drops it (the server reports the loss): success.
    if (err instanceof AdapterError && err.code === 'CONNECTION_FAILED') {
      conn.discard()
      return
    }
    throw err
  }
}

/** Every value as text (null stays null): the catalog is shown, not computed with. */
const asText = (rows: unknown[][]) => rows.map((r) => r.map((v) => (v === null || v === undefined ? null : String(v))))

const MYSQL_CATALOG = {
  collations: {
    columns: ['charset', 'collation', 'isDefault'],
    sql: 'SELECT CHARACTER_SET_NAME, COLLATION_NAME, IS_DEFAULT FROM information_schema.COLLATIONS ORDER BY CHARACTER_SET_NAME, COLLATION_NAME',
  },
  engines: {
    columns: ['name', 'support', 'transactions', 'comment'],
    sql: 'SELECT ENGINE, SUPPORT, TRANSACTIONS, COMMENT FROM information_schema.ENGINES ORDER BY ENGINE',
  },
  plugins: {
    columns: ['name', 'status', 'type', 'library', 'license'],
    sql: 'SELECT PLUGIN_NAME, PLUGIN_STATUS, PLUGIN_TYPE, PLUGIN_LIBRARY, PLUGIN_LICENSE FROM information_schema.PLUGINS ORDER BY PLUGIN_NAME',
  },
} satisfies Record<ServerCatalogKind, { columns: CatalogColumn[]; sql: string }>

export async function mysqlServerCatalog(conn: Conn, kind: ServerCatalogKind): Promise<ServerCatalog> {
  const { columns, sql } = MYSQL_CATALOG[kind]
  return { columns, rows: asText(firstResult(await conn.query(sql)).rows) }
}

type Records = { name: string; value: string | null }[][]

/** Every row as name → value pairs, whatever columns this server version has. */
const records = (r: { columns: { name: string }[]; rows: unknown[][] }): Records =>
  r.rows.map((row) => r.columns.map((c, i) => ({ name: c.name, value: row[i] == null ? null : String(row[i]) })))

/** Not allowed, or not there at all (binary logging off): the part is shown as unavailable, not as an error. */
const UNAVAILABLE = new Set(['ER_SPECIFIC_ACCESS_DENIED_ERROR', 'ER_NO_BINARY_LOGGING'])

/** A statement, falling back to its pre-8.0.22 / MariaDB spelling where the server does not know the new one. */
async function readOrNull(conn: Conn, sql: string, legacy?: string): Promise<Records | null> {
  try {
    return records(firstResult(await conn.query(sql)))
  } catch (err) {
    if (!(err instanceof AdapterError)) throw err
    if (legacy && err.nativeCode === 'ER_PARSE_ERROR') return readOrNull(conn, legacy)
    if (UNAVAILABLE.has(err.nativeCode ?? '') || err.code === 'PERMISSION_DENIED') return null
    throw err
  }
}

export async function mysqlReplicationInfo(conn: Conn): Promise<ReplicationInfo> {
  const source = await readOrNull(conn, 'SHOW REPLICA STATUS', 'SHOW SLAVE STATUS')
  const replicas = await readOrNull(conn, 'SHOW REPLICAS', 'SHOW SLAVE HOSTS')
  const logs = await readOrNull(conn, 'SHOW BINARY LOGS')
  return {
    role: replicationRole(source, replicas),
    source,
    replicas,
    logs: logs?.map((r) => ({ name: r[0]?.value ?? '', size: r[1]?.value ?? null })) ?? null,
  }
}

const NOTHING = (status: DiagnosticReport['status']): DiagnosticReport => ({
  status,
  columns: [],
  rows: [],
  text: null,
})
const text = (v: unknown) => (v === null || v === undefined ? null : String(v))
const isOff = (v: unknown) => /^(0|off|false)$/i.test(String(v ?? '0'))

/** Seconds of a TIME(6) `query_time`, with its fraction. */
const SECONDS = (column: string) => `TIME_TO_SEC(${column}) + MICROSECOND(${column}) / 1000000`

/** Why a log cannot be read from its table (off, or written to a file), or null when it can. */
async function mysqlLogUnreadable(conn: Conn, kind: 'slow' | 'general'): Promise<DiagnosticReport | null> {
  const flags = firstResult(
    await conn.query(
      kind === 'slow'
        ? 'SELECT @@GLOBAL.slow_query_log, @@GLOBAL.log_output'
        : 'SELECT @@GLOBAL.general_log, @@GLOBAL.log_output'
    )
  ).rows[0]
  if (isOff(flags?.[0])) return NOTHING('disabled')
  if (!/table/i.test(String(flags?.[1] ?? ''))) return NOTHING('notTable')
  return null
}

/** The most recent statements of the general log table, newest first, without the ones this tool ran itself. */
async function mysqlRecentStatements(
  conn: Conn,
  since: string | undefined,
  ownThreads: readonly number[]
): Promise<DiagnosticReport> {
  const unreadable = await mysqlLogUnreadable(conn, 'general')
  if (unreadable) return unreadable
  const params: unknown[] = []
  const where = ["command_type IN ('Query', 'Execute')"]
  if (ownThreads.length > 0) {
    where.push(`thread_id NOT IN (${ownThreads.map(() => '?').join(', ')})`)
    params.push(...ownThreads)
  }
  if (since !== undefined) {
    where.push('event_time > ?')
    params.push(since)
  }
  const r = firstResult(
    await conn.query(
      `SELECT CAST(event_time AS CHAR), CAST(argument AS CHAR) FROM mysql.general_log WHERE ${where.join(' AND ')} ORDER BY event_time DESC LIMIT 200`,
      params
    )
  )
  return { status: 'ok', columns: ['time', 'statement'], rows: r.rows.map((row) => row.map(text)), text: null }
}

/** A logged-statement report from a log kept in a table: only when the log is on and writes to a table. */
async function mysqlLogTable(conn: Conn, kind: 'slow' | 'general'): Promise<DiagnosticReport> {
  const unreadable = await mysqlLogUnreadable(conn, kind)
  if (unreadable) return unreadable
  if (kind === 'general') {
    const r = firstResult(
      await conn.query(
        "SELECT CAST(argument AS CHAR), COUNT(*) FROM mysql.general_log WHERE command_type = 'Query' GROUP BY 1 ORDER BY 2 DESC LIMIT 50"
      )
    )
    return { status: 'ok', columns: ['statement', 'runs'], rows: r.rows.map((row) => row.map(text)), text: null }
  }
  const r = firstResult(
    await conn.query(
      `SELECT CAST(sql_text AS CHAR), COUNT(*), SUM(${SECONDS('query_time')}), MAX(${SECONDS('query_time')}), SUM(rows_examined)
       FROM mysql.slow_log GROUP BY 1 ORDER BY 3 DESC LIMIT 50`
    )
  )
  return {
    status: 'ok',
    columns: ['statement', 'runs', 'totalSeconds', 'maxSeconds', 'rowsExamined'],
    rows: r.rows.map((row) => row.map(text)),
    text: null,
  }
}

async function mysqlBinlogEvents(conn: Conn, file: string | undefined): Promise<DiagnosticReport> {
  let logs: string[]
  try {
    logs = firstResult(await conn.query('SHOW BINARY LOGS')).rows.map((r) => String(r[0]))
  } catch (err) {
    if (err instanceof AdapterError && err.nativeCode === 'ER_NO_BINARY_LOGGING') return NOTHING('disabled')
    throw err
  }
  const chosen = file ?? logs.at(-1)
  if (chosen === undefined) return NOTHING('disabled')
  // The name goes into a SHOW statement (which takes no placeholders): only one the server itself listed.
  if (!logs.includes(chosen)) throw new AdapterError('VALIDATION', 'Unknown binary log')
  const r = firstResult(await conn.query(`SHOW BINLOG EVENTS IN ${mysqlLiteral(chosen)} LIMIT 200`))
  return {
    status: 'ok',
    columns: ['logName', 'position', 'eventType', 'serverId', 'endPosition', 'info'],
    rows: r.rows.map((row) => row.slice(0, 6).map(text)),
    text: null,
  }
}

/** Logged statements, InnoDB status and binary log events. What the account may not read is `denied`, not an error. */
export async function mysqlDiagnostics(
  conn: Conn,
  kind: DiagnosticKind,
  query?: DiagnosticQuery,
  ownThreads: readonly number[] = []
): Promise<DiagnosticReport> {
  try {
    switch (kind) {
      case 'recentStatements':
        return await mysqlRecentStatements(conn, query?.since, ownThreads)
      case 'slowLog':
        return await mysqlLogTable(conn, 'slow')
      case 'generalLog':
        return await mysqlLogTable(conn, 'general')
      case 'binlogEvents':
        return await mysqlBinlogEvents(conn, query?.file)
      case 'engineStatus': {
        const row = firstResult(await conn.query('SHOW ENGINE INNODB STATUS')).rows[0]
        return { status: 'ok', columns: [], rows: [], text: text(row?.[2]) }
      }
      case 'statements':
        return NOTHING('unsupported')
    }
  } catch (err) {
    if (
      err instanceof AdapterError &&
      (err.code === 'PERMISSION_DENIED' || err.nativeCode === 'ER_SPECIFIC_ACCESS_DENIED_ERROR')
    )
      return NOTHING('denied')
    throw err
  }
}
