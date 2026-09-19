import type { StatementResult } from '@tsmyadmin/shared'
import { locale } from '@/config/locale.ts'
import { cn } from '@/lib/cn.ts'
import { locateInSql } from '@/lib/sql-position.ts'

/** A statement that failed: the server's message, where in the SQL it points (PostgreSQL), and the SQL itself. */
export function StatementError({
  result,
  heading,
  className,
}: {
  result: Extract<StatementResult, { kind: 'error' }>
  heading: string
  className?: string
}) {
  const where = result.position ? locateInSql(result.sql, result.position) : null
  return (
    <section
      aria-label={heading}
      className={cn(
        'rounded border border-red-300 bg-red-50 p-3 text-sm dark:border-red-700 dark:bg-red-950',
        className
      )}
    >
      <h3 className="mb-1 font-semibold text-red-800 dark:text-red-200">
        {heading} — {locale.common.error}
        {result.nativeCode ? (
          <span className="ml-2 font-mono text-xs" title={locale.sql.nativeCode}>
            {result.nativeCode}
          </span>
        ) : null}
      </h3>
      <p role="alert" className="text-red-800 dark:text-red-200">
        {result.message}
        {where ? (
          <span className="ml-2 text-xs text-red-700 dark:text-red-300">
            {locale.sql.errorPosition(where.line, where.column)}
          </span>
        ) : null}
      </p>
      {where ? (
        <pre tabIndex={0} className="mt-1 overflow-x-auto font-mono text-xs text-red-900 dark:text-red-100">
          {where.text}
          {'\n'}
          {`${' '.repeat(Math.max(0, where.column - 1))}^`}
        </pre>
      ) : null}
      <pre
        tabIndex={0}
        className="mt-2 overflow-x-auto rounded bg-white/60 p-2 font-mono text-xs text-ink dark:bg-black/30"
      >
        {result.sql}
      </pre>
    </section>
  )
}
