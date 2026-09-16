import type { ReactNode } from 'react'
import { cn } from '@/lib/cn.ts'

/**
 * A raised surface on the page canvas, with an optional titled header and header-level actions.
 *
 * Borrowed from Polaris's Card: grouping related controls on a surface is what gives a dense screen a shape,
 * and it is what a flat page of tables was missing.
 */
export function Card({
  title,
  actions,
  children,
  bleed = false,
  className,
}: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  /** Let the content reach the card's edges (a table draws its own row separators). */
  bleed?: boolean
  className?: string
}) {
  return (
    <section className={cn('rounded-card border border-line bg-surface shadow-card', className)}>
      {title ? (
        <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div
        className={cn(
          bleed ? '' : 'px-4 pb-4',
          bleed && title ? 'border-t border-line' : '',
          !title && !bleed ? 'pt-4' : ''
        )}
      >
        {children}
      </div>
    </section>
  )
}
