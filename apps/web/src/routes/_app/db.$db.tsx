import { createFileRoute, Outlet } from '@tanstack/react-router'
import { PageTitle } from '@/components/layout/PageTitle.tsx'
import { TabNav } from '@/components/layout/TabNav.tsx'
import { Badge } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'

export const Route = createFileRoute('/_app/db/$db')({ component: DatabaseLayout })

function DatabaseLayout() {
  const { db } = Route.useParams()
  const { schema } = Route.useSearch()
  const search = schema ? { schema } : {}
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
        ]}
      />
      <Outlet />
    </>
  )
}
