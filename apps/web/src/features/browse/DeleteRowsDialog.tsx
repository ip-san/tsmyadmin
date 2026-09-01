import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'

export interface DeleteRowsDialogProps {
  open: boolean
  count: number
  pending: boolean
  error: unknown
  onCancel: () => void
  onConfirm: () => void
}

export function DeleteRowsDialog({ open, count, pending, error, onCancel, onConfirm }: DeleteRowsDialogProps) {
  return (
    <Dialog
      open={open}
      title={locale.browse.deleteSelected}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel} disabled={pending}>
            {locale.common.cancel}
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={pending}>
            {locale.common.delete}
          </Button>
        </>
      }
    >
      <p>{locale.browse.deleteConfirm(count)}</p>
      {error ? <ErrorBox error={error} className="mt-2" /> : null}
    </Dialog>
  )
}
