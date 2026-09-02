import { Link, type LinkProps } from '@tanstack/react-router'
import { cn } from '@/lib/cn.ts'

export interface TabItem {
  label: string
  to: NonNullable<LinkProps['to']>
  params?: NonNullable<LinkProps['params']>
  search?: NonNullable<LinkProps['search']>
  exact?: boolean
  /** Tab that does not apply to the current object (e.g. insert on a view). */
  hidden?: boolean
}

export function TabNav({ items, label }: { items: TabItem[]; label: string }) {
  return (
    <nav aria-label={label} className="mb-4 border-b border-zinc-200 dark:border-zinc-700">
      <ul className="-mb-px flex flex-wrap gap-1">
        {items
          .filter((i) => !i.hidden)
          .map(({ label: itemLabel, exact, hidden: _hidden, ...linkProps }) => (
            <li key={itemLabel}>
              <Link
                {...linkProps}
                activeOptions={{ exact: exact ?? false, includeSearch: false }}
                className={cn(
                  'inline-block border-b-2 border-transparent px-3 py-2 text-sm text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-500 dark:hover:text-white'
                )}
                activeProps={{
                  className: 'border-blue-600! text-blue-700! dark:border-blue-400! dark:text-blue-300! font-medium',
                }}
              >
                {itemLabel}
              </Link>
            </li>
          ))}
      </ul>
    </nav>
  )
}
