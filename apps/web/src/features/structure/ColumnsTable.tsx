import type { TableSchema } from '@tsmyadmin/shared'
import { isGeneratedColumn } from '@tsmyadmin/shared'
import { Button } from '@/components/ui/Button.tsx'
import { Badge } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'

export function ColumnsTable({
  schema,
  editable,
  onEdit,
  onDrop,
}: {
  schema: TableSchema
  editable: boolean
  onEdit: (name: string) => void
  onDrop: (name: string) => void
}) {
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
          {editable ? <Th>{locale.ddl.actions}</Th> : null}
        </tr>
      </thead>
      <tbody>
        {schema.columns.map((c, i) => (
          <Tr key={c.name}>
            <Td>{i + 1}</Td>
            <Td className="font-medium">
              {c.name} {pk.has(c.name) ? <Badge tone="info">{locale.table.primary}</Badge> : null}
            </Td>
            <Td className="font-mono text-xs">{c.dataType}</Td>
            <Td className="text-xs">{c.collation ?? ''}</Td>
            <Td className="whitespace-nowrap">{c.nullable ? locale.common.yes : locale.common.no}</Td>
            <Td className="font-mono text-xs">
              {c.default !== null ? (
                c.default
              ) : c.nullable ? (
                <span className="italic text-zinc-500 dark:text-zinc-400">{locale.common.null}</span>
              ) : (
                <span className="text-zinc-500 dark:text-zinc-400">{locale.table.noDefault}</span>
              )}
            </Td>
            <Td className="text-xs">{c.extra}</Td>
            <Td className="text-xs">{c.comment ?? ''}</Td>
            {editable ? (
              <Td className="whitespace-nowrap">
                {/* MySQL rewrites the whole column, and the form cannot express a generation expression: editing
                    here would silently turn a generated column into a plain one. */}
                <Button
                  size="sm"
                  onClick={() => onEdit(c.name)}
                  disabled={isGeneratedColumn(c.extra)}
                  title={isGeneratedColumn(c.extra) ? locale.ddl.generatedNotEditable : undefined}
                  aria-label={`${c.name}: ${locale.ddl.edit}`}
                >
                  {locale.ddl.edit}
                </Button>{' '}
                <Button
                  size="sm"
                  variant="danger"
                  aria-haspopup="dialog"
                  onClick={() => onDrop(c.name)}
                  aria-label={`${c.name}: ${locale.ddl.drop}`}
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
