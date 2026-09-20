import { useQuery } from '@tanstack/react-query'
import type { Dialect, UserInfo, UserOp, UserRef } from '@tsmyadmin/shared'
import { useState } from 'react'
import { UserOpPreviewDialog } from '@/components/ddl/UserOpPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { Badge, ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { downloadText, safeFilename } from '@/lib/download.ts'
import { grantsQuery, sessionQuery, usersQuery } from '@/lib/queries.ts'
import { userLabel, userRef, useUserOpFlow } from '@/lib/user-ops.ts'
import { AccountDatabasesPanel } from './AccountDatabasesPanel.tsx'
import { CopyForm, LimitsForm, RenameForm } from './AccountDialogs.tsx'
import { BulkDropBar } from './BulkDropBar.tsx'
import { PasswordForm } from './PasswordForm.tsx'
import { GlobalPrivilegesForm, RoleAttributesForm } from './PrivilegeForms.tsx'
import { SecondFactorResetDialog, useResettableAccounts } from './SecondFactorReset.tsx'
import { UserForm } from './UserForm.tsx'

function GrantsPanel({ user }: { user: UserRef }) {
  const grants = useQuery(grantsQuery(user))
  if (grants.isPending) return <Spinner />
  if (grants.isError) return <ErrorBox error={grants.error} onRetry={() => void grants.refetch()} />
  if (grants.data.statements.length === 0) return <Notice>{locale.users.noGrants}</Notice>
  const script = grants.data.statements.map((s) => `${s};`).join('\n')
  return (
    <div className="space-y-1">
      <pre
        aria-label={`${userLabel(user)}: ${locale.users.grants}`}
        className="max-w-3xl whitespace-pre-wrap [overflow-wrap:anywhere] rounded border border-line bg-surface-sub p-3 font-mono text-xs"
      >
        {script}
      </pre>
      <Button
        size="sm"
        onClick={() =>
          downloadText(safeFilename(`${userLabel(user)}-grants`, 'sql'), `${script}\n`, 'application/sql;charset=utf-8')
        }
      >
        {locale.users.account.exportGrants}
      </Button>
    </div>
  )
}

type AccountDialogKind = 'rename' | 'copy' | 'limits' | 'global' | 'role'

const accountTitle = (kind: AccountDialogKind) =>
  locale.users.account[kind === 'global' ? 'globalPrivileges' : kind === 'role' ? 'roleAttributes' : kind]

function AccountForm({
  kind,
  info,
  dialect,
  onSubmit,
  onCancel,
}: {
  kind: AccountDialogKind
  info: UserInfo
  dialect: Dialect
  onSubmit: (op: UserOp) => void
  onCancel: () => void
}) {
  const user = userRef(info)
  const mysql = dialect === 'mysql'
  if (kind === 'rename') return <RenameForm user={user} mysql={mysql} onSubmit={onSubmit} onCancel={onCancel} />
  if (kind === 'copy') return <CopyForm user={user} mysql={mysql} onSubmit={onSubmit} onCancel={onCancel} />
  if (kind === 'limits')
    return <LimitsForm user={user} limits={info.limits} mysql={mysql} onSubmit={onSubmit} onCancel={onCancel} />
  if (kind === 'global') return <GlobalPrivilegesForm user={user} onSubmit={onSubmit} onCancel={onCancel} />
  return <RoleAttributesForm user={user} info={info} onSubmit={onSubmit} onCancel={onCancel} />
}

