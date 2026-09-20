import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/Button.tsx'
import { locale, numberLocale } from '@/config/locale.ts'
import { rowCountQuery, type TableRef } from '@/lib/queries.ts'

/**
 * A table's row count in the list: the catalog's estimate, and — on request, since COUNT(*) reads every row —
 * the exact number (phpMyAdmin's "~" counts with the exact one a click away).
 */
export function RowCountCell({ tableRef, estimate }: { tableRef: TableRef; estimate: number | null }) {
  const exact = useQuery({ ...rowCountQuery(tableRef), enabled: false })
  if (exact.data !== undefined)
    return <span title={locale.database.exactCount}>{exact.data.toLocaleString(numberLocale)}</span>
  return (
    <span className="inline-flex items-center gap-1">
      <span title={locale.database.estimated}>
        {estimate === null ? '–' : `~${estimate.toLocaleString(numberLocale)}`}
      </span>
      <Button
        size="sm"
        variant="ghost"
        className="text-xs"
        disabled={exact.isFetching}
        aria-label={locale.database.countOf(tableRef.table)}
        onClick={() => void exact.refetch()}
      >
        {exact.isError ? locale.common.retry : locale.database.count}
      </Button>
    </span>
  )
}
