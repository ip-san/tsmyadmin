import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { locale } from '@/config/locale-screens.ts'
import { homeNamespace, namespaceOf } from '@/lib/home-namespace.ts'
import { tablesQuery } from '@/lib/queries.ts'
import { useDialect } from '@/lib/session.ts'
import { useAllStructures } from '@/lib/use-all-structures.ts'
import { databaseMap } from './database-map.ts'

const t = locale.databaseMap
/** Tables named when some could not be read; the rest are counted. */
const FAILED_NAMED = 5

/**
 * The map of a database (`databaseMap`) from every table's and view's definition (read a few at a time, shared with
 * the other screens that read them all), with the one line that says what is being read and then what was, and a
 * reading again of what failed.
 */
export function useDatabaseMap(db: string, schema: string | undefined) {
  const tables = useQuery(tablesQuery(db, schema))
  const dialect = useDialect()
  // A sequence has no columns or keys.
  const names = useMemo(
    () => (tables.data ?? []).filter((x) => x.kind !== 'sequence').map((x) => x.name),
    [tables.data]
  )
  const all = useAllStructures(db, schema, names, { enabled: tables.data !== undefined })
  const map = useMemo(
    () =>
      all.data
        ? databaseMap([...all.data.byName.values()], homeNamespace(dialect, namespaceOf(db, schema)))
        : undefined,
    [all.data, dialect, db, schema]
  )
  const failed = all.data?.failed ?? []
  const empty = tables.data !== undefined && names.length === 0
  // A second press joins the reading under way (`cancelRefetch: false`), not starting it over: no guard is needed.
  const readAgain = () => void all.refetch({ cancelRefetch: false })
  // The list of tables failing leaves nothing to read; the definitions failing as a whole, reading them again.
  const error = tables.isError
    ? { error: tables.error, retry: () => void tables.refetch() }
    : all.isError
      ? { error: all.error, retry: readAgain }
      : null
  const status = empty
    ? t.empty
    : map
      ? t.sentences(
          [
            t.summary(map.tables, map.views),
            failed.length > 0 ? t.failed(failed.slice(0, FAILED_NAMED), failed.length - FAILED_NAMED) : '',
            // Reading again (pressed, or the definitions grown old): said, the map read before kept meanwhile.
            all.isFetching ? t.reading : '',
          ].filter(Boolean)
        )
      : error
        ? ''
        : t.reading
  return { map, failed, error, status, readAgain, fetching: all.isFetching }
}
