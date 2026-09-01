import type { BrowseOptions } from '@tsmyadmin/shared'
import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale.ts'
import { cellToText } from '@/lib/format.ts'

export function FilterChips({ options, onClear }: { options: BrowseOptions; onClear: () => void }) {
  if (options.filters.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="font-medium text-zinc-600 dark:text-zinc-300">{locale.search.activeFilters}:</span>
      {options.filters.map((f) => (
        <span
          key={`${f.column}-${f.op}`}
          className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-amber-900 dark:bg-amber-900 dark:text-amber-100"
        >
          {f.column} {locale.search.ops[f.op]} {f.value === undefined ? '' : cellToText(f.value)}
        </span>
      ))}
      <Button size="sm" onClick={onClear}>
        {locale.search.clear}
      </Button>
    </div>
  )
}
