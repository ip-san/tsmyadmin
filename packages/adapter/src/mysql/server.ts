import type { KeyValue, ProcessInfo, ServerInfo } from '@tsmyadmin/shared'
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

const PROCESSLIST = 'SELECT p.ID, p.USER, p.HOST, p.DB, p.COMMAND, p.TIME, p.STATE, p.INFO'
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

export async function mysqlKillProcess(conn: Conn, id: string): Promise<void> {
  if (!/^\d+$/.test(id)) throw new AdapterError('QUERY_FAILED', 'process id must be numeric')
  try {
    await conn.query(`KILL ${id}`)
  } catch (err) {
    // KILL of the connection this statement runs on drops it (the server reports the loss): success.
    if (err instanceof AdapterError && err.code === 'CONNECTION_FAILED') {
      conn.discard()
      return
    }
    throw err
  }
}
