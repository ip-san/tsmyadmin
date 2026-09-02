import type { Dialect } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import {
  type ColumnFormValues,
  EMPTY_COLUMN,
  TYPE_SUGGESTIONS,
  toColumnSpec,
  validateColumn,
} from '@/lib/column-spec.ts'
import { useDdlFlow } from '@/lib/ddl.ts'

interface Row extends ColumnFormValues {
  primary: boolean
}

const newRow = (): Row => ({ ...EMPTY_COLUMN, primary: false })

/** phpMyAdmin-style "create table" block shown under the database structure list. */
export function CreateTableForm({
  db,
  schema,
  dialect,
}: {
  db: string
  schema?: string | undefined
  dialect: Dialect
}) {
  const [name, setName] = useState('')
  const [rows, setRows] = useState<Row[]>([
    {
      ...newRow(),
      name: 'id',
      dataType: TYPE_SUGGESTIONS[dialect][0] ?? 'INT',
      nullable: false,
      autoIncrement: true,
      primary: true,
    },
    newRow(),
  ])
  const flow = useDdlFlow(db, schema, () => {
    setName('')
    setRows([newRow()])
  })
  const update = (i: number, patch: Partial<Row>) =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)))
  // A row with no name and no type is an untouched blank line, not an error.
  const filled = rows.filter((r) => r.name.trim() !== '' || r.dataType.trim() !== '')
  const valid = name.trim() !== '' && filled.length > 0 && filled.every((r) => validateColumn(r) === null)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!valid) return
    flow.preview({
      op: 'createTable',
      table: name.trim(),
      columns: filled.map(toColumnSpec),
      primaryKey: filled.filter((r) => r.primary).map((r) => r.name.trim()),
    })
  }
  return (
    <form onSubmit={submit} className="space-y-3" aria-label={locale.ddl.createTableTitle}>
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{locale.ddl.createTableTitle}</h2>
      <div className="max-w-sm">
        <Field id="new-table-name" label={locale.ddl.tableName}>
          <Input
            id="new-table-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoComplete="off"
          />
        </Field>
      </div>
      <Table>
        <thead>
          <tr>
            <Th>{locale.ddl.columnName}</Th>
            <Th>{locale.ddl.dataType}</Th>
            <Th>{locale.ddl.nullable}</Th>
            <Th>{locale.ddl.autoIncrement}</Th>
            <Th>{locale.ddl.primaryKey}</Th>
            <Th>{locale.ddl.default}</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <Tr key={i}>
              <Td>
                <Input
                  aria-label={`${locale.ddl.columnName} ${i + 1}`}
                  value={r.name}
                  onChange={(e) => update(i, { name: e.target.value })}
                />
              </Td>
              <Td>
                <Input
                  aria-label={`${locale.ddl.dataType} ${i + 1}`}
                  list="create-type-suggestions"
                  value={r.dataType}
                  onChange={(e) => update(i, { dataType: e.target.value })}
                  className="font-mono"
                />
              </Td>
              <Td className="text-center">
                <input
                  type="checkbox"
                  aria-label={`${locale.ddl.nullable} ${i + 1}`}
                  checked={r.nullable}
                  onChange={(e) => update(i, { nullable: e.target.checked })}
                />
              </Td>
              <Td className="text-center">
                <input
                  type="checkbox"
                  aria-label={`${locale.ddl.autoIncrement} ${i + 1}`}
                  checked={r.autoIncrement}
                  onChange={(e) => update(i, { autoIncrement: e.target.checked })}
                />
              </Td>
              <Td className="text-center">
                <input
                  type="checkbox"
                  aria-label={`${locale.ddl.primaryKey} ${i + 1}`}
                  checked={r.primary}
                  onChange={(e) =>
                    update(i, { primary: e.target.checked, nullable: e.target.checked ? false : r.nullable })
                  }
                />
              </Td>
              <Td>
                <div className="flex gap-1">
                  <Select
                    aria-label={`${locale.ddl.default} ${i + 1}`}
                    value={r.defaultKind}
                    onChange={(e) => update(i, { defaultKind: e.target.value as Row['defaultKind'] })}
                    className="w-auto"
                  >
                    <option value="none">{locale.ddl.defaultNone}</option>
                    <option value="literal">{locale.ddl.defaultLiteral}</option>
                    <option value="expression">{locale.ddl.defaultExpression}</option>
                  </Select>
                  <Input
                    aria-label={`${locale.ddl.default} ${locale.rows.value} ${i + 1}`}
                    value={r.defaultValue}
                    disabled={r.defaultKind === 'none'}
                    onChange={(e) => update(i, { defaultValue: e.target.value })}
                    className="font-mono"
                  />
                </div>
              </Td>
              <Td>
                <Button
                  size="sm"
                  onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                  disabled={rows.length <= 1}
                  aria-label={`${locale.ddl.removeColumnRow} ${i + 1}`}
                >
                  ×
                </Button>
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      <datalist id="create-type-suggestions">
        {TYPE_SUGGESTIONS[dialect].map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <div className="flex gap-2">
        <Button onClick={() => setRows((r) => [...r, newRow()])}>{locale.ddl.addColumnRow}</Button>
        <Button type="submit" variant="primary" disabled={!valid}>
          {locale.ddl.submit}
        </Button>
      </div>
      <DdlPreviewDialog flow={flow} />
    </form>
  )
}
