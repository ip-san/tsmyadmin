import { useQuery } from '@tanstack/react-query'
import type { Dialect, UserRef } from '@tsmyadmin/shared'
import { useState } from 'react'
import { UserOpPreviewDialog } from '@/components/ddl/UserOpPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { Badge, ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { grantsQuery, usersQuery } from '@/lib/queries.ts'
import { userLabel, userRef, useUserOpFlow } from '@/lib/user-ops.ts'
import { PasswordForm } from './PasswordForm.tsx'
import { UserForm } from './UserForm.tsx'

function GrantsPanel({ user }: { user: UserRef }) {
  const grants = useQuery(grantsQuery(user))
  if (grants.isPending) return <Spinner />
  if (grants.isError) return <ErrorBox error={grants.error} />
  if (grants.data.statements.length === 0) return <Notice>{locale.users.noGrants}</Notice>
  return (
    <pre
      aria-label={`${userLabel(user)}: ${locale.users.grants}`}
      className="overflow-x-auto rounded border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-950"
    >
      {grants.data.statements.map((s) => `${s};`).join('\n')}
    </pre>
  )
}

export function UsersPage({ dialect }: { dialect: Dialect }) {
  const users = useQuery(usersQuery)
  const flow = useUserOpFlow()
  const [creating, setCreating] = useState(false)
  const [passwordFor, setPasswordFor] = useState<UserRef | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  if (users.isPending) return <Spinner />
  if (users.isError)
    return (
      <div className="space-y-2">
        <Notice>{locale.users.cannotLoad}</Notice>
        <ErrorBox error={users.error} />
      </div>
    )
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{locale.users.title}</h2>
        <Button size="sm" onClick={() => setCreating(true)}>
          {locale.users.create}
        </Button>
      </div>
      <Table>
        <thead>
          <tr>
            <Th>{locale.users.name}</Th>
            {dialect === 'mysql' ? <Th>{locale.users.host}</Th> : null}
            <Th>{locale.users.login}</Th>
            <Th>{locale.users.attributes}</Th>
            <Th>{locale.ddl.actions}</Th>
          </tr>
        </thead>
        <tbody>
          {users.data.map((u) => {
            const r = userRef(u)
            const key = userLabel(r)
            return (
              <Tr key={key}>
                <Td className="font-medium">{u.name}</Td>
                {dialect === 'mysql' ? <Td className="font-mono text-xs">{u.host}</Td> : null}
                <Td>{u.canLogin ? locale.common.yes : locale.common.no}</Td>
                <Td className="space-x-1">
                  {u.attributes.map((a) => (
                    <Badge key={a} tone={a === 'SUPERUSER' ? 'warn' : 'neutral'}>
                      {a}
                    </Badge>
                  ))}
                  {expanded === key ? (
                    <div className="mt-2">
                      <GrantsPanel user={r} />
                    </div>
                  ) : null}
                </Td>
                <Td className="whitespace-nowrap space-x-1">
                  <Button
                    size="sm"
                    onClick={() => setExpanded(expanded === key ? null : key)}
                    aria-label={`${key}: ${locale.users.showGrants}`}
                    aria-expanded={expanded === key}
                  >
                    {locale.users.showGrants}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => setPasswordFor(r)}
                    aria-label={`${key}: ${locale.users.changePassword}`}
                  >
                    {locale.users.changePassword}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => flow.preview({ op: 'dropUser', user: r })}
                    aria-label={`${key}: ${locale.users.drop}`}
                  >
                    {locale.users.drop}
                  </Button>
                </Td>
              </Tr>
            )
          })}
        </tbody>
      </Table>
      <Dialog open={creating} title={locale.users.create} onClose={() => setCreating(false)}>
        {creating ? (
          <UserForm
            dialect={dialect}
            onCancel={() => setCreating(false)}
            onSubmit={(op) => {
              setCreating(false)
              flow.preview(op)
            }}
          />
        ) : null}
      </Dialog>
      <Dialog open={passwordFor !== null} title={locale.users.changePassword} onClose={() => setPasswordFor(null)}>
        {passwordFor ? (
          <PasswordForm
            onCancel={() => setPasswordFor(null)}
            onSubmit={(password) => {
              const user = passwordFor
              setPasswordFor(null)
              flow.preview({ op: 'setPassword', user, password })
            }}
          />
        ) : null}
      </Dialog>
      <UserOpPreviewDialog flow={flow} />
    </div>
  )
}
