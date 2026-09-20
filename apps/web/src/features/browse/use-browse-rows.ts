import { useQuery } from '@tanstack/react-query'
import type { BrowseOptions } from '@tsmyadmin/shared'
import { useState } from 'react'
import { rowsQuery, sessionQuery, type TableRef } from '@/lib/queries.ts'
import { resolveSettings } from '@/lib/settings.ts'
import { useShowAll } from './use-show-all.tsx'

/**
 * The page's rows. Profiling is a look at one statement and "show all" a choice for this view, so neither is part of the
 * page's address: they are kept here, and off again with the page.
 */
export function useBrowseRows(tableRef: TableRef, options: BrowseOptions) {
  const [profile, setProfile] = useState(false)
  const all = useShowAll(resolveSettings().browseUnlimited)
  const read = all.apply(options)
  const rows = useQuery(rowsQuery(tableRef, profile ? { ...read, profile: true } : read))
  const dialect = useQuery(sessionQuery).data?.dialect
  return { rows, all, profile, setProfile, dialect }
}
