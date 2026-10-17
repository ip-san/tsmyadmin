import type {
  CatalogColumn,
  ConnectionUsage,
  DiagnosticKind,
  DiagnosticQuery,
  DiagnosticReport,
  KeyValue,
  KillMode,
  LockWaitReport,
  ProcessInfo,
  ReplicationInfo,
  ServerCatalog,
  ServerCatalogKind,
  ServerInfo,
  TableUsageReport,
} from '@tsmyadmin/shared'
import { replicationRole } from '@tsmyadmin/shared'
import { type Conn, firstResult } from '../driver.ts'
import { joinParts, lockWaitFromRow, str, strOrNull } from '../sql/format.ts'
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

/**
 * Who waits for whom, by InnoDB transaction: `r` waits, `b` holds the lock. INNODB_TRX carries the processlist id
 * (the lock-wait tables' THREAD_ID columns are performance_schema's own numbering), when each transaction began and
 * how long the waiter has waited; PROCESSLIST adds the account, the database and what each runs now.
 */
const LOCK_WAIT_COLUMNS = `SELECT DISTINCT r.trx_mysql_thread_id, rp.USER, rp.DB,
    TIMESTAMPDIFF(SECOND, r.trx_wait_started, NOW()), LEFT(COALESCE(rp.INFO, r.trx_query), 65536),
    b.trx_mysql_thread_id, bp.USER, bp.DB, CONCAT_WS(' / ', bp.COMMAND, NULLIF(bp.STATE, '')), bp.COMMAND = 'Sleep',
    TIMESTAMPDIFF(SECOND, b.trx_started, NOW())`
const lockWaitSessions = (
  waiting: string,
  blocking: string
) => `JOIN information_schema.INNODB_TRX r ON r.trx_id = ${waiting}
  JOIN information_schema.INNODB_TRX b ON b.trx_id = ${blocking}
  LEFT JOIN information_schema.PROCESSLIST rp ON rp.ID = r.trx_mysql_thread_id
  LEFT JOIN information_schema.PROCESSLIST bp ON bp.ID = b.trx_mysql_thread_id`
/**
 * MySQL 8: performance_schema's lock waits. An idle blocker has no statement in PROCESSLIST; the statement it ran
 * last is still in events_statements_current, which is what tells a developer which code left the transaction open.
 */
const MYSQL_LOCK_WAITS = `${LOCK_WAIT_COLUMNS},
    LEFT(COALESCE(bp.INFO, b.trx_query, (SELECT s.SQL_TEXT FROM performance_schema.threads t
      JOIN performance_schema.events_statements_current s ON s.THREAD_ID = t.THREAD_ID
      WHERE t.PROCESSLIST_ID = b.trx_mysql_thread_id ORDER BY s.EVENT_ID DESC LIMIT 1)), 65536),
    CONCAT_WS('.', l.OBJECT_SCHEMA, l.OBJECT_NAME), l.LOCK_MODE
  FROM performance_schema.data_lock_waits w
  ${lockWaitSessions('w.REQUESTING_ENGINE_TRANSACTION_ID', 'w.BLOCKING_ENGINE_TRANSACTION_ID')}
  LEFT JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
  ORDER BY 4 DESC, 1, 6`
/** MariaDB (and MySQL before 8.0): the same pairs from information_schema's InnoDB tables. */
const MARIADB_LOCK_WAITS = `${LOCK_WAIT_COLUMNS},
    LEFT(COALESCE(bp.INFO, b.trx_query), 65536), l.lock_table, l.lock_mode
  FROM information_schema.INNODB_LOCK_WAITS w
  ${lockWaitSessions('w.requesting_trx_id', 'w.blocking_trx_id')}
  LEFT JOIN information_schema.INNODB_LOCKS l ON l.lock_id = w.requested_lock_id
  ORDER BY 4 DESC, 1, 6`
/** Connections whose server has no performance_schema.data_lock_waits (MariaDB): the MySQL form is not retried. */
const NO_DATA_LOCK_WAITS = new WeakSet<object>()

/** performance_schema's table is missing (ER_NO_SUCH_TABLE), or information_schema does not know the view (ER_UNKNOWN_TABLE). */
const isMissingTable = (err: unknown) =>
  err instanceof AdapterError && (err.nativeCode === 'ER_NO_SUCH_TABLE' || err.nativeCode === 'ER_UNKNOWN_TABLE')
const isDenied = (err: unknown) =>
  err instanceof AdapterError &&
  (err.code === 'PERMISSION_DENIED' || err.nativeCode === 'ER_SPECIFIC_ACCESS_DENIED_ERROR')

async function mysqlWaitRows(conn: Conn): Promise<{ status: LockWaitReport['status']; rows: unknown[][] }> {
  if (!NO_DATA_LOCK_WAITS.has(conn.id)) {
    try {
      const rows = firstResult(await conn.query(MYSQL_LOCK_WAITS)).rows
      if (rows.length > 0) return { status: 'ok', rows }
      // With performance_schema switched off its tables are there but always empty: that is not "nobody waits".
      const on = firstResult(await conn.query('SELECT @@performance_schema')).rows[0]?.[0]
      return { status: isOff(on) ? 'unsupported' : 'ok', rows }
    } catch (err) {
      if (!isMissingTable(err)) throw err
      NO_DATA_LOCK_WAITS.add(conn.id)
    }
  }
  try {
    return { status: 'ok', rows: firstResult(await conn.query(MARIADB_LOCK_WAITS)).rows }
  } catch (err) {
    if (isMissingTable(err)) return { status: 'unsupported', rows: [] }
    throw err
  }
}

