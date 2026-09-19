import { Link } from '@tanstack/react-router'
import { isViewKind, type TableInfo } from '@tsmyadmin/shared'
import { Eye, ListOrdered, Table2 } from 'lucide-react'

export const ROW_HEIGHT = 26

interface RowProps {
  db: string
  schema?: string | undefined
  table: TableInfo
}

/** The link itself; the caller supplies the <li> (static or absolutely positioned when virtualized). */
export function TableLink({ db, schema, table }: RowProps) {
  return (
    <Link
      to="/db/$db/table/$table"
      params={{ db, table: table.name }}
      search={schema ? { schema } : {}}
      className="flex h-full items-center gap-1 truncate rounded px-1 text-sm text-ink hover:bg-surface-sub"
      activeProps={{ className: 'bg-brand/10 font-medium text-brand' }}
      title={table.name}
    >
      {table.kind === 'sequence' ? (
        <ListOrdered className="size-3.5 shrink-0" aria-hidden />
      ) : isViewKind(table.kind) ? (
        <Eye className="size-3.5 shrink-0" aria-hidden />
      ) : (
        <Table2 className="size-3.5 shrink-0" aria-hidden />
      )}
      <span className="truncate">{table.name}</span>
    </Link>
  )
}
