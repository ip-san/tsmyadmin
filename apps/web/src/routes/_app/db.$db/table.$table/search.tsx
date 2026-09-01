import { createFileRoute } from '@tanstack/react-router'
import type { Filter } from '@tsmyadmin/shared'
import { z } from 'zod'
import { BrowseSearchSchema, browseOptionsFromSearch } from '@/features/browse/browse-search.ts'
import { SearchForm } from '@/features/rows/SearchForm.tsx'

export const Route = createFileRoute('/_app/db/$db/table/$table/search')({
  validateSearch: z.object({ schema: z.string().optional(), filters: z.string().optional() }),
  component: Search,
})

function Search() {
  const { db, table } = Route.useParams()
  const { schema, filters } = Route.useSearch()
  const navigate = Route.useNavigate()
  const initial: Filter[] = browseOptionsFromSearch(BrowseSearchSchema.parse({ schema, filters })).filters
  return (
    <SearchForm
      tableRef={{ db, schema, table }}
      initial={initial}
      onSearch={(next) =>
        navigate({
          to: '/db/$db/table/$table',
          params: { db, table },
          search: {
            ...(schema ? { schema } : {}),
            ...(next.length > 0 ? { filters: JSON.stringify(next) } : {}),
            page: 1,
          },
        })
      }
    />
  )
}
