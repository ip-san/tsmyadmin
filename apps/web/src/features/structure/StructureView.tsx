import { useQuery } from '@tanstack/react-query'
import type { DdlOp, Dialect } from '@tsmyadmin/shared'
import { useState } from 'react'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { DefinitionToggle } from '@/components/ddl/DefinitionToggle.tsx'
import { ForeignKeyForm } from '@/components/ddl/ForeignKeyForm.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Card } from '@/components/ui/Card.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { ColumnsTable } from '@/features/structure/ColumnsTable.tsx'
import { useCentralColumns } from '@/lib/central-columns.ts'
import { fromColumnDef, toColumnSpec } from '@/lib/column-spec.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import { createStatementQuery, structureQuery, type TableRef } from '@/lib/queries.ts'
import { ColumnBulk } from './ColumnBulk.tsx'
import { ColumnForm } from './ColumnForm.tsx'
import { type IndexDialog, IndexesCard } from './IndexesCard.tsx'
import { NormalizationHints } from './NormalizationHints.tsx'
import { PartitionsCard } from './PartitionsCard.tsx'
import { DisplayColumnSelect, ForeignKeysTable, ReferencedByTable } from './RelationsTables.tsx'
import { StatsCard } from './StatsCard.tsx'
import { TransformsCard } from './TransformsCard.tsx'

type ColumnDialog = { mode: 'add' } | { mode: 'modify'; name: string } | null

export function StructureView({ tableRef, dialect }: { tableRef: TableRef; dialect: Dialect }) {
  const structure = useQuery(structureQuery(tableRef))
  const flow = useDdlFlow(tableRef.db, tableRef.schema)
  const [columnDialog, setColumnDialog] = useState<ColumnDialog>(null)
  const central = useCentralColumns(tableRef.db, tableRef.schema)
  const [indexDialog, setIndexDialog] = useState<IndexDialog>(null)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [fkDialog, setFkDialog] = useState(false)
  if (structure.isPending) return <Spinner />
  if (structure.isError) return <ErrorBox error={structure.error} onRetry={() => void structure.refetch()} />
  const s = structure.data
  const editable = s.kind === 'table'
  const table = tableRef.table
  const editing = columnDialog?.mode === 'modify' ? s.columns.find((c) => c.name === columnDialog.name) : undefined
  // In table order, and only columns that still exist after a refetch.
  const selected = s.columns.map((c) => c.name).filter((n) => picked.has(n))
  const preview = (op: DdlOp) => {
    setPicked(new Set())
    flow.preview(op)
  }

  return (
    <div className="space-y-4">
      <DdlPreviewDialog flow={flow} />
      <Card
        title={
          <>
            {locale.table.columns}
            {s.comment ? <span className="ml-2 font-normal text-ink-sub">— {s.comment}</span> : null}
          </>
        }
        actions={
          editable ? (
            <Button size="sm" onClick={() => setColumnDialog({ mode: 'add' })}>
              {locale.ddl.titles.addColumn}
            </Button>
          ) : null
        }
        bleed
      >
        <ColumnsTable
          schema={s}
          editable={editable}
          onEdit={(name) => setColumnDialog({ mode: 'modify', name })}
          onDrop={(name) => flow.preview({ op: 'dropColumn', table, name })}
          selected={picked}
          onToggle={(name) =>
            setPicked((p) => {
              const next = new Set(p)
              if (next.has(name)) next.delete(name)
              else next.add(name)
              return next
            })
          }
        />
        {editable ? (
          <ColumnBulk
            schema={s}
            dialect={dialect}
            selected={selected}
            onPreview={preview}
            onIndex={(kind, columns) =>
              setIndexDialog({ mode: 'add', initial: { kind, columns, unique: kind === 'unique' } })
            }
          />
        ) : null}
      </Card>
      <IndexesCard
        schema={s}
        dialect={dialect}
        editable={editable}
        dialog={indexDialog}
        onDialog={setIndexDialog}
        onPreview={preview}
      />
      <Card
        title={locale.table.foreignKeys}
        actions={
          editable ? (
            <Button size="sm" onClick={() => setFkDialog(true)}>
              {locale.ddl.titles.addForeignKey}
            </Button>
          ) : null
        }
        bleed
      >
        <ForeignKeysTable
          schema={s}
          {...(editable ? { onDrop: (name: string) => flow.preview({ op: 'dropForeignKey', table, name }) } : {})}
        />
      </Card>
      <Card
        title={locale.table.referencedBy}
        actions={<DisplayColumnSelect tableRef={tableRef} columns={s.columns.map((c) => c.name)} />}
        bleed
      >
        <ReferencedByTable schema={s} />
      </Card>
      {editable ? <PartitionsCard tableRef={tableRef} dialect={dialect} onPreview={flow.preview} /> : null}
      <StatsCard tableRef={tableRef} />
      <Card title={locale.table.createStatement}>
        <DefinitionToggle query={createStatementQuery(tableRef)} label={table} />
      </Card>
      <TransformsCard tableRef={tableRef} columns={s.columns.map((c) => c.name)} />
      {editable ? <NormalizationHints tableRef={tableRef} schema={s} /> : null}

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
            mode={columnDialog.mode}
            {...(columnDialog.mode === 'add'
              ? { positions: s.columns.map((c) => c.name), presets: central.entries }
              : { positions: s.columns.map((c) => c.name).filter((n) => n !== columnDialog.name) })}
            onCancel={() => setColumnDialog(null)}
            onSubmit={(values, placement) => {
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
                  ...(placement.first ? { first: true } : {}),
                  ...(placement.after ? { after: placement.after } : {}),
                })
              else flow.preview({ op: 'addColumn', table, column, ...placement })
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
