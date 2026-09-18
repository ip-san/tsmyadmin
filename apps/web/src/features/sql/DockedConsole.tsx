import { useQuery } from '@tanstack/react-query'
import type { Dialect } from '@tsmyadmin/shared'
import { useMemo } from 'react'
import { tablesQuery } from '@/lib/queries.ts'
import { SqlConsole } from './SqlConsole.tsx'

/**
 * phpMyAdmin's console at the foot of every page: the same SQL console as the SQL tab, against the database the
 * page is showing, kept open while moving between tabs. Its draft is its own (per database), so it does not
 * overwrite what is being written on a SQL tab.
 */
export function DockedConsole({ db, schema, dialect }: { db: string; schema?: string | undefined; dialect: Dialect }) {
  const tables = useQuery(tablesQuery(db, schema))
  const completion = useMemo<Record<string, string[]>>(
    () => Object.fromEntries((tables.data ?? []).map((t) => [t.name, []])),
    [tables.data]
  )
  return (
    <SqlConsole
      key={`${db}/${schema ?? ''}`}
      db={db}
      schema={schema}
      dialect={dialect}
      completion={completion}
      draftId="dock"
    />
  )
}
