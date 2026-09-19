import { useQuery } from '@tanstack/react-query'
import type { Dialect } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import { databasesQuery, serverCatalogQuery } from '@/lib/queries.ts'

const t = locale.databaseOps

/**
 * phpMyAdmin's database "Collation" (with "Change all tables collations" and "Change all tables columns
 * collations"). MySQL changes the default and, when asked, converts every table; PostgreSQL keeps the collation
 * a database was created with, so there only the text columns of the schema's tables change.
 */
export function DatabaseCollationForm({
  db,
  schema,
  dialect,
}: {
  db: string
  schema?: string | undefined
  dialect: Dialect
}) {
  const flow = useDdlFlow(db, schema)
  const databases = useQuery({ ...databasesQuery, enabled: dialect === 'mysql' })
  const current = databases.data?.find((d) => d.name === db)?.collation ?? ''
  const collations = useQuery(serverCatalogQuery('collations'))
  const at = dialect === 'mysql' ? 1 : 0
  const names = (collations.data?.rows ?? []).map((r) => String(r[at] ?? '')).filter((n) => n !== '')
  const [collation, setCollation] = useState('')
  const [applyToTables, setApplyToTables] = useState(dialect === 'postgres')
  const valid = collation.trim() !== '' && (dialect === 'mysql' || applyToTables)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (valid) flow.preview({ op: 'setDatabaseCollation', name: db, collation: collation.trim(), applyToTables })
  }
  return (
    <section className="rounded border border-line p-3">
      <form onSubmit={submit} className="space-y-2" aria-label={locale.ddl.titles.setDatabaseCollation}>
        <h2 className="text-sm font-semibold text-ink">{locale.ddl.titles.setDatabaseCollation}</h2>
        <p className="text-xs text-ink-sub">
          {dialect === 'mysql' ? t.collationHintMysql(current) : t.collationHintPostgres}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <Field id="database-collation" label={locale.table.collation}>
            <Input
              id="database-collation"
              list="database-collation-names"
              value={collation}
              onChange={(e) => setCollation(e.target.value)}
              className="w-64 font-mono"
              autoComplete="off"
            />
          </Field>
          <datalist id="database-collation-names">
            {names.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <Button type="submit" variant="primary" aria-haspopup="dialog" disabled={!valid}>
            {locale.ddl.submit}
          </Button>
        </div>
        <label className="flex items-center gap-1 text-sm">
          <input
            type="checkbox"
            checked={applyToTables}
            disabled={dialect === 'postgres'}
            onChange={(e) => setApplyToTables(e.target.checked)}
          />
          {t.applyToTables}
        </label>
      </form>
      <DdlPreviewDialog flow={flow} />
    </section>
  )
}
