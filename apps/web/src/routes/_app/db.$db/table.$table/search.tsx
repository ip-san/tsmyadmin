import { useMutation } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import type { Filter, QueryBuilderRequestInput } from '@tsmyadmin/shared'
import { z } from 'zod'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { BrowseSearchSchema, browseOptionsFromSearch } from '@/features/browse/browse-search.ts'
import { ReplaceForm } from '@/features/rows/ReplaceForm.tsx'
import { SearchForm } from '@/features/rows/SearchForm.tsx'
import { needsStatement } from '@/features/rows/SearchOptions.tsx'
import { browseParams, statementRequest } from '@/features/rows/search-target.ts'
import { ZoomSearch } from '@/features/rows/ZoomSearch.tsx'
import { useOpenInDatabaseConsole } from '@/lib/open-in-console.ts'
import { mutations } from '@/lib/queries.ts'

export const Route = createFileRoute('/_app/db/$db/table/$table/search')({
  validateSearch: z.object({ schema: z.string().optional(), filters: z.string().optional() }),
  component: Search,
})

function Search() {
  const { db, table } = Route.useParams()
  const { schema, filters } = Route.useSearch()
  const navigate = Route.useNavigate()
  const openInSql = useOpenInDatabaseConsole(db, schema)
  const build = useMutation({
    mutationFn: (body: QueryBuilderRequestInput) => mutations.buildQuery(db, body),
    onSuccess: (r) => openInSql(r.sql),
  })
  const initial: Filter[] = browseOptionsFromSearch(BrowseSearchSchema.parse({ schema, filters })).filters
  return (
    <>
      <SearchForm
        tableRef={{ db, schema, table }}
        initial={initial}
        onSearch={(next, options, all) => {
          // DISTINCT and conditions typed as SQL need a SELECT of their own, opened in the SQL tab.
          if (needsStatement(options)) return build.mutate(statementRequest(table, schema, next, options, all))
          void navigate({
            to: '/db/$db/table/$table',
            params: { db, table },
            search: { ...(schema ? { schema } : {}), ...browseParams(next, options, all) },
          })
        }}
      />
      {build.isError ? <ErrorBox error={build.error} /> : null}
      <ZoomSearch tableRef={{ db, schema, table }} filters={initial} />
      <ReplaceForm tableRef={{ db, schema, table }} />
    </>
  )
}
