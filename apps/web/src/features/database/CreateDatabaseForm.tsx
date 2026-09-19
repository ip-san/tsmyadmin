import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import { serverCatalogQuery, sessionQuery } from '@/lib/queries.ts'

export interface CreateNamespaceFormProps {
  /** Namespace the statement runs in (server namespace for databases; the database itself for schemas). */
  database: string
  /** 'database' (server page) or 'schema' (PostgreSQL database page). */
  kind: 'database' | 'schema'
}

/** Create a database (server page) or a PostgreSQL schema (database page) through the SQL preview flow. */
export function CreateDatabaseForm({ database, kind }: CreateNamespaceFormProps) {
  const [name, setName] = useState('')
  const [collation, setCollation] = useState('')
  const dialect = useQuery(sessionQuery).data?.dialect ?? 'mysql'
  const catalog = useQuery({ ...serverCatalogQuery('collations'), enabled: kind === 'database' })
  const names = (catalog.data?.rows ?? [])
    .map((r) => String(r[dialect === 'mysql' ? 1 : 0] ?? ''))
    .filter((n) => n !== '')
  const navigate = useNavigate()
  const flow = useDdlFlow(database, undefined, async (op) => {
    setName('')
    setCollation('')
    // A new database opens directly (a new schema stays on its database page, where it now appears).
    if (op.op === 'createDatabase') await navigate({ to: '/db/$db', params: { db: op.name }, search: {} })
  })
  const title = kind === 'schema' ? locale.ddl.titles.createSchema : locale.ddl.titles.createDatabase
  const label = kind === 'schema' ? locale.ddl.schemaName : locale.ddl.databaseName
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (name.trim())
      flow.preview(
        kind === 'schema'
          ? { op: 'createSchema', name: name.trim() }
          : { op: 'createDatabase', name: name.trim(), ...(collation.trim() ? { collation: collation.trim() } : {}) }
      )
  }
  return (
    <div className="max-w-2xl space-y-2">
      <DdlPreviewDialog flow={flow} />
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2" aria-label={title}>
        <div className="flex-1">
          <Field id={`new-${kind}-name`} label={label}>
            <Input
              id={`new-${kind}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="off"
            />
          </Field>
        </div>
        {kind === 'database' ? (
          <Field id="new-database-collation" label={locale.table.collation}>
            <Input
              id="new-database-collation"
              list="new-database-collations"
              value={collation}
              onChange={(e) => setCollation(e.target.value)}
              className="w-56 font-mono"
              autoComplete="off"
            />
            <datalist id="new-database-collations">
              {names.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </Field>
        ) : null}
        <Button type="submit" variant="primary" disabled={!name.trim()}>
          {title}
        </Button>
      </form>
    </div>
  )
}
