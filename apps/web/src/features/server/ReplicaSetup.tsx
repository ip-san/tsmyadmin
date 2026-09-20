import { useQuery } from '@tanstack/react-query'
import type { Dialect, UserOp } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { PasswordFields, usePasswordConfirm } from '@/components/forms/PasswordFields.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Badge, ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { variablesQuery } from '@/lib/queries.ts'

const t = locale.replication.controls.source

/** The settings a server needs before a replica can follow it, and what makes each one good enough. */
const SETTINGS: Record<Dialect, { name: string; ok: (value: string) => boolean }[]> = {
  mysql: [
    { name: 'server_id', ok: (v) => Number(v) > 0 },
    { name: 'log_bin', ok: (v) => /^(1|ON)$/i.test(v) },
    { name: 'binlog_format', ok: (v) => v.toUpperCase() === 'ROW' },
    { name: 'gtid_mode', ok: (v) => v.toUpperCase() === 'ON' },
  ],
  postgres: [
    { name: 'wal_level', ok: (v) => v === 'replica' || v === 'logical' },
    { name: 'max_wal_senders', ok: (v) => Number(v) > 0 },
    { name: 'max_replication_slots', ok: (v) => Number(v) > 0 },
  ],
}

/** Whether this server can act as a replication source: read from its variables, with what to change when it cannot. */
export function SourceSettings({ dialect }: { dialect: Dialect }) {
  const variables = useQuery(variablesQuery)
  if (variables.isPending) return <Spinner />
  if (variables.isError) return <ErrorBox error={variables.error} onRetry={() => void variables.refetch()} />
  const rows = SETTINGS[dialect].flatMap((s) => {
    const found = variables.data.find((v) => v.name === s.name)
    return found ? [{ name: s.name, value: found.value, good: s.ok(found.value) }] : []
  })
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-semibold text-ink">{t.title}</h4>
      <p className="text-xs text-ink-sub">{t.hint[dialect]}</p>
      <Table aria-label={t.title}>
        <thead>
          <tr>
            <Th>{locale.server.name}</Th>
            <Th>{locale.server.value}</Th>
            <Th>{t.state}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Tr key={r.name}>
              <Td className="font-mono text-xs">{r.name}</Td>
              <Td className="font-mono text-xs">{r.value}</Td>
              <Td>
                <Badge tone={r.good ? 'neutral' : 'warn'}>{r.good ? t.ready : t.check}</Badge>
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </div>
  )
}

export function ReplicaUserForm({
  dialect,
  onSubmit,
  onCancel,
}: {
  dialect: Dialect
  onSubmit: (op: UserOp) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('repl')
  const [host, setHost] = useState('%')
  const pw = usePasswordConfirm()
  const ready = name.trim() !== '' && pw.complete && (dialect === 'postgres' || host.trim() !== '')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!ready) return
    onSubmit({
      op: 'createUser',
      user: dialect === 'mysql' ? { name: name.trim(), host: host.trim() } : { name: name.trim() },
      password: pw.password,
      attributes: { superuser: false, createdb: false, createrole: false },
      replication: true,
    })
  }
  return (
    <form onSubmit={submit} className="space-y-3" aria-label={t.createUser}>
      <p className="text-xs text-ink-sub">{t.userHint[dialect]}</p>
      <div className="grid grid-cols-2 gap-3">
        <Field id="replica-user" label={locale.users.name}>
          <Input id="replica-user" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </Field>
        {dialect === 'mysql' ? (
          <Field id="replica-host" label={locale.users.host}>
            <Input id="replica-host" value={host} onChange={(e) => setHost(e.target.value)} autoComplete="off" />
          </Field>
        ) : null}
        <PasswordFields state={pw} idPrefix="replica" />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onCancel}>
          {locale.common.cancel}
        </Button>
        <Button type="submit" variant="primary" disabled={!ready} aria-haspopup="dialog">
          {locale.ddl.submit}
        </Button>
      </div>
    </form>
  )
}
