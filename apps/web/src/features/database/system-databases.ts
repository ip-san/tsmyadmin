import { type Dialect, SYSTEM_DATABASES } from '@tsmyadmin/shared'

/** The server's own catalogs. */
export function isSystemDatabase(dialect: Dialect, name: string): boolean {
  return SYSTEM_DATABASES[dialect].has(name.toLowerCase())
}

/**
 * Databases that must not be dropped, renamed or copied: the server's own catalogs, and on PostgreSQL the
 * database the session is connected to (every one of those fails there: "cannot drop the currently open database").
 */
export function isProtectedDatabase(dialect: Dialect, name: string, connected: string | undefined): boolean {
  if (isSystemDatabase(dialect, name)) return true
  return dialect === 'postgres' && connected !== undefined && name === connected
}
