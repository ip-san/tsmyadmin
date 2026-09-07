import { Link } from '@tanstack/react-router'
import type { ImportResult } from '@tsmyadmin/shared'
import { Notice } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'

/** Result banner; the live region is rendered by the parent so it exists before the message arrives. */
export function ImportSummary({
  result,
  db,
  schema,
}: {
  result: ImportResult
  db: string
  schema?: string | undefined
}) {
  if (result.format === 'csv') {
    return (
      <Notice>
        {locale.import.csvResult(result.inserted, result.table, result.durationMs)}{' '}
        <Link
          to="/db/$db/table/$table"
          params={{ db, table: result.table }}
          search={schema ? { schema } : {}}
          className="text-blue-700 underline dark:text-blue-300"
        >
          {locale.import.viewRows}
        </Link>
        {result.skippedColumns.length > 0 ? (
          <span className="block text-xs">{locale.import.skippedColumns(result.skippedColumns.join(', '))}</span>
        ) : null}
      </Notice>
    )
  }
  const skipped = result.total - result.statements
  return (
    <div className="space-y-2">
      <Notice>
        {locale.import.sqlResult(result.succeeded, result.failed, result.durationMs)}
        {skipped > 0 ? <span className="block text-xs">{locale.import.skipped(skipped)}</span> : null}
        {result.warnings.map((w) => (
          <span key={w} className="block text-xs text-amber-900 dark:text-amber-200">
            {locale.import.warnings[w]}
          </span>
        ))}
      </Notice>
      {result.errors.length > 0 ? (
        <section className="rounded border border-red-300 bg-red-50 p-3 text-sm dark:border-red-700 dark:bg-red-950">
          <h3 className="mb-1 font-semibold text-red-800 dark:text-red-200">{locale.import.errors}</h3>
          <ul className="space-y-1">
            {/* The enclosing <output> already announces; per-item alerts would fire twenty times at once. */}
            {result.errors.map((e, i) => (
              <li key={`${i}-${e.sql}`} className="text-red-800 dark:text-red-200">
                <span>
                  {e.line !== undefined && e.index !== undefined ? `${locale.import.errorAt(e.line, e.index)}: ` : ''}
                  {e.message}
                </span>
                <pre tabIndex={0} className="mt-0.5 overflow-x-auto font-mono text-xs text-zinc-600 dark:text-zinc-300">
                  {e.sql}
                </pre>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
