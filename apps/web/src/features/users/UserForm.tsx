import type { Dialect, UserOp } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Notice } from '@/components/ui/Feedback.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'

export function UserForm({
  dialect,
  onSubmit,
  onCancel,
}: {
  dialect: Dialect
  onSubmit: (op: UserOp) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [host, setHost] = useState('%')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [superuser, setSuperuser] = useState(false)
  const [createdb, setCreatedb] = useState(false)
  const [createrole, setCreaterole] = useState(false)
  const mismatch = password !== confirm
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || mismatch) return
    onSubmit({
      op: 'createUser',
      user: dialect === 'mysql' ? { name: name.trim(), host: host.trim() || '%' } : { name: name.trim() },
      password,
      attributes: { superuser, createdb, createrole },
    })
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field id="user-name" label={locale.users.name}>
          <Input id="user-name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="off" />
        </Field>
        {dialect === 'mysql' ? (
          <Field id="user-host" label={locale.users.host} hint={locale.users.anyHost}>
            <Input id="user-host" value={host} onChange={(e) => setHost(e.target.value)} />
          </Field>
        ) : null}
        <Field id="user-password" label={locale.users.password}>
          <Input
            id="user-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
        <Field id="user-password2" label={locale.users.passwordConfirm}>
          <Input
            id="user-password2"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
      </div>
      {mismatch ? <Notice>{locale.users.passwordMismatch}</Notice> : null}
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={superuser} onChange={(e) => setSuperuser(e.target.checked)} />
          {locale.users.superuser}
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={createdb} onChange={(e) => setCreatedb(e.target.checked)} />
          {locale.users.createdb}
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={createrole} onChange={(e) => setCreaterole(e.target.checked)} />
          {locale.users.createrole}
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{locale.common.cancel}</Button>
        <Button type="submit" variant="primary" disabled={!name.trim() || mismatch}>
          {locale.ddl.submit}
        </Button>
      </div>
    </form>
  )
}
