import type { DdlOp, TableSchema } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import type { TableRef } from '@/lib/queries.ts'
import type { Proposal } from './normalization.ts'

const t = locale.normalize.actions

const MAX_NAME = 60
const fit = (name: string) => name.slice(0, MAX_NAME)

/** The new table a proposal makes: named, with the columns it takes (all by default) and whether they leave the old one. */
function ProposalForm({
  table,
  proposal,
  onSubmit,
  onCancel,
}: {
  table: string
  proposal: Proposal
  onSubmit: (op: DdlOp) => void
  onCancel: () => void
}) {
  const split = proposal.kind === 'split'
  const [name, setName] = useState(
    fit(split ? `${table}_${proposal.keyColumns.join('_')}` : `${table}_${proposal.stem}`)
  )
  const [chosen, setChosen] = useState(proposal.columns)
  const [valueColumn, setValueColumn] = useState(split ? '' : proposal.stem || 'value')
  const [dropMoved, setDropMoved] = useState(true)
  const enough = chosen.length >= (split ? 1 : 2)
  const ready = name.trim() !== '' && enough && (split || valueColumn.trim() !== '')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!ready) return
    onSubmit(
      proposal.kind === 'split'
        ? { op: 'splitTable', table, newName: name.trim(), keyColumns: proposal.keyColumns, columns: chosen, dropMoved }
        : {
            op: 'moveRepeatingGroup',
            table,
            newName: name.trim(),
            keyColumns: [], // filled by the caller from the primary key
            columns: chosen,
            valueColumn: valueColumn.trim(),
            dropMoved,
          }
    )
  }
  return (
    <form onSubmit={submit} className="space-y-3" aria-label={t.formLabel(table)}>
      <p className="text-xs text-ink-sub">{split ? t.splitHint(proposal.keyColumns.join(', ')) : t.groupHint}</p>
      <Field id="normalize-name" label={t.newTable}>
        <Input id="normalize-name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="off" />
      </Field>
      {split ? null : (
        <Field id="normalize-value" label={t.valueColumn}>
          <Input
            id="normalize-value"
            value={valueColumn}
            onChange={(e) => setValueColumn(e.target.value)}
            required
            autoComplete="off"
          />
        </Field>
      )}
      <fieldset className="space-y-1">
        <legend className="text-xs text-ink-sub">{t.columns}</legend>
        {proposal.columns.map((c) => (
          <label key={c} className="flex items-center gap-1 text-sm text-ink">
            <input
              type="checkbox"
              checked={chosen.includes(c)}
              onChange={(e) =>
                setChosen(
                  e.target.checked
                    ? proposal.columns.filter((x) => x === c || chosen.includes(x))
                    : chosen.filter((x) => x !== c)
                )
              }
            />
            {c}
          </label>
        ))}
      </fieldset>
      <label className="flex items-center gap-1 text-sm text-ink">
        <input type="checkbox" checked={dropMoved} onChange={(e) => setDropMoved(e.target.checked)} />
        {t.dropMoved}
      </label>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={!ready} aria-haspopup="dialog">
          {locale.create.review}
        </Button>
        <Button type="button" onClick={onCancel}>
          {locale.common.cancel}
        </Button>
      </div>
    </form>
  )
}

/**
 * phpMyAdmin's Normalize, taken to the new table: each dependency or repeating group the hints found can become a
 * table of its own, through the usual SQL preview. The moved values are copied before anything is dropped.
 */
export function NormalizeActions({
  tableRef,
  schema,
  proposals,
}: {
  tableRef: TableRef
  schema: TableSchema
  proposals: Proposal[]
}) {
  const flow = useDdlFlow(tableRef.db, tableRef.schema)
  const [open, setOpen] = useState<number | null>(null)
  if (proposals.length === 0) return null
  const current = open === null ? undefined : proposals[open]
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold text-ink">{t.title}</h4>
      <ul className="space-y-1">
        {proposals.map((p, i) => {
          const label =
            p.kind === 'split'
              ? t.splitLabel(p.keyColumns.join(', '), p.columns.join(', '))
              : t.groupLabel(p.columns.join(', '))
          return (
            <li key={`${p.kind}:${p.columns.join(',')}`} className="flex flex-wrap items-center gap-2 text-sm text-ink">
              <span>{label}</span>
              <Button size="sm" aria-haspopup="dialog" aria-label={`${label}: ${t.make}`} onClick={() => setOpen(i)}>
                {t.make}
              </Button>
            </li>
          )
        })}
      </ul>
      <Dialog open={current !== undefined} title={t.make} onClose={() => setOpen(null)}>
        {current ? (
          <ProposalForm
            table={tableRef.table}
            proposal={current}
            onCancel={() => setOpen(null)}
            onSubmit={(op) => {
              setOpen(null)
              flow.preview(op.op === 'moveRepeatingGroup' ? { ...op, keyColumns: schema.primaryKey } : op)
            }}
          />
        ) : null}
      </Dialog>
      <DdlPreviewDialog flow={flow} />
    </div>
  )
}
