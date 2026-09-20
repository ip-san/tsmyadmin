import { useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { locale } from '@/config/locale.ts'

/** Past this many rows, "show all" asks first: the page would be slow to fetch and to draw. */
const BROWSE_ALL_WARN = 10_000

function ShowAllConfirm({
  open,
  total,
  onCancel,
  onConfirm,
}: {
  open: boolean
  total: number
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog
      open={open}
      title={locale.browse.showAll}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>{locale.common.cancel}</Button>
          <Button variant="primary" onClick={onConfirm}>
            {locale.browse.showAllConfirm}
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink">{locale.browse.showAllWarning(total)}</p>
    </Dialog>
  )
}

/**
 * "Show all rows": off unless the setting offers it, and never carried by a link. Asking first past
 * `BROWSE_ALL_WARN` rows; the rows are fetched only once that is confirmed.
 */
export function useShowAll(offered: boolean) {
  const [on, setOn] = useState(false)
  const [asking, setAsking] = useState(false)
  return {
    /** The options to read with: every row while it is on. */
    apply: <T extends { offset: number; limit: number }>(options: T): T =>
      on ? { ...options, offset: 0, limit: 0 } : options,
    /** What the pagination bar needs, or undefined where it is not offered. */
    pagination: (total: number | null) =>
      offered
        ? {
            on,
            onToggle: () => (on ? setOn(false) : (total ?? 0) > BROWSE_ALL_WARN ? setAsking(true) : setOn(true)),
          }
        : undefined,
    dialog: (total: number | null) => (
      <ShowAllConfirm
        open={asking}
        total={total ?? 0}
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false)
          setOn(true)
        }}
      />
    ),
  }
}
