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
  selected,
  onToggle,
  onDistinct,
}: {
  schema: TableSchema
  editable: boolean
  onEdit: (name: string) => void
  onDrop: (name: string) => void
  /** Ticked columns, for the actions under the list (omit to show no checkboxes). */
  selected?: ReadonlySet<string>
  onToggle?: (name: string) => void
  /** Opens the distinct values of a column (a view's columns too: it only reads). */
  onDistinct?: (name: string) => void
}) {
  const pk = new Set(schema.primaryKey)
  return (
    <Table aria-label={locale.table.columns}>
      <thead>
        <tr>
          {editable && selected ? (
            <Th>
              <span className="sr-only">{locale.ddl.bulk.pick}</span>
            </Th>
          ) : null}
          <Th>#</Th>
          <Th>{locale.table.name}</Th>
          <Th>{locale.table.type}</Th>
          <Th>{locale.table.collation}</Th>
          <Th>{locale.table.nullable}</Th>
          <Th>{locale.table.default}</Th>
          <Th>{locale.table.extra}</Th>
          <Th>{locale.table.comment}</Th>
          {editable || onDistinct ? <Th>{locale.ddl.actions}</Th> : null}
        </tr>
      </thead>
      <tbody>
        {schema.columns.map((c, i) => (
          <Tr key={c.name}>
            {editable && selected ? (
              <Td>
                <input
                  type="checkbox"
                  aria-label={`${c.name}: ${locale.ddl.bulk.pick}`}
                  checked={selected.has(c.name)}
                  onChange={() => onToggle?.(c.name)}
                />
              </Td>
            ) : null}
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
                <span className="italic text-ink-sub">{locale.common.null}</span>
              ) : (
                <span className="text-ink-sub">{locale.table.noDefault}</span>
              )}
            </Td>
            <Td className="text-xs">{c.extra}</Td>
            <Td className="text-xs">{c.comment ?? ''}</Td>
            {editable || onDistinct ? (
              <Td className="whitespace-nowrap">
                {onDistinct ? (
                  <>
                    <Button
                      size="sm"
                      aria-haspopup="dialog"
                      onClick={() => onDistinct(c.name)}
                      aria-label={`${c.name}: ${locale.table.distinct.button}`}
                    >
                      {locale.table.distinct.button}
                    </Button>{' '}
                  </>
                ) : null}
                {editable ? (
                  <>
                    {/* A generated column is editable when its expression was read back: MySQL rewrites the whole
                    column, and without the expression the edit would silently turn it into a plain one. */}
                    <Button
                      size="sm"
                      onClick={() => onEdit(c.name)}
                      disabled={isGeneratedColumn(c.extra) && !c.generated}
                      title={isGeneratedColumn(c.extra) && !c.generated ? locale.ddl.generatedNotEditable : undefined}
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
                  </>
                ) : null}
              </Td>
            ) : null}
          </Tr>
        ))}
      </tbody>
    </Table>
  )
}
