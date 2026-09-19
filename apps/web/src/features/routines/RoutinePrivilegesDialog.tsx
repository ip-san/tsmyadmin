import { useQuery } from '@tanstack/react-query'
import type { Dialect, RoutineInfo, RoutinePrivilege, UserOp } from '@tsmyadmin/shared'
import { useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { Spinner } from '@/components/ui/Feedback.tsx'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { usersQuery } from '@/lib/queries.ts'
import { userLabel, userRef } from '@/lib/user-ops.ts'
import { signatureOf } from './routine-signature.ts'

const t = locale.routines

/** Grant or revoke privileges on this routine to an account (the account list needs read access to the accounts). */
export function RoutinePrivilegesDialog({
  routine,
  dialect,
  db,
  schema,
  onSubmit,
  onClose,
}: {
  routine: RoutineInfo & { kind: 'procedure' | 'function' }
  dialect: Dialect
  db: string
  schema: string | undefined
  onSubmit: (op: UserOp) => void
  onClose: () => void
}) {
  const users = useQuery(usersQuery)
  const accounts = (users.data ?? []).map(userRef)
  const [chosen, setChosen] = useState('')
  const [typed, setTyped] = useState('')
  const [privileges, setPrivileges] = useState<RoutinePrivilege[]>(['EXECUTE'])
  const options: RoutinePrivilege[] = dialect === 'mysql' ? ['EXECUTE', 'ALTER ROUTINE', 'GRANT OPTION'] : ['EXECUTE']
  const account = accounts.find((a) => userLabel(a) === (chosen || (accounts[0] ? userLabel(accounts[0]) : '')))
  const user =
    account ??
    (typed.trim() ? (dialect === 'mysql' ? { name: typed.trim(), host: '%' } : { name: typed.trim() }) : null)
  const parameters = signatureOf(dialect, routine.parameters)
  const submit = (op: 'grantRoutinePrivileges' | 'revokeRoutinePrivileges') => {
    if (!user || privileges.length === 0) return
    onClose()
    onSubmit({
      op,
      user,
      privileges,
      database: db,
      ...(schema ? { schema } : {}),
      routine: routine.name,
      kind: routine.kind === 'function' ? 'FUNCTION' : 'PROCEDURE',
      ...(parameters !== undefined ? { parameters } : {}),
    })
  }
  return (
    <Dialog open title={`${routine.name}: ${t.privileges}`} onClose={onClose}>
      <form onSubmit={(e) => e.preventDefault()} className="space-y-3" aria-label={`${routine.name}: ${t.privileges}`}>
        <p className="text-xs text-ink-sub">{t.privilegesHint}</p>
        {users.isPending ? (
          <Spinner />
        ) : accounts.length > 0 ? (
          <Field id="routine-account" label={t.account}>
            <Select
              id="routine-account"
              value={chosen || userLabel(accounts[0] ?? { name: '' })}
              onChange={(e) => setChosen(e.target.value)}
            >
              {accounts.map((a) => (
                <option key={userLabel(a)} value={userLabel(a)}>
                  {userLabel(a)}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field id="routine-account-name" label={t.account}>
            <Input
              id="routine-account-name"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
            />
          </Field>
        )}
        <fieldset className="space-y-3">
          <legend className="text-xs text-ink-sub">{t.privilegeList}</legend>
          {options.map((p) => (
            <label key={p} className="flex items-center gap-1 font-mono text-xs text-ink">
              <input
                type="checkbox"
                checked={privileges.includes(p)}
                onChange={(e) =>
                  setPrivileges(e.target.checked ? [...privileges, p] : privileges.filter((x) => x !== p))
                }
              />
              {p}
            </label>
          ))}
        </fieldset>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="primary"
            disabled={!user || privileges.length === 0}
            aria-haspopup="dialog"
            onClick={() => submit('grantRoutinePrivileges')}
          >
            {t.grant}
          </Button>
          <Button
            type="button"
            disabled={!user || privileges.length === 0}
            aria-haspopup="dialog"
            onClick={() => submit('revokeRoutinePrivileges')}
          >
            {t.revoke}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
