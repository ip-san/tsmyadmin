import { type FormEvent, useState } from 'react'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'

/** Server page: create a database (runs in the session's server namespace). */
export function CreateDatabaseForm({ serverDatabase }: { serverDatabase: string }) {
  const [name, setName] = useState('')
  const flow = useDdlFlow(serverDatabase, undefined, () => setName(''))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (name.trim()) flow.preview({ op: 'createDatabase', name: name.trim() })
  }
  return (
    <form onSubmit={submit} className="flex max-w-md items-end gap-2" aria-label={locale.ddl.titles.createDatabase}>
      <div className="flex-1">
        <Field id="new-db-name" label={locale.ddl.databaseName}>
          <Input id="new-db-name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="off" />
        </Field>
      </div>
      <Button type="submit" variant="primary" disabled={!name.trim()}>
        {locale.ddl.titles.createDatabase}
      </Button>
      <DdlPreviewDialog flow={flow} />
    </form>
  )
}
