import { Button } from '@/components/ui/Button.tsx'
import { locale, numberLocale } from '@/config/locale.ts'
import { clearDebugSql, DEBUG_SQL_MAX, useDebugSql } from '@/lib/debug-sql.ts'

const time = (at: number) => new Date(at).toLocaleTimeString(numberLocale)

/**
 * "Debug SQL": what this page itself sent to the server since it was opened — rows fetched, statements run — with how
 * long each took. Kept in this browser tab only (newest 200); passwords in account statements are masked.
 */
export function DebugSqlPanel({ onLoad, onRerun }: { onLoad: (sql: string) => void; onRerun: (sql: string) => void }) {
  const entries = useDebugSql()
  const newestFirst = [...entries].reverse()
  return (
    <details className="rounded border border-line">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink">
        {locale.sql.debug} ({entries.length})
      </summary>
      <div className="max-h-64 overflow-auto border-t border-line">
        <p className="px-3 py-2 text-xs text-ink-sub">{locale.sql.debugNote(DEBUG_SQL_MAX)}</p>
        {entries.length === 0 ? (
          <p className="px-3 py-2 text-xs text-ink-sub">{locale.sql.noDebug}</p>
        ) : (
          <>
            <ul>
              {newestFirst.map((e) => (
                <li key={e.id} className="flex items-start gap-2 border-b border-line px-3 py-1.5 text-xs">
                  <span className="shrink-0 tabular-nums text-ink-sub">{time(e.at)}</span>
                  <span className="w-16 shrink-0 text-right tabular-nums text-ink-sub">
                    {e.ms === null ? '' : locale.sql.debugMs(e.ms)}
                  </span>
                  <code
                    className={`min-w-0 flex-1 whitespace-pre-wrap break-all font-mono ${e.ok ? '' : 'text-red-700 dark:text-red-300'}`}
                  >
                    {e.sql}
                  </code>
                  <Button size="sm" onClick={() => onLoad(e.rerun)}>
                    {locale.sql.load}
                  </Button>
                  <Button size="sm" onClick={() => onRerun(e.rerun)}>
                    {locale.sql.debugRerun}
                  </Button>
                </li>
              ))}
            </ul>
            <div className="px-3 py-2">
              <Button size="sm" onClick={clearDebugSql}>
                {locale.sql.debugClear}
              </Button>
            </div>
          </>
        )}
      </div>
    </details>
  )
}
