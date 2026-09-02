import { createFileRoute, Outlet } from '@tanstack/react-router'
import { PageTitle } from '@/components/layout/PageTitle.tsx'
import { TabNav } from '@/components/layout/TabNav.tsx'
import { locale } from '@/config/locale.ts'
import { useDocumentTitle } from '@/lib/document-title.ts'

export const Route = createFileRoute('/_app/db/$db/table/$table')({ component: TableLayout })

function TableLayout() {
  const { db, table } = Route.useParams()
  const { schema } = Route.useSearch()
  const params = { db, table }
  const search = schema ? { schema } : {}
  useDocumentTitle(table, schema ? `${db}.${schema}` : db)
  return (
    <>
      <PageTitle level={2}>
        <span className="text-zinc-500 dark:text-zinc-400">
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
          { label: locale.tabs.insert, to: '/db/$db/table/$table/insert', params, search },
          { label: locale.tabs.export, to: '/db/$db/table/$table/export', params, search },
          { label: locale.tabs.import, to: '/db/$db/table/$table/import', params, search },
          { label: locale.tabs.triggers, to: '/db/$db/table/$table/triggers', params, search },
          { label: locale.tabs.operations, to: '/db/$db/table/$table/operations', params, search },
        ]}
      />
      <Outlet />
    </>
  )
}
