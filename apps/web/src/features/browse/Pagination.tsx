import { Button } from '@/components/ui/Button.tsx'
import { Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'

const LIMITS = [25, 50, 100, 250, 500, 1000]

export interface PaginationProps {
  page: number
  limit: number
  total: number | null
  approximate?: boolean
  shown: number
  onChange: (patch: { page?: number; limit?: number }) => void
}

export function Pagination({ page, limit, total, approximate = false, shown, onChange }: PaginationProps) {
  const from = shown === 0 ? 0 : (page - 1) * limit + 1
  const to = (page - 1) * limit + shown
  const lastPage = total === null ? null : Math.max(1, Math.ceil(total / limit))
  const hasNext = lastPage === null ? shown === limit : page < lastPage
  return (
    <nav aria-label={locale.tabs.browse} className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-zinc-600 dark:text-zinc-300">
        {locale.browse.total(total, approximate)}
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
          {page}
          {lastPage === null ? '' : ` / ${lastPage}`}
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
