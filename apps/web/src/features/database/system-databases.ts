import { type Dialect, SYSTEM_DATABASES } from '@tsmyadmin/shared'

/**
 * Databases that must not get a delete button: the server's own catalogs, and on PostgreSQL the database the
 * session is connected to (dropping it always fails: "cannot drop the currently open database").
 */
export function isProtectedDatabase(dialect: Dialect, name: string, connected: string | undefined): boolean {
  if (SYSTEM_DATABASES[dialect].has(name.toLowerCase())) return true
  return dialect === 'postgres' && connected !== undefined && name === connected
}
