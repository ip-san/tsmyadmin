import { Link } from '@tanstack/react-router'
import type { Cell, ForeignKeyDef } from '@tsmyadmin/shared'
import { ExternalLink } from 'lucide-react'
import { CellValue } from '@/components/cells/CellValue.tsx'
import { locale } from '@/config/locale.ts'
import { fkTarget } from './fk-links.ts'

/** A cell value, followed by a link to the referenced row when the column is a single-column foreign key. */
export function FkCell({ cell, fk, db }: { cell: Cell; fk: ForeignKeyDef | undefined; db: string }) {
  const target = fk ? fkTarget(fk, cell, db) : null
  if (!fk || !target) return <CellValue cell={cell} />
  const refColumn = fk.refColumns[0] ?? ''
  return (
    <span className="inline-flex items-center gap-1">
      <CellValue cell={cell} />
      <Link
        to="/db/$db/table/$table"
        params={{ db: target.db, table: target.table }}
        search={{ ...(target.schema ? { schema: target.schema } : {}), filters: target.filters, page: 1 }}
        className="text-blue-600 hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-100"
        aria-label={locale.browse.fkLink(target.table, refColumn)}
        title={locale.browse.fkLink(target.table, refColumn)}
      >
        <ExternalLink className="size-3" aria-hidden />
      </Link>
    </span>
  )
}
