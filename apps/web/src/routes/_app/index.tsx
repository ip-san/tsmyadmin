import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useRouteContext } from '@tanstack/react-router'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { ServerTabs } from '@/components/layout/ServerTabs.tsx'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { CreateDatabaseForm } from '@/features/database/CreateDatabaseForm.tsx'
import { DropDatabaseButton } from '@/features/database/DropDatabaseButton.tsx'
import { isProtectedDatabase } from '@/features/database/system-databases.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import { databasesQuery } from '@/lib/queries.ts'

export const Route = createFileRoute('/_app/')({ component: ServerPage })

function ServerPage() {
  const databases = useQuery(databasesQuery)
  const { session } = useRouteContext({ from: '/_app' })
  const dropFlow = useDdlFlow(session.serverDatabase, undefined)
  return (
    <>
      <ServerTabs tab={locale.tabs.databases} />
      <DdlPreviewDialog flow={dropFlow} />
      <h2 className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-200">{locale.server.databasesTitle}</h2>
      {databases.isPending ? (
        <Spinner />
      ) : databases.isError ? (
        <ErrorBox error={databases.error} onRetry={() => void databases.refetch()} />
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
                <Td className="space-x-2 whitespace-nowrap">
                  <Link
                    to="/db/$db"
                    params={{ db: d.name }}
                    className="text-xs text-blue-700 hover:underline dark:text-blue-300"
                  >
                    {locale.server.open}
                  </Link>
                  {isProtectedDatabase(session.dialect, d.name, session.database) ? null : (
                    <DropDatabaseButton name={d.name} flow={dropFlow} />
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <div className="mt-6">
        <CreateDatabaseForm database={session.serverDatabase} kind="database" />
      </div>
    </>
  )
}
