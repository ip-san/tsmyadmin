import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { isViewKind, type TableInfo } from '@tsmyadmin/shared'
import { Eye, Table2 } from 'lucide-react'
import { useDeferredValue, useLayoutEffect, useRef, useState } from 'react'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { tablesQuery } from '@/lib/queries.ts'

const ROW_HEIGHT = 26
/** Below this many rows plain rendering is cheaper than a virtualizer. */
const VIRTUALIZE_FROM = 60

export function filterTables(tables: TableInfo[], filter: string): TableInfo[] {
  const q = filter.trim().toLowerCase()
  return q ? tables.filter((t) => t.name.toLowerCase().includes(q)) : tables
}

interface RowProps {
  db: string
  schema?: string | undefined
  table: TableInfo
}

/** The link itself; the caller supplies the <li> (static or absolutely positioned when virtualized). */
function TableLink({ db, schema, table }: RowProps) {
  return (
    <Link
      to="/db/$db/table/$table"
      params={{ db, table: table.name }}
      search={schema ? { schema } : {}}
      className="flex h-full items-center gap-1 truncate rounded px-1 text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
      activeProps={{ className: 'bg-blue-50 text-blue-800 dark:bg-blue-950 dark:text-blue-200' }}
      title={table.name}
    >
      {isViewKind(table.kind) ? (
        <Eye className="size-3.5 shrink-0" aria-hidden />
      ) : (
        <Table2 className="size-3.5 shrink-0" aria-hidden />
      )}
      <span className="truncate">{table.name}</span>
    </Link>
  )
}

/**
 * Table links for one database/schema. Large lists are virtualized against the sidebar's scroll container
 * (the closest `[data-scroll-root]` ancestor) so thousands of tables cost only the visible rows.
 */
export function TableList({ db, schema, filter }: { db: string; schema?: string | undefined; filter: string }) {
  const tables = useQuery(tablesQuery(db, schema))
  const deferred = useDeferredValue(filter)
  const listRef = useRef<HTMLUListElement>(null)
  const shown = tables.data ? filterTables(tables.data, deferred) : []
  const virtual = shown.length >= VIRTUALIZE_FROM
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
  const count =
    deferred.trim() !== '' ? (
      <p className="px-2 py-0.5 text-xs text-zinc-500 dark:text-zinc-400">
        {locale.nav.matchCount(shown.length, total)}
      </p>
    ) : null
  if (shown.length === 0) {
    return (
      <>
        {count}
        <p className="px-2 py-1 text-xs text-zinc-500 dark:text-zinc-400">{locale.nav.noTables}</p>
      </>
    )
  }
  if (!virtual) {
    return (
      <>
        {count}
        <ul className="ml-3 border-l border-zinc-200 pl-2 dark:border-zinc-700">
          {shown.map((t) => (
            <li key={t.name} style={{ height: ROW_HEIGHT }}>
              <TableLink db={db} schema={schema} table={t} />
            </li>
          ))}
        </ul>
      </>
    )
  }
  return (
    <>
      {count}
      <ul
        ref={listRef}
        className="relative ml-3 border-l border-zinc-200 pl-2 dark:border-zinc-700"
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
    </>
  )
}
