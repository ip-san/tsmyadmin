import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useRouteContext } from '@tanstack/react-router'
import { useState } from 'react'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { ServerTabs } from '@/components/layout/ServerTabs.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { PrintButton } from '@/components/ui/PrintButton.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { CreateDatabaseForm } from '@/features/database/CreateDatabaseForm.tsx'
import { DropDatabaseButton } from '@/features/database/DropDatabaseButton.tsx'
import { isProtectedDatabase } from '@/features/database/system-databases.ts'
import { ServerInfoCard } from '@/features/server/ServerInfoCard.tsx'
import { useDdlFlow } from '@/lib/ddl.ts'
import { databasesQuery } from '@/lib/queries.ts'

export const Route = createFileRoute('/_app/')({ component: ServerPage })

function ServerPage() {
  const databases = useQuery(databasesQuery)
  const { session } = useRouteContext({ from: '/_app' })
  const [selected, setSelected] = useState<string[]>([])
  const dropFlow = useDdlFlow(session.serverDatabase, undefined, () => setSelected([]))
  const droppable = (databases.data ?? [])
    .map((d) => d.name)
    .filter((n) => !isProtectedDatabase(session.dialect, n, session.database))
  const chosen = selected.filter((n) => droppable.includes(n))
  const allChecked = droppable.length > 0 && chosen.length === droppable.length
  return (
    <>
      <ServerTabs tab={locale.tabs.databases} />
      <DdlPreviewDialog flow={dropFlow} bulkConfirmName={session.host} />
      <ServerInfoCard />
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">{locale.server.databasesTitle}</h2>
        <PrintButton />
      </div>
      {databases.isPending ? (
        <Spinner />
      ) : databases.isError ? (
        <ErrorBox error={databases.error} onRetry={() => void databases.refetch()} />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th data-print-hide>
                <input
                  type="checkbox"
                  aria-label={locale.browse.selectAll}
                  checked={allChecked}
                  ref={(el) => {
                    if (el) el.indeterminate = chosen.length > 0 && !allChecked
                  }}
                  disabled={droppable.length === 0}
                  onChange={() => setSelected(allChecked ? [] : droppable)}
                />
              </Th>
              <Th>{locale.server.databaseName}</Th>
              <Th className="text-right">{locale.database.size}</Th>
              {session.dialect === 'mysql' ? <Th className="text-right">{locale.database.tableCount}</Th> : null}
              <Th data-print-hide>{locale.database.actions}</Th>
            </tr>
          </thead>
          <tbody>
            {databases.data.map((d) => (
              <Tr key={d.name}>
                <Td data-print-hide>
                  {droppable.includes(d.name) ? (
                    <input
                      type="checkbox"
                      aria-label={locale.server.selectDatabase(d.name)}
                      checked={chosen.includes(d.name)}
                      onChange={() =>
                        setSelected((s) => (s.includes(d.name) ? s.filter((n) => n !== d.name) : [...s, d.name]))
                      }
                    />
                  ) : null}
                </Td>
                <Td>
                  <Link
                    to="/db/$db"
                    params={{ db: d.name }}
                    className="font-medium text-blue-700 hover:underline dark:text-blue-300"
                  >
                    {d.name}
                  </Link>
                </Td>
                <Td className="whitespace-nowrap text-right tabular-nums">
                  {d.sizeBytes === null ? '–' : locale.common.bytes(d.sizeBytes)}
                </Td>
                {session.dialect === 'mysql' ? (
                  <Td className="text-right tabular-nums">{d.tableCount === null ? '–' : d.tableCount}</Td>
                ) : null}
                <Td className="space-x-2 whitespace-nowrap" data-print-hide>
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
      {chosen.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-line bg-surface-sub px-3 py-2 text-sm">
          <span>{locale.server.selectedDatabases(chosen.length)}</span>
          <Button
            size="sm"
            variant="danger"
            aria-haspopup="dialog"
            onClick={() => dropFlow.preview({ op: 'dropDatabases', names: chosen })}
          >
            {locale.server.dropSelected}
          </Button>
        </div>
      ) : null}
      <div className="mt-6">
        <CreateDatabaseForm database={session.serverDatabase} kind="database" />
      </div>
    </>
  )
}
