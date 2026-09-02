import type { ReactNode } from 'react'

/** Page heading. Nested layouts (table inside database) pass `level={2}` so each route has exactly one h1. */
export function PageTitle({
  children,
  actions,
  level = 1,
}: {
  children: ReactNode
  actions?: ReactNode
  level?: 1 | 2
}) {
  const Heading = level === 1 ? 'h1' : 'h2'
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <Heading className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{children}</Heading>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  )
}
