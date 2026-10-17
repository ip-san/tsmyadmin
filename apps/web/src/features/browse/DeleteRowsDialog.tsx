import { DELETE_IMPACT_MAX_KEYS, type RowKey } from '@tsmyadmin/shared'
import { lazy, Suspense, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale-screens.ts'
import type { TableRef } from '@/lib/queries.ts'

// Loaded when asked for: the diagram is not wanted for most deletes.
const DeleteImpactPanel = lazy(() => import('./DeleteImpactPanel.tsx').then((m) => ({ default: m.DeleteImpactPanel })))

export interface DeleteRowsDialogProps {
  open: boolean
  tableRef: TableRef
  keys: RowKey[]
  pending: boolean
  error: unknown
  onCancel: () => void
  onConfirm: () => void
}

export function DeleteRowsDialog({ open, tableRef, keys, pending, error, onCancel, onConfirm }: DeleteRowsDialogProps) {
  const [impact, setImpact] = useState(false)
  // Closed by a delete that went through as well as by Cancel: the next rows start without the impact open.
  if (!open && impact) setImpact(false)
  const tooMany = keys.length > DELETE_IMPACT_MAX_KEYS
  return (
    <Dialog
      open={open}
      title={locale.browse.deleteSelected}
      onClose={onCancel}
      // Escape must not close it mid-delete: cancelling resets the mutation, so a failure would then show nowhere.
      busy={pending}
      footer={
        <>
          <Button onClick={onCancel} disabled={pending}>
            {locale.common.cancel}
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={pending}>
            {locale.browse.deleteExecute}
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>{locale.browse.deleteConfirm(keys.length)}</p>
        <Button size="sm" aria-expanded={impact} disabled={tooMany} onClick={() => setImpact(!impact)}>
          {impact ? locale.deleteImpact.hide : locale.deleteImpact.show}
        </Button>
      </div>
      {tooMany ? <p className="text-xs text-ink-sub">{locale.deleteImpact.tooMany(DELETE_IMPACT_MAX_KEYS)}</p> : null}
      {error ? <ErrorBox error={error} className="mt-2" /> : null}
      {impact && open ? (
        <Suspense fallback={<Spinner />}>
          <DeleteImpactPanel tableRef={tableRef} keys={keys} />
        </Suspense>
      ) : null}
    </Dialog>
  )
}
