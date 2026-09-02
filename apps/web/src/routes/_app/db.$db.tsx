import { createFileRoute, Link, Outlet, useMatch } from '@tanstack/react-router'
import { PageTitle } from '@/components/layout/PageTitle.tsx'
import { TabNav } from '@/components/layout/TabNav.tsx'
import { Badge } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { useDocumentTitle } from '@/lib/document-title.ts'

export const Route = createFileRoute('/_app/db/$db')({ component: DatabaseLayout })

function DatabaseLayout() {
  const { db } = Route.useParams()
  const { schema } = Route.useSearch()
  const search = schema ? { schema } : {}
  useDocumentTitle(schema ? `${db}.${schema}` : db)
  // With a table open the table layout owns the heading and tabs; the database becomes a breadcrumb link so the
  // page does not stack two title rows and two tab bars with overlapping labels.
  const tableOpen = useMatch({ from: '/_app/db/$db/table/$table', shouldThrow: false }) !== undefined
  if (tableOpen) {
    return (
      <>
        <nav aria-label={locale.nav.breadcrumb} className="mb-2 text-sm text-zinc-600 dark:text-zinc-300">
          <Link to="/" className="hover:underline">
            {locale.server.title}
          </Link>
          <span aria-hidden> / </span>
          <Link to="/db/$db" params={{ db }} search={search} className="hover:underline">
            {db}
            {schema ? `.${schema}` : ''}
          </Link>
        </nav>
        <Outlet />
      </>
    )
  }
  return (
    <>
      <PageTitle>
        {locale.database.title(db)}{' '}
        {schema ? (
          <Badge>
            {locale.database.schema}: {schema}
          </Badge>
        ) : null}
      </PageTitle>
      <TabNav
        label={locale.nav.databases}
        items={[
          { label: locale.tabs.structure, to: '/db/$db', params: { db }, search, exact: true },
          { label: locale.tabs.sql, to: '/db/$db/sql', params: { db }, search },
          { label: locale.tabs.export, to: '/db/$db/export', params: { db }, search },
          { label: locale.tabs.import, to: '/db/$db/import', params: { db }, search },
          { label: locale.tabs.privileges, to: '/db/$db/privileges', params: { db }, search },
          { label: locale.tabs.routines, to: '/db/$db/routines', params: { db }, search },
          { label: locale.tabs.triggers, to: '/db/$db/triggers', params: { db }, search },
          { label: locale.tabs.events, to: '/db/$db/events', params: { db }, search },
        ]}
      />
      <Outlet />
    </>
  )
}
