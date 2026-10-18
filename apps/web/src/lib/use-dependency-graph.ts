import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { type DependencyGraph, dependencyGraph, viewNamesOf } from './dependencies.ts'
import { dependenciesQuery, tablesQuery, triggersQuery } from './queries.ts'

/** A part of the graph that could not be read, with the way to read it again. */
interface MissingPart {
  error: unknown
  retry: () => void
}

/**
 * Who uses what in a namespace, from the three reads it is made of: what views and routines depend on (without it
 * there is no graph), and the triggers and the list of tables (without them the graph is drawn, but incomplete:
 * a screen says what is missing and does not say that nothing uses a table). For the dependency tab and the cards
 * of a table's structure and overview alike.
 */
export function useDependencyGraph(db: string, schema: string | undefined) {
  const report = useQuery(dependenciesQuery(db, schema))
  const triggers = useQuery(triggersQuery(db, schema))
  const tables = useQuery(tablesQuery(db, schema))
  const graph: DependencyGraph = useMemo(
    () => dependencyGraph(report.data?.objects ?? [], triggers.data ?? [], viewNamesOf(tables.data ?? [])),
    [report.data, triggers.data, tables.data]
  )
  const missing: MissingPart[] = [
    ...(triggers.isError ? [{ error: triggers.error, retry: () => void triggers.refetch() }] : []),
    ...(tables.isError ? [{ error: tables.error, retry: () => void tables.refetch() }] : []),
  ]
  return {
    pending: report.isPending || triggers.isPending || tables.isPending,
    /** The dependency report itself failed: nothing to draw. */
    failed: report.isError ? { error: report.error, retry: () => void report.refetch() } : undefined,
    /** `unsupported` where the server keeps no catalog of what views and routines use (MariaDB). */
    status: report.data?.status,
    graph,
    /** The parts that could not be read: say so, and do not say that nothing uses something. */
    missing,
  }
}
