import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { PageTitle } from '@/components/layout/PageTitle.tsx'
import { TabNav } from '@/components/layout/TabNav.tsx'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { databasesQuery } from '@/lib/queries.ts'

export const Route = createFileRoute('/_app/')({ component: ServerPage })

function ServerPage() {
  const databases = useQuery(databasesQuery)
  return (
    <>
      <PageTitle>{locale.server.title}</PageTitle>
      <TabNav
        label={locale.nav.server}
        items={[
          { label: locale.tabs.databases, to: '/', exact: true },
          { label: locale.tabs.users, to: '/users' },
        ]}
      />
      <h2 className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-200">{locale.server.databasesTitle}</h2>
      {databases.isPending ? (
        <Spinner />
      ) : databases.isError ? (
        <ErrorBox error={databases.error} />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>{locale.server.databaseName}</Th>
              <Th>{locale.database.actions}</Th>
            </tr>
          </thead>
          <tbody>
            {databases.data.map((d) => (
              <Tr key={d.name}>
                <Td>
                  <Link
                    to="/db/$db"
                    params={{ db: d.name }}
                    className="font-medium text-blue-700 hover:underline dark:text-blue-300"
                  >
                    {d.name}
                  </Link>
                </Td>
                <Td>
                  <Link
                    to="/db/$db"
                    params={{ db: d.name }}
                    className="text-xs text-blue-700 hover:underline dark:text-blue-300"
                  >
                    {locale.server.open}
                  </Link>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  )
}
