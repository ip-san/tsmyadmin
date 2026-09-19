import type { TableInfo } from '@tsmyadmin/shared'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { locale } from '@/config/locale.ts'
import { ROW_HEIGHT, TableLink } from './TableLink.tsx'

/** A run of tables that share a prefix, shown as one collapsible entry of the sidebar. */
export function TableGroup({
  db,
  schema,
  prefix,
  tables,
  open,
  onToggle,
}: {
  db: string
  schema?: string | undefined
  prefix: string
  tables: TableInfo[]
  open: boolean
  onToggle: () => void
}) {
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-h-6 w-full items-center gap-1 rounded px-1 text-left text-sm text-ink-sub hover:bg-surface-sub"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" aria-hidden />
        )}
        <span className="truncate">{locale.nav.groupOf(prefix, tables.length)}</span>
      </button>
      {open ? (
        <ul className="ml-3 border-l border-line pl-2">
          {tables.map((t) => (
            <li key={t.name} style={{ height: ROW_HEIGHT }}>
              <TableLink db={db} schema={schema} table={t} />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}
