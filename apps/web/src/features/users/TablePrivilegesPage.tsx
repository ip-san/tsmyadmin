import type { Dialect, UserGrants } from '@tsmyadmin/shared'
import { PRIVILEGES } from '@tsmyadmin/shared'
import { useCallback } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Badge, ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { userLabel, userRef } from '@/lib/user-ops.ts'
import { useAccountGrants, usePrivilegeDialogs } from './account-privileges.tsx'
import { type Grant, tableAccess } from './table-access.ts'

const t = locale.tablePrivileges

function GrantBadges({ grants }: { grants: readonly Grant[] }) {
  if (grants.length === 0) return <span className="text-ink-faint">–</span>
  return (
    <span className="flex flex-wrap gap-1">
      {grants.map((g) =>
        g.scope === 'columns' ? (
          <Badge key={`columns:${JSON.stringify(g.columns)}`} tone="warn" title={t.scopeHints.columns}>
            {t.columns(g.columns.join(', '))}
          </Badge>
        ) : (
          <Badge key={g.scope} tone={g.scope === 'table' ? 'info' : 'neutral'} title={t.scopeHints[g.scope]}>
            {t.scopes[g.scope]}
          </Badge>
        )
      )}
    </span>
  )
}

/**
 * phpMyAdmin's table-level Privileges tab: who may do what to this table, privilege by privilege, and whether it
 * comes from the table, some of its columns, the database or the server. Changing it goes through the privilege
 * chooser with this table already picked, and from there through the usual preview.
 */
export function TablePrivilegesPage({
  db,
  schema,
  table,
  dialect,
}: {
  db: string
  schema?: string | undefined
  table: string
  dialect: Dialect
}) {
  const { choose, dialogs } = usePrivilegeDialogs(db, schema, table)
  const selectAccess = useCallback(
    (g: UserGrants) => tableAccess(dialect, db, schema, table, g.statements),
    [dialect, db, schema, table]
  )
  const { users, logins, grants } = useAccountGrants(db, schema, selectAccess)
  if (users.isPending) return <Spinner />
  if (users.isError) return <ErrorBox error={users.error} onRetry={() => void users.refetch()} />
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-ink">{t.title(table)}</h2>
      <Notice>{dialect === 'mysql' ? t.hintMysql : t.hintPostgres}</Notice>
      <Table aria-label={t.title(table)}>
        <thead>
          <tr>
            <Th>{locale.users.name}</Th>
            {dialect === 'mysql' ? <Th>{locale.users.host}</Th> : null}
            {PRIVILEGES.map((p) => (
              <Th key={p}>{p}</Th>
            ))}
            <Th>{locale.ddl.actions}</Th>
          </tr>
        </thead>
        <tbody>
          {logins.map((u, i) => {
            const r = userRef(u)
            const key = userLabel(r)
            const g = grants[i]
            return (
              <Tr key={key}>
                <Td className="font-medium">{u.name}</Td>
                {dialect === 'mysql' ? <Td className="font-mono text-xs">{u.host}</Td> : null}
                {PRIVILEGES.map((p) => (
                  <Td key={p} className="text-xs">
                    {g?.data ? (
                      <GrantBadges grants={g.data[p]} />
                    ) : (
                      <span className="text-ink-sub">{g?.isError ? locale.common.unknown : '…'}</span>
                    )}
                  </Td>
                ))}
                <Td>
                  <Button
                    size="sm"
                    aria-haspopup="dialog"
                    onClick={() => choose(r, key)}
                    aria-label={`${key}: ${locale.users.choose}`}
                  >
                    {locale.users.choose}
                  </Button>
                </Td>
              </Tr>
            )
          })}
        </tbody>
      </Table>
      {dialogs}
    </div>
  )
}
