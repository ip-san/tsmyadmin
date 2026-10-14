import type { AdapterError } from '@tsmyadmin/adapter'
import type { LoginHintReason } from '@tsmyadmin/shared'

export interface LoginHint {
  reason: LoginHintReason
  params: Record<string, string | number>
}

/** What a failed login tried to reach. */
export interface LoginTarget {
  host: string
  port: number
  user: string
  database?: string | undefined
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i
/** `'user'@'host'` in a MySQL access error. */
const MYSQL_ACCOUNT = /'([^']*)'@'([^']*)'/
/** `Host 'x' is …` in a MySQL host error. */
const MYSQL_HOST = /Host '([^']*)'/
/** `no pg_hba.conf entry for host "x", user "y", database "z"`. */
const PG_HBA = /no pg_hba\.conf entry for host "([^"]*)"(?:, user "([^"]*)")?(?:, database "([^"]*)")?/

/**
 * The reason a login failed, read from the server's error, for a development deployment to say what to fix: a MySQL
 * account that exists only for other hosts, a host the server refuses or has blocked, a PostgreSQL pg_hba.conf with
 * no line for this address, a wrong password, nothing listening on the port, a host that cannot be reached or does
 * not resolve. Null when the error says nothing more useful than its code.
 */
export function loginHint(err: AdapterError, target: LoginTarget): LoginHint | null {
  const text = `${err.message} ${err.detail ?? ''}`
  const native = err.nativeCode ?? ''
  switch (native) {
    case 'ER_ACCESS_DENIED_ERROR':
    case 'ER_ACCESS_DENIED_NO_PASSWORD_ERROR': {
      const m = MYSQL_ACCOUNT.exec(text)
      return { reason: 'LOGIN_MYSQL_ACCESS_DENIED', params: { user: m?.[1] ?? target.user, from: m?.[2] ?? '' } }
    }
    case 'ER_HOST_NOT_PRIVILEGED':
      return { reason: 'LOGIN_MYSQL_HOST_NOT_ALLOWED', params: { from: MYSQL_HOST.exec(text)?.[1] ?? '' } }
    case 'ER_HOST_IS_BLOCKED':
      return { reason: 'LOGIN_MYSQL_HOST_BLOCKED', params: { from: MYSQL_HOST.exec(text)?.[1] ?? '' } }
    case '28000': {
      const m = PG_HBA.exec(text)
      if (!m) return null
      return {
        reason: 'LOGIN_PG_NO_HBA_ENTRY',
        params: { from: m[1] ?? '', user: m[2] ?? target.user, database: m[3] ?? target.database ?? '' },
      }
    }
    case '28P01':
      return { reason: 'LOGIN_PG_PASSWORD', params: { user: target.user } }
    case 'ECONNREFUSED':
      // Inside a container, localhost is the container itself, not the machine the database runs on.
      return {
        reason: 'LOGIN_REFUSED',
        params: { host: target.host, port: target.port, loopback: LOOPBACK.test(target.host) ? 1 : 0 },
      }
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
      return { reason: 'LOGIN_UNREACHABLE', params: { host: target.host, port: target.port } }
    case 'ENOTFOUND':
      return { reason: 'LOGIN_HOST_UNKNOWN', params: { host: target.host } }
    default:
      return null
  }
}
