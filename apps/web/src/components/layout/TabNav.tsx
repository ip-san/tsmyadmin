import { useQuery } from '@tanstack/react-query'
import { Link, type LinkProps, useRouterState } from '@tanstack/react-router'
import { groupTabOf } from '@tsmyadmin/shared'
import { BookOpen } from 'lucide-react'
import { locale } from '@/config/locale.ts'
import { cn } from '@/lib/cn.ts'
import { manualTopic, manualUrl } from '@/lib/manual-links.ts'
import { myGroupTabsQuery, serverInfoQuery, sessionQuery } from '@/lib/queries.ts'

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
  const manual = useManualLink(items)
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
        {manual ? (
          <li className="ml-auto">
            <a
              href={manual}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-3 py-2 text-sm text-blue-700 hover:underline dark:text-blue-300"
            >
              <BookOpen className="size-3.5" aria-hidden />
              {locale.server.manual}
            </a>
          </li>
        ) : null}
      </ul>
    </nav>
  )
}

/** The manual page for the tab that is open (the deepest of these tabs the route is on), or null. */
function useManualLink(items: TabItem[]): string | null {
  const open = useRouterState({ select: (s) => s.matches.map((m) => m.fullPath).join('\n') }).split('\n')
  // What is already known about the server: a link never costs a request of its own.
  const dialect = useQuery(sessionQuery).data?.dialect
  const version = useQuery({ ...serverInfoQuery, enabled: false }).data?.version ?? ''
  if (!dialect) return null
  const normalise = (p: string) => (p.length > 1 ? p.replace(/\/$/, '') : p)
  const active = items.findLast((i) => open.some((p) => normalise(p) === normalise(String(i.to))))
  const topic = active ? manualTopic(String(active.to)) : null
  return topic ? manualUrl(dialect, version, topic) : null
}
