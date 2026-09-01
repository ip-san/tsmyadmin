import { type FormEvent, useState } from 'react'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'

export interface CreateNamespaceFormProps {
  /** Namespace the statement runs in (server namespace for databases; the database itself for schemas). */
  database: string
  /** 'database' (server page) or 'schema' (PostgreSQL database page). */
  kind: 'database' | 'schema'
}

/** Create a database (server page) or a PostgreSQL schema (database page) through the SQL preview flow. */
export function CreateDatabaseForm({ database, kind }: CreateNamespaceFormProps) {
  const [name, setName] = useState('')
  const flow = useDdlFlow(database, undefined, () => setName(''))
  const title = kind === 'schema' ? locale.ddl.titles.createSchema : locale.ddl.titles.createDatabase
  const label = kind === 'schema' ? locale.ddl.schemaName : locale.ddl.databaseName
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (name.trim())
      flow.preview(
        kind === 'schema' ? { op: 'createSchema', name: name.trim() } : { op: 'createDatabase', name: name.trim() }
      )
  }
  return (
    <form onSubmit={submit} className="flex max-w-md items-end gap-2" aria-label={title}>
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
      <Button type="submit" variant="primary" disabled={!name.trim()}>
        {title}
      </Button>
      <DdlPreviewDialog flow={flow} />
    </form>
  )
}
