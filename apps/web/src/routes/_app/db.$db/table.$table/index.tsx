import { createFileRoute } from '@tanstack/react-router'
import {
  BrowseSearchSchema,
  browseOptionsFromSearch,
  preferredLimit,
  rememberLimit,
} from '@/features/browse/browse-search.ts'
import { RowsGrid } from '@/features/browse/RowsGrid.tsx'
import { useShortcuts } from '@/lib/shortcuts.ts'

export const Route = createFileRoute('/_app/db/$db/table/$table/')({
  validateSearch: BrowseSearchSchema,
  component: BrowsePage,
})

function BrowsePage() {
  const { db, table } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  useShortcuts([
    {
      keys: 'arrowleft',
      handler: () => search.page > 1 && navigate({ search: (prev) => ({ ...prev, page: search.page - 1 }) }),
    },
    { keys: 'arrowright', handler: () => navigate({ search: (prev) => ({ ...prev, page: search.page + 1 }) }) },
  ])
  const limit = search.limit ?? preferredLimit()
  return (
    <RowsGrid
      tableRef={{ db, schema: search.schema, table }}
      options={browseOptionsFromSearch(search, limit)}
      page={search.page}
      cols={search.cols}
      onChange={(patch) => {
        if (patch.limit !== undefined) rememberLimit(patch.limit)
        return navigate({ search: (prev) => ({ ...prev, ...patch }) })
      }}
    />
  )
}
