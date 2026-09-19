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
  preset,
  onPresetDone,
}: {
  db: string
  schema?: string | undefined
  tables: string[]
  /** Columns picked on the diagram: opens the dialog with them filled in. */
  preset?: { table: string; column: string; refTable: string; refColumn: string } | undefined
  onPresetDone?: () => void
}) {
  const [opened, setOpen] = useState(false)
  const open = opened || preset !== undefined
  const close = () => {
    setOpen(false)
    onPresetDone?.()
  }
  const [from, setFrom] = useState('')
  const table = preset?.table ?? (tables.includes(from) ? from : (tables[0] ?? ''))
  const tableRef = { db, schema, table }
  const structure = useQuery({ ...structureQuery(tableRef), enabled: open && table !== '' })
  const flow = useDdlFlow(db, schema)
  return (
    <>
      <Button size="sm" aria-haspopup="dialog" onClick={() => setOpen(true)} disabled={tables.length === 0}>
        {locale.ddl.titles.addForeignKey}
      </Button>
      <Dialog open={open} title={locale.ddl.titles.addForeignKey} onClose={close}>
        {open ? (
          <div className="space-y-3">
            <Field id="designer-fk-table" label={t.fromTable}>
              <Select
                id="designer-fk-table"
                value={table}
                disabled={preset !== undefined}
                onChange={(e) => setFrom(e.target.value)}
              >
                {tables.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </Select>
            </Field>
            {structure.data ? (
              <ForeignKeyForm
                key={`${table}:${preset?.column}:${preset?.refColumn}`}
                tableRef={tableRef}
                columns={structure.data.columns.map((c) => c.name)}
                {...(preset
                  ? { initial: { columns: [preset.column], refTable: preset.refTable, refColumns: [preset.refColumn] } }
                  : {})}
                onCancel={close}
                onSubmit={(v) => {
                  close()
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
