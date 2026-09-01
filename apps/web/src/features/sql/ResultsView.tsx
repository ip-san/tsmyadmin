import type { StatementResult } from '@tsmyadmin/shared'
import { CellValue } from '@/components/cells/CellValue.tsx'
import { Notice } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { locateInSql } from '@/lib/sql-position.ts'

function Statement({ index, result, maxRows }: { index: number; result: StatementResult; maxRows: number }) {
  const heading = `${locale.sql.statement(index + 1)}`
  if (result.kind === 'error') {
    const where = result.position ? locateInSql(result.sql, result.position) : null
    return (
      <section
        aria-label={heading}
        className="rounded border border-red-300 bg-red-50 p-3 text-sm dark:border-red-700 dark:bg-red-950"
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
              （{locale.sql.errorPosition(where.line, where.column)}）
            </span>
          ) : null}
        </p>
        {where ? (
          <pre className="mt-1 overflow-x-auto font-mono text-xs text-red-900 dark:text-red-100">
            {where.text}
            {'\n'}
            {`${' '.repeat(Math.max(0, where.column - 1))}^`}
          </pre>
        ) : null}
        <pre className="mt-2 overflow-x-auto rounded bg-white/60 p-2 font-mono text-xs text-zinc-700 dark:bg-black/30 dark:text-zinc-200">
          {result.sql}
        </pre>
      </section>
    )
  }
  if (result.kind === 'affected') {
    return (
      <section aria-label={heading} className="space-y-1">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{heading}</h3>
        <Notice>{locale.sql.affected(result.affectedRows, result.durationMs)}</Notice>
        <pre className="overflow-x-auto font-mono text-xs text-zinc-500 dark:text-zinc-400">{result.sql}</pre>
      </section>
    )
  }
  const { columns, rows, truncated } = result.result
  return (
    <section aria-label={heading} className="space-y-1">
      <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
        {heading}{' '}
        <span className="font-normal text-zinc-500 dark:text-zinc-400">
          {locale.sql.rowsResult(rows.length, result.durationMs)}
        </span>
      </h3>
      {truncated ? <Notice>{locale.sql.truncated(maxRows)}</Notice> : null}
      <pre className="overflow-x-auto font-mono text-xs text-zinc-500 dark:text-zinc-400">{result.sql}</pre>
      {rows.length === 0 ? (
        <Notice>{locale.browse.noRows}</Notice>
      ) : (
        <Table>
          <thead>
            <tr>
              {columns.map((c, i) => (
                <Th key={`${c.name}-${i}`}>
                  {c.name} <span className="font-normal text-zinc-400 dark:text-zinc-500">{c.dataType}</span>
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <Tr key={`${r}-${row.length}`}>
                {columns.map((c, i) => (
                  <Td key={`${c.name}-${i}`} className="max-w-md font-mono text-xs">
                    <CellValue cell={row[i] ?? null} />
                  </Td>
                ))}
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  )
}

export function ResultsView({ results, maxRows }: { results: StatementResult[]; maxRows: number }) {
  if (results.length === 0) return <Notice>{locale.sql.empty}</Notice>
  return (
    <div className="space-y-4" aria-label={locale.sql.results}>
      {results.map((r, i) => (
        <Statement key={`${i}-${r.sql}`} index={i} result={r} maxRows={maxRows} />
      ))}
    </div>
  )
}
