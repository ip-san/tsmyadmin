import { ArrowDown, ArrowUp } from 'lucide-react'
import type { ReactNode } from 'react'
import { locale } from '@/config/locale.ts'
import { cn } from '@/lib/cn.ts'
import { Th } from './Table.tsx'

/** A column header that sorts a list held in the page: one click ascending, a second descending, a third clears. */
export function SortTh({
  dir,
  onSort,
  className,
  children,
}: {
  dir: 'asc' | 'desc' | null
  onSort: () => void
  className?: string
  children: ReactNode
}) {
  return (
    <Th aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'} className={className}>
      <button
        type="button"
        className={cn('inline-flex items-center gap-1 hover:underline', dir && 'text-brand')}
        onClick={onSort}
        title={
          dir === 'asc' ? locale.browse.sortDesc : dir === 'desc' ? locale.browse.clearSort : locale.browse.sortAsc
        }
      >
        {children}
        {dir === 'asc' ? <ArrowUp className="size-3" aria-hidden /> : null}
        {dir === 'desc' ? <ArrowDown className="size-3" aria-hidden /> : null}
      </button>
    </Th>
  )
}

/** asc → desc → none for the column clicked, from what the list is sorted by now. */
export function nextListSort<K extends string>(
  current: { key: K; dir: 'asc' | 'desc' } | null,
  key: K
): { key: K; dir: 'asc' | 'desc' } | null {
  if (current?.key !== key) return { key, dir: 'asc' }
  return current.dir === 'asc' ? { key, dir: 'desc' } : null
}
