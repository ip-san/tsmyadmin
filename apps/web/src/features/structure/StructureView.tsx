import { useQuery } from '@tanstack/react-query'
import type { TableSchema } from '@tsmyadmin/shared'
import { Badge, ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { structureQuery, type TableRef } from '@/lib/queries.ts'

function ColumnsTable({ schema }: { schema: TableSchema }) {
  const pk = new Set(schema.primaryKey)
  return (
    <Table aria-label={locale.table.columns}>
      <thead>
        <tr>
          <Th>#</Th>
          <Th>{locale.table.name}</Th>
          <Th>{locale.table.type}</Th>
          <Th>{locale.table.collation}</Th>
          <Th>{locale.table.nullable}</Th>
          <Th>{locale.table.default}</Th>
          <Th>{locale.table.extra}</Th>
          <Th>{locale.table.comment}</Th>
        </tr>
      </thead>
      <tbody>
        {schema.columns.map((c, i) => (
          <Tr key={c.name}>
            <Td className="text-zinc-400">{i + 1}</Td>
            <Td className="font-medium">
              {c.name} {pk.has(c.name) ? <Badge tone="info">{locale.table.primary}</Badge> : null}
            </Td>
            <Td className="font-mono text-xs">{c.dataType}</Td>
            <Td className="text-xs">{c.collation ?? ''}</Td>
            <Td>{c.nullable ? locale.common.yes : locale.common.no}</Td>
            <Td className="font-mono text-xs">
              {c.default === null ? <span className="italic text-zinc-400">{locale.common.null}</span> : c.default}
            </Td>
            <Td className="text-xs">{c.extra}</Td>
            <Td className="text-xs">{c.comment ?? ''}</Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  )
}

function IndexesTable({ schema }: { schema: TableSchema }) {
  if (schema.indexes.length === 0) return <Notice>{locale.table.noIndexes}</Notice>
  return (
    <Table aria-label={locale.table.indexes}>
      <thead>
        <tr>
          <Th>{locale.table.name}</Th>
          <Th>{locale.table.columns}</Th>
          <Th>{locale.table.unique}</Th>
          <Th>{locale.table.indexType}</Th>
        </tr>
      </thead>
      <tbody>
        {schema.indexes.map((i) => (
          <Tr key={i.name}>
            <Td className="font-medium">
              {i.name} {i.primary ? <Badge tone="info">{locale.table.primary}</Badge> : null}
            </Td>
            <Td className="font-mono text-xs">{i.columns.join(', ')}</Td>
            <Td>{i.unique ? locale.common.yes : locale.common.no}</Td>
            <Td className="text-xs">{i.type ?? ''}</Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  )
}

function ForeignKeysTable({ schema }: { schema: TableSchema }) {
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
          </Tr>
        ))}
      </tbody>
    </Table>
  )
}

export function StructureView({ tableRef }: { tableRef: TableRef }) {
  const structure = useQuery(structureQuery(tableRef))
  if (structure.isPending) return <Spinner />
  if (structure.isError) return <ErrorBox error={structure.error} />
  const s = structure.data
  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-200">
          {locale.table.columns}{' '}
          {s.comment ? <span className="font-normal text-zinc-500 dark:text-zinc-400">— {s.comment}</span> : null}
        </h2>
        <ColumnsTable schema={s} />
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-200">{locale.table.indexes}</h2>
        <IndexesTable schema={s} />
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-200">{locale.table.foreignKeys}</h2>
        <ForeignKeysTable schema={s} />
      </section>
    </div>
  )
}
