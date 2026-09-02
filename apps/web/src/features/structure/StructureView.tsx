import { useQuery } from '@tanstack/react-query'
import type { Dialect, TableSchema } from '@tsmyadmin/shared'
import { useState } from 'react'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { DefinitionToggle } from '@/components/ddl/DefinitionToggle.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { Badge, ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { fromColumnDef, toColumnSpec } from '@/lib/column-spec.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import { createStatementQuery, structureQuery, type TableRef } from '@/lib/queries.ts'
import { ColumnForm } from './ColumnForm.tsx'
import { ForeignKeyForm } from './ForeignKeyForm.tsx'
import { IndexForm } from './IndexForm.tsx'
import { ForeignKeysTable, ReferencedByTable } from './RelationsTables.tsx'

type ColumnDialog = { mode: 'add' } | { mode: 'modify'; name: string } | null

function ColumnsTable({
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
                <Button size="sm" onClick={() => onEdit(c.name)} aria-label={`${c.name}: ${locale.ddl.edit}`}>
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

function IndexesTable({
  schema,
  editable,
  onDrop,
}: {
  schema: TableSchema
  editable: boolean
  onDrop: (name: string) => void
}) {
  if (schema.indexes.length === 0) return <Notice>{locale.table.noIndexes}</Notice>
  return (
    <Table aria-label={locale.table.indexes}>
      <thead>
        <tr>
          <Th>{locale.table.name}</Th>
          <Th>{locale.table.columns}</Th>
          <Th>{locale.table.unique}</Th>
          <Th>{locale.table.indexType}</Th>
          {editable ? <Th>{locale.ddl.actions}</Th> : null}
        </tr>
      </thead>
      <tbody>
        {schema.indexes.map((i) => (
          <Tr key={i.name}>
            <Td className="font-medium">
              {i.name} {i.primary ? <Badge tone="info">{locale.table.primary}</Badge> : null}
            </Td>
            <Td className="font-mono text-xs">
              {i.columns.join(', ')}
              {i.predicate ? <span className="text-zinc-500 dark:text-zinc-400"> WHERE {i.predicate}</span> : null}
            </Td>
            <Td>{i.unique ? locale.common.yes : locale.common.no}</Td>
            <Td className="text-xs">{i.type ?? ''}</Td>
            {editable ? (
              <Td>
                {i.primary ? null : (
                  <Button
                    size="sm"
                    variant="danger"
                    aria-haspopup="dialog"
                    onClick={() => onDrop(i.name)}
                    aria-label={`${i.name}: ${locale.ddl.drop}`}
                  >
                    {locale.ddl.drop}
                  </Button>
                )}
              </Td>
            ) : null}
          </Tr>
        ))}
      </tbody>
    </Table>
  )
}

/** Section heading with optional action buttons as siblings (buttons must not be heading content). */
function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-3">
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{children}</h2>
      {action}
    </div>
  )
}

