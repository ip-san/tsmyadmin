import { useQueries, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { type DdlOp, type Dialect, encodeTableList } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { createStatementQuery, databasesQuery, schemasQuery } from '@/lib/queries.ts'

const t = locale.bulk

type Maintain = Extract<DdlOp, { op: 'maintainTables' }>['action']
const MAINTENANCE: Record<Dialect, Maintain[]> = {
  mysql: ['analyze', 'check', 'checksum', 'optimize', 'repair'],
  postgres: ['analyze', 'vacuum', 'optimize'],
}

/** New names for a prefix added to, or replaced at the start of, each name; a name without `from` is left alone. */
export function prefixRenames(tables: string[], to: string, from?: string): { from: string; to: string }[] {
  return tables.flatMap((name) => {
    if (from === undefined) return [{ from: name, to: `${to}${name}` }]
    return name.startsWith(from) && from !== to ? [{ from: name, to: `${to}${name.slice(from.length)}` }] : []
  })
}

type Dialogs = 'prefix' | 'replace' | 'copy' | 'create' | null

/** phpMyAdmin's "With selected" under the table list: every action on the ticked tables, through the preview. */
export function TableBulkBar({
  db,
  schema,
  dialect,
  chosen,
  onPreview,
}: {
  db: string
  schema: string | undefined
  dialect: Dialect
  chosen: string[]
  onPreview: (op: DdlOp) => void
}) {
  const [dialog, setDialog] = useState<Dialogs>(null)
  const close = () => setDialog(null)
  const link = 'text-xs text-blue-700 hover:underline dark:text-blue-300'
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-line bg-surface-sub px-3 py-2 text-sm">
      <span>{locale.ddl.bulkSelected(chosen.length)}</span>
      <Link
        to="/db/$db/export"
        params={{ db }}
        search={{ ...(schema ? { schema } : {}), tables: encodeTableList(chosen) }}
        className={link}
      >
        {locale.ddl.bulkExport}
      </Link>
      <Button size="sm" aria-haspopup="dialog" onClick={() => setDialog('create')}>
        {t.showCreate}
      </Button>
      <Select
        aria-label={t.maintain}
        value=""
        onChange={(e) => {
          const action = e.target.value as Maintain | ''
          if (action) onPreview({ op: 'maintainTables', tables: chosen, action })
        }}
        className="w-auto py-1 text-xs"
      >
        <option value="">{t.maintain}</option>
        {MAINTENANCE[dialect].map((a) => (
          <option key={a} value={a}>
            {locale.ddl.maintenance[dialect][a]}
          </option>
        ))}
      </Select>
      <Button size="sm" aria-haspopup="dialog" onClick={() => setDialog('copy')}>
        {t.copy}
      </Button>
      <Button size="sm" aria-haspopup="dialog" onClick={() => setDialog('prefix')}>
        {t.addPrefix}
      </Button>
      <Button size="sm" aria-haspopup="dialog" onClick={() => setDialog('replace')}>
        {t.replacePrefix}
      </Button>
      <Button
        size="sm"
        variant="danger"
        aria-haspopup="dialog"
        onClick={() => onPreview({ op: 'truncateTables', tables: chosen })}
      >
        {locale.ddl.bulkTruncate}
      </Button>
      <Button
        size="sm"
        variant="danger"
        aria-haspopup="dialog"
        onClick={() => onPreview({ op: 'dropTables', tables: chosen })}
      >
        {locale.ddl.bulkDrop}
      </Button>

      <Dialog
        open={dialog === 'prefix' || dialog === 'replace'}
        title={dialog === 'replace' ? t.replacePrefix : t.addPrefix}
        onClose={close}
      >
        {dialog === 'prefix' || dialog === 'replace' ? (
          <PrefixForm
            replace={dialog === 'replace'}
            onCancel={close}
            onSubmit={(to, from) => {
              close()
              const renames = prefixRenames(chosen, to, from)
              if (renames.length > 0) onPreview({ op: 'renameTables', renames })
            }}
          />
        ) : null}
      </Dialog>
      <Dialog open={dialog === 'copy'} title={locale.ddl.titles.copyTables} onClose={close}>
        {dialog === 'copy' ? (
          <CopyForm
            db={db}
            schema={schema}
            dialect={dialect}
            onCancel={close}
            onSubmit={(space, withData) => {
              close()
              onPreview({
                op: 'copyTables',
                tables: chosen,
                withData,
                ...(dialect === 'mysql' ? { toDatabase: space } : { toSchema: space }),
              })
            }}
          />
        ) : null}
      </Dialog>
      <Dialog open={dialog === 'create'} title={t.showCreate} onClose={close}>
        {dialog === 'create' ? <CreateStatements db={db} schema={schema} tables={chosen} /> : null}
      </Dialog>
    </div>
  )
}

