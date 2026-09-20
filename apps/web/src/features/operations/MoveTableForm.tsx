import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { type Dialect, SYSTEM_DATABASES } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import { databasesQuery, schemasQuery, type TableRef } from '@/lib/queries.ts'

/**
 * phpMyAdmin's "Move table to": another database on MySQL, another schema of this database on PostgreSQL (which
 * cannot move a table between databases). The page follows the table to where it went.
 */
export function MoveTableForm({ tableRef, dialect }: { tableRef: TableRef; dialect: Dialect }) {
  const navigate = useNavigate()
  const databases = useQuery({ ...databasesQuery, enabled: dialect === 'mysql' })
  const schemas = useQuery({ ...schemasQuery(tableRef.db), enabled: dialect === 'postgres' })
  const here = dialect === 'mysql' ? tableRef.db : (tableRef.schema ?? 'public')
  const targets = (
    dialect === 'mysql'
      ? (databases.data ?? []).map((d) => d.name).filter((n) => !SYSTEM_DATABASES.mysql.has(n.toLowerCase()))
      : (schemas.data ?? [])
  ).filter((n) => n !== here)
  const [to, setTo] = useState('')
  const target = targets.includes(to) ? to : (targets[0] ?? '')
  const flow = useDdlFlow(tableRef.db, tableRef.schema, async (op) => {
    if (op.op !== 'moveTable') return
    await navigate({
      to: '/db/$db/table/$table',
      params: { db: dialect === 'mysql' ? op.to : tableRef.db, table: tableRef.table },
      search: dialect === 'postgres' ? { schema: op.to } : {},
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
