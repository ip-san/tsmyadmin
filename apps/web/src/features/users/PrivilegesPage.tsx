import { useQueries, useQuery } from '@tanstack/react-query'
import type { Dialect, UserGrants } from '@tsmyadmin/shared'
import { UserOpPreviewDialog } from '@/components/ddl/UserOpPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Badge, ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { grantsQuery, usersQuery } from '@/lib/queries.ts'
import { userLabel, userRef, useUserOpFlow } from '@/lib/user-ops.ts'
import { privilegeLevel } from './privilege-level.ts'

export function PrivilegesPage({ db, schema, dialect }: { db: string; schema?: string | undefined; dialect: Dialect }) {
  const users = useQuery(usersQuery)
  const flow = useUserOpFlow()
  const logins = (users.data ?? []).filter((u) => u.canLogin)
  // Current grants per account so the page shows who already has access (one request per account, cached).
  // One request per account; the level is derived inside `select` so it is memoised per query, not per render.
  const grants = useQueries({
    queries: logins.map((u) => ({
      ...grantsQuery(userRef(u), { database: db, schema }),
      select: (g: UserGrants) => privilegeLevel(dialect, db, schema, g.statements),
    })),
  })
  if (users.isPending) return <Spinner />
  if (users.isError) return <ErrorBox error={users.error} onRetry={() => void users.refetch()} />
  const target = schema ? { database: db, schema } : { database: db }
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
        {locale.users.privilegesTitle(db, schema)}
      </h2>
      <Notice>{locale.users.privilegesHint}</Notice>
      <Table>
        <thead>
          <tr>
            <Th>{locale.users.name}</Th>
            {dialect === 'mysql' ? <Th>{locale.users.host}</Th> : null}
            <Th>{locale.users.currentPrivileges}</Th>
            <Th>{locale.ddl.actions}</Th>
          </tr>
        </thead>
        <tbody>
          {logins.map((u, i) => {
            const r = userRef(u)
            const key = userLabel(r)
            const g = grants[i]
            const level = g?.data ?? null
            return (
              <Tr key={key}>
                <Td className="font-medium">{u.name}</Td>
                {dialect === 'mysql' ? <Td className="font-mono text-xs">{u.host}</Td> : null}
                <Td>
                  {level === null ? (
                    g?.isError ? (
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">{locale.common.unknown}</span>
                    ) : (
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">…</span>
                    )
                  ) : (
                    <Badge tone={level === 'all' ? 'info' : level === 'some' ? 'warn' : 'neutral'}>
                      {locale.users.levels[level]}
                    </Badge>
                  )}
                </Td>
                <Td className="whitespace-nowrap space-x-1">
                  <Button
                    size="sm"
                    disabled={level === 'all'}
                    aria-haspopup="dialog"
                    onClick={() => flow.preview({ op: 'grantAll', user: r, ...target })}
                    aria-label={`${key}: ${locale.users.grantAll}`}
                  >
                    {locale.users.grantAll}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={level === 'none'}
                    aria-haspopup="dialog"
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