async function mysqlConnectionUsage(conn: Conn): Promise<ConnectionUsage> {
  const r = firstResult(await conn.query("SHOW GLOBAL STATUS LIKE 'Threads_connected'"))
  const max = firstResult(await conn.query('SELECT @@max_connections')).rows[0]?.[0]
  let idle: number | null = null
  try {
    // An open transaction on a connection that runs nothing; reading INNODB_TRX takes the PROCESS privilege.
    const n = firstResult(
      await conn.query(
        `SELECT COUNT(*) FROM information_schema.INNODB_TRX x
         JOIN information_schema.PROCESSLIST p ON p.ID = x.trx_mysql_thread_id WHERE p.COMMAND = 'Sleep'`
      )
    ).rows[0]?.[0]
    idle = Number(n ?? 0)
  } catch (err) {
    if (!isDenied(err)) throw err
  }
  return { current: Number(r.rows[0]?.[1] ?? 0), max: max == null ? null : Number(max), idleInTransaction: idle }
}

/** Lock waits and connection usage. Lock tables the account may not read are `denied`, not an error. */
export async function mysqlLockWaits(conn: Conn): Promise<LockWaitReport> {
  const connections = await mysqlConnectionUsage(conn)
  try {
    const { status, rows } = await mysqlWaitRows(conn)
    return { status, waits: rows.map(lockWaitFromRow), connections }
  } catch (err) {
    if (isDenied(err)) return { status: 'denied', waits: [], connections }
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

/**
 * Rows read per table and per index since the server started, from performance_schema: the row without an index
 * (`INDEX_NAME IS NULL`) counts rows read through no index. A unique index is marked from the catalog's first column;
 * an index the catalog does not know (InnoDB's hidden GEN_CLUST_INDEX, one dropped a moment ago) is not unique.
 */
const MYSQL_INDEX_USAGE = `SELECT u.OBJECT_NAME, u.INDEX_NAME, u.COUNT_READ, s.NON_UNIQUE
  FROM performance_schema.table_io_waits_summary_by_index_usage u
  LEFT JOIN information_schema.STATISTICS s
    ON s.TABLE_SCHEMA = u.OBJECT_SCHEMA AND s.TABLE_NAME = u.OBJECT_NAME AND s.INDEX_NAME = u.INDEX_NAME AND s.SEQ_IN_INDEX = 1
  WHERE u.OBJECT_SCHEMA = ? AND u.OBJECT_TYPE = 'TABLE'
  ORDER BY 1, 2`

/** The instrument that counts table reads: performance_schema can be on with it switched off, counting nothing. */
const TABLE_IO_INSTRUMENT =
  "SELECT ENABLED FROM performance_schema.setup_instruments WHERE NAME = 'wait/io/table/sql/handler'"

/**
 * When the server started, by its own clock: the counters run from then (a TRUNCATE of the summary table starts
 * them again without the server knowing, which this cannot see).
 */
const STARTED_AT =
  "SELECT UNIX_TIMESTAMP() - VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Uptime'"

/**
 * How the tables of `database` are read. performance_schema off (MariaDB's default), missing, or with its table
 * read instrument off is `unsupported`: zero reads everywhere would read as "nothing is used".
 */
export async function mysqlTableUsage(conn: Conn, database: string): Promise<TableUsageReport> {
  const none = (status: TableUsageReport['status']): TableUsageReport => ({
    status,
    unit: 'rows',
    since: null,
    tables: [],
    indexes: [],
  })
  let rows: unknown[][]
  try {
    if (isOff(firstResult(await conn.query('SELECT @@performance_schema')).rows[0]?.[0])) return none('unsupported')
    const instrument = firstResult(await conn.query(TABLE_IO_INSTRUMENT)).rows[0]?.[0]
    // No row for it (a server without this instrument) counts nothing either.
    if (String(instrument ?? 'NO').toUpperCase() !== 'YES') return none('unsupported')
    rows = firstResult(await conn.query(MYSQL_INDEX_USAGE, [database])).rows
  } catch (err) {
    if (isMissingTable(err)) return none('unsupported')
    if (isDenied(err)) return none('denied')
    throw err
  }
  const tables = new Map<string, { table: string; fullReads: number; indexReads: number }>()
  const indexes: TableUsageReport['indexes'] = []
  for (const r of rows) {
    const table = str(r[0])
    const reads = Number(r[2] ?? 0)
    const t = tables.get(table) ?? { table, fullReads: 0, indexReads: 0 }
    if (r[1] === null || r[1] === undefined) t.fullReads += reads
    else {
      t.indexReads += reads
      indexes.push({
        table,
        index: str(r[1]),
        reads,
        unique: r[3] !== null && r[3] !== undefined && Number(r[3]) === 0,
      })
    }
    tables.set(table, t)
  }
  return { status: 'ok', unit: 'rows', since: await mysqlStartedAt(conn), tables: [...tables.values()], indexes }
}

/** Unknown (null) when the server will not say: the counts are there all the same. */
async function mysqlStartedAt(conn: Conn): Promise<string | null> {
  const cell = await conn.query(STARTED_AT).then(
    (out) => firstResult(out).rows[0]?.[0],
    () => null
  )
  const started = cell === null || cell === undefined ? Number.NaN : Number(cell)
  return Number.isFinite(started) ? new Date(started * 1000).toISOString() : null
}
