import { useNavigate } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import type { TableRef } from '@/lib/queries.ts'

export function CopyTableForm({ tableRef }: { tableRef: TableRef }) {
  const [newName, setNewName] = useState(`${tableRef.table}_copy`)
  const [withData, setWithData] = useState(true)
  const navigate = useNavigate()
  const flow = useDdlFlow(tableRef.db, tableRef.schema, async (op) => {
    if (op.op === 'copyTable') {
      await navigate({
        to: '/db/$db/table/$table',
        params: { db: tableRef.db, table: op.newName },
        search: tableRef.schema ? { schema: tableRef.schema } : {},
      })
    }
  })
  const valid = newName.trim() !== '' && newName.trim() !== tableRef.table
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (valid) flow.preview({ op: 'copyTable', table: tableRef.table, newName: newName.trim(), withData })
  }
  return (
    <section className="rounded border border-zinc-200 p-3 dark:border-zinc-700">
      <form onSubmit={submit} className="space-y-2" aria-label={locale.ddl.titles.copyTable}>
        <div className="flex max-w-md items-end gap-2">
          <div className="flex-1">
            <Field id="copy-table" label={locale.ddl.copyTargetName} hint={locale.ddl.copyHint}>
              <Input
                id="copy-table"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
                autoComplete="off"
              />
            </Field>
          </div>
          <Button type="submit" variant="primary" disabled={!valid}>
            {locale.ddl.titles.copyTable}
          </Button>
        </div>
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={withData} onChange={(e) => setWithData(e.target.checked)} />
          {locale.ddl.copyWithData}
        </label>
      </form>
      <DdlPreviewDialog flow={flow} />
    </section>
  )
}
