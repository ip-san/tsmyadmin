import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { ErrorBox, Notice } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'

/**
 * An "Edit" button for a routine, trigger or event: it reads the definition back from the server, and opens the same
 * form as "create" filled with it. What the form cannot say (`load` gives null) is not offered there: the notice
 * points at editing it in the SQL tab.
 */
export function EditDetail<T>({
  label,
  title,
  load,
  children,
}: {
  /** The button's accessible name, e.g. `orders_after_insert: 編集`. */
  label: string
  title: string
  load: () => Promise<T | null>
  children: (detail: T, close: () => void) => ReactNode
}) {
  const [detail, setDetail] = useState<T | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const close = () => setDetail(null)
  const open = async () => {
    setBusy(true)
    setNotice(false)
    setError(null)
    try {
      const found = await load()
      if (found === null) setNotice(true)
      else setDetail(found)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button size="sm" aria-haspopup="dialog" aria-label={label} disabled={busy} onClick={() => void open()}>
        {locale.create.edit.button}
      </Button>
      {notice ? <Notice className="mt-1">{locale.create.edit.notEditable}</Notice> : null}
      {error ? <ErrorBox error={error} className="mt-1" /> : null}
      <Dialog open={detail !== null} title={title} onClose={close}>
        {detail !== null ? children(detail, close) : null}
      </Dialog>
    </>
  )
}
