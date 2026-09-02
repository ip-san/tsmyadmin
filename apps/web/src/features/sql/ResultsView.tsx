import { useVirtualizer } from '@tanstack/react-virtual'
import type { Cell, ResultSet, StatementResult } from '@tsmyadmin/shared'
import { toCsv } from '@tsmyadmin/shared'
import { Download } from 'lucide-react'
import { type CSSProperties, memo, useRef } from 'react'
import { CellValue } from '@/components/cells/CellValue.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Notice } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { downloadText, safeFilename } from '@/lib/download.ts'
import { locateInSql } from '@/lib/sql-position.ts'

/** Client-side export of one result set (what is on screen, up to maxRows). */
function DownloadButtons({ result, label, index }: { result: ResultSet; label: string; index: number }) {
  const names = result.columns.map((c) => c.name)
  const csv = () => downloadText(safeFilename(label, 'csv'), toCsv(names, result.rows), 'text/csv;charset=utf-8')
  const json = () =>
    downloadText(
      safeFilename(label, 'json'),
      JSON.stringify(
        result.rows.map((row) => Object.fromEntries(names.map((n, i) => [n, row[i] ?? null]))),
        null,
        2
      ),
      'application/json'
    )
  return (
    <span className="ml-2 inline-flex gap-1">
      <Button size="sm" onClick={csv} aria-label={`${locale.sql.downloadResult(index + 1)} ${locale.sql.downloadCsv}`}>
        <Download className="size-3" aria-hidden />
        {locale.sql.downloadCsv}
      </Button>
      <Button
        size="sm"
        onClick={json}
        aria-label={`${locale.sql.downloadResult(index + 1)} ${locale.sql.downloadJson}`}
      >
        <Download className="size-3" aria-hidden />
        {locale.sql.downloadJson}
      </Button>
    </span>
  )
}

/** Rendered per statement; memoised because streaming appends re-render the list many times. */
const Statement = memo(function Statement({
  index,
  result,
  maxRows,
}: {
  index: number
  result: StatementResult
  maxRows: number
}) {
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
              {locale.sql.errorPosition(where.line, where.column)}
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
        {rows.length > 0 ? <DownloadButtons result={result.result} label={heading} index={index} /> : null}
      </h3>
      {truncated ? <Notice>{locale.sql.truncated(maxRows)}</Notice> : null}
      <pre className="overflow-x-auto font-mono text-xs text-zinc-500 dark:text-zinc-400">{result.sql}</pre>
      {rows.length === 0 ? <Notice>{locale.browse.noRows}</Notice> : <RowsTable columns={columns} rows={rows} />}
    </section>
  )
})

const ROW_HEIGHT = 29
/** Above this many rows the body is virtualised inside a fixed-height scroller (10k rows × N columns otherwise). */
const VIRTUALIZE_FROM = 200

function RowsTable({ columns, rows }: { columns: ResultSet['columns']; rows: ResultSet['rows'] }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtual = rows.length >= VIRTUALIZE_FROM
  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  })
  const header = (
    <thead>
      <tr>
        {columns.map((c, i) => (
          <Th key={`${c.name}-${i}`}>
            {c.name} <span className="font-normal text-zinc-600 dark:text-zinc-400">{c.dataType}</span>
          </Th>
        ))}
      </tr>
    </thead>
  )
  const renderRow = (row: Cell[], r: number, style?: CSSProperties) => (
    <Tr key={r} style={style} data-index={r} {...(virtual ? { ref: virtualizer.measureElement } : {})}>
      {columns.map((c, i) => (
        <Td key={`${c.name}-${i}`} className="max-w-md font-mono text-xs">
          <CellValue cell={row[i] ?? null} />
        </Td>
      ))}
    </Tr>
  )
  if (!virtual) {
    return (
      <Table>
        {header}
        <tbody>{rows.map((row, r) => renderRow(row, r))}</tbody>
      </Table>
    )
  }
  const items = virtualizer.getVirtualItems()
  const padTop = items[0]?.start ?? 0
  const padBottom = virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0)
  return (
    <div ref={scrollRef} className="max-h-[70vh] overflow-auto">
      <Table>
        {header}
        <tbody>
          {padTop > 0 ? (
            <tr aria-hidden style={{ height: padTop }}>
              <td colSpan={columns.length} />
            </tr>
          ) : null}
          {items.map((item) => {
            const row = rows[item.index]
            return row ? renderRow(row, item.index) : null
          })}
          {padBottom > 0 ? (
            <tr aria-hidden style={{ height: padBottom }}>
              <td colSpan={columns.length} />
            </tr>
          ) : null}
        </tbody>
      </Table>
    </div>
  )
}

export function ResultsView({ results, maxRows }: { results: StatementResult[]; maxRows: number }) {
  if (results.length === 0) return <Notice>{locale.sql.empty}</Notice>
  return (
    <div className="space-y-4" aria-label={locale.sql.results}>
      {results.map((r, i) => (
        <Statement key={i} index={i} result={r} maxRows={maxRows} />
      ))}
    </div>
  )
}
