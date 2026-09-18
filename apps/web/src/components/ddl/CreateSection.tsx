import type { ReactNode } from 'react'

/**
 * A "create …" form below a list, folded until asked for (phpMyAdmin's "Add routine" link): the list stays the
 * first thing on the page, and the native disclosure needs no script to be operable by keyboard.
 */
export function CreateSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="rounded border border-line p-3">
      <summary className="cursor-pointer text-sm font-semibold text-ink">{title}</summary>
      <div className="mt-3">{children}</div>
    </details>
  )
}
