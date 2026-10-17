import { useQueries } from '@tanstack/react-query'
import { referenceCheckQuery } from '@/lib/queries.ts'
import { referenceOverlay, type TableCheck } from './reference-overlay.ts'

/**
 * The reference check of every table with a foreign key, once asked for: it reads whole tables, so it never runs
 * on its own. Each table is its own request, so one that times out leaves the others' answers standing.
 */
export function useReferences(db: string, schema: string | undefined, tables: readonly string[], on: boolean) {
  const results = useQueries({
    queries: tables.map((table) => ({ ...referenceCheckQuery({ db, schema, table }), enabled: on })),
  })
  const checks = new Map<string, TableCheck>()
  tables.forEach((table, i) => {
    const r = results[i]
    if (r?.isError) checks.set(table, 'failed')
    else if (r?.data) checks.set(table, r.data)
  })
  return {
    checks,
    checking: on && results.some((r) => r.isFetching),
    overlay: on ? referenceOverlay(checks) : undefined,
  }
}
