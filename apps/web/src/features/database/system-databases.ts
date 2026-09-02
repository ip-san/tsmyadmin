import type { Dialect } from '@tsmyadmin/shared'

const SYSTEM: Record<Dialect, ReadonlySet<string>> = {
  mysql: new Set(['information_schema', 'mysql', 'performance_schema', 'sys']),
  postgres: new Set(['postgres', 'template0', 'template1']),
}

/**
 * Databases that must not get a delete button: the server's own catalogs, and on PostgreSQL the database the
 * session is connected to (dropping it always fails: "cannot drop the currently open database").
 */
export function isProtectedDatabase(dialect: Dialect, name: string, connected: string | undefined): boolean {
  if (SYSTEM[dialect].has(name.toLowerCase())) return true
  return dialect === 'postgres' && connected !== undefined && name === connected
}
