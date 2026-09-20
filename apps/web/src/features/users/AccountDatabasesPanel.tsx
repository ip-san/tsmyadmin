import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Dialect, UserOp, UserRef } from '@tsmyadmin/shared'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { grantsQuery } from '@/lib/queries.ts'
import { userLabel } from '@/lib/user-ops.ts'
import { databaseGrants, grantDatabase, revokeOp } from './database-grants.ts'

const KIND = () => locale.users.databases.kind

export function AccountDatabasesPanel({
  user,
  dialect,
  database,
  onRevoke,
}: {
  user: UserRef
  dialect: Dialect
  /** The database the session is connected to: PostgreSQL lists only that one. */
  database: string
  onRevoke: (op: UserOp) => void
}) {
  const grants = useQuery(grantsQuery(user))
  if (grants.isPending) return <Spinner />
  if (grants.isError) return <ErrorBox error={grants.error} onRetry={() => void grants.refetch()} />
  const rows = databaseGrants(dialect, grants.data.statements)
  const t = locale.users.databases
  return (
    <div className="space-y-1">
      <h3 className="text-xs font-semibold text-ink">{t.title}</h3>
      {dialect === 'postgres' ? <Notice>{t.postgresNote(database)}</Notice> : null}
      {rows.length === 0 ? (
        <Notice>{t.none}</Notice>
      ) : (
        <Table aria-label={`${userLabel(user)}: ${t.title}`}>
          <thead>
            <tr>
              <Th>{t.database}</Th>
              <Th>{t.object}</Th>
              <Th>{t.privileges}</Th>
              <Th>{t.grantOption}</Th>
              <Th data-print-hide>{locale.ddl.actions}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => {
              const db = dialect === 'mysql' ? grantDatabase(g) : database
              const op = revokeOp(user, dialect, g, database)
              const name = `${g.database ?? database}${g.schema ? `.${g.schema}` : ''}${g.object ? `.${g.object}` : ''}`
              return (
                <Tr key={`${g.kind}:${name}`}>
                  <Td className="font-mono text-xs">{g.database ?? `${database}.${g.schema}`}</Td>
                  <Td className="text-xs">{g.object ?? KIND()[g.kind]}</Td>
                  <Td className="font-mono text-xs">{g.privileges.join(', ')}</Td>
                  <Td>{g.grantOption ? locale.common.yes : locale.common.no}</Td>
                  <Td data-print-hide className="whitespace-nowrap space-x-1">
                    {db !== null ? (
                      <Link
                        to="/db/$db/privileges"
                        params={{ db }}
                        search={g.schema ? { schema: g.schema } : {}}
                        className="text-xs text-blue-700 hover:underline dark:text-blue-300"
                        aria-label={`${name}: ${t.edit}`}
                      >
                        {t.edit}
                      </Link>
                    ) : null}
                    {op ? (
                      <Button
                        size="sm"
                        variant="danger"
                        aria-haspopup="dialog"
                        aria-label={`${name}: ${t.revoke}`}
                        onClick={() => onRevoke(op)}
                      >
                        {t.revoke}
                      </Button>
                    ) : null}
                  </Td>
                </Tr>
              )
            })}
          </tbody>
        </Table>
      )}
    </div>
  )
}
