import { useQuery } from '@tanstack/react-query'
import type { Dialect } from '@tsmyadmin/shared'
import { UserOpPreviewDialog } from '@/components/ddl/UserOpPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { usersQuery } from '@/lib/queries.ts'
import { userLabel, userRef, useUserOpFlow } from '@/lib/user-ops.ts'

export function PrivilegesPage({ db, schema, dialect }: { db: string; schema?: string | undefined; dialect: Dialect }) {
  const users = useQuery(usersQuery)
  const flow = useUserOpFlow()
  if (users.isPending) return <Spinner />
  if (users.isError) return <ErrorBox error={users.error} />
  const target = schema ? { database: db, schema } : { database: db }
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{locale.users.privilegesTitle(db)}</h2>
      <Notice>{locale.users.privilegesHint}</Notice>
      <Table>
        <thead>
          <tr>
            <Th>{locale.users.name}</Th>
            {dialect === 'mysql' ? <Th>{locale.users.host}</Th> : null}
            <Th>{locale.ddl.actions}</Th>
          </tr>
        </thead>
        <tbody>
          {users.data
            .filter((u) => u.canLogin)
            .map((u) => {
              const r = userRef(u)
              const key = userLabel(r)
              return (
                <Tr key={key}>
                  <Td className="font-medium">{u.name}</Td>
                  {dialect === 'mysql' ? <Td className="font-mono text-xs">{u.host}</Td> : null}
                  <Td className="whitespace-nowrap space-x-1">
                    <Button
                      size="sm"
                      onClick={() => flow.preview({ op: 'grantAll', user: r, ...target })}
                      aria-label={`${key}: ${locale.users.grantAll}`}
                    >
                      {locale.users.grantAll}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => flow.preview({ op: 'revokeAll', user: r, ...target })}
                      aria-label={`${key}: ${locale.users.revokeAll}`}
                    >
                      {locale.users.revokeAll}
                    </Button>
                  </Td>
                </Tr>
              )
            })}
        </tbody>
      </Table>
      <UserOpPreviewDialog flow={flow} />
    </div>
  )
}
