import { useQuery } from '@tanstack/react-query'
import type { Dialect, TableSchema } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import { serverCatalogQuery, type TableRef } from '@/lib/queries.ts'

const t = locale.operations

/** Columns that carry a collation: the text types. */
export function textColumns(schema: Pick<TableSchema, 'columns'>): { name: string; dataType: string }[] {
  return schema.columns
    .filter((c) => /char|text|string|citext/i.test(c.dataType) && c.generated === null)
    .map((c) => ({ name: c.name, dataType: c.dataType }))
}

/**
 * phpMyAdmin's "Collation" (with "Change all column collations") and "Alter table order by": every text column
 * to one collation, and the rows' physical order — MySQL by a column, PostgreSQL along an index (CLUSTER).
 */
export function CollationOrderForm({
  tableRef,
  dialect,
  schema,
}: {
  tableRef: TableRef
  dialect: Dialect
  schema: TableSchema
}) {
  const flow = useDdlFlow(tableRef.db, tableRef.schema)
  const collations = useQuery(serverCatalogQuery('collations'))
  // The name is the second column on MySQL (after the character set), the first on PostgreSQL.
  const at = dialect === 'mysql' ? 1 : 0
  const names = (collations.data?.rows ?? []).map((r) => String(r[at] ?? '')).filter((n) => n !== '')
  const [collation, setCollation] = useState('')
  const [column, setColumn] = useState(schema.columns[0]?.name ?? '')
  const [desc, setDesc] = useState(false)
  const indexes = schema.indexes.filter((i) => !i.predicate)
  const [index, setIndex] = useState(indexes[0]?.name ?? '')
  const text = textColumns(schema)
  const table = tableRef.table
  const convert = (e: FormEvent) => {
    e.preventDefault()
    if (collation.trim()) flow.preview({ op: 'convertCollation', table, collation: collation.trim(), columns: text })
  }
  const order = (e: FormEvent) => {
    e.preventDefault()
    flow.preview(dialect === 'mysql' ? { op: 'orderTable', table, column, desc } : { op: 'orderTable', table, index })
  }
  return (
    <section className="space-y-4 rounded border border-line p-3">
      <form onSubmit={convert} className="space-y-2" aria-label={locale.ddl.titles.convertCollation}>
        <h2 className="text-sm font-semibold text-ink">{locale.ddl.titles.convertCollation}</h2>
        <p className="text-xs text-ink-sub">{dialect === 'mysql' ? t.convertHintMysql : t.convertHintPostgres}</p>
        <div className="flex flex-wrap items-end gap-2">
          <Field id="convert-collation" label={locale.table.collation}>
            <Input
              id="convert-collation"
              list="convert-collation-names"
              value={collation}
              onChange={(e) => setCollation(e.target.value)}
              className="w-64 font-mono"
              autoComplete="off"
            />
          </Field>
          <datalist id="convert-collation-names">
            {names.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <Button
            type="submit"
            variant="primary"
            aria-haspopup="dialog"
            disabled={!collation.trim() || (dialect === 'postgres' && text.length === 0)}
          >
            {locale.ddl.submit}
          </Button>
        </div>
      </form>
      <form onSubmit={order} className="space-y-2" aria-label={locale.ddl.titles.orderTable}>
        <h2 className="text-sm font-semibold text-ink">{locale.ddl.titles.orderTable}</h2>
        <p className="text-xs text-ink-sub">{dialect === 'mysql' ? t.orderHintMysql : t.orderHintPostgres}</p>
        <div className="flex flex-wrap items-end gap-2">
          {dialect === 'mysql' ? (
            <>
              <Field id="order-column" label={t.orderColumn}>
                <Select id="order-column" value={column} onChange={(e) => setColumn(e.target.value)}>
                  {schema.columns.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <label className="flex items-center gap-1 self-center text-sm text-ink">
                <input type="checkbox" checked={desc} onChange={(e) => setDesc(e.target.checked)} />
                {t.descending}
              </label>
            </>
          ) : (
            <Field id="order-index" label={t.orderIndex}>
              <Select id="order-index" value={index} onChange={(e) => setIndex(e.target.value)}>
                {indexes.map((i) => (
                  <option key={i.name} value={i.name}>
                    {i.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Button
            type="submit"
            variant="primary"
            aria-haspopup="dialog"
            disabled={dialect === 'mysql' ? !column : !index}
          >
            {locale.ddl.submit}
          </Button>
        </div>
      </form>
      <DdlPreviewDialog flow={flow} />
    </section>
  )
}
