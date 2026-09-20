import { useNavigate } from '@tanstack/react-router'
import type { Dialect } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Notice } from '@/components/ui/Feedback.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { type DdlFlow, useDdlFlow } from '@/lib/ddl.ts'
import { DatabaseCollationForm } from './DatabaseCollationForm.tsx'
import { isProtectedDatabase, isSystemDatabase } from './system-databases.ts'

/**
 * Rename and copy a whole database. Both run from the session's own server database, never from the one being
 * changed: PostgreSQL cannot rename or copy the database a statement is running in.
 */
export function DatabaseOperations({
  db,
  schema,
  dialect,
  serverDatabase,
}: {
  db: string
  schema?: string | undefined
  dialect: Dialect
  serverDatabase: string
}) {
  const navigate = useNavigate()
  // After a rename the database to look at is the new one; after a copy it is too, unless asked to stay.
  const [switchToCopy, setSwitchToCopy] = useState(true)
  const flow = useDdlFlow(serverDatabase, undefined, async (op) => {
    if (op.op === 'renameDatabase' || (op.op === 'copyDatabase' && switchToCopy))
      await navigate({ to: '/db/$db', params: { db: op.newName } })
  })
  // The server's own databases take no operation; the one this session is connected to cannot be renamed or copied
  // (its connection would be pulled from under it), but its collation can change.
  if (isSystemDatabase(dialect, db)) return <Notice>{locale.databaseOps.systemDatabase}</Notice>
  const connected = isProtectedDatabase(dialect, db, serverDatabase)
  return (
    <div className="space-y-4">
      <DatabaseCollationForm key={`collation-${db}-${schema ?? ''}`} db={db} schema={schema} dialect={dialect} />
      {connected ? (
        <Notice>{locale.databaseOps.connectedDatabase}</Notice>
      ) : (
        <>
          <RenameDatabaseForm key={`rename-${db}`} db={db} dialect={dialect} flow={flow} />
          <CopyDatabaseForm
            key={`copy-${db}`}
            db={db}
            dialect={dialect}
            flow={flow}
            switchToCopy={switchToCopy}
            onSwitchToCopy={setSwitchToCopy}
          />
          <DdlPreviewDialog flow={flow} />
        </>
      )}
    </div>
  )
}

function RenameDatabaseForm({ db, dialect, flow }: { db: string; dialect: Dialect; flow: DdlFlow }) {
  const [newName, setNewName] = useState(db)
  const name = newName.trim()
  const valid = name !== '' && name !== db
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (valid) flow.preview({ op: 'renameDatabase', name: db, newName: name })
  }
  return (
    <section className="rounded border border-line p-3">
      <form onSubmit={submit} className="flex max-w-xl items-end gap-2" aria-label={locale.ddl.titles.renameDatabase}>
        <div className="flex-1">
          <Field
            id="rename-database"
            label={locale.databaseOps.newName}
            hint={dialect === 'mysql' ? locale.databaseOps.renameHintMysql : locale.databaseOps.renameHintPostgres}
          >
            <Input
              id="rename-database"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              required
              autoComplete="off"
            />
          </Field>
        </div>
        <Button type="submit" variant="primary" disabled={!valid}>
          {locale.ddl.submit}
        </Button>
      </form>
    </section>
  )
}

type CopyMode = 'both' | 'structure' | 'data'

function CopyDatabaseForm({
  db,
  dialect,
  flow,
  switchToCopy,
  onSwitchToCopy,
}: {
  db: string
  dialect: Dialect
  flow: DdlFlow
  switchToCopy: boolean
  onSwitchToCopy: (on: boolean) => void
}) {
  const [newName, setNewName] = useState(`${db}_copy`)
  const [mode, setMode] = useState<CopyMode>('both')
  // MySQL's copy leaves these behind by default; PostgreSQL copies from a template that already brings them.
  const [keep, setKeep] = useState({ foreignKeys: false, autoIncrement: false, privileges: false })
  const name = newName.trim()
  const valid = name !== '' && name !== db
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (valid)
      flow.preview({
        op: 'copyDatabase',
        name: db,
        newName: name,
        withData: dialect === 'postgres' || mode !== 'structure',
        ...(dialect === 'mysql' && mode === 'data' ? { structure: false } : {}),
        ...(dialect === 'mysql'
          ? {
              ...(keep.foreignKeys ? { foreignKeys: true } : {}),
              ...(keep.autoIncrement ? { autoIncrement: true } : {}),
              ...(keep.privileges ? { privileges: true } : {}),
            }
          : {}),
      })
  }
  return (
    <section className="rounded border border-line p-3">
      <form onSubmit={submit} className="space-y-2" aria-label={locale.ddl.titles.copyDatabase}>
        <div className="flex max-w-xl items-end gap-2">
          <div className="flex-1">
            <Field
              id="copy-database"
              label={locale.databaseOps.copyName}
              hint={dialect === 'mysql' ? locale.databaseOps.copyHintMysql : locale.databaseOps.copyHintPostgres}
            >
              <Input
                id="copy-database"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
                autoComplete="off"
              />
            </Field>
          </div>
          <Button type="submit" variant="primary" disabled={!valid}>
            {locale.ddl.submit}
          </Button>
        </div>
        {/* PostgreSQL copies from a template, which always brings the data. */}
        {dialect === 'mysql' ? (
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-1">
              {locale.databaseOps.copyMode.label}
              <select
                aria-label={locale.databaseOps.copyMode.label}
                value={mode}
                onChange={(e) => setMode(e.target.value as CopyMode)}
                className="rounded-control border border-line-strong bg-surface px-2 py-1 text-sm text-ink"
              >
                <option value="both">{locale.databaseOps.copyMode.both}</option>
                <option value="structure">{locale.databaseOps.copyMode.structure}</option>
                <option value="data">{locale.databaseOps.copyMode.data}</option>
              </select>
            </label>
            {mode === 'data' ? (
              <p className="w-full text-xs text-ink-sub">{locale.databaseOps.copyMode.dataHint}</p>
            ) : null}
            {(['foreignKeys', 'autoIncrement', 'privileges'] as const).map((k) => (
              <label key={k} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={keep[k]}
                  onChange={(e) => setKeep((prev) => ({ ...prev, [k]: e.target.checked }))}
                />
                {locale.databaseOps.copyKeep[k]}
              </label>
            ))}
          </div>
        ) : null}
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={switchToCopy} onChange={(e) => onSwitchToCopy(e.target.checked)} />
          {locale.databaseOps.switchToCopy}
        </label>
      </form>
    </section>
  )
}
