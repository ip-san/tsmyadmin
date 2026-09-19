import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale.ts'

/** What EXPLAIN takes: MySQL 5.7+ and PostgreSQL both explain these, not a DDL statement or a SET. */
const EXPLAINABLE = /^\s*(?:SELECT|WITH|INSERT|UPDATE|DELETE|REPLACE|TABLE|VALUES|\()\b/i

export interface StatementHandlers {
  edit: (sql: string) => void
  rerun: (sql: string) => void
  explain: (sql: string) => void
  code: (sql: string) => void
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
        <Button size="sm" onClick={() => handlers.explain(sql)} aria-label={of(t.explain)}>
          {t.explain}
        </Button>
      ) : null}
      <Button size="sm" onClick={() => handlers.code(sql)} aria-label={of(t.code)}>
        {t.code}
      </Button>
    </div>
  )
}
