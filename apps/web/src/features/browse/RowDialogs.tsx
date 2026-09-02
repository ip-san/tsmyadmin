import { useMutation, useQuery } from '@tanstack/react-query'
import type { Cell, RowKey, RowValues } from '@tsmyadmin/shared'
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
  return (
    <Dialog open={open} title={locale.rows.editTitle} onClose={onClose}>
      {structure.isPending ? (
        <Spinner />
      ) : structure.isError ? (
        <ErrorBox error={structure.error} onRetry={() => void structure.refetch()} />
      ) : open ? (
        <RowForm
          columns={structure.data.columns}
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
