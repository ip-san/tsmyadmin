import { useQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { TableInfo } from '@tsmyadmin/shared'
import { useDeferredValue, useLayoutEffect, useRef, useState } from 'react'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { tablesQuery } from '@/lib/queries.ts'
import { resolveSettings } from '@/lib/settings.ts'
import { groupTables, pageEntries } from './nav-groups.ts'
import { TableGroup } from './TableGroup.tsx'
import { ROW_HEIGHT, TableLink } from './TableLink.tsx'

/** Below this many rows plain rendering is cheaper than a virtualizer. */
const VIRTUALIZE_FROM = 60

export function filterTables(tables: TableInfo[], filter: string): TableInfo[] {
  const q = filter.trim().toLowerCase()
  return q ? tables.filter((t) => t.name.toLowerCase().includes(q)) : tables
}

/**
 * Table links for one database/schema. Large lists are virtualized against the sidebar's scroll container
 * (the closest `[data-scroll-root]` ancestor) so thousands of tables cost only the visible rows.
 */
export function TableList({ db, schema, filter }: { db: string; schema?: string | undefined; filter: string }) {
  const tables = useQuery(tablesQuery(db, schema))
  const deferred = useDeferredValue(filter)
  const listRef = useRef<HTMLUListElement>(null)
  // Read once when the list appears: changing a setting reloads the page.
  const [{ navGroupDelimiter, navPageSize }] = useState(resolveSettings)
  // 0 is "everything": the list scrolls (and, when long and ungrouped, is virtualized) instead of paging.
  const step = navPageSize === 0 ? Number.POSITIVE_INFINITY : navPageSize
  const [limit, setLimit] = useState(step)
  // A new search starts from the first page again.
  const [pagedFor, setPagedFor] = useState(deferred)
  if (pagedFor !== deferred) {
    setPagedFor(deferred)
    setLimit(step)
  }
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
  // Keyed by where the group is, not by its prefix alone: one prefix can be in several schemas.
  const groupKey = (prefix: string) => `${db}/${schema ?? ''}/${prefix}`
  const matches = tables.data ? filterTables(tables.data, deferred) : []
  const grouped = navGroupDelimiter !== ''
  const entries = pageEntries(grouped ? groupTables(matches, navGroupDelimiter) : [], limit)
  const page = pageEntries(matches, limit)
  const shown = page.shown
  const rest = grouped ? entries.rest : page.rest
  const virtual = !grouped && shown.length >= VIRTUALIZE_FROM
  // A search opens every group it found something in: the match is what was asked for.
  const searching = deferred.trim() !== ''
  // Offset of this list inside the shared scroll container (it is not the container's first child). Measured
  // after every commit (the ref is null during the first render, and expanding a sibling above moves the list);
  // setState only when it actually changed, so the extra render happens once per layout change.
  const [scrollMargin, setScrollMargin] = useState(0)
  useLayoutEffect(() => {
    const next = listRef.current?.offsetTop ?? 0
    if (next !== scrollMargin) setScrollMargin(next)
  })
  const virtualizer = useVirtualizer({
    count: virtual ? shown.length : 0,
    getScrollElement: () => listRef.current?.closest<HTMLElement>('[data-scroll-root]') ?? null,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    scrollMargin,
  })
  if (tables.isPending) return <Spinner />
  if (tables.isError) return <ErrorBox error={tables.error} onRetry={() => void tables.refetch()} />
  const total = tables.data.length
  const count = (
    <output
      aria-live="polite"
      className={deferred.trim() !== '' ? 'block px-2 py-0.5 text-xs text-ink-sub' : 'sr-only'}
    >
      {deferred.trim() !== '' ? locale.nav.matchCount(matches.length, total) : ''}
    </output>
  )
  if (matches.length === 0) {
    return (
      <>
        {count}
        <p className="px-2 py-1 text-xs text-ink-sub">{locale.nav.noTables}</p>
      </>
    )
  }
  const more =
    rest > 0 ? (
      <button
        type="button"
        onClick={() => setLimit((n) => n + step)}
        className="ml-3 rounded px-2 py-1 text-xs text-brand hover:bg-surface-sub"
      >
        {locale.nav.showMore(rest)}
      </button>
    ) : null
  if (grouped) {
    return (
      <>
        {count}
        <ul className="ml-3 border-l border-line pl-2">
          {entries.shown.map((e) =>
            e.kind === 'group' ? (
              <TableGroup
                key={`group:${e.prefix}`}
                db={db}
                schema={schema}
                prefix={e.prefix}
                tables={e.tables}
                open={searching || (openGroups[groupKey(e.prefix)] ?? false)}
                onToggle={() => setOpenGroups((o) => ({ ...o, [groupKey(e.prefix)]: !o[groupKey(e.prefix)] }))}
              />
            ) : (
              <li key={e.table.name} style={{ height: ROW_HEIGHT }}>
                <TableLink db={db} schema={schema} table={e.table} />
              </li>
            )
          )}
        </ul>
        {more}
      </>
    )
  }
  if (!virtual) {
    return (
      <>
        {count}
        <ul className="ml-3 border-l border-line pl-2">
          {shown.map((t) => (
            <li key={t.name} style={{ height: ROW_HEIGHT }}>
              <TableLink db={db} schema={schema} table={t} />
            </li>
          ))}
        </ul>
        {more}
      </>
    )
  }
  return (
    <>
      {count}
      <ul
        ref={listRef}
        className="relative ml-3 border-l border-line pl-2"
        style={{ height: virtualizer.getTotalSize() }}
        aria-label={locale.nav.tables}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const t = shown[item.index]
          if (!t) return null
          return (
            <li
              key={t.name}
              className="absolute left-0 top-0 w-full"
              style={{ height: item.size, transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)` }}
            >
              <TableLink db={db} schema={schema} table={t} />
            </li>
          )
        })}
      </ul>
      {more}
    </>
  )
}
