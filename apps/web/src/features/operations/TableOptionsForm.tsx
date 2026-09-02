import type { Dialect, TableSchema } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import type { TableRef } from '@/lib/queries.ts'

const IDENT = /^[A-Za-z0-9_]+$/

/** Table comment (both dialects) and MySQL's engine / collation / AUTO_INCREMENT, through the preview flow. */
export function TableOptionsForm({
  tableRef,
  dialect,
  schema,
}: {
  tableRef: TableRef
  dialect: Dialect
  schema: TableSchema
}) {
  const mysql = dialect === 'mysql'
  const [comment, setComment] = useState(schema.comment ?? '')
  const [engine, setEngine] = useState(schema.engine ?? '')
  const [collation, setCollation] = useState('')
  const [autoIncrement, setAutoIncrement] = useState('')
  const flow = useDdlFlow(tableRef.db, tableRef.schema)
  const commentChanged = comment !== (schema.comment ?? '')
  const engineChanged = mysql && engine.trim() !== '' && engine.trim() !== (schema.engine ?? '')
  const collationChanged = mysql && collation.trim() !== ''
  const autoIncrementChanged = mysql && autoIncrement.trim() !== ''
  const invalid =
    (engineChanged && !IDENT.test(engine.trim())) ||
    (collationChanged && !IDENT.test(collation.trim())) ||
    (autoIncrementChanged && !/^\d{1,20}$/.test(autoIncrement.trim()))
  const changed = commentChanged || engineChanged || collationChanged || autoIncrementChanged
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!changed || invalid) return
    flow.preview({
      op: 'setTableOptions',
      table: tableRef.table,
      ...(commentChanged ? { comment: comment === '' ? null : comment } : {}),
      ...(engineChanged ? { engine: engine.trim() } : {}),
      ...(collationChanged ? { collation: collation.trim() } : {}),
      ...(autoIncrementChanged ? { autoIncrement: autoIncrement.trim() } : {}),
    })
  }
  return (
    <section className="rounded border border-zinc-200 p-3 dark:border-zinc-700">
      <form onSubmit={submit} className="space-y-2" aria-label={locale.ddl.titles.setTableOptions}>
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{locale.ddl.titles.setTableOptions}</h2>
        <div className="grid max-w-2xl gap-2 sm:grid-cols-2">
          <Field id="table-comment" label={locale.database.comment}>
            <Input id="table-comment" value={comment} onChange={(e) => setComment(e.target.value)} />
          </Field>
          {mysql ? (
            <>
              <Field id="table-engine" label={locale.database.engine} hint={locale.ddl.engineHint}>
                <Input id="table-engine" value={engine} onChange={(e) => setEngine(e.target.value)} />
              </Field>
              <Field id="table-collation" label={locale.table.collation} hint={locale.ddl.collationHint}>
                <Input
                  id="table-collation"
                  value={collation}
                  onChange={(e) => setCollation(e.target.value)}
                  placeholder={locale.ddl.unchanged}
                />
              </Field>
              <Field id="table-auto-increment" label={locale.ddl.autoIncrementNext} hint={locale.ddl.autoIncrementHint}>
                <Input
                  id="table-auto-increment"
                  inputMode="numeric"
                  value={autoIncrement}
                  onChange={(e) => setAutoIncrement(e.target.value)}
                  placeholder={locale.ddl.unchanged}
                />
              </Field>
            </>
          ) : null}
        </div>
        <Button type="submit" variant="primary" disabled={!changed || invalid}>
          {locale.ddl.submit}
        </Button>
      </form>
      <DdlPreviewDialog flow={flow} />
    </section>
  )
}
