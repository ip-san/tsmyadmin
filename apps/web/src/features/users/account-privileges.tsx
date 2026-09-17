import { useQueries, useQuery } from '@tanstack/react-query'
import type { UserGrants, UserRef } from '@tsmyadmin/shared'
import { useState } from 'react'
import { UserOpPreviewDialog } from '@/components/ddl/UserOpPreviewDialog.tsx'
import { grantsQuery, usersQuery } from '@/lib/queries.ts'
import { userRef, useUserOpFlow } from '@/lib/user-ops.ts'
import { PrivilegeChooser } from './PrivilegeChooser.tsx'

/**
 * The accounts that can log in, and what `select` makes of each one's grants in this database (one request per
 * account, cached). `select` must be stable (useCallback) so its result stays memoised across renders.
 */
export function useAccountGrants<T>(db: string, schema: string | undefined, select: (g: UserGrants) => T) {
  const users = useQuery(usersQuery)
  const logins = (users.data ?? []).filter((u) => u.canLogin)
  const grants = useQueries({
    queries: logins.map((u) => ({ ...grantsQuery(userRef(u), { database: db, schema }), select })),
  })
  return { users, logins, grants }
}

/**
 * The privilege chooser and the preview it leads to, for a page listing accounts. `choose` opens the chooser for
 * one account; `dialogs` goes at the end of the page.
 */
export function usePrivilegeDialogs(db: string, schema: string | undefined, table?: string) {
  const flow = useUserOpFlow()
  const [choosing, setChoosing] = useState<{ user: UserRef; label: string } | null>(null)
  const dialogs = (
    <>
      {choosing ? (
        <PrivilegeChooser
          user={choosing.user}
          label={choosing.label}
          db={db}
          schema={schema}
          {...(table === undefined ? {} : { initialTable: table })}
          onClose={() => setChoosing(null)}
          onSubmit={(op) => {
            setChoosing(null)
            flow.preview(op)
          }}
        />
      ) : null}
      <UserOpPreviewDialog flow={flow} />
    </>
  )
  return { flow, choose: (user: UserRef, label: string) => setChoosing({ user, label }), dialogs }
}
