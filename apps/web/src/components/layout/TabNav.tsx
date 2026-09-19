import { useQuery } from '@tanstack/react-query'
import { Link, type LinkProps } from '@tanstack/react-router'
import { groupTabOf } from '@tsmyadmin/shared'
import { cn } from '@/lib/cn.ts'
import { myGroupTabsQuery } from '@/lib/queries.ts'

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
  // Tabs the account's user groups hide. Only hidden from view: the pages behind them still answer.
  const hiddenByGroup = new Set(useQuery(myGroupTabsQuery).data?.hiddenTabs ?? [])
  return (
    <nav aria-label={label} className="mb-4 border-b border-line print:hidden">
      <ul className="-mb-px flex flex-wrap gap-1">
        {items
          .filter((i) => !i.hidden && !hiddenByGroup.has(groupTabOf(String(i.to)) ?? ''))
          .map(({ label: itemLabel, exact, hidden: _hidden, ...linkProps }) => (
            <li key={itemLabel}>
              <Link
                {...linkProps}
                activeOptions={{ exact: exact ?? false, includeSearch: false }}
                className={cn(
                  'inline-block border-b-2 border-transparent px-3 py-2 text-sm text-ink-sub hover:border-line-strong hover:text-ink'
                )}
                activeProps={{
                  className: 'border-brand! text-brand! font-medium',
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
