import { useQuery } from '@tanstack/react-query'
import type { Dialect } from '@tsmyadmin/shared'
import { sessionQuery } from './queries.ts'

/**
 * The connected server's dialect, read from the session in the query cache (the live copy, so it needs no router).
 * Before that first fetch there is nothing to read, and MySQL stands in.
 */
export function useDialect(): Dialect {
  return useQuery(sessionQuery).data?.dialect ?? 'mysql'
}
