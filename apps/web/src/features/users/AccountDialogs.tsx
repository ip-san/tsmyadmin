import { type AccountLimits, type UserOp, type UserRef } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { PasswordFields, usePasswordConfirm } from '@/components/forms/PasswordFields.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { userLabel } from '@/lib/user-ops.ts'

const t = locale.users.account

export function Buttons({ ready, onCancel }: { ready: boolean; onCancel: () => void }) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" onClick={onCancel}>
        {locale.common.cancel}
      </Button>
      <Button type="submit" variant="primary" disabled={!ready} aria-haspopup="dialog">
        {locale.ddl.submit}
      </Button>
    </div>
  )
}

/** The account's new name (and, on MySQL, host). */
export function RenameForm({
  user,
  mysql,
  onSubmit,
  onCancel,
}: {
  user: UserRef
  mysql: boolean
  onSubmit: (op: UserOp) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(user.name)
  const [host, setHost] = useState(user.host ?? '%')
  const next: UserRef = mysql ? { name: name.trim(), host: host.trim() || '%' } : { name: name.trim() }
  const changed = next.name !== '' && userLabel(next) !== userLabel(user)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (changed) onSubmit({ op: 'renameUser', user, newUser: next })
  }
  return (
    <form onSubmit={submit} className="space-y-3" aria-label={`${userLabel(user)}: ${t.rename}`}>
      <p className="text-xs text-ink-sub">{mysql ? t.renameHintMysql : t.renameHintPostgres}</p>
      <div className="grid grid-cols-2 gap-3">
        <Field id="rename-name" label={t.newName}>
          <Input id="rename-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </Field>
        {mysql ? (
          <Field id="rename-host" label={locale.users.host}>
            <Input id="rename-host" value={host} onChange={(e) => setHost(e.target.value)} autoComplete="off" />
          </Field>
        ) : null}
      </div>
      <Buttons ready={changed} onCancel={onCancel} />
    </form>
  )
}

/** A new account with the source's privileges, and a password of its own. */
export function CopyForm({
  user,
  mysql,
  onSubmit,
  onCancel,
}: {
  user: UserRef
  mysql: boolean
  onSubmit: (op: UserOp) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(`${user.name}_copy`)
  const [host, setHost] = useState(user.host ?? '%')
  const pw = usePasswordConfirm()
  const next: UserRef = mysql ? { name: name.trim(), host: host.trim() || '%' } : { name: name.trim() }
  const ready = next.name !== '' && userLabel(next) !== userLabel(user) && pw.complete
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (ready) onSubmit({ op: 'copyUser', user, newUser: next, password: pw.password })
  }
  return (
    <form onSubmit={submit} className="space-y-3" aria-label={`${userLabel(user)}: ${t.copy}`}>
      <p className="text-xs text-ink-sub">{mysql ? t.copyHintMysql : t.copyHintPostgres}</p>
      <div className="grid grid-cols-2 gap-3">
        <Field id="copy-name" label={t.newName}>
          <Input id="copy-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </Field>
        {mysql ? (
          <Field id="copy-host" label={locale.users.host}>
            <Input id="copy-host" value={host} onChange={(e) => setHost(e.target.value)} autoComplete="off" />
          </Field>
        ) : null}
        <PasswordFields state={pw} idPrefix="copy" />
      </div>
      <Buttons ready={ready} onCancel={onCancel} />
    </form>
  )
}

const number = (v: string) => (v.trim() === '' ? 0 : Math.max(0, Math.floor(Number(v)) || 0))

/** MySQL's resource limits and REQUIRE; PostgreSQL's connection limit. Blank is no limit. */
export function LimitsForm({
  user,
  limits,
  mysql,
  onSubmit,
  onCancel,
}: {
  user: UserRef
  limits: AccountLimits | null | undefined
  mysql: boolean
  onSubmit: (op: UserOp) => void
  onCancel: () => void
}) {
  const [require, setRequire] = useState<AccountLimits['require']>(limits?.require ?? 'NONE')
  const [queries, setQueries] = useState(String(limits?.maxQueries ?? 0))
  const [updates, setUpdates] = useState(String(limits?.maxUpdates ?? 0))
  const [connections, setConnections] = useState(String(limits?.maxConnections ?? 0))
  const [simultaneous, setSimultaneous] = useState(String(limits?.maxUserConnections ?? 0))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    onSubmit(
      mysql
        ? {
            op: 'setAccountLimits',
            user,
            require,
            maxQueries: number(queries),
            maxUpdates: number(updates),
            maxConnections: number(connections),
            maxUserConnections: number(simultaneous),
          }
        : { op: 'setAccountLimits', user, maxUserConnections: number(simultaneous) }
    )
  }
  const numberField = (id: string, label: string, value: string, set: (v: string) => void) => (
    <Field id={id} label={label}>
      <Input
        id={id}
        type="number"
        min={0}
        value={value}
        onChange={(e) => set(e.target.value)}
        className="tabular-nums"
      />
    </Field>
  )
  return (
    <form onSubmit={submit} className="space-y-3" aria-label={`${userLabel(user)}: ${t.limits}`}>
      <p className="text-xs text-ink-sub">{mysql ? t.limitsHintMysql : t.limitsHintPostgres}</p>
      <div className="grid grid-cols-2 gap-3">
        {mysql ? (
          <>
            <Field id="limit-require" label={t.require}>
              <Select
                id="limit-require"
                value={require}
                onChange={(e) => setRequire(e.target.value as AccountLimits['require'])}
              >
                <option value="NONE">{t.requireOptions.NONE}</option>
                <option value="SSL">{t.requireOptions.SSL}</option>
                <option value="X509">{t.requireOptions.X509}</option>
              </Select>
            </Field>
            <div />
            {numberField('limit-queries', t.maxQueries, queries, setQueries)}
            {numberField('limit-updates', t.maxUpdates, updates, setUpdates)}
            {numberField('limit-connections', t.maxConnections, connections, setConnections)}
          </>
        ) : null}
        {numberField('limit-simultaneous', t.maxUserConnections, simultaneous, setSimultaneous)}
      </div>
      <Buttons ready onCancel={onCancel} />
    </form>
  )
}
