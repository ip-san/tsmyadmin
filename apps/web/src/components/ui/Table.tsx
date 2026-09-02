import type { HTMLAttributes, Ref, TdHTMLAttributes, ThHTMLAttributes } from 'react'
import { cn } from '@/lib/cn.ts'

export function Table({ className, ref, ...rest }: HTMLAttributes<HTMLTableElement> & { ref?: Ref<HTMLTableElement> }) {
  return (
    <div className="w-full overflow-x-auto rounded border border-zinc-200 dark:border-zinc-700">
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

export function Tr({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('hover:bg-blue-50/60 dark:hover:bg-zinc-800/60', className)} {...rest} />
}
