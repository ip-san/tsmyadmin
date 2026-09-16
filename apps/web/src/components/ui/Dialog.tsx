import { type ReactNode, useEffect, useId, useRef } from 'react'
import { locale } from '@/config/locale.ts'
import { Button } from './Button.tsx'

export interface DialogProps {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** While true, Escape does not close the dialog (an operation is in flight and its result must stay visible). */
  busy?: boolean
}

/** Accessible modal built on the native <dialog> element (focus trap + Esc handled by the browser). */
export function Dialog({ open, title, onClose, children, footer, busy = false }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  // The element that opened the dialog gets focus back on close: Chromium does this natively, WebKit does not.
  const opener = useRef<HTMLElement | null>(null)
  // What the close event sees: a close the effect itself requested must not be mistaken for a user's Escape.
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      el.showModal()
    } else if (!open && el.open) {
      el.close()
      opener.current?.focus()
      opener.current = null
    }
  }, [open])
  return (
    <dialog
      ref={ref}
      onClose={() => {
        if (!openRef.current) return
        // A close that slipped past onCancel (a second Escape through the close watcher) must not discard
        // an in-flight operation's result: reopen and keep waiting.
        if (busy) ref.current?.showModal()
        else onClose()
      }}
      onCancel={(e) => {
        if (busy) e.preventDefault()
      }}
      aria-labelledby={titleId}
      // m-auto restores the centring that Tailwind's preflight (margin: 0 on every element) takes away from <dialog>.
      className="m-auto w-full max-w-2xl rounded-lg border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-black/40"
    >
      {open ? (
        <div className="flex max-h-[80vh] flex-col">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label={locale.common.close} disabled={busy}>
              ×
            </Button>
          </div>
          <div className="overflow-auto px-4 py-3">{children}</div>
          {footer ? <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  )
}
