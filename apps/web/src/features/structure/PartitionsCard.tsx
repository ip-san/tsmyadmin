import { useQuery } from '@tanstack/react-query'
import type { DdlOp, Dialect } from '@tsmyadmin/shared'
import { useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Card } from '@/components/ui/Card.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Select } from '@/components/ui/Field.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale, numberLocale } from '@/config/locale.ts'
import { partitionsQuery, type TableRef } from '@/lib/queries.ts'
import { AddPartitionForm, boundExample, PartitionTableForm } from './PartitionForms.tsx'

const t = locale.partitions

/** phpMyAdmin's partition maintenance under the structure: the partitions, and every change through the preview. */
export function PartitionsCard({
  tableRef,
  dialect,
  onPreview,
}: {
  tableRef: TableRef
  dialect: Dialect
  onPreview: (op: DdlOp) => void
}) {
  const parts = useQuery(partitionsQuery(tableRef))
  const [dialog, setDialog] = useState<'partition' | 'add' | null>(null)
  const table = tableRef.table
  const close = () => setDialog(null)
  if (parts.isPending) return <Spinner />
  if (parts.isError) return <ErrorBox error={parts.error} onRetry={() => void parts.refetch()} />
  const p = parts.data
  const actions =
    p.method === null ? (
      dialect === 'mysql' ? (
        <Button size="sm" aria-haspopup="dialog" onClick={() => setDialog('partition')}>
          {t.partition}
        </Button>
      ) : null
    ) : (
      <div className="flex gap-2">
        <Button size="sm" aria-haspopup="dialog" onClick={() => setDialog('add')}>
          {locale.ddl.titles.addPartition}
        </Button>
        {dialect === 'mysql' ? (
          <Button size="sm" aria-haspopup="dialog" onClick={() => onPreview({ op: 'removePartitioning', table })}>
            {locale.ddl.titles.removePartitioning}
          </Button>
        ) : null}
      </div>
    )
  return (
    <Card title={t.title} actions={actions} bleed={p.method !== null}>
      {p.method === null ? (
        <Notice>{dialect === 'mysql' ? t.none : t.nonePostgres}</Notice>
      ) : (
        <>
          <p className="px-4 pt-2 text-xs text-ink-sub">{t.by(p.method.toUpperCase(), p.expression ?? '')}</p>
          <Table aria-label={t.title}>
            <thead>
              <tr>
                <Th>{t.name}</Th>
                <Th>{t.bound}</Th>
                <Th className="text-right">{locale.database.rowEstimate}</Th>
                <Th className="text-right">{locale.database.size}</Th>
                <Th>{locale.ddl.actions}</Th>
              </tr>
            </thead>
            <tbody>
              {p.partitions.map((x) => (
                <Tr key={x.name}>
                  <Td className="font-medium">{x.name}</Td>
                  <Td className="font-mono text-xs">{x.bound}</Td>
                  <Td className="text-right tabular-nums">{x.rowEstimate?.toLocaleString(numberLocale) ?? '–'}</Td>
                  <Td className="text-right tabular-nums">
                    {x.sizeBytes === null ? '–' : locale.common.bytes(x.sizeBytes)}
                  </Td>
                  <Td className="whitespace-nowrap space-x-1">
                    <PartitionActions dialect={dialect} name={x.name} onRun={(o) => onPreview({ ...o, table })} />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
      <Dialog open={dialog === 'partition'} title={locale.ddl.titles.partitionTable} onClose={close}>
        {dialog === 'partition' ? (
          <PartitionTableForm
            onCancel={close}
            onSubmit={(v) => {
              close()
              onPreview({ op: 'partitionTable', table, ...v })
            }}
          />
        ) : null}
      </Dialog>
      <Dialog open={dialog === 'add'} title={locale.ddl.titles.addPartition} onClose={close}>
        {dialog === 'add' ? (
          <AddPartitionForm
            example={boundExample(dialect, p.method)}
            onCancel={close}
            onSubmit={(partition) => {
              close()
              onPreview({ op: 'addPartition', table, partition })
            }}
          />
        ) : null}
      </Dialog>
    </Card>
  )
}

type PartitionOp =
  | { op: 'dropPartition' | 'truncatePartition' | 'detachPartition'; name: string }
  | {
      op: 'maintainPartition'
      name: string
      action: 'analyze' | 'check' | 'optimize' | 'rebuild' | 'repair'
    }

/** A partition's own actions: empty, drop, detach (PostgreSQL) and maintenance (all of it on MySQL). */
function PartitionActions({
  dialect,
  name,
  onRun,
}: {
  dialect: Dialect
  name: string
  onRun: (op: PartitionOp) => void
}) {
  const maintenance =
    dialect === 'mysql' ? (['analyze', 'check', 'optimize', 'rebuild', 'repair'] as const) : (['analyze'] as const)
  return (
    <>
      <Select
        aria-label={t.maintainOf(name)}
        value=""
        onChange={(e) => {
          const action = e.target.value as (typeof maintenance)[number] | ''
          if (action) onRun({ op: 'maintainPartition', name, action })
        }}
        className="w-auto py-1 text-xs"
      >
        <option value="">{t.maintain}</option>
        {maintenance.map((a) => (
          <option key={a} value={a}>
            {a.toUpperCase()}
          </option>
        ))}
      </Select>
      <Button
        size="sm"
        aria-haspopup="dialog"
        aria-label={t.truncateOf(name)}
        onClick={() => onRun({ op: 'truncatePartition', name })}
      >
        {t.truncate}
      </Button>
      {dialect === 'postgres' ? (
        <Button
          size="sm"
          aria-haspopup="dialog"
          aria-label={t.detachOf(name)}
          onClick={() => onRun({ op: 'detachPartition', name })}
        >
          {t.detach}
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="danger"
        aria-haspopup="dialog"
        aria-label={t.dropOf(name)}
        onClick={() => onRun({ op: 'dropPartition', name })}
      >
        {locale.ddl.drop}
      </Button>
    </>
  )
}
