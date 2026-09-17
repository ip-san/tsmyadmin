import { z } from 'zod'

export const DialectSchema = z.enum(['mysql', 'postgres'])
export type Dialect = z.infer<typeof DialectSchema>

/** The server's own databases: never offered for dropping, renaming or copying. Compared case-insensitively. */
export const SYSTEM_DATABASES: Record<Dialect, ReadonlySet<string>> = {
  mysql: new Set(['information_schema', 'mysql', 'performance_schema', 'sys']),
  postgres: new Set(['postgres', 'template0', 'template1']),
}
