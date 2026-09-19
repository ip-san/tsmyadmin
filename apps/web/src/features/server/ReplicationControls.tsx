import type { Dialect, ReplicationInfo, ReplicationOp } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { PreviewDialog } from '@/components/ddl/PreviewDialog.tsx'
import { PasswordFields, usePasswordConfirm } from '@/components/forms/PasswordFields.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { useReplicationOpFlow } from '@/lib/replication-ops.ts'

const t = locale.replication.controls

function ChangeSourceForm({ onSubmit, onCancel }: { onSubmit: (op: ReplicationOp) => void; onCancel: () => void }) {
  const [host, setHost] = useState('')
  const [port, setPort] = useState('3306')
  const [user, setUser] = useState('')
  const [logFile, setLogFile] = useState('')
  const [logPos, setLogPos] = useState('')
  const [auto, setAuto] = useState(false)
  const [start, setStart] = useState(true)
  const pw = usePasswordConfirm()
  const ready = host.trim() !== '' && user.trim() !== '' && pw.complete && Number(port) > 0
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!ready) return
    onSubmit({
      op: 'changeSource',
      host: host.trim(),
      port: Number(port),
      user: user.trim(),
      password: pw.password,
      autoPosition: auto,
      start,
      ...(!auto && logFile.trim() ? { logFile: logFile.trim() } : {}),
      ...(!auto && logPos.trim() ? { logPos: Number(logPos) } : {}),
    })
  }
  return (
    <form onSubmit={submit} className="space-y-3" aria-label={t.changeSource}>
      <p className="text-xs text-ink-sub">{t.changeSourceHint}</p>
      <div className="grid grid-cols-2 gap-3">
        <Field id="source-host" label={t.sourceHost}>
          <Input id="source-host" value={host} onChange={(e) => setHost(e.target.value)} autoComplete="off" />
        </Field>
        <Field id="source-port" label={t.sourcePort}>
          <Input id="source-port" type="number" min={1} value={port} onChange={(e) => setPort(e.target.value)} />
        </Field>
        <Field id="source-user" label={t.sourceUser}>
          <Input id="source-user" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />
        </Field>
        <PasswordFields state={pw} idPrefix="source" />
        <Field id="source-file" label={t.logFile}>
          <Input
            id="source-file"
            value={logFile}
            disabled={auto}
            onChange={(e) => setLogFile(e.target.value)}
            autoComplete="off"
          />
        </Field>
        <Field id="source-pos" label={t.logPos}>
          <Input
            id="source-pos"
            type="number"
            min={4}
            value={logPos}
            disabled={auto}
            onChange={(e) => setLogPos(e.target.value)}
          />
        </Field>
      </div>
      <label className="flex items-center gap-1 text-sm text-ink">
        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
        {t.autoPosition}
      </label>
      <label className="flex items-center gap-1 text-sm text-ink">
        <input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} />
        {t.startAfter}
      </label>
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

/**
 * phpMyAdmin's replica controls: start and stop the threads, skip the statement that stopped the SQL thread, reset,
 * and point the replica at a source. On PostgreSQL a standby's WAL replay is paused and resumed. Each goes through
 * the same preview as any other change.
 */
export function ReplicationControls({ dialect, info }: { dialect: Dialect; info: ReplicationInfo }) {
  const flow = useReplicationOpFlow()
  const [configuring, setConfiguring] = useState(false)
  const replica = info.role === 'replica' || info.role === 'relay'
  const ask = (op: ReplicationOp) => flow.preview(op)
  return (
    <section className="space-y-2 print:hidden">
      <h3 className="text-sm font-semibold text-ink">{t.title}</h3>
      <p className="text-xs text-ink-sub">{dialect === 'mysql' ? t.hintMysql : t.hintPostgres}</p>
      <div className="flex flex-wrap gap-2">
        {replica || dialect === 'mysql' ? (
          <>
            <Button size="sm" aria-haspopup="dialog" onClick={() => ask({ op: 'startReplica', threads: 'all' })}>
              {dialect === 'mysql' ? t.start : t.resume}
            </Button>
            <Button size="sm" aria-haspopup="dialog" onClick={() => ask({ op: 'stopReplica', threads: 'all' })}>
              {dialect === 'mysql' ? t.stop : t.pause}
            </Button>
          </>
        ) : null}
        {dialect === 'mysql' ? (
          <>
            <Button size="sm" aria-haspopup="dialog" onClick={() => ask({ op: 'skipReplicaError', count: 1 })}>
              {t.skip}
            </Button>
            <Button
              size="sm"
              variant="danger"
              aria-haspopup="dialog"
              onClick={() => ask({ op: 'resetReplica', all: false })}
            >
              {t.reset}
            </Button>
            <Button size="sm" aria-haspopup="dialog" onClick={() => setConfiguring(true)}>
              {t.changeSource}
            </Button>
          </>
        ) : null}
      </div>
      <Dialog open={configuring} title={t.changeSource} onClose={() => setConfiguring(false)}>
        {configuring ? (
          <ChangeSourceForm
            onCancel={() => setConfiguring(false)}
            onSubmit={(op) => {
              setConfiguring(false)
              ask(op)
            }}
          />
        ) : null}
      </Dialog>
      <PreviewDialog
        flow={flow}
        title={(op) => t.ops[op.op]}
        destructive={(op) => op.op === 'resetReplica'}
        hint={t.previewHint}
        successMessage={(op) => locale.ddl.executed(t.ops[op.op])}
      />
    </section>
  )
}
