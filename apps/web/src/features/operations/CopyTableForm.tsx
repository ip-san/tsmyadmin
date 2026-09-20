import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { type Dialect, type FkAction, FkActionSchema, type TableSchema } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import { databasesQuery, schemasQuery, type TableRef } from '@/lib/queries.ts'

type What = 'both' | 'structure' | 'data'

/** A referential action the catalog reported, when it is one the builders write (NO ACTION is the default anyway). */
function action<K extends 'onUpdate' | 'onDelete'>(key: K, value: string | null): Partial<Record<K, FkAction>> {
  const parsed = FkActionSchema.safeParse(value?.toUpperCase())
  return parsed.success ? ({ [key]: parsed.data } as Partial<Record<K, FkAction>>) : {}
}

/** The copy's own names for the source's foreign keys (a constraint name is unique per database / schema). */
export function copiedForeignKeys(schema: Pick<TableSchema, 'foreignKeys'>, newName: string) {
  return schema.foreignKeys.map((fk) => ({
    name: `${newName}_${fk.name}`.slice(0, 63),
    columns: fk.columns,
    refTable: fk.refTable,
    refDatabase: fk.refNamespace.database,
    ...(fk.refNamespace.schema ? { refSchema: fk.refNamespace.schema } : {}),
    refColumns: fk.refColumns,
    ...action('onUpdate', fk.onUpdate),
    ...action('onDelete', fk.onDelete),
  }))
}

/**
 * phpMyAdmin's "Copy table to (database.table)": structure and / or data, into this or another database (MySQL)
 * or schema (PostgreSQL), optionally replacing a table of that name and adding the source's foreign keys.
 */
export function CopyTableForm({
  tableRef,
  dialect,
  schema,
}: {
  tableRef: TableRef
  dialect: Dialect
  schema: TableSchema
}) {
  const own = dialect === 'mysql' ? tableRef.db : (tableRef.schema ?? 'public')
  const [newName, setNewName] = useState(`${tableRef.table}_copy`)
  const [space, setSpace] = useState(own)
  const [what, setWhat] = useState<What>('both')
  const [dropExisting, setDropExisting] = useState(false)
  const [withKeys, setWithKeys] = useState(false)
  const databases = useQuery({ ...databasesQuery, enabled: dialect === 'mysql' })
  const schemas = useQuery({ ...schemasQuery(tableRef.db), enabled: dialect === 'postgres' })
  const spaces = dialect === 'mysql' ? (databases.data ?? []).map((d) => d.name) : (schemas.data ?? [])
  const navigate = useNavigate()
  const flow = useDdlFlow(tableRef.db, tableRef.schema, async (op) => {
    if (op.op === 'copyTable') {
      const schemaName = op.toSchema ?? tableRef.schema
      await navigate({
        to: '/db/$db/table/$table',
        params: { db: op.toDatabase ?? tableRef.db, table: op.newName },
        search: schemaName ? { schema: schemaName } : {},
      })
    }
  })
  const name = newName.trim()
  const valid = name !== '' && (name !== tableRef.table || space !== own)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!valid) return
    flow.preview({
      op: 'copyTable',
      table: tableRef.table,
      newName: name,
      withData: what !== 'structure',
      ...(what === 'data' ? { structure: false } : {}),
      ...(space !== own ? (dialect === 'mysql' ? { toDatabase: space } : { toSchema: space }) : {}),
      ...(dropExisting && what !== 'data' ? { dropExisting: true } : {}),
      ...(withKeys && what !== 'data' ? { foreignKeys: copiedForeignKeys(schema, name) } : {}),
    })
  }
  return (
    <section className="rounded border border-line p-3">
      <form onSubmit={submit} className="space-y-2" aria-label={locale.ddl.titles.copyTable}>
        <div className="flex flex-wrap items-start gap-2">
          <Field id="copy-space" label={dialect === 'mysql' ? locale.ddl.copyToDatabase : locale.ddl.copyToSchema}>
            <Select id="copy-space" value={space} onChange={(e) => setSpace(e.target.value)}>
              {[own, ...spaces.filter((n) => n !== own)].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
          <div className="min-w-56 flex-1">
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
          <Button type="submit" variant="primary" disabled={!valid} className="mt-5">
            {locale.ddl.submit}
          </Button>
        </div>
        <fieldset className="flex flex-wrap gap-4 text-sm">
          <legend className="sr-only">{locale.ddl.copyWhat}</legend>
          {(['both', 'structure', 'data'] as const).map((w) => (
            <label key={w} className="flex items-center gap-1">
              <input type="radio" name="copy-what" checked={what === w} onChange={() => setWhat(w)} />
              {locale.ddl.copyWhatOptions[w]}
            </label>
          ))}
        </fieldset>
        {what === 'data' ? null : (
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={dropExisting} onChange={(e) => setDropExisting(e.target.checked)} />
              {locale.ddl.copyDropExisting}
            </label>
            {schema.foreignKeys.length > 0 ? (
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={withKeys} onChange={(e) => setWithKeys(e.target.checked)} />
                {locale.ddl.copyForeignKeys(schema.foreignKeys.length)}
              </label>
            ) : null}
          </div>
        )}
      </form>
      <DdlPreviewDialog flow={flow} />
    </section>
  )
}
