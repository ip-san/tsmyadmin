import { Link } from '@tanstack/react-router'
import type { Cell, ForeignKeyDef, ReferencingKeyDef } from '@tsmyadmin/shared'
import { CornerDownLeft, ExternalLink } from 'lucide-react'
import { CellValue } from '@/components/cells/CellValue.tsx'
import { locale } from '@/config/locale.ts'
import { fkTarget, reverseTarget } from './fk-links.ts'

/** A cell value, followed by a link to the referenced row when the column is a single-column foreign key. */
export function FkCell({
  cell,
  fk,
  reverse = [],
  db,
}: {
  cell: Cell
  fk: ForeignKeyDef | undefined
  reverse?: ReferencingKeyDef[]
  db: string
}) {
  const target = fk ? fkTarget(fk, cell, db) : null
  const reverseLinks = reverse
    .map((r) => ({ ref: r, target: reverseTarget(r, cell, db) }))
    .filter((x) => x.target !== null)
  if (!target && reverseLinks.length === 0) return <CellValue cell={cell} />
  const linkClass = 'text-blue-600 hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-100'
  return (
    <span className="inline-flex items-center gap-1">
      <CellValue cell={cell} />
      {fk && target ? (
        <Link
          to="/db/$db/table/$table"
          params={{ db: target.db, table: target.table }}
          search={{ ...(target.schema ? { schema: target.schema } : {}), filters: target.filters, page: 1 }}
          className={linkClass}
          aria-label={locale.browse.fkLink(target.table, fk.refColumns[0] ?? '')}
          title={locale.browse.fkLink(target.table, fk.refColumns[0] ?? '')}
        >
          <ExternalLink className="size-3" aria-hidden />
        </Link>
      ) : null}
      {reverseLinks.map(({ ref, target: t }) =>
        t ? (
          <Link
            key={ref.name}
            to="/db/$db/table/$table"
            params={{ db: t.db, table: t.table }}
            search={{ ...(t.schema ? { schema: t.schema } : {}), filters: t.filters, page: 1 }}
            className={linkClass}
            aria-label={locale.browse.reverseLink(ref.fromTable, ref.fromColumns[0] ?? '')}
            title={locale.browse.reverseLink(ref.fromTable, ref.fromColumns[0] ?? '')}
          >
            <CornerDownLeft className="size-3" aria-hidden />
          </Link>
        ) : null
      )}
    </span>
  )
}