export function UsersPage({ dialect }: { dialect: Dialect }) {
  const users = useQuery(usersQuery)
  const session = useQuery(sessionQuery)
  const flow = useUserOpFlow()
  const [creating, setCreating] = useState(false)
  const [passwordFor, setPasswordFor] = useState<UserRef | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [resetFor, setResetFor] = useState<string | null>(null)
  const [ticked, setTicked] = useState<string[]>([])
  const [account, setAccount] = useState<{ kind: AccountDialogKind; info: UserInfo } | null>(null)
  const resettable = useResettableAccounts()
  if (users.isPending) return <Spinner />
  if (users.isError)
    return (
      <div className="space-y-2">
        <Notice>{locale.users.cannotLoad}</Notice>
        <ErrorBox error={users.error} onRetry={() => void users.refetch()} />
      </div>
    )
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-semibold text-ink">{locale.users.title}</h2>
        <Button size="sm" onClick={() => setCreating(true)}>
          {locale.users.create}
        </Button>
      </div>
      {dialect === 'postgres' ? <Notice>{locale.users.dropHint}</Notice> : null}
      <Table>
        <thead>
          <tr>
            <Th data-print-hide>
              <input
                type="checkbox"
                aria-label={locale.users.bulk.selectAll}
                checked={users.data.length > 0 && ticked.length === users.data.length}
                onChange={() =>
                  setTicked(ticked.length === users.data.length ? [] : users.data.map((u) => userLabel(userRef(u))))
                }
              />
            </Th>
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
                <Td data-print-hide>
                  <input
                    type="checkbox"
                    aria-label={locale.users.bulk.select(key)}
                    checked={ticked.includes(key)}
                    onChange={() => setTicked((t) => (t.includes(key) ? t.filter((k) => k !== key) : [...t, key]))}
                  />
                </Td>
                <Td className="font-medium">{u.name}</Td>
                {dialect === 'mysql' ? <Td className="font-mono text-xs">{u.host}</Td> : null}
                <Td>{u.canLogin ? locale.common.yes : locale.common.no}</Td>
                <Td className="space-x-1">
                  {resettable.has(u.name) ? <Badge tone="neutral">{locale.users.secondFactor.badge}</Badge> : null}
                  {u.attributes.map((a) => (
                    <Badge key={a} tone={a === 'SUPERUSER' ? 'warn' : 'neutral'}>
                      {a}
                    </Badge>
                  ))}
                  {expanded === key ? (
                    <div className="mt-2">
                      <GrantsPanel user={r} />
                      <div className="mt-3">
                        <AccountDatabasesPanel
                          user={r}
                          dialect={dialect}
                          database={session.data?.database ?? ''}
                          onRevoke={flow.preview}
                        />
                      </div>
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
                  {resettable.has(u.name) ? (
                    <Button
                      size="sm"
                      aria-haspopup="dialog"
                      onClick={() => setResetFor(u.name)}
                      aria-label={`${key}: ${locale.users.secondFactor.reset}`}
                    >
                      {locale.users.secondFactor.reset}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    aria-haspopup="dialog"
                    aria-label={`${key}: ${u.canLogin ? locale.users.account.lock : locale.users.account.unlock}`}
                    onClick={() => flow.preview({ op: 'lockUser', user: r, locked: u.canLogin })}
                  >
                    {u.canLogin ? locale.users.account.lock : locale.users.account.unlock}
                  </Button>
                  {(['rename', 'copy', 'limits', dialect === 'mysql' ? 'global' : 'role'] as const).map((kind) => (
                    <Button
                      key={kind}
                      size="sm"
                      aria-haspopup="dialog"
                      aria-label={`${key}: ${locale.users.account[kind === 'global' ? 'globalPrivileges' : kind === 'role' ? 'roleAttributes' : kind]}`}
                      onClick={() => setAccount({ kind, info: u })}
                    >
                      {
                        locale.users.account[
                          kind === 'global' ? 'globalPrivileges' : kind === 'role' ? 'roleAttributes' : kind
                        ]
                      }
                    </Button>
                  ))}
                  <Button
                    size="sm"
                    variant="danger"
                    aria-haspopup="dialog"
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
      <BulkDropBar
        users={users.data.filter((u) => ticked.includes(userLabel(userRef(u)))).map(userRef)}
        dialect={dialect}
        onPreview={(op) => {
          setTicked([])
          flow.preview(op)
        }}
      />
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
      <Dialog
        open={passwordFor !== null}
        title={passwordFor ? `${locale.users.changePassword}: ${userLabel(passwordFor)}` : ''}
        onClose={() => setPasswordFor(null)}
      >
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
      <Dialog
        open={account !== null}
        title={account ? `${accountTitle(account.kind)}: ${userLabel(userRef(account.info))}` : ''}
        onClose={() => setAccount(null)}
      >
        {account ? (
          <AccountForm
            kind={account.kind}
            info={account.info}
            dialect={dialect}
            onCancel={() => setAccount(null)}
            onSubmit={(op) => {
              setAccount(null)
              flow.preview(op)
            }}
          />
        ) : null}
      </Dialog>
      <SecondFactorResetDialog user={resetFor} onClose={() => setResetFor(null)} />
      <UserOpPreviewDialog flow={flow} />
    </div>
  )
}
