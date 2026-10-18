import type { RelationDef } from '@tsmyadmin/shared'
import { relationKey } from '@/components/schema-diagram/layout.ts'
import { Button } from '@/components/ui/Button.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale-screens.ts'

const t = locale.designer

/**
 * The foreign keys under the diagram, for anyone not using the picture: where each goes, its rules, and a button
 * to drop it. With the reference check on, a column says how many rows have no parent (`orphans`).
 */
export function DesignerKeys({
  keys,
  target,
  orphans,
  onDrop,
}: {
  keys: readonly RelationDef[]
  /** Where a key goes, as written in the table (qualified when it leaves this namespace). */
  target: (r: RelationDef) => string
  /** The reference check's count for a key, while the check is on. */
  orphans?: ((r: RelationDef) => string) | undefined
  onDrop: (r: RelationDef) => void
}) {
  return (
    <>
      <h3 className="text-sm font-semibold text-ink">{t.relations}</h3>
      {keys.length === 0 ? (
        <p className="text-sm text-ink-sub">{t.noRelations}</p>
      ) : (
        <Table aria-label={t.relations}>
          <thead>
            <tr>
              <Th>{t.table}</Th>
              <Th>{t.columns}</Th>
              <Th>{t.references}</Th>
              <Th>{t.refColumns}</Th>
              <Th>ON DELETE</Th>
              <Th>ON UPDATE</Th>
              <Th>{t.constraint}</Th>
              {orphans ? <Th>{t.refCheck.column}</Th> : null}
              <Th className="print:hidden">{locale.ddl.actions}</Th>
            </tr>
          </thead>
          <tbody>
            {keys.map((r) => (
              <Tr key={relationKey(r)}>
                <Td>{r.table}</Td>
                <Td>{r.columns.join(', ')}</Td>
                <Td>{target(r)}</Td>
                <Td>{r.refColumns.join(', ')}</Td>
                <Td>{r.onDelete ?? '—'}</Td>
                <Td>{r.onUpdate ?? '—'}</Td>
                <Td className="text-ink-sub">{r.name}</Td>
                {orphans ? <Td className="tabular-nums">{orphans(r)}</Td> : null}
                <Td className="print:hidden">
                  <Button
                    size="sm"
                    variant="danger"
                    aria-haspopup="dialog"
                    aria-label={t.dropKey(r.table, r.name)}
                    onClick={() => onDrop(r)}
                  >
                    {t.drop}
                  </Button>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  )
}
