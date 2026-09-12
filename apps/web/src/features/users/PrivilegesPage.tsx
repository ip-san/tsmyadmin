import { useQueries, useQuery } from '@tanstack/react-query'
import type { Dialect, Privilege, UserGrants, UserOp, UserRef } from '@tsmyadmin/shared'
import { PRIVILEGES } from '@tsmyadmin/shared'
import { useCallback, useState } from 'react'
import { UserOpPreviewDialog } from '@/components/ddl/UserOpPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { Badge, ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Field, Select } from '@/components/ui/Field.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { grantsQuery, tablesQuery, usersQuery } from '@/lib/queries.ts'
import { userLabel, userRef, useUserOpFlow } from '@/lib/user-ops.ts'
import { globalPrivilegeLevel, privilegeLevel } from './privilege-level.ts'

/**
 * Picks privileges and an optional table, then goes through the same preview → execute flow as everything else.
 * The privilege names come from a closed list in `packages/shared`, so nothing typed here reaches SQL.
 */
function PrivilegeChooser({
  user,
  label,
  db,
  schema,
  onSubmit,
  onClose,
}: {
  user: UserRef
  label: string
  db: string
  schema?: string | undefined
  onSubmit: (op: UserOp) => void
  onClose: () => void
}) {
  const tables = useQuery(tablesQuery(db, schema))
  const [chosen, setChosen] = useState<Privilege[]>(['SELECT'])
  const [table, setTable] = useState('')
  const target = {
    user,
    privileges: chosen,
    database: db,
    ...(schema ? { schema } : {}),
    ...(table ? { table } : {}),
  }
  return (
    <Dialog
      open
      title={locale.users.choosePrivileges(label)}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{locale.common.cancel}</Button>
          <Button
            variant="danger"
            disabled={chosen.length === 0}
            aria-haspopup="dialog"
            onClick={() => onSubmit({ op: 'revokePrivileges', ...target })}
          >
            {locale.users.ops.revokePrivileges}
          </Button>
          <Button
            variant="primary"
            disabled={chosen.length === 0}
            aria-haspopup="dialog"
            onClick={() => onSubmit({ op: 'grantPrivileges', ...target })}
          >
            {locale.users.ops.grantPrivileges}
          </Button>
        </>
      }
    >
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium text-zinc-700 dark:text-zinc-200">{locale.users.privileges}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {PRIVILEGES.map((p) => (
            <label key={p} className="flex items-center gap-2 py-1 text-sm">
              <input
                type="checkbox"
                checked={chosen.includes(p)}
                onChange={(e) => setChosen((c) => (e.target.checked ? [...c, p] : c.filter((x) => x !== p)))}
              />
              {p}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-3">
        <Field id="priv-table" label={locale.users.privilegeTarget}>
          <Select id="priv-table" value={table} onChange={(e) => setTable(e.target.value)}>
            <option value="">{locale.users.wholeDatabase}</option>
            {(tables.data ?? [])
              .filter((t) => t.kind === 'table')
              .map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
          </Select>
        </Field>
      </div>
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{locale.users.privilegesNote}</p>
    </Dialog>
  )
}

export function PrivilegesPage({ db, schema, dialect }: { db: string; schema?: string | undefined; dialect: Dialect }) {
  const users = useQuery(usersQuery)
  const flow = useUserOpFlow()
  const [choosing, setChoosing] = useState<{ user: UserRef; label: string } | null>(null)
  const logins = (users.data ?? []).filter((u) => u.canLogin)
  // Current grants per account so the page shows who already has access (one request per account, cached).
  // One request per account; the level is derived inside `select` so it is memoised per query, not per render.
  // A stable `select` keeps its result memoised across renders (a new function each render would re-run it).
  const selectLevels = useCallback(
    (g: UserGrants) => ({
      level: privilegeLevel(dialect, db, schema, g.statements),
      global: dialect === 'mysql' ? globalPrivilegeLevel(g.statements) : null,
    }),
    [dialect, db, schema]
  )
  const grants = useQueries({
    queries: logins.map((u) => ({ ...grantsQuery(userRef(u), { database: db, schema }), select: selectLevels })),
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
            const level = g?.data?.level ?? null
            const global = g?.data?.global ?? null
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
                    <>
                      <Badge tone={level === 'all' ? 'info' : level === 'some' ? 'warn' : 'neutral'}>
                        {locale.users.levels[level]}
                      </Badge>
                      {global ? (
                        <>
                          {' '}
                          <Badge tone="neutral" title={locale.users.globalGrantHint}>
                            {locale.users.globalGrant}
                          </Badge>
                        </>
                      ) : null}
                    </>
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
                  <Button
                    size="sm"
                    aria-haspopup="dialog"
                    onClick={() => setChoosing({ user: r, label: key })}
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
      {choosing ? (
        <PrivilegeChooser
          user={choosing.user}
          label={choosing.label}
          db={db}
          schema={schema}
          onClose={() => setChoosing(null)}
          onSubmit={(op) => {
            setChoosing(null)
            flow.preview(op)
          }}
        />
      ) : null}
      <UserOpPreviewDialog flow={flow} />
    </div>
  )
}
