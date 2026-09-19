import type { ReactNode } from 'react'

/**
 * A "create …" form below a list, folded until asked for (phpMyAdmin's "Add routine" link): the list stays the
 * first thing on the page, and the native disclosure needs no script to be operable by keyboard.
 */
export function CreateSection({
  title,
  children,
  open = false,
}: {
  title: string
  children: ReactNode
  /** Opened from the start (arriving with something to fill in, such as a view from a result). */
  open?: boolean
}) {
  return (
    <details className="rounded border border-line p-3" open={open}>
      <summary className="cursor-pointer text-sm font-semibold text-ink">{title}</summary>
      <div className="mt-3">{children}</div>
    </details>
  )
}
