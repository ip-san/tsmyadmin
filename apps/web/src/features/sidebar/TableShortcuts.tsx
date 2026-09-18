import { Link } from '@tanstack/react-router'
import { locale } from '@/config/locale.ts'
import { type TableShortcut, useTableShortcuts } from '@/lib/table-shortcuts.ts'

function ShortcutList({ title, items }: { title: string; items: TableShortcut[] }) {
  if (items.length === 0) return null
  return (
    <details className="mb-2" open>
      <summary className="cursor-pointer px-1 text-xs font-semibold text-ink-sub">{title}</summary>
      <ul className="mt-1">
        {items.map((t) => (
          <li key={JSON.stringify([t.db, t.schema ?? '', t.table])}>
            <Link
              to="/db/$db/table/$table"
              params={{ db: t.db, table: t.table }}
              search={t.schema ? { schema: t.schema } : {}}
              className="block truncate rounded px-2 py-0.5 text-sm text-ink hover:bg-surface-sub"
            >
              <span className="text-ink-sub">
                {t.db}
                {t.schema ? `.${t.schema}` : ''}.
              </span>
              {t.table}
            </Link>
          </li>
        ))}
      </ul>
    </details>
  )
}

/** phpMyAdmin's Favorites and Recent lists, above the tree; nothing is shown while both are empty. */
export function TableShortcuts() {
  const { favorites, recent } = useTableShortcuts()
  return (
    <>
      <ShortcutList title={locale.nav.favoriteTables} items={favorites} />
      <ShortcutList title={locale.nav.recentTables} items={recent} />
    </>
  )
}
