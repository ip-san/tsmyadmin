import type { ApiError, Dialect } from '@tsmyadmin/shared'
import { apiError } from './errors.ts'

/** Longest identifier the server accepts: MySQL 64 characters, PostgreSQL 63 bytes (longer ones are truncated silently). */
function identifierLimit(dialect: Dialect): { max: number; unit: 'chars' | 'bytes' } {
  return dialect === 'mysql' ? { max: 64, unit: 'chars' } : { max: 63, unit: 'bytes' }
}

const NAME_KEYS = new Set(['name', 'newName', 'table', 'database', 'schema', 'refTable', 'user'])
const encoder = new TextEncoder()

/**
 * The first identifier in an operation (a DDL or account op) longer than the server allows, or null. Objects are
 * walked recursively; only the keys that carry object names are considered (a host, a comment or a default value
 * may legitimately be long).
 */
export function tooLongIdentifier(op: unknown, dialect: Dialect): { name: string; max: number } | null {
  const { max, unit } = identifierLimit(dialect)
  const length = (s: string) => (unit === 'bytes' ? encoder.encode(s).length : [...s].length)
  const visit = (value: unknown, key: string | null): { name: string; max: number } | null => {
    if (typeof value === 'string')
      return key !== null && NAME_KEYS.has(key) && length(value) > max ? { name: value, max } : null
    if (Array.isArray(value)) {
      for (const v of value) {
        const hit = visit(v, key === 'columns' || key === 'refColumns' ? 'name' : null)
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
