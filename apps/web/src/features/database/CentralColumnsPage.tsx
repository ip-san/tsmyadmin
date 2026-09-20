import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CentralColumnBody, ColumnDef, Dialect } from '@tsmyadmin/shared'
import { type FormEvent, useId, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Card } from '@/components/ui/Card.tsx'
import { ErrorBox, Notice } from '@/components/ui/Feedback.tsx'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { TypeInput } from '@/components/ui/TypeInput.tsx'
import { locale } from '@/config/locale.ts'
import { useCentralColumns } from '@/lib/central-columns.ts'
import { downloadText, safeFilename } from '@/lib/download.ts'
import { centralColumnsQuery, mutations, structureQuery, tablesQuery } from '@/lib/queries.ts'

const t = locale.central

/** A table's column as a central column of the same database. */
function toCentral(c: ColumnDef, database: string, schema: string | undefined): CentralColumnBody {
  return {
    database,
    ...(schema ? { schema } : {}),
    name: c.name,
    dataType: c.dataType,
    nullable: c.nullable,
    default: c.default,
    defaultIsExpression: c.defaultIsExpression,
    comment: c.comment ?? '',
  }
}

type CentralDraft = Omit<CentralColumnBody, 'database'>

/** The form to add a central column; with `initial` it edits that one instead (remount it with a new `key`). */
function AddForm({
  onAdd,
  onCancel,
  initial,
  dialect,
}: {
  onAdd: (c: CentralDraft) => void
  onCancel?: () => void
  initial?: CentralDraft | undefined
  dialect: Dialect
}) {
  const id = useId()
  const [name, setName] = useState(initial?.name ?? '')
  const [dataType, setDataType] = useState(initial?.dataType ?? '')
  const [nullable, setNullable] = useState(initial?.nullable ?? true)
  const [def, setDef] = useState(initial?.default ?? '')
  const [expression, setExpression] = useState(initial?.defaultIsExpression ?? false)
  const [comment, setComment] = useState(initial?.comment ?? '')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !dataType.trim()) return
    onAdd({
      name: name.trim(),
      dataType: dataType.trim(),
      nullable,
      default: def === '' ? null : def,
      defaultIsExpression: def !== '' && expression,
      comment,
    })
    setName('')
    setDataType('')
    setDef('')
    setComment('')
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <Field id={`${id}-name`} label={locale.ddl.columnName}>
        <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} required autoComplete="off" />
      </Field>
      <Field id={`${id}-type`} label={locale.ddl.dataType}>
        <TypeInput id={`${id}-type`} required dialect={dialect} value={dataType} onChange={setDataType} />
      </Field>
      <Field id={`${id}-default`} label={locale.ddl.default}>
        <Input id={`${id}-default`} value={def} onChange={(e) => setDef(e.target.value)} className="font-mono" />
      </Field>
      <label className="flex items-center gap-1 pb-2 text-sm text-ink">
        <input type="checkbox" checked={expression} onChange={(e) => setExpression(e.target.checked)} />
        {t.expression}
      </label>
      <label className="flex items-center gap-1 pb-2 text-sm text-ink">
        <input type="checkbox" checked={nullable} onChange={(e) => setNullable(e.target.checked)} />
        {locale.ddl.nullable}
      </label>
      <Field id={`${id}-comment`} label={locale.ddl.comment}>
        <Input id={`${id}-comment`} value={comment} onChange={(e) => setComment(e.target.value)} />
      </Field>
      <Button type="submit" variant="primary">
        {initial ? t.saveEdit : t.add}
      </Button>
      {onCancel ? <Button onClick={onCancel}>{locale.common.cancel}</Button> : null}
    </form>
  )
}

function ImportFromTable({
  db,
  schema,
  onImport,
}: {
  db: string
  schema: string | undefined
  onImport: (columns: ColumnDef[]) => void
}) {
  const id = useId()
  const tables = useQuery(tablesQuery(db, schema))
  const names = (tables.data ?? []).filter((x) => x.kind === 'table').map((x) => x.name)
  const [chosen, setChosen] = useState('')
  const table = names.includes(chosen) ? chosen : (names[0] ?? '')
  const structure = useQuery({ ...structureQuery({ db, schema, table }), enabled: table !== '' })
  const [picked, setPicked] = useState<string[]>([])
  if (names.length === 0) return null
  const columns = structure.data?.columns ?? []
  return (
    <div className="space-y-2">
      <Field id={`${id}-table`} label={t.table}>
        <Select
          id={`${id}-table`}
          value={table}
          onChange={(e) => {
            setChosen(e.target.value)
            setPicked([])
          }}
        >
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      </Field>
      <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
        <legend className="mb-1 text-xs font-medium text-ink-sub">{t.columns}</legend>
        {columns.map((c) => (
          <label key={c.name} className="flex items-center gap-1 text-sm text-ink">
            <input
              type="checkbox"
              checked={picked.includes(c.name)}
              onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c.name] : p.filter((n) => n !== c.name)))}
            />
            <span className="font-mono">{c.name}</span>
          </label>
        ))}
      </fieldset>
      <Button
        disabled={picked.length === 0}
        onClick={() => {
          onImport(columns.filter((c) => picked.includes(c.name)))
          setPicked([])
        }}
      >
        {t.importSelected}
      </Button>
    </div>
  )
}

