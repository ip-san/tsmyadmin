import type { KeyValue, ProcessInfo, ServerInfo } from '@tsmyadmin/shared'
import { type Conn, firstResult } from '../base.ts'
import { AdapterError } from '../types.ts'

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

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

export async function mysqlListProcesses(conn: Conn): Promise<ProcessInfo[]> {
  const r = firstResult(
    await conn.query(
      'SELECT ID, USER, HOST, DB, COMMAND, TIME, STATE, INFO FROM information_schema.PROCESSLIST ORDER BY ID'
    )
  )
  return r.rows.map((row) => ({
    id: str(row[0]),
    user: strOrNull(row[1]),
    host: strOrNull(row[2]),
    database: strOrNull(row[3]),
    state: [strOrNull(row[4]), strOrNull(row[6])].filter((x): x is string => !!x).join(' / ') || null,
    timeSec: row[5] === null || row[5] === undefined ? null : Number(row[5]),
    query: strOrNull(row[7]),
  }))
}

export async function mysqlKillProcess(conn: Conn, id: string): Promise<void> {
  if (!/^\d+$/.test(id)) throw new AdapterError('QUERY_FAILED', 'process id must be numeric')
  await conn.query(`KILL ${id}`)
}
