import { useNavigate } from '@tanstack/react-router'
import type { Dialect } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Notice } from '@/components/ui/Feedback.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { type DdlFlow, useDdlFlow } from '@/lib/ddl.ts'
import { isProtectedDatabase, isSystemDatabase } from './system-databases.ts'

/**
 * Rename and copy a whole database. Both run from the session's own server database, never from the one being
 * changed: PostgreSQL cannot rename or copy the database a statement is running in.
 */
export function DatabaseOperations({
  db,
  dialect,
  serverDatabase,
}: {
  db: string
  dialect: Dialect
  serverDatabase: string
}) {
  const navigate = useNavigate()
  // Either way the database to look at next is the new one.
  const flow = useDdlFlow(serverDatabase, undefined, async (op) => {
    if (op.op === 'renameDatabase' || op.op === 'copyDatabase')
      await navigate({ to: '/db/$db', params: { db: op.newName } })
  })
  if (isProtectedDatabase(dialect, db, serverDatabase))
    return (
      <Notice>
        {isSystemDatabase(dialect, db) ? locale.databaseOps.systemDatabase : locale.databaseOps.connectedDatabase}
      </Notice>
    )
  return (
    <div className="space-y-4">
      <RenameDatabaseForm key={`rename-${db}`} db={db} dialect={dialect} flow={flow} />
      <CopyDatabaseForm key={`copy-${db}`} db={db} dialect={dialect} flow={flow} />
      <DdlPreviewDialog flow={flow} />
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

function CopyDatabaseForm({ db, dialect, flow }: { db: string; dialect: Dialect; flow: DdlFlow }) {
  const [newName, setNewName] = useState(`${db}_copy`)
  const [withData, setWithData] = useState(true)
  const name = newName.trim()
  const valid = name !== '' && name !== db
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (valid)
      flow.preview({ op: 'copyDatabase', name: db, newName: name, withData: dialect === 'postgres' || withData })
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
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={withData} onChange={(e) => setWithData(e.target.checked)} />
            {locale.ddl.copyWithData}
          </label>
        ) : null}
      </form>
    </section>
  )
}
