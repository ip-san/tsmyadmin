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
import { replicationRole } from '@tsmyadmin/shared'
import { type Conn, firstResult } from '../base.ts'
import { joinParts, str, strOrNull } from '../sql/format.ts'
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
