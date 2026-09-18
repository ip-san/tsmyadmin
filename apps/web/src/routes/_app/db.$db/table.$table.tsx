import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Outlet, useMatches } from '@tanstack/react-router'
import { isViewKind } from '@tsmyadmin/shared'
import { Star } from 'lucide-react'
import { useEffect } from 'react'
import { PageTitle } from '@/components/layout/PageTitle.tsx'
import { TabNav } from '@/components/layout/TabNav.tsx'
import { locale } from '@/config/locale.ts'
import { useDocumentTitle } from '@/lib/document-title.ts'
import { structureQuery } from '@/lib/queries.ts'
import { useTableShortcuts } from '@/lib/table-shortcuts.ts'

export const Route = createFileRoute('/_app/db/$db/table/$table')({ component: TableLayout })

function TableLayout() {
  const { db, table } = Route.useParams()
  const { schema } = Route.useSearch()
  const params = { db, table }
  const search = schema ? { schema } : {}
  const leaf = useMatches().at(-1)?.routeId ?? ''
  const tab = TAB_LABELS[leaf.slice(leaf.lastIndexOf('/') + 1)] ?? locale.tabs.browse
  useDocumentTitle(`${table} – ${tab}`, schema ? `${db}.${schema}` : db)
  // Views cannot take rows: the insert / import tabs would only lead to a "read-only" notice.
  const structure = useQuery(structureQuery({ db, schema, table }))
  const view = structure.data !== undefined && isViewKind(structure.data.kind)
  const shortcuts = useTableShortcuts()
  const ref = { db, schema, table }
  const favorite = shortcuts.isFavorite(ref)
  const { visit } = shortcuts
  // Each table opened goes to the top of the recent list (phpMyAdmin's "Recent").
  useEffect(() => {
    visit({ db, schema, table })
  }, [db, schema, table, visit])
  return (
    <>
      <PageTitle
        actions={
          <button
            type="button"
            aria-pressed={favorite}
            onClick={() => shortcuts.toggleFavorite(ref)}
            className="rounded p-1 text-ink-sub hover:text-ink"
            title={favorite ? locale.nav.unfavorite : locale.nav.favorite}
          >
            <Star
              aria-hidden="true"
              className={
                favorite ? 'size-4 fill-amber-400 text-amber-500 dark:fill-amber-300 dark:text-amber-300' : 'size-4'
              }
            />
            <span className="sr-only">{favorite ? locale.nav.unfavorite : locale.nav.favorite}</span>
          </button>
        }
      >
        <span className="text-ink-sub">
          {db}
          {schema ? `.${schema}` : ''}.
        </span>
        {table}
      </PageTitle>
      <TabNav
        label={locale.nav.tables}
        items={[
          { label: locale.tabs.browse, to: '/db/$db/table/$table', params, search, exact: true },
          { label: locale.tabs.structure, to: '/db/$db/table/$table/structure', params, search },
          { label: locale.tabs.sql, to: '/db/$db/table/$table/sql', params, search },
          { label: locale.tabs.search, to: '/db/$db/table/$table/search', params, search },
          { label: locale.tabs.insert, to: '/db/$db/table/$table/insert', params, search, hidden: view },
          { label: locale.tabs.export, to: '/db/$db/table/$table/export', params, search },
          { label: locale.tabs.import, to: '/db/$db/table/$table/import', params, search, hidden: view },
          { label: locale.tabs.triggers, to: '/db/$db/table/$table/triggers', params, search },
          { label: locale.tabs.privileges, to: '/db/$db/table/$table/privileges', params, search },
          { label: locale.tabs.operations, to: '/db/$db/table/$table/operations', params, search },
        ]}
      />
      <Outlet />
    </>
  )
}

/** Last path segment of each table sub-route → tab label (for the document title). */
const TAB_LABELS: Record<string, string> = {
  structure: locale.tabs.structure,
  sql: locale.tabs.sql,
  search: locale.tabs.search,
  insert: locale.tabs.insert,
  export: locale.tabs.export,
  import: locale.tabs.import,
  triggers: locale.tabs.triggers,
  privileges: locale.tabs.privileges,
  operations: locale.tabs.operations,
}
