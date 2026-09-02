import { useNavigate } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import type { TableRef } from '@/lib/queries.ts'

export function RenameTableForm({
  tableRef,
  view = false,
  sequence = false,
}: {
  tableRef: TableRef
  view?: boolean
  sequence?: boolean
}) {
  const [newName, setNewName] = useState(tableRef.table)
  const navigate = useNavigate()
  const flow = useDdlFlow(tableRef.db, tableRef.schema, async (op) => {
    if (op.op === 'renameTable') {
      await navigate({
        to: '/db/$db/table/$table',
        params: { db: tableRef.db, table: op.newName },
        search: tableRef.schema ? { schema: tableRef.schema } : {},
      })
    }
  })
  const changed = newName.trim() !== '' && newName.trim() !== tableRef.table
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (changed) flow.preview({ op: 'renameTable', table: tableRef.table, newName: newName.trim() })
  }
  return (
    <section className="rounded border border-zinc-200 p-3 dark:border-zinc-700">
      <form onSubmit={submit} className="flex max-w-md items-end gap-2" aria-label={locale.ddl.titles.renameTable}>
        <div className="flex-1">
          <Field
            id="rename-table"
            label={sequence ? locale.ddl.newSequenceName : view ? locale.ddl.newViewName : locale.ddl.newTableName}
            hint={locale.ddl.renameHint}
          >
            <Input
              id="rename-table"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              required
              autoComplete="off"
            />
          </Field>
        </div>
        <Button type="submit" variant="primary" disabled={!changed}>
          {locale.ddl.submit}
        </Button>
      </form>
      <DdlPreviewDialog flow={flow} />
    </section>
  )
}