/**
 * phpMyAdmin's central columns: definitions of the columns this database uses again and again, kept so that
 * adding one to a table (Structure → Add column) can start from the same definition every time. Nothing here
 * changes a table.
 */
export function CentralColumnsPage({
  db,
  schema,
  dialect,
}: {
  db: string
  schema?: string | undefined
  dialect: Dialect
}) {
  const list = useCentralColumns(db, schema)
  const queryClient = useQueryClient()
  const [importError, setImportError] = useState<Error | null>(null)
  const [editing, setEditing] = useState<(typeof list.entries)[number] | null>(null)
  const save = (c: CentralDraft) => list.save(c.name, { ...c, database: db, ...(schema ? { schema } : {}) })
  // One after another on the server: fired together, the replies (each the whole list) could arrive out of order
  // and the last to land would not be the last written.
  const importColumns = async (columns: ColumnDef[]) => {
    setImportError(null)
    if (!list.onServer) {
      for (const c of columns) save(toCentral(c, db, schema))
      return
    }
    try {
      for (const c of columns) await mutations.saveCentralColumn(toCentral(c, db, schema))
    } catch (error) {
      setImportError(error instanceof Error ? error : new Error(String(error)))
    } finally {
      await queryClient.invalidateQueries({ queryKey: centralColumnsQuery.queryKey })
    }
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-sub">{t.hint}</p>
      <p className="text-xs text-ink-sub">{list.onServer ? locale.sql.savedOnServer : locale.sql.savedInBrowser}</p>
      {list.error ? <ErrorBox error={list.error} /> : null}
      <Card title={t.title} bleed>
        {list.entries.length === 0 ? (
          <Notice>{t.empty}</Notice>
        ) : (
          <Table aria-label={t.title}>
            <thead>
              <tr>
                <Th>{locale.ddl.columnName}</Th>
                <Th>{locale.ddl.dataType}</Th>
                <Th>NULL</Th>
                <Th>{locale.ddl.default}</Th>
                <Th>{locale.ddl.comment}</Th>
                <Th>
                  <span className="sr-only">{locale.ddl.actions}</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {list.entries.map((c) => (
                <Tr key={c.id || c.name}>
                  <Td className="font-medium">{c.name}</Td>
                  <Td className="font-mono text-xs">{c.dataType}</Td>
                  <Td>{c.nullable ? locale.common.yes : locale.common.no}</Td>
                  <Td className="font-mono text-xs">{c.default ?? ''}</Td>
                  <Td className="text-xs">{c.comment}</Td>
                  <Td>
                    <Button size="sm" onClick={() => setEditing(c)} aria-label={t.edit(c.name)}>
                      {locale.server.editVariable}
                    </Button>{' '}
                    <Button size="sm" variant="danger" onClick={() => list.remove(c)} aria-label={t.remove(c.name)}>
                      {locale.common.delete}
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {list.entries.length > 0 ? (
        <Button
          onClick={() =>
            downloadText(
              safeFilename(`${db}-central-columns`, 'json'),
              `${JSON.stringify(
                list.entries.map(({ id: _id, ...c }) => c),
                null,
                2
              )}\n`,
              'application/json;charset=utf-8'
            )
          }
        >
          {t.download}
        </Button>
      ) : null}
      <Card title={editing ? t.editTitle(editing.name) : t.addTitle}>
        <AddForm
          key={editing?.id || editing?.name || 'new'}
          dialect={dialect}
          initial={editing ?? undefined}
          {...(editing ? { onCancel: () => setEditing(null) } : {})}
          onAdd={(c) => {
            // A renamed column is a new entry: the old name goes.
            if (editing && editing.name !== c.name) list.remove(editing)
            save(c)
            setEditing(null)
          }}
        />
      </Card>
      <Card title={t.fromTable}>
        <ImportFromTable db={db} schema={schema} onImport={(cols) => void importColumns(cols)} />
        {importError ? <ErrorBox error={importError} className="mt-2" /> : null}
      </Card>
    </div>
  )
}
