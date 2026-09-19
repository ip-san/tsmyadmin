import { useQuery } from '@tanstack/react-query'
import { AUTH_PLUGINS, type Dialect, type UserOp } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { PasswordFields, usePasswordConfirm } from '@/components/forms/PasswordFields.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { serverInfoQuery } from '@/lib/queries.ts'

type HostChoice = 'any' | 'local' | 'this' | 'custom'

export function UserForm({
  dialect,
  onSubmit,
  onCancel,
}: {
  dialect: Dialect
  onSubmit: (op: UserOp) => void
  onCancel: () => void
}) {
  const info = useQuery(serverInfoQuery).data
  const thisHost = info?.extra.hostname ?? ''
  // MariaDB spells the password plugin differently (`IDENTIFIED VIA …`): it keeps its default.
  const offersPlugin = dialect === 'mysql' && info !== undefined && !/mariadb/i.test(info.version)
  const [name, setName] = useState('')
  const [hostChoice, setHostChoice] = useState<HostChoice>('any')
  const [customHost, setCustomHost] = useState('')
  const [plugin, setPlugin] = useState<(typeof AUTH_PLUGINS)[number] | ''>('')
  const [createDatabase, setCreateDatabase] = useState(false)
  const [grantWildcard, setGrantWildcard] = useState(false)
  const pw = usePasswordConfirm()
  const [superuser, setSuperuser] = useState(false)
  const [createdb, setCreatedb] = useState(false)
  const [createrole, setCreaterole] = useState(false)
  const host = { any: '%', local: 'localhost', this: thisHost, custom: customHost.trim() }[hostChoice] || '%'
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !pw.complete) return
    onSubmit({
      op: 'createUser',
      user: dialect === 'mysql' ? { name: name.trim(), host } : { name: name.trim() },
      password: pw.password,
      attributes: { superuser, createdb, createrole },
      ...(dialect === 'mysql' && offersPlugin && plugin ? { plugin } : {}),
      ...(dialect === 'mysql' && createDatabase ? { createDatabase } : {}),
      ...(dialect === 'mysql' && grantWildcard ? { grantWildcard } : {}),
    })
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field id="user-name" label={locale.users.name}>
          <Input id="user-name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="off" />
        </Field>
        {dialect === 'mysql' ? (
          <Field id="user-host-choice" label={locale.users.host}>
            <Select
              id="user-host-choice"
              value={hostChoice}
              onChange={(e) => setHostChoice(e.target.value as HostChoice)}
            >
              <option value="any">{locale.users.anyHost}</option>
              <option value="local">{locale.users.localHost}</option>
              {thisHost ? <option value="this">{locale.users.thisHost(thisHost)}</option> : null}
              <option value="custom">{locale.users.customHost}</option>
            </Select>
          </Field>
        ) : null}
        {dialect === 'mysql' && hostChoice === 'custom' ? (
          <Field id="user-host" label={locale.users.customHost} hint={locale.users.hostPattern}>
            <Input
              id="user-host"
              value={customHost}
              onChange={(e) => setCustomHost(e.target.value)}
              autoComplete="off"
            />
          </Field>
        ) : null}
        {offersPlugin ? (
          <Field id="user-plugin" label={locale.users.plugin}>
            <Select id="user-plugin" value={plugin} onChange={(e) => setPlugin(e.target.value as typeof plugin)}>
              <option value="">{locale.users.pluginDefault}</option>
              {AUTH_PLUGINS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
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
      {dialect === 'mysql' ? (
        <div className="space-y-1 text-sm">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={createDatabase} onChange={(e) => setCreateDatabase(e.target.checked)} />
            {locale.users.createDatabase}
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={grantWildcard} onChange={(e) => setGrantWildcard(e.target.checked)} />
            {locale.users.grantWildcard}
          </label>
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{locale.common.cancel}</Button>
        <Button type="submit" variant="primary" disabled={!name.trim() || !pw.complete}>
          {locale.ddl.submit}
        </Button>
      </div>
    </form>
  )
}
