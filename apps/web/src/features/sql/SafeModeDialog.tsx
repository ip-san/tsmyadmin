import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { locale } from '@/config/locale.ts'

/** Asks before a statement that would change every row (an UPDATE or DELETE with no WHERE) is run. */
export function SafeModeDialog({
  kinds,
  onCancel,
  onRun,
}: {
  /** The statement kinds waiting for confirmation; the dialog is open while there are any. */
  kinds: string[]
  onCancel: () => void
  onRun: () => void
}) {
  return (
    <Dialog
      open={kinds.length > 0}
      title={locale.sql.safeModeTitle}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>{locale.common.cancel}</Button>
          <Button variant="danger" onClick={onRun}>
            {locale.sql.run}
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink">{locale.sql.safeModeBody(kinds.join(' / '))}</p>
    </Dialog>
  )
}
