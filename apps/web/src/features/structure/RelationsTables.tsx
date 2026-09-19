import type { TableSchema } from '@tsmyadmin/shared'
import { useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Notice } from '@/components/ui/Feedback.tsx'
import { Select } from '@/components/ui/Field.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { chooseDisplayColumn, chosenDisplayColumn } from '@/lib/display-column.ts'
import type { TableRef } from '@/lib/queries.ts'

export function ForeignKeysTable({ schema, onDrop }: { schema: TableSchema; onDrop?: (name: string) => void }) {
  if (schema.foreignKeys.length === 0) return <Notice>{locale.table.noForeignKeys}</Notice>
  return (
    <Table aria-label={locale.table.foreignKeys}>
      <thead>
        <tr>
          <Th>{locale.table.name}</Th>
          <Th>{locale.table.columns}</Th>
          <Th>{locale.table.references}</Th>
          <Th>{locale.table.onUpdate}</Th>
          <Th>{locale.table.onDelete}</Th>
          {onDrop ? <Th>{locale.ddl.actions}</Th> : null}
        </tr>
      </thead>
      <tbody>
        {schema.foreignKeys.map((fk) => (
          <Tr key={fk.name}>
            <Td className="font-medium">{fk.name}</Td>
            <Td className="font-mono text-xs">{fk.columns.join(', ')}</Td>
            <Td className="font-mono text-xs">
              {fk.refNamespace.schema ? `${fk.refNamespace.schema}.` : ''}
              {fk.refTable} ({fk.refColumns.join(', ')})
            </Td>
            <Td className="text-xs">{fk.onUpdate ?? ''}</Td>
            <Td className="text-xs">{fk.onDelete ?? ''}</Td>
            {onDrop ? (
              <Td>
                <Button
                  size="sm"
                  variant="danger"
                  aria-haspopup="dialog"
                  onClick={() => onDrop(fk.name)}
                  aria-label={`${fk.name}: ${locale.ddl.titles.dropForeignKey}`}
                >
                  {locale.ddl.drop}
                </Button>
              </Td>
            ) : null}
          </Tr>
        ))}
      </tbody>
    </Table>
  )
}

export function ReferencedByTable({ schema }: { schema: TableSchema }) {
  if (schema.referencedBy.length === 0) return <Notice>{locale.table.noReferencedBy}</Notice>
  return (
    <Table aria-label={locale.table.referencedBy}>
      <thead>
        <tr>
          <Th>{locale.table.name}</Th>
          <Th>{locale.table.fromTable}</Th>
          <Th>{locale.table.columns}</Th>
        </tr>
      </thead>
      <tbody>
        {schema.referencedBy.map((r) => (
          <Tr key={`${r.fromTable}:${r.name}`}>
            <Td className="font-medium">{r.name}</Td>
            <Td className="font-mono text-xs">
              {r.fromNamespace.schema ? `${r.fromNamespace.schema}.` : ''}
              {r.fromTable} ({r.fromColumns.join(', ')})
            </Td>
            <Td className="font-mono text-xs">{r.columns.join(', ')}</Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  )
}

/** This table's display column: what names its rows beside another table's foreign key values. */
export function DisplayColumnSelect({ tableRef, columns }: { tableRef: TableRef; columns: string[] }) {
  const [chosen, setChosen] = useState(() => chosenDisplayColumn(tableRef) ?? '')
  return (
    <label className="flex items-center gap-1 text-xs text-ink-sub" title={locale.table.displayColumnHint}>
      {locale.table.displayColumn}
      <Select
        value={columns.includes(chosen) ? chosen : ''}
        onChange={(e) => {
          setChosen(e.target.value)
          chooseDisplayColumn(tableRef, e.target.value || undefined)
        }}
        className="w-auto py-1"
      >
        <option value="">{locale.table.displayColumnAuto}</option>
        {columns.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </Select>
    </label>
  )
}
