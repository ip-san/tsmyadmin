import type { DdlOp } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { CreateSection } from '@/components/ddl/CreateSection.tsx'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input, Textarea } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'

const t = locale.create

/** phpMyAdmin's "Create view": a name over a SELECT, optionally replacing a view of that name. */
function CreateViewForm({
  onSubmit,
  initialSelect = '',
}: {
  onSubmit: (op: DdlOp) => void
  initialSelect?: string | undefined
}) {
  const [name, setName] = useState('')
  const [select, setSelect] = useState(initialSelect)
  const [orReplace, setOrReplace] = useState(false)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !select.trim()) return
    onSubmit({ op: 'createView', name: name.trim(), select, orReplace })
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <Field id="view-name" label={t.name}>
        <Input id="view-name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="off" />
      </Field>
      <Field id="view-select" label={t.view.select}>
        <Textarea
          id="view-select"
          value={select}
          onChange={(e) => setSelect(e.target.value)}
          rows={5}
          spellCheck={false}
          className="w-full font-mono text-xs"
          required
        />
      </Field>
      <label className="flex items-center gap-1 text-sm text-ink">
        <input type="checkbox" checked={orReplace} onChange={(e) => setOrReplace(e.target.checked)} />
        {t.view.orReplace}
      </label>
      <Button type="submit" variant="primary" aria-haspopup="dialog" aria-label={`${t.view.title}: ${t.review}`}>
        {t.review}
      </Button>
    </form>
  )
}

/** The create-view block under the database structure list, with its own preview. */
export function CreateViewSection({
  db,
  schema,
  initialSelect,
}: {
  db: string
  schema?: string | undefined
  /** A SELECT to start from (the SQL console's "Create view" under a result). */
  initialSelect?: string | undefined
}) {
  const flow = useDdlFlow(db, schema)
  return (
    <>
      <DdlPreviewDialog flow={flow} />
      <CreateSection title={t.view.title} open={initialSelect !== undefined}>
        <CreateViewForm key={initialSelect ?? ''} onSubmit={flow.preview} initialSelect={initialSelect} />
      </CreateSection>
    </>
  )
}
