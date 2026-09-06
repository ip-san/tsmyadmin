import type { CountKind } from '@tsmyadmin/shared'
import { Button } from '@/components/ui/Button.tsx'
import { Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'

const LIMITS = [25, 50, 100, 250, 500, 1000]

export interface PaginationProps {
  page: number
  limit: number
  total: number | null
  count?: CountKind
  shown: number
  onChange: (patch: { page?: number; limit?: number }) => void
}

export function Pagination({ page, limit, total, count = 'exact', shown, onChange }: PaginationProps) {
  const from = shown === 0 ? 0 : (page - 1) * limit + 1
  const to = (page - 1) * limit + shown
  // A floor says nothing about where the rows end: page forward while pages come back full. A catalog estimate
  // may undercount, so a full page keeps 次へ open past its computed last page too.
  const lastPage = total === null || count === 'lower_bound' ? null : Math.max(1, Math.ceil(total / limit))
  const hasNext =
    lastPage === null || count === 'estimate'
      ? shown === limit || (lastPage !== null && page < lastPage)
      : page < lastPage
  return (
    <nav aria-label={locale.tabs.browse} className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-zinc-600 dark:text-zinc-300">
        {locale.browse.total(total, count)}
        {to > 0 ? ` · ${locale.browse.range(from, to)}` : ''}
      </span>
      <div className="ml-auto flex items-center gap-1">
        <Button size="sm" onClick={() => onChange({ page: 1 })} disabled={page <= 1} aria-label={locale.browse.first}>
          «
        </Button>
        <Button size="sm" onClick={() => onChange({ page: page - 1 })} disabled={page <= 1}>
          {locale.browse.prev}
        </Button>
        <span className="px-2 tabular-nums" aria-current="page">
          {locale.browse.pageLabel(page, lastPage, count)}
        </span>
        <Button size="sm" onClick={() => onChange({ page: page + 1 })} disabled={!hasNext}>
          {locale.browse.next}
        </Button>
        <Button
          size="sm"
          onClick={() => lastPage && onChange({ page: lastPage })}
          disabled={lastPage === null || page >= lastPage}
          aria-label={locale.browse.last}
        >
          »
        </Button>
        <label htmlFor="browse-limit" className="ml-2 flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-300">
          {locale.browse.perPage}
          <Select
            id="browse-limit"
            value={limit}
            onChange={(e) => onChange({ limit: Number(e.target.value), page: 1 })}
            className="w-auto py-1"
          >
            {LIMITS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
        </label>
      </div>
    </nav>
  )
}
