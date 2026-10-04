import { AdapterError, type AdapterErrorCode } from '../types.ts'

const AUTH_CODES = new Set(['ER_ACCESS_DENIED_ERROR', 'ER_ACCESS_DENIED_NO_PASSWORD_ERROR'])
const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'PROTOCOL_CONNECTION_LOST',
  'ER_HOST_NOT_PRIVILEGED',
  'ER_HOST_IS_BLOCKED',
  // The server has no connection to give (max_connections, or the account's own limit): a capacity problem on the
  // server's side, not a mistake in the request, so it is a CONNECTION_FAILED (502) rather than a QUERY_FAILED (400).
  'ER_CON_COUNT_ERROR',
  'ER_TOO_MANY_USER_CONNECTIONS',
  'ER_USER_LIMIT_REACHED',
])
const NOT_FOUND_CODES = new Set([
  'ER_NO_SUCH_TABLE',
  'ER_UNKNOWN_SEQUENCES',
  'ER_TRG_DOES_NOT_EXIST',
  'ER_EVENT_DOES_NOT_EXIST',
  'ER_BAD_DB_ERROR',
  'ER_BAD_FIELD_ERROR',
  'ER_NO_SUCH_THREAD',
  'ER_SP_DOES_NOT_EXIST',
])
/** The account is authenticated but lacks a privilege for this statement/object. */
const PERMISSION_CODES = new Set([
  'ER_TABLEACCESS_DENIED_ERROR',
  'ER_COLUMNACCESS_DENIED_ERROR',
  'ER_SPECIFIC_ACCESS_DENIED_ERROR',
  'ER_PROCACCESS_DENIED_ERROR',
  'ER_DBACCESS_DENIED_ERROR',
  'ER_KILL_DENIED_ERROR',
])
/**
 * A connection the server took away: killed, lost, or closed by a shutdown or restart (each surfaces as a fatal protocol
 * error). ER_QUERY_INTERRUPTED (KILL QUERY / max_execution_time) is deliberately *not* here: it ends the statement but
 * leaves the connection usable, so it stays QUERY_FAILED.
 */
const LOST_CONNECTION_CODES = new Set(['ER_CONNECTION_KILLED', 'PROTOCOL_CONNECTION_LOST', 'ER_SERVER_SHUTDOWN'])

/** MariaDB-only errno values the driver has no symbolic name for; anything else unnamed becomes `ER_<errno>`. */
const MARIADB_ERRNO_NAMES: Record<number, string> = {
  1969: 'ER_STATEMENT_TIMEOUT',
  4084: 'ER_SEQUENCE_RUN_OUT',
  4091: 'ER_UNKNOWN_SEQUENCES',
}

/**
 * A driver error as an AdapterError: what kind it is (a wrong login, a server that cannot be reached, a missing object,
 * a missing privilege, or an ordinary failed query) and the server's own wording. `mariadb` says whether the server is
 * MariaDB, whose own error numbers have no name in the driver.
 */
export function mapMysqlError(err: unknown, mariadb: boolean): AdapterError {
  if (err instanceof AdapterError) return err
  const e = err as { code?: unknown; sqlMessage?: unknown; message?: unknown; errno?: unknown }
  // mysql2 names errno values after MySQL 8; a MariaDB-only number (1969, 4000+) needs its own name.
  const mariadbNumber = mariadb && typeof e.errno === 'number' && (e.errno >= 4000 || e.errno in MARIADB_ERRNO_NAMES)
  const code =
    typeof e.code === 'string' && !mariadbNumber
      ? e.code
      : typeof e.errno === 'number'
        ? (MARIADB_ERRNO_NAMES[e.errno] ?? `ER_${e.errno}`)
        : 'UNKNOWN'
  const detail =
    typeof e.sqlMessage === 'string' ? e.sqlMessage : typeof e.message === 'string' ? e.message : String(err)
  let kind: AdapterErrorCode = 'QUERY_FAILED'
  if (AUTH_CODES.has(code)) kind = 'AUTH_FAILED'
  else if (CONNECTION_CODES.has(code) || LOST_CONNECTION_CODES.has(code) || (e as { fatal?: boolean }).fatal === true)
    kind = 'CONNECTION_FAILED'
  else if (PERMISSION_CODES.has(code)) kind = 'PERMISSION_DENIED'
  else if (NOT_FOUND_CODES.has(code)) kind = 'NOT_FOUND'
  return new AdapterError(kind, `${code}: ${detail}`, detail, code === 'UNKNOWN' ? {} : { nativeCode: code })
}
