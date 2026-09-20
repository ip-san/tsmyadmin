import { Link } from '@tanstack/react-router'
import type { Cell, ForeignKeyDef, ReferencingKeyDef } from '@tsmyadmin/shared'
import { CornerDownLeft, ExternalLink } from 'lucide-react'
import { CellValue } from '@/components/cells/CellValue.tsx'
import { useCellDisplay } from '@/components/cells/cell-display.ts'
import { locale } from '@/config/locale.ts'
import { cn } from '@/lib/cn.ts'
import { fkTarget, reverseTarget } from './fk-links.ts'

/** Up to this many referencing tables get an icon of their own; more are folded into one list. */
const MAX_INLINE_REVERSE = 2

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
  const { fkLabel } = useCellDisplay()
  const target = fk ? fkTarget(fk, cell, db) : null
  const label = fk ? fkLabel?.(fk.columns[0] ?? '', cell) : undefined
  const reverseLinks = reverse
    .map((r) => ({ ref: r, target: reverseTarget(r, cell, db) }))
    .filter((x) => x.target !== null)
  if (!target && reverseLinks.length === 0) return <CellValue cell={cell} />
  const linkClass =
    '-my-1 inline-flex min-h-6 min-w-6 items-center justify-center rounded align-middle text-blue-600 hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-100'
  return (
    <span className="inline-flex items-center gap-1">
      <CellValue cell={cell} />
      {label !== undefined ? <span className="font-sans text-ink-sub">{label}</span> : null}
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
      {reverseLinks.length > MAX_INLINE_REVERSE ? (
        // A key that many tables point at (a company id): one icon each would run out of the cell and over the next.
        <details className="inline-block align-middle">
          <summary
            className={cn(
              linkClass,
              'cursor-pointer list-none gap-0.5 px-1 text-xs [&::-webkit-details-marker]:hidden'
            )}
            aria-label={locale.browse.reverseMany(reverseLinks.length)}
            title={locale.browse.reverseMany(reverseLinks.length)}
          >
            <CornerDownLeft className="size-3" aria-hidden />
            {reverseLinks.length}
          </summary>
          <ul className="mt-1 font-sans text-xs">
            {reverseLinks.map(({ ref, target: t }) =>
              t ? (
                <li key={ref.name}>
                  <Link
                    to="/db/$db/table/$table"
                    params={{ db: t.db, table: t.table }}
                    search={{ ...(t.schema ? { schema: t.schema } : {}), filters: t.filters, page: 1 }}
                    className="inline-flex min-h-6 items-center text-blue-600 hover:underline dark:text-blue-300"
                    aria-label={locale.browse.reverseLink(ref.fromTable, ref.fromColumns[0] ?? '')}
                  >
                    {ref.fromTable}.{ref.fromColumns[0]}
                  </Link>
                </li>
              ) : null
            )}
          </ul>
        </details>
      ) : (
        reverseLinks.map(({ ref, target: t }) =>
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
        )
      )}
    </span>
  )
}
