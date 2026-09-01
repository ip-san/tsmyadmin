import { createFileRoute } from '@tanstack/react-router'
import { BrowseSearchSchema, browseOptionsFromSearch } from '@/features/browse/browse-search.ts'
import { RowsGrid } from '@/features/browse/RowsGrid.tsx'

export const Route = createFileRoute('/_app/db/$db/table/$table/')({
  validateSearch: BrowseSearchSchema,
  component: BrowsePage,
})

function BrowsePage() {
  const { db, table } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <RowsGrid
      tableRef={{ db, schema: search.schema, table }}
      options={browseOptionsFromSearch(search)}
      page={search.page}
      cols={search.cols}
      onChange={(patch) => navigate({ search: (prev) => ({ ...prev, ...patch }) })}
    />
  )
}
