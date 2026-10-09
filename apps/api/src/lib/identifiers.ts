import { type ApiError, capabilities, type Dialect } from '@tsmyadmin/shared'
import { apiError } from './errors.ts'

const NAME_KEYS = new Set(['name', 'newName', 'table', 'database', 'schema', 'refTable', 'user', 'valueColumn'])
const encoder = new TextEncoder()
/** MariaDB allows 128 characters in an account name where MySQL allows 32 (checked on MariaDB 10.11 and 11.8). */
const MARIADB_ACCOUNT_MAX = 128

/**
 * The first identifier in an operation (a DDL or account op) longer than the server allows, or null. Objects are
 * walked recursively; only the keys that carry object names are considered (a host, a comment or a default value
 * may legitimately be long). `serverVersion` tells MariaDB from MySQL, which share a dialect but not the account limit.
 */
export function tooLongIdentifier(
  op: unknown,
  dialect: Dialect,
  serverVersion = ''
): { name: string; max: number } | null {
  const { max, unit, accountMax: dialectAccountMax } = capabilities(dialect).identifier
  const accountMax =
    dialectAccountMax !== null && /mariadb/i.test(serverVersion) ? MARIADB_ACCOUNT_MAX : dialectAccountMax
  const length = (s: string) => (unit === 'bytes' ? encoder.encode(s).length : [...s].length)
  const visit = (value: unknown, key: string | null): { name: string; max: number } | null => {
    if (typeof value === 'string') {
      if (key === null || !NAME_KEYS.has(key)) return null
      const limit = key === 'user' && accountMax !== null ? accountMax : max
      return length(value) > limit ? { name: value, max: limit } : null
    }
    if (Array.isArray(value)) {
      for (const v of value) {
        const hit = visit(v, key === 'columns' || key === 'refColumns' || key === 'keyColumns' ? 'name' : null)
        if (hit) return hit
      }
      return null
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        // `user: { name, host }` — the host is a pattern, not an identifier.
        const hit = visit(v, k === 'user' && v && typeof v === 'object' ? null : k)
        if (hit) return hit
      }
    }
    return null
  }
  return visit(op, null)
}

/** The 400 body for an identifier over the limit (the client renders `reason` with `params`). */
export function identifierTooLong(long: { name: string; max: number }): ApiError {
  return {
    ...apiError('VALIDATION', `Identifier "${long.name}" is longer than ${long.max}`),
    reason: 'IDENTIFIER_TOO_LONG',
    params: { name: long.name.slice(0, 80), max: long.max },
  }
}
