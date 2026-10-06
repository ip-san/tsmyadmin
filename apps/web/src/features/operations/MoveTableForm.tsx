import { useNavigate } from '@tanstack/react-router'
import { type Dialect, SYSTEM_DATABASES } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import type { TableRef } from '@/lib/queries.ts'
import { useSpaces } from '@/lib/spaces.ts'

/**
 * phpMyAdmin's "Move table to": another database on MySQL, another schema of this database on PostgreSQL (which
 * cannot move a table between databases). The page follows the table to where it went.
 */
export function MoveTableForm({ tableRef, dialect }: { tableRef: TableRef; dialect: Dialect }) {
  const navigate = useNavigate()
  const { names, own: here, databasesAreSchemas, locate } = useSpaces(dialect, tableRef)
  // A MySQL system database is not somewhere to move a table to.
  const targets = (
    databasesAreSchemas ? names.filter((n) => !SYSTEM_DATABASES.mysql.has(n.toLowerCase())) : names
  ).filter((n) => n !== here)
  const [to, setTo] = useState('')
  const target = targets.includes(to) ? to : (targets[0] ?? '')
  const flow = useDdlFlow(tableRef.db, tableRef.schema, async (op) => {
    if (op.op !== 'moveTable') return
    const { db, schema } = locate(op.to)
    await navigate({
      to: '/db/$db/table/$table',
      params: { db, table: tableRef.table },
      search: schema ? { schema } : {},
    })
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (target) flow.preview({ op: 'moveTable', table: tableRef.table, to: target })
  }
  return (
    <section className="rounded border border-line p-3">
      <form onSubmit={submit} className="flex max-w-md items-start gap-2" aria-label={locale.ddl.titles.moveTable}>
        <div className="flex-1">
          <Field id="move-table" label={locale.ddl.moveTo[dialect]} hint={locale.ddl.moveHint[dialect]}>
            <Select
              id="move-table"
              value={target}
              onChange={(e) => setTo(e.target.value)}
              disabled={targets.length === 0}
            >
              {targets.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Button type="submit" variant="primary" disabled={!target} aria-haspopup="dialog" className="mt-5">
          {locale.ddl.titles.moveTable}
        </Button>
      </form>
      <DdlPreviewDialog flow={flow} />
    </section>
  )
}
