import { useQuery } from '@tanstack/react-query'
import { GLOBAL_PRIVILEGES, type GlobalPrivilege, type UserInfo, type UserOp, type UserRef } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { grantsQuery } from '@/lib/queries.ts'
import { userLabel } from '@/lib/user-ops.ts'
import { Buttons } from './AccountDialogs.tsx'
import { globalPrivilegeChange, heldGlobalPrivileges } from './global-privileges.ts'

const t = locale.users.account

/** MySQL: each global privilege as a box, from what the account holds now; only the differences are sent. */
export function GlobalPrivilegesForm({
  user,
  onSubmit,
  onCancel,
}: {
  user: UserRef
  onSubmit: (op: UserOp) => void
  onCancel: () => void
}) {
  const grants = useQuery(grantsQuery(user))
  if (grants.isPending) return <Spinner />
  if (grants.isError) return <ErrorBox error={grants.error} onRetry={() => void grants.refetch()} />
  return (
    <GlobalPrivilegesBoxes
      user={user}
      held={heldGlobalPrivileges(grants.data.statements)}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  )
}

function GlobalPrivilegesBoxes({
  user,
  held,
  onSubmit,
  onCancel,
}: {
  user: UserRef
  held: ReadonlySet<GlobalPrivilege>
  onSubmit: (op: UserOp) => void
  onCancel: () => void
}) {
  const [chosen, setChosen] = useState<ReadonlySet<GlobalPrivilege>>(held)
  const change = globalPrivilegeChange(held, chosen)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (change.grant.length + change.revoke.length > 0) onSubmit({ op: 'changeGlobalPrivileges', user, ...change })
  }
  const toggle = (p: GlobalPrivilege, on: boolean) => {
    const next = new Set(chosen)
    if (on) next.add(p)
    else next.delete(p)
    setChosen(next)
  }
  return (
    <form onSubmit={submit} className="space-y-3" aria-label={`${userLabel(user)}: ${t.globalPrivileges}`}>
      <p className="text-xs text-ink-sub">{t.globalHint}</p>
      <fieldset className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        <legend className="sr-only">{t.globalPrivileges}</legend>
        {GLOBAL_PRIVILEGES.map((p) => (
          <label key={p} className="flex items-center gap-1 font-mono text-xs text-ink">
            <input type="checkbox" checked={chosen.has(p)} onChange={(e) => toggle(p, e.target.checked)} />
            {p}
          </label>
        ))}
      </fieldset>
      <Buttons ready={change.grant.length + change.revoke.length > 0} onCancel={onCancel} />
    </form>
  )
}

const ROLE_FLAGS = ['superuser', 'createdb', 'createrole', 'replication', 'bypassrls', 'inherit', 'login'] as const
type RoleFlag = (typeof ROLE_FLAGS)[number]

/** PostgreSQL: a role's attributes. What the list shows (`SUPERUSER`, `NOLOGIN`…) is where the boxes start. */
export function RoleAttributesForm({
  user,
  info,
  onSubmit,
  onCancel,
}: {
  user: UserRef
  info: UserInfo
  onSubmit: (op: UserOp) => void
  onCancel: () => void
}) {
  const start: Record<RoleFlag, boolean> = {
    superuser: info.attributes.includes('SUPERUSER'),
    createdb: info.attributes.includes('CREATEDB'),
    createrole: info.attributes.includes('CREATEROLE'),
    replication: info.attributes.includes('REPLICATION'),
    bypassrls: info.attributes.includes('BYPASSRLS'),
    inherit: !info.attributes.includes('NOINHERIT'),
    login: info.canLogin,
  }
  const [flags, setFlags] = useState(start)
  const changed = ROLE_FLAGS.filter((f) => flags[f] !== start[f])
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (changed.length > 0)
      onSubmit({ op: 'alterRole', user, ...Object.fromEntries(changed.map((f) => [f, flags[f]])) })
  }
  return (
    <form onSubmit={submit} className="space-y-3" aria-label={`${userLabel(user)}: ${t.roleAttributes}`}>
      <p className="text-xs text-ink-sub">{t.roleHint}</p>
      <fieldset className="space-y-3">
        <legend className="sr-only">{t.roleAttributes}</legend>
        {ROLE_FLAGS.map((f) => (
          <label key={f} className="flex items-center gap-1 font-mono text-xs text-ink">
            <input type="checkbox" checked={flags[f]} onChange={(e) => setFlags({ ...flags, [f]: e.target.checked })} />
            {f.toUpperCase()}
          </label>
        ))}
      </fieldset>
      <Buttons ready={changed.length > 0} onCancel={onCancel} />
    </form>
  )
}
