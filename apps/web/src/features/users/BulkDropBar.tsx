import type { Dialect, UserOp, UserRef } from '@tsmyadmin/shared'
import { useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { locale } from '@/config/locale.ts'

const t = locale.users.bulk

/** Under the list, once accounts are ticked: how many, and the way to drop them together (after a preview). */
export function BulkDropBar({
  users,
  dialect,
  onPreview,
}: {
  users: UserRef[]
  dialect: Dialect
  onPreview: (op: UserOp) => void
}) {
  const [open, setOpen] = useState(false)
  const [revokeFirst, setRevokeFirst] = useState(false)
  const [sameName, setSameName] = useState(false)
  if (users.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-line bg-surface-sub px-3 py-2 text-sm">
      <span>{t.selected(users.length)}</span>
      <Button size="sm" variant="danger" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {t.drop}
      </Button>
      <Dialog open={open} title={t.title} onClose={() => setOpen(false)}>
        <div className="space-y-3">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={revokeFirst} onChange={(e) => setRevokeFirst(e.target.checked)} />
            {t.revokeFirst}
          </label>
          {dialect === 'mysql' ? (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={sameName} onChange={(e) => setSameName(e.target.checked)} />
              {t.sameNameDatabases}
            </label>
          ) : null}
          <p className="text-xs text-ink-sub">{t.note}</p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setOpen(false)}>{locale.common.cancel}</Button>
            <Button
              variant="primary"
              aria-haspopup="dialog"
              onClick={() => {
                setOpen(false)
                onPreview({
                  op: 'dropUsers',
                  users,
                  ...(revokeFirst ? { revokeFirst } : {}),
                  ...(sameName && dialect === 'mysql' ? { dropSameNameDatabases: true } : {}),
                })
              }}
            >
              {locale.ddl.submit}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
