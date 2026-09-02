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
      className={cn('w-full overflow-x-auto rounded border border-zinc-200 dark:border-zinc-700', scrollClassName)}
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
        'whitespace-nowrap border-b border-zinc-200 bg-zinc-100 px-2 py-1.5 text-left font-semibold text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200',
        className
      )}
      {...rest}
    />
  )
}

export function Td({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={cn(
        'border-b border-zinc-100 px-2 py-1 align-top text-zinc-800 dark:border-zinc-800 dark:text-zinc-100',
        className
      )}
      {...rest}
    />
  )
}

export function Tr({
  className,
  ref,
  ...rest
}: HTMLAttributes<HTMLTableRowElement> & { ref?: Ref<HTMLTableRowElement> }) {
  return <tr ref={ref} className={cn('hover:bg-blue-50/60 dark:hover:bg-zinc-800/60', className)} {...rest} />
}
