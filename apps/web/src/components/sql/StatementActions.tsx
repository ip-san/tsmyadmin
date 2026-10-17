import { EXPLAINABLE } from '@tsmyadmin/shared'
import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale.ts'

export interface StatementHandlers {
  edit: (sql: string) => void
  rerun: (sql: string) => void
  explain: (sql: string) => void
  /** Optional: draw the statement's plan (the SQL tab's own results). */
  visualize?: (sql: string) => void
  code: (sql: string) => void
  /** Optional: keep the statement as a bookmark (the console's own results have it in the history instead). */
  bookmark?: (sql: string) => void
}

/** Under a statement that ran: carry on from it — edit it, run it again, explain it, or turn it into code. */
export function StatementActions({
  sql,
  index,
  handlers,
}: {
  sql: string
  index: number
  handlers: StatementHandlers
}) {
  const t = locale.sql.after
  const of = (action: string) => `${locale.sql.statement(index + 1)} ${action}`
  // One statement only: EXPLAIN over a script would explain its first statement, which is not what was run.
  const single = !sql
    .trim()
    .replace(/;+\s*$/, '')
    .includes(';')
  return (
    <div className="flex flex-wrap items-center gap-2 print:hidden">
      <Button size="sm" onClick={() => handlers.edit(sql)} aria-label={of(t.edit)}>
        {t.edit}
      </Button>
      <Button size="sm" onClick={() => handlers.rerun(sql)} aria-label={of(t.rerun)}>
        {t.rerun}
      </Button>
      {single && EXPLAINABLE.test(sql) && !/^\s*EXPLAIN\b/i.test(sql) ? (
        <>
          <Button size="sm" onClick={() => handlers.explain(sql)} aria-label={of(t.explain)}>
            {t.explain}
          </Button>
          {handlers.visualize ? (
            <Button size="sm" onClick={() => handlers.visualize?.(sql)} aria-label={of(locale.plan.show)}>
              {locale.plan.show}
            </Button>
          ) : null}
        </>
      ) : null}
      <Button size="sm" onClick={() => handlers.code(sql)} aria-label={of(t.code)}>
        {t.code}
      </Button>
      {handlers.bookmark ? (
        <Button size="sm" onClick={() => handlers.bookmark?.(sql)} aria-label={of(t.bookmark)}>
          {t.bookmark}
        </Button>
      ) : null}
    </div>
  )
}