export function StructureView({ tableRef, dialect }: { tableRef: TableRef; dialect: Dialect }) {
  const structure = useQuery(structureQuery(tableRef))
  const flow = useDdlFlow(tableRef.db, tableRef.schema)
  const [columnDialog, setColumnDialog] = useState<ColumnDialog>(null)
  const [indexDialog, setIndexDialog] = useState(false)
  const [fkDialog, setFkDialog] = useState(false)
  if (structure.isPending) return <Spinner />
  if (structure.isError) return <ErrorBox error={structure.error} onRetry={() => void structure.refetch()} />
  const s = structure.data
  const editable = s.kind === 'table'
  const table = tableRef.table
  const editing = columnDialog?.mode === 'modify' ? s.columns.find((c) => c.name === columnDialog.name) : undefined

  return (
    <div className="space-y-6">
      <DdlPreviewDialog flow={flow} />
      <section>
        <SectionTitle
          action={
            editable ? (
              <Button size="sm" onClick={() => setColumnDialog({ mode: 'add' })}>
                {locale.ddl.titles.addColumn}
              </Button>
            ) : null
          }
        >
          {locale.table.columns}
          {s.comment ? <span className="font-normal text-zinc-500 dark:text-zinc-400">— {s.comment}</span> : null}
        </SectionTitle>
        <ColumnsTable
          schema={s}
          editable={editable}
          onEdit={(name) => setColumnDialog({ mode: 'modify', name })}
          onDrop={(name) => flow.preview({ op: 'dropColumn', table, name })}
        />
      </section>
      <section>
        <SectionTitle
          action={
            editable ? (
              <Button size="sm" onClick={() => setIndexDialog(true)}>
                {locale.ddl.titles.addIndex}
              </Button>
            ) : null
          }
        >
          {locale.table.indexes}
        </SectionTitle>
        <IndexesTable
          schema={s}
          editable={editable}
          onDrop={(name) => flow.preview({ op: 'dropIndex', table, name })}
        />
      </section>
      <section>
        <SectionTitle
          action={
            editable ? (
              <Button size="sm" onClick={() => setFkDialog(true)}>
                {locale.ddl.titles.addForeignKey}
              </Button>
            ) : null
          }
        >
          {locale.table.foreignKeys}
        </SectionTitle>
        <ForeignKeysTable
          schema={s}
          {...(editable ? { onDrop: (name: string) => flow.preview({ op: 'dropForeignKey', table, name }) } : {})}
        />
      </section>
      <section>
        <SectionTitle>{locale.table.referencedBy}</SectionTitle>
        <ReferencedByTable schema={s} />
      </section>
      <section>
        <SectionTitle>{locale.table.createStatement}</SectionTitle>
        <DefinitionToggle query={createStatementQuery(tableRef)} label={table} />
      </section>

      <Dialog
        open={columnDialog !== null}
        title={columnDialog?.mode === 'modify' ? locale.ddl.titles.modifyColumn : locale.ddl.titles.addColumn}
        onClose={() => setColumnDialog(null)}
      >
        {columnDialog ? (
          <ColumnForm
            key={columnDialog.mode === 'modify' ? columnDialog.name : 'add'}
            dialect={dialect}
            {...(editing ? { initial: fromColumnDef(editing, dialect) } : {})}
            {...(columnDialog.mode === 'add' ? { positions: s.columns.map((c) => c.name) } : {})}
            onCancel={() => setColumnDialog(null)}
            onSubmit={(values, after) => {
              const column = toColumnSpec(values)
              setColumnDialog(null)
              if (columnDialog.mode === 'modify')
                flow.preview({
                  op: 'modifyColumn',
                  table,
                  name: columnDialog.name,
                  column,
                  // The current definition lets PostgreSQL emit only the clauses that change.
                  ...(editing ? { previous: toColumnSpec(fromColumnDef(editing, dialect)) } : {}),
                })
              else flow.preview({ op: 'addColumn', table, column, ...(after ? { after } : {}) })
            }}
          />
        ) : null}
      </Dialog>
      <Dialog open={indexDialog} title={locale.ddl.titles.addIndex} onClose={() => setIndexDialog(false)}>
        {indexDialog ? (
          <IndexForm
            table={table}
            columns={s.columns.map((c) => c.name)}
            onCancel={() => setIndexDialog(false)}
            onSubmit={(v) => {
              setIndexDialog(false)
              flow.preview({ op: 'addIndex', table, ...v })
            }}
          />
        ) : null}
      </Dialog>
      <Dialog open={fkDialog} title={locale.ddl.titles.addForeignKey} onClose={() => setFkDialog(false)}>
        {fkDialog ? (
          <ForeignKeyForm
            tableRef={tableRef}
            columns={s.columns.map((c) => c.name)}
            onCancel={() => setFkDialog(false)}
            onSubmit={(v) => {
              setFkDialog(false)
              flow.preview({ op: 'addForeignKey', table, ...v })
            }}
          />
        ) : null}
      </Dialog>
    </div>
  )
}
