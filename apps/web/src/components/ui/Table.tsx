import type { HTMLAttributes, Ref, TdHTMLAttributes, ThHTMLAttributes } from 'react'
import { cn } from '@/lib/cn.ts'

export function Table({
  className,
  ref,
  scrollLabel,
  scrollRef,
  scrollClassName,
  ...rest
}: HTMLAttributes<HTMLTableElement> & {
  ref?: Ref<HTMLTableElement>
  scrollLabel?: string
  /** The scrolling wrapper (a virtualiser's scroll element). */
  scrollRef?: Ref<HTMLDivElement>
  /** Extra classes on the wrapper (a vertical limit for virtualised results). */
  scrollClassName?: string
}) {
  // A table without focusable cells (read-only results) needs its scroller in the tab order to scroll by keyboard.
  const scroller = scrollLabel ? { tabIndex: 0, role: 'group', 'aria-label': scrollLabel } : {}
  return (
    <div
      ref={scrollRef}
      // `relative`: an `sr-only` (absolutely positioned) cell label would otherwise sit outside the scroller and
      // widen the whole page when the table is wider than the screen.
      className={cn('relative w-full overflow-x-auto rounded border border-line', scrollClassName)}
      {...scroller}
    >
      <table ref={ref} className={cn('w-full border-collapse text-sm', className)} {...rest} />
    </div>
  )
}

export function Th({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={cn(
        'whitespace-nowrap border-b border-line-strong bg-surface-sub px-2 py-1.5 text-left font-semibold text-ink',
        className
      )}
      {...rest}
    />
  )
}

export function Td({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('border-b border-line px-2 py-1 align-top text-ink', className)} {...rest} />
}

export function Tr({
  className,
  ref,
  ...rest
}: HTMLAttributes<HTMLTableRowElement> & { ref?: Ref<HTMLTableRowElement> }) {
  return <tr ref={ref} className={cn('hover:bg-row-hover', className)} {...rest} />
}
