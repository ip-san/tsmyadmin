import type { Dialect, UserOp } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { PasswordFields, usePasswordConfirm } from './PasswordFields.tsx'

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
  const pw = usePasswordConfirm()
  const [superuser, setSuperuser] = useState(false)
  const [createdb, setCreatedb] = useState(false)
  const [createrole, setCreaterole] = useState(false)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || pw.mismatch) return
    onSubmit({
      op: 'createUser',
      user: dialect === 'mysql' ? { name: name.trim(), host: host.trim() || '%' } : { name: name.trim() },
      password: pw.password,
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
        <PasswordFields state={pw} idPrefix="user" />
      </div>
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
        <Button type="submit" variant="primary" disabled={!name.trim() || pw.mismatch}>
          {locale.ddl.submit}
        </Button>
      </div>
    </form>
  )
}
