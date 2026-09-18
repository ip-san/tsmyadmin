import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { ForeignKeyForm } from '@/components/ddl/ForeignKeyForm.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { Spinner } from '@/components/ui/Feedback.tsx'
import { Field, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import { structureQuery } from '@/lib/queries.ts'

const t = locale.designer

/**
 * Adding a foreign key from the designer: the table it starts from, then the same form as the Structure tab. The
 * key is drawn once it exists (the preview's success refreshes the list the diagram is drawn from).
 */
export function DesignerAddForeignKey({
  db,
  schema,
  tables,
}: {
  db: string
  schema?: string | undefined
  tables: string[]
}) {
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState('')
  const table = tables.includes(from) ? from : (tables[0] ?? '')
  const tableRef = { db, schema, table }
  const structure = useQuery({ ...structureQuery(tableRef), enabled: open && table !== '' })
  const flow = useDdlFlow(db, schema)
  return (
    <>
      <Button size="sm" aria-haspopup="dialog" onClick={() => setOpen(true)} disabled={tables.length === 0}>
        {locale.ddl.titles.addForeignKey}
      </Button>
      <Dialog open={open} title={locale.ddl.titles.addForeignKey} onClose={() => setOpen(false)}>
        {open ? (
          <div className="space-y-3">
            <Field id="designer-fk-table" label={t.fromTable}>
              <Select id="designer-fk-table" value={table} onChange={(e) => setFrom(e.target.value)}>
                {tables.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </Select>
            </Field>
            {structure.data ? (
              <ForeignKeyForm
                key={table}
                tableRef={tableRef}
                columns={structure.data.columns.map((c) => c.name)}
                onCancel={() => setOpen(false)}
                onSubmit={(v) => {
                  setOpen(false)
                  flow.preview({ op: 'addForeignKey', table, ...v })
                }}
              />
            ) : (
              <Spinner />
            )}
          </div>
        ) : null}
      </Dialog>
      <DdlPreviewDialog flow={flow} />
    </>
  )
}
