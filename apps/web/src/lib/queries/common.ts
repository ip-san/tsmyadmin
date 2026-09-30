/** Shared by every queries/* file: the table reference, the schema query parameter and the invalidation rule. */
import { type QueryClient } from '@tanstack/react-query'

export interface TableRef {
  db: string
  schema?: string | undefined
  table: string
}

/** The `schema` query parameter, present only when a schema is chosen (PostgreSQL). */
export const schemaQuery = (schema?: string) => (schema ? { schema } : {})

/**
 * Whether a cached query holds something a write may have changed. The session names the connection (who is
 * logged in where), not anything the database holds, so it is the one query a write leaves alone.
 */
export const isDatabaseData = (key: readonly unknown[]) => key[0] !== 'session'

/** Refetches everything the database could have changed: after a script, an import or a DDL step. */
export const invalidateDatabaseData = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ predicate: (q) => isDatabaseData(q.queryKey) })
