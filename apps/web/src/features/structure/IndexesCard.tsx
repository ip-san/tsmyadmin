import type { DdlOp, Dialect, IndexDef, TableSchema } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Card } from '@/components/ui/Card.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { Badge, Notice } from '@/components/ui/Feedback.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { IndexForm, type IndexValues } from './IndexForm.tsx'

type Kind = IndexValues['kind']
type Method = NonNullable<IndexValues['method']>
const METHODS = new Set<string>(['btree', 'hash', 'gin', 'gist', 'brin', 'spgist'])

/** An index as the form's starting values: its kind and method read from the type the server reports. */
function valuesOf(i: IndexDef): Partial<IndexValues> {
  const type = (i.type ?? '').toLowerCase()
  const kind: Kind = type === 'fulltext' ? 'fulltext' : type === 'spatial' ? 'spatial' : i.unique ? 'unique' : 'index'
  return {
    name: i.name,
    columns: i.columns,
    unique: i.unique,
    kind,
    ...(METHODS.has(type) ? { method: type as Method } : {}),
    ...(Object.keys(i.lengths).length > 0 ? { lengths: i.lengths } : {}),
  }
}

/** A dialog asking for an index's new name. */
function RenameForm({
  name,
  onSubmit,
  onCancel,
}: {
  name: string
  onSubmit: (to: string) => void
  onCancel: () => void
}) {
  const [to, setTo] = useState(name)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (to.trim() && to.trim() !== name) onSubmit(to.trim())
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <Field id="idx-rename" label={locale.ddl.index.newName}>
        <Input id="idx-rename" value={to} onChange={(e) => setTo(e.target.value)} required autoComplete="off" />
      </Field>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{locale.common.cancel}</Button>
        <Button type="submit" variant="primary" disabled={!to.trim() || to.trim() === name}>
          {locale.ddl.submit}
        </Button>
      </div>
    </form>
  )
}

export type IndexDialog =
  | { mode: 'add'; initial?: Partial<IndexValues> }
  | { mode: 'edit'; index: IndexDef }
  | { mode: 'rename'; index: IndexDef }
  | null

/** The index list with its add / change / rename / drop, all through the SQL preview. */
export function IndexesCard({
  schema,
  dialect,
  editable,
  dialog,
  onDialog,
  onPreview,
}: {
  schema: TableSchema
  dialect: Dialect
  editable: boolean
  dialog: IndexDialog
  onDialog: (d: IndexDialog) => void
  onPreview: (op: DdlOp) => void
}) {
  const table = schema.name
  const columns = schema.columns.map((c) => c.name)
  const close = () => onDialog(null)
  // PostgreSQL's primary key is a constraint: it is replaced from the column list, not edited as an index.
  const canEdit = (i: IndexDef) => !(i.primary && dialect === 'postgres')
  return (
    <Card
      title={locale.table.indexes}
      actions={
        editable ? (
          <Button size="sm" onClick={() => onDialog({ mode: 'add' })}>
            {locale.ddl.titles.addIndex}
          </Button>
        ) : null
      }
      bleed
    >
      {schema.indexes.length === 0 ? (
        <Notice>{locale.table.noIndexes}</Notice>
      ) : (
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
                  {i.columns.map((c) => (i.lengths[c] ? `${c}(${i.lengths[c]})` : c)).join(', ')}
                  {i.predicate ? <span className="text-ink-sub"> WHERE {i.predicate}</span> : null}
                </Td>
                <Td>{i.unique ? locale.common.yes : locale.common.no}</Td>
                <Td className="text-xs">{i.type ?? ''}</Td>
                {editable ? (
                  <Td className="whitespace-nowrap">
                    {canEdit(i) && !i.predicate ? (
                      <Button
                        size="sm"
                        aria-haspopup="dialog"
                        onClick={() => onDialog({ mode: 'edit', index: i })}
                        aria-label={locale.ddl.index.editOf(i.name)}
                      >
                        {locale.ddl.edit}
                      </Button>
                    ) : null}{' '}
                    {i.primary ? null : (
                      <>
                        <Button
                          size="sm"
                          aria-haspopup="dialog"
                          onClick={() => onDialog({ mode: 'rename', index: i })}
                          aria-label={locale.ddl.index.renameOf(i.name)}
                        >
                          {locale.ddl.index.rename}
                        </Button>{' '}
                        <Button
                          size="sm"
                          variant="danger"
                          aria-haspopup="dialog"
                          onClick={() => onPreview({ op: 'dropIndex', table, name: i.name })}
                          aria-label={locale.ddl.index.dropOf(i.name)}
                        >
                          {locale.ddl.drop}
                        </Button>
                      </>
                    )}
                  </Td>
                ) : null}
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <Dialog
        open={dialog?.mode === 'add' || dialog?.mode === 'edit'}
        title={dialog?.mode === 'edit' ? locale.ddl.titles.alterIndex : locale.ddl.titles.addIndex}
        onClose={close}
      >
        {dialog?.mode === 'add' || dialog?.mode === 'edit' ? (
          <IndexForm
            key={dialog.mode === 'edit' ? dialog.index.name : JSON.stringify(dialog.initial ?? null)}
            table={table}
            dialect={dialect}
            columns={columns}
            {...(dialog.mode === 'edit'
              ? { initial: valuesOf(dialog.index) }
              : dialog.initial
                ? { initial: dialog.initial }
                : {})}
            onCancel={close}
            onSubmit={(v) => {
              close()
              if (dialog.mode === 'add') return onPreview({ op: 'addIndex', table, ...v })
              onPreview({ op: 'alterIndex', table, name: dialog.index.name, index: v })
            }}
          />
        ) : null}
      </Dialog>
      <Dialog open={dialog?.mode === 'rename'} title={locale.ddl.titles.renameIndex} onClose={close}>
        {dialog?.mode === 'rename' ? (
          <RenameForm
            name={dialog.index.name}
            onCancel={close}
            onSubmit={(to) => {
              close()
              onPreview({ op: 'renameIndex', table, name: dialog.index.name, newName: to })
            }}
          />
        ) : null}
      </Dialog>
    </Card>
  )
}
