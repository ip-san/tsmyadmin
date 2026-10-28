import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale-screens.ts'
import type { RowCounts } from '@/lib/use-row-counts.ts'

const t = locale.tour

/**
 * The button that counts a presentation's rows exactly (`useRowCounts`), and what it is doing: there from the start
 * (empty), then counting, then counted, naming the tables that could not be (they keep their estimate). Pressed while
 * counting, it does nothing more: it stays (`aria-disabled`), so the focus is not lost.
 */
export function CountRows({ counts, tables }: { counts: RowCounts; tables: number }) {
  let said = ''
  if (counts.counting) said = t.counting(tables)
  else if (counts.failed.length > 0) said = t.countFailed(counts.failed.join(', '), counts.failed.length < tables)
  else if (counts.done) said = t.counted
  return (
    <span className="flex items-center gap-2">
      <Button
        size="sm"
        title={t.countHint}
        aria-disabled={counts.counting || undefined}
        onClick={() => {
          if (!counts.counting) counts.count()
        }}
      >
        {t.count}
      </Button>
      <span role="status" className="text-xs text-ink-sub empty:sr-only">
        {said}
      </span>
    </span>
  )
}