function PrefixForm({
  replace,
  onSubmit,
  onCancel,
}: {
  replace: boolean
  onSubmit: (to: string, from?: string) => void
  onCancel: () => void
}) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (replace ? from !== '' : to !== '') onSubmit(to, replace ? from : undefined)
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      {replace ? (
        <Field id="prefix-from" label={t.prefixFrom}>
          <Input id="prefix-from" value={from} onChange={(e) => setFrom(e.target.value)} required autoComplete="off" />
        </Field>
      ) : null}
      <Field id="prefix-to" label={replace ? t.prefixTo : t.prefix} {...(replace ? { hint: t.prefixToHint } : {})}>
        <Input
          id="prefix-to"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          required={!replace}
          autoComplete="off"
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{locale.common.cancel}</Button>
        <Button type="submit" variant="primary" disabled={replace ? from === '' : to === ''}>
          {locale.ddl.submit}
        </Button>
      </div>
    </form>
  )
}

function CopyForm({
  db,
  schema,
  dialect,
  onSubmit,
  onCancel,
}: {
  db: string
  schema: string | undefined
  dialect: Dialect
  onSubmit: (space: string, withData: boolean) => void
  onCancel: () => void
}) {
  const own = dialect === 'mysql' ? db : (schema ?? 'public')
  const databases = useQuery({ ...databasesQuery, enabled: dialect === 'mysql' })
  const schemas = useQuery({ ...schemasQuery(db), enabled: dialect === 'postgres' })
  const spaces = (dialect === 'mysql' ? (databases.data ?? []).map((d) => d.name) : (schemas.data ?? [])).filter(
    (n) => n !== own
  )
  const [space, setSpace] = useState('')
  const [withData, setWithData] = useState(true)
  const target = spaces.includes(space) ? space : (spaces[0] ?? '')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (target) onSubmit(target, withData)
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-xs text-ink-sub">{t.copyHint}</p>
      <Field id="bulk-copy-space" label={dialect === 'mysql' ? locale.ddl.copyToDatabase : locale.ddl.copyToSchema}>
        <Select id="bulk-copy-space" value={target} onChange={(e) => setSpace(e.target.value)}>
          {spaces.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      </Field>
      <label className="flex items-center gap-1 text-sm">
        <input type="checkbox" checked={withData} onChange={(e) => setWithData(e.target.checked)} />
        {locale.ddl.copyWithData}
      </label>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{locale.common.cancel}</Button>
        <Button type="submit" variant="primary" disabled={!target}>
          {locale.ddl.submit}
        </Button>
      </div>
    </form>
  )
}

/** The CREATE statements of the ticked tables, one after another, to read or copy. */
function CreateStatements({ db, schema, tables }: { db: string; schema: string | undefined; tables: string[] }) {
  const results = useQueries({ queries: tables.map((table) => createStatementQuery({ db, schema, table })) })
  const text = results
    .map((r, i) =>
      r.data ? r.data.definition : r.isError ? `-- ${tables[i]}: ${t.createFailed}` : `-- ${tables[i]} …`
    )
    .join('\n\n')
  return (
    <pre
      tabIndex={0}
      aria-label={t.showCreate}
      className="max-h-96 overflow-auto rounded border border-line p-2 font-mono text-xs text-ink"
    >
      {text}
    </pre>
  )
}
