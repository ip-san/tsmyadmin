import type { ProcessInfo } from '@tsmyadmin/shared'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale-screens.ts'

/** Asks before closing a connection (from the process list, or a lock blocker): it rolls back what it has open. */
export function KillDialog({
  victim,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  victim: ProcessInfo | null
  pending: boolean
  error: unknown
  onClose: () => void
  onConfirm: (victim: ProcessInfo) => void
}) {
  return (
    <Dialog
      open={victim !== null}
      title={locale.server.kill}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {locale.common.cancel}
          </Button>
          <Button variant="danger" onClick={() => victim && onConfirm(victim)} disabled={pending}>
            {locale.server.killExecute}
          </Button>
        </>
      }
    >
      <p>{victim ? locale.server.killConfirm(victim.id) : ''}</p>
      {victim?.self ? (
        <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {locale.server.killSelfWarning}
        </p>
      ) : null}
      {victim ? (
        <dl className="mt-2 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <dt className="text-ink-sub">{locale.server.user}</dt>
          <dd>{[victim.user, victim.host].filter(Boolean).join('@') || '–'}</dd>
          <dt className="text-ink-sub">{locale.server.database}</dt>
          <dd>{victim.database ?? '–'}</dd>
          <dt className="text-ink-sub">{locale.server.query}</dt>
          <dd className="truncate font-mono">{victim.query?.replace(/\s+/g, ' ').trim().slice(0, 200) || '–'}</dd>
        </dl>
      ) : null}
      {error ? <ErrorBox error={error} className="mt-2" /> : null}
    </Dialog>
  )
}
