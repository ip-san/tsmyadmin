import { useMutation, useQuery } from '@tanstack/react-query'
import type { Cell, RowKey, RowValues } from '@tsmyadmin/shared'
import { useState } from 'react'
import { RowForm } from '@/components/rows/RowForm.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { mutations, structureQuery, type TableRef } from '@/lib/queries.ts'

interface CommonProps {
  tableRef: TableRef
  /** Row values of the selected row, or null when no dialog is open. */
  values: Record<string, Cell> | null
  onClose: () => void
  onDone: (notice: string) => Promise<void>
}

/** Edit one row in a modal form (only changed columns are sent). */
export function EditRowDialog({ tableRef, values, rowKey, onClose, onDone }: CommonProps & { rowKey: RowKey | null }) {
  const open = values !== null && rowKey !== null
  const structure = useQuery({ ...structureQuery(tableRef), enabled: open })
  const update = useMutation({
    mutationFn: ({ key, next }: { key: RowKey; next: RowValues }) => mutations.updateRow(tableRef, key, next),
    onSuccess: () => onDone(locale.rows.updated),
  })
  // A previous row's failure must not greet the next row (the dialog component stays mounted).
  const [prevValues, setPrevValues] = useState(values)
  if (prevValues !== values) {
    setPrevValues(values)
    update.reset()
  }
  return (
    <Dialog open={open} title={locale.rows.editTitle} onClose={onClose}>
      {structure.isPending ? (
        <Spinner />
      ) : structure.isError ? (
        <ErrorBox error={structure.error} onRetry={() => void structure.refetch()} />
      ) : open ? (
        <RowForm
          columns={structure.data.columns}
          foreignKeys={structure.data.foreignKeys}
          mode="edit"
          initial={values}
          pending={update.isPending}
          error={update.error}
          onCancel={onClose}
          onSubmit={(next) => {
            if (Object.keys(next).length === 0) return void onDone(locale.rows.nothingChanged)
            update.mutate({ key: rowKey, next })
          }}
        />
      ) : null}
    </Dialog>
  )
}

/** Insert a copy of an existing row (generated columns take fresh values). */
export function CopyRowDialog({ tableRef, values, onClose, onDone }: CommonProps) {
  const open = values !== null
  const structure = useQuery({ ...structureQuery(tableRef), enabled: open })
  const insert = useMutation({
    mutationFn: (next: RowValues) => mutations.insertRow(tableRef, next),
    onSuccess: (r) => onDone(locale.rows.inserted(r.affectedRows)),
  })
  const [prevValues, setPrevValues] = useState(values)
  if (prevValues !== values) {
    setPrevValues(values)
    insert.reset()
  }
  return (
    <Dialog open={open} title={locale.rows.copyTitle} onClose={onClose}>
      {structure.isPending ? (
        <Spinner />
      ) : structure.isError ? (
        <ErrorBox error={structure.error} onRetry={() => void structure.refetch()} />
      ) : open ? (
        <div className="space-y-3">
          <Notice>{locale.rows.copyHint}</Notice>
          <RowForm
            columns={structure.data.columns}
            foreignKeys={structure.data.foreignKeys}
            mode="insert"
            initial={values}
            pending={insert.isPending}
            error={insert.error}
            onCancel={onClose}
            onSubmit={(next) => insert.mutate(next)}
          />
        </div>
      ) : null}
    </Dialog>
  )
}

/**
 * Edit several rows at once (phpMyAdmin's "Edit" with rows ticked): a section per row; each row that changed is
 * updated in turn, stopping at the first failure — the rows before it stay updated, and the notice says how many.
 */
export function EditRowsDialog({
  tableRef,
  rows,
  onClose,
  onDone,
}: {
  tableRef: TableRef
  rows: { key: RowKey; values: Record<string, Cell> }[] | null
  onClose: () => void
  onDone: (notice: string) => Promise<void>
}) {
  const open = rows !== null && rows.length > 0
  const structure = useQuery({ ...structureQuery(tableRef), enabled: open })
  const [done, setDone] = useState(0)
  const update = useMutation({
    mutationFn: async (changes: { key: RowKey; next: RowValues }[]) => {
      let n = 0
      try {
        for (const { key, next } of changes) {
          await mutations.updateRow(tableRef, key, next)
          n++
        }
      } finally {
        setDone(n)
      }
      return n
    },
    onSuccess: (n) => onDone(n === 0 ? locale.rows.nothingChanged : locale.rows.updatedRows(n)),
  })
  const [prevRows, setPrevRows] = useState(rows)
  if (prevRows !== rows) {
    setPrevRows(rows)
    setDone(0)
    update.reset()
  }
  return (
    <Dialog open={open} title={locale.rows.editRowsTitle(rows?.length ?? 0)} onClose={onClose}>
      {structure.isPending ? (
        <Spinner />
      ) : structure.isError ? (
        <ErrorBox error={structure.error} onRetry={() => void structure.refetch()} />
      ) : open && rows ? (
        <div className="space-y-3">
          {update.isError && done > 0 ? <Notice>{locale.rows.updatedBeforeError(done)}</Notice> : null}
          <RowForm
            columns={structure.data.columns}
            foreignKeys={structure.data.foreignKeys}
            mode="edit"
            initialRows={rows.map((r) => r.values)}
            pending={update.isPending}
            error={update.error}
            onCancel={onClose}
            onSubmit={(_, all) => {
              const changes = all.flatMap((next, i) => {
                const key = rows[i]?.key
                return key && Object.keys(next).length > 0 ? [{ key, next }] : []
              })
              if (changes.length === 0) return void onDone(locale.rows.nothingChanged)
              update.mutate(changes)
            }}
          />
        </div>
      ) : null}
    </Dialog>
  )
}
