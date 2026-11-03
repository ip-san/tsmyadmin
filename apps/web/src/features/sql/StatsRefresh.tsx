import { PreviewDialog } from '@/components/ddl/PreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale-screens.ts'
import type { StatsSign } from './plan-stats.ts'
import type { StatsRefresh as Refresh } from './use-stats-refresh.ts'

const t = locale.plan

/**
 * The tables whose statistics the plan suggests may be old, each with why, and taking them again from here (ANALYZE,
 * previewed). Done, the plan is read again and the status says the rows it expects of the table before and after.
 * A table refreshed stays listed, so its button (and the focus on it) does not go away under the person.
 */
export function StatsRefresh({
  stats,
  signs,
  rowsNow,
  rereading,
  busy,
}: {
  stats: Refresh
  signs: readonly StatsSign[]
  /** The rows the plan as read now expects of a table (null where it reads no such table). */
  rowsNow: (table: string) => number | null
  /** The plan is being read again. */
  rereading: boolean
  /** Something else runs the statement (a measuring): nothing is taken while it does. */
  busy: boolean
}) {
  const { flow, refreshed } = stats
  const shown =
    refreshed && !signs.some((s) => s.table === refreshed.table)
      ? [...signs, { kind: 'refreshed' as const, table: refreshed.table }]
      : signs
  const blocked = busy || flow.running || flow.previewing
  const said = !refreshed
    ? ''
    : rereading
      ? t.statsRereading(refreshed.table)
      : t.statsDone(refreshed.table, refreshed.before, rowsNow(refreshed.table), refreshed.cleared)
  return (
    <div className="space-y-2">
      {shown.length > 0 ? (
        <section aria-label={t.statsGroup} className="space-y-2 rounded border border-line p-2 text-xs">
          <p className="text-ink">{t.statsIntro}</p>
          <ul className="space-y-1">
            {shown.map((s) => (
              <li key={s.table} className="flex flex-wrap items-center gap-2">
                <span className="text-ink-sub">
                  {s.kind === 'list'
                    ? t.statsList(s.table, s.plan, s.list)
                    : s.kind === 'measured'
                      ? t.statsMeasured(s.table, s.expected, s.actual)
                      : t.statsTaken(s.table)}
                </span>
                <Button
                  size="sm"
                  aria-haspopup="dialog"
                  aria-disabled={blocked || undefined}
                  onClick={() => !blocked && stats.refresh(s.table, rowsNow(s.table))}
                >
                  {t.statsRefresh(s.table)}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {/* There from the start, empty: what taking them again did is said in it. */}
      <p role="status" className="text-xs text-ink empty:sr-only">
        {said}
      </p>
      <PreviewDialog
        flow={flow}
        title={(op) => locale.ddl.titles[op.op]}
        destructive={() => false}
        hint={t.statsHint}
        successMessage={(op) => locale.ddl.executed(locale.ddl.titles[op.op])}
      />
    </div>
  )
}
