import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { useState } from 'react'
import {
  type CellDisplay,
  CellDisplayContext,
  preferredCellDisplay,
  rememberCellDisplay,
} from '@/components/cells/cell-display.ts'
import {
  BrowseSearchSchema,
  browseOptionsFromSearch,
  preferredLimit,
  rememberColumns,
  rememberedColumns,
  rememberLimit,
} from '@/features/browse/browse-search.ts'
import { GisView } from '@/features/browse/GisView.tsx'
import { RowsGrid } from '@/features/browse/RowsGrid.tsx'
import { cellUrl } from '@/lib/cell-url.ts'
import { useShortcuts } from '@/lib/shortcuts.ts'

export const Route = createFileRoute('/_app/db/$db/table/$table/')({
  validateSearch: BrowseSearchSchema,
  component: BrowsePage,
})

function BrowsePage() {
  const { db, table } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { session } = useRouteContext({ from: '/_app' })
  const [display, setDisplayState] = useState<CellDisplay>(preferredCellDisplay)
  const setDisplay = (d: CellDisplay) => {
    rememberCellDisplay(d)
    setDisplayState(d)
  }
  useShortcuts([
    {
      keys: 'arrowleft',
      handler: () => search.page > 1 && navigate({ search: (prev) => ({ ...prev, page: search.page - 1 }) }),
    },
    { keys: 'arrowright', handler: () => navigate({ search: (prev) => ({ ...prev, page: search.page + 1 }) }) },
  ])
  const limit = search.limit ?? preferredLimit()
  const tableRef = { db, schema: search.schema, table }
  const options = browseOptionsFromSearch(search, limit)
  return (
    <CellDisplayContext
      value={{
        display,
        setDisplay,
        dialect: session.dialect,
        downloadUrl: (key, column) => cellUrl({ ...tableRef, key, column }),
      }}
    >
      <RowsGrid
        tableRef={tableRef}
        options={options}
        page={search.page}
        // An explicit ?cols= wins (shareable links); otherwise the columns last chosen for this table.
        cols={search.cols ?? rememberedColumns(db, search.schema, table)}
        onChange={(patch) => {
          if (patch.limit !== undefined) rememberLimit(patch.limit)
          if ('cols' in patch) rememberColumns(db, search.schema, table, patch.cols)
          return navigate({ search: (prev) => ({ ...prev, ...patch }) })
        }}
      />
      <GisView tableRef={tableRef} options={options} />
    </CellDisplayContext>
  )
}
