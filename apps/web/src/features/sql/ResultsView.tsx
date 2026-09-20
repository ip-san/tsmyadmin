import { Link } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Cell, ResultSet, StatementResult } from '@tsmyadmin/shared'
import { type CSSProperties, memo, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { CellValue } from '@/components/cells/CellValue.tsx'
import { ProfileView } from '@/components/results/ProfileView.tsx'
import { ResultChart } from '@/components/results/ResultChart.tsx'
import { StatementActions, type StatementHandlers } from '@/components/sql/StatementActions.tsx'
import { Notice } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { cn } from '@/lib/cn.ts'
import { setPrinting, usePrinting } from '@/lib/printing.ts'
import { ResultActions } from './ResultActions.tsx'
import { StatementError } from './StatementError.tsx'

interface ViewTarget {
  db: string
  schema?: string | undefined
}

/** A statement a view can be made of (phpMyAdmin's "Create view" under a result): a SELECT or a WITH query. */
const SELECT = /^\s*(?:SELECT|WITH|\()\b/i

/** Rendered per statement; memoised because streaming appends re-render the list many times. */
const Statement = memo(function Statement({
  index,
  result,
  maxRows,
  printHidden,
  onPrint,
  viewTarget,
  handlers,
}: {
  index: number
  result: StatementResult
  handlers: StatementHandlers | undefined
  maxRows: number
  /** Where a view made from this SELECT would be created (the console's database); absent to offer none. */
  viewTarget: ViewTarget | undefined
  /** Another statement's result is being printed on its own. */
  printHidden: boolean
  onPrint: (index: number) => void
}) {
  const heading = `${locale.sql.statement(index + 1)}`
  const [chartOpen, setChartOpen] = useState(false)
  const paper = printHidden ? 'print:hidden' : ''
  if (result.kind === 'error') return <StatementError result={result} heading={heading} className={paper} />
  if (result.kind === 'affected') {
    return (
      <section aria-label={heading} className={cn('space-y-1', paper)}>
        <h3 className="text-sm font-semibold text-ink">{heading}</h3>
        <Notice>
          {locale.sql.affected(result.affectedRows, result.durationMs)}
          {(result.notices ?? []).map((n, i) => (
            <span key={`${i}-${n}`} className="block text-xs text-amber-900 dark:text-amber-200">
              {n}
            </span>
          ))}
        </Notice>
        <ProfileView profile={result.profile} />
        <pre tabIndex={0} className="overflow-x-auto font-mono text-xs text-ink-sub">
          {result.sql}
        </pre>
        {handlers ? <StatementActions sql={result.sql} index={index} handlers={handlers} /> : null}
      </section>
    )
  }
  const { columns, rows, truncated } = result.result
  return (
    <section aria-label={heading} className={cn('space-y-1', paper)}>
      <h3 className="text-sm font-semibold text-ink">
        {heading}{' '}
        <span className="font-normal text-ink-sub">{locale.sql.rowsResult(rows.length, result.durationMs)}</span>
        {rows.length > 0 ? (
          <ResultActions
            result={result.result}
            label={heading}
            index={index}
            chartOpen={chartOpen}
            onToggleChart={() => setChartOpen((open) => !open)}
            onPrint={() => onPrint(index)}
          />
        ) : null}
      </h3>
      {chartOpen && rows.length > 0 ? <ResultChart result={result.result} /> : null}
      {truncated ? <Notice>{locale.sql.truncated(maxRows)}</Notice> : null}
      <ProfileView profile={result.profile} />
      <pre tabIndex={0} className="overflow-x-auto font-mono text-xs text-ink-sub">
        {result.sql}
      </pre>
      {handlers ? <StatementActions sql={result.sql} index={index} handlers={handlers} /> : null}
      {viewTarget && SELECT.test(result.sql) ? (
        <Link
          to="/db/$db"
          params={{ db: viewTarget.db }}
          search={{ ...(viewTarget.schema ? { schema: viewTarget.schema } : {}), createView: result.sql }}
          className="text-xs text-blue-700 underline print:hidden dark:text-blue-300"
        >
          {locale.sql.createView}
        </Link>
      ) : null}
      {rows.length === 0 ? (
        <Notice>{locale.browse.noRows}</Notice>
      ) : (
        <RowsTable columns={columns} rows={rows} label={heading} />
      )}
    </section>
  )
})

const ROW_HEIGHT = 29
/** Above this many rows the body is virtualised inside a fixed-height scroller (10k rows × N columns otherwise). */
const VIRTUALIZE_FROM = 200
/** Rows laid out for paper, where nothing can be virtualised; a longer result says it was cut. */
const PRINT_MAX_ROWS = 1000

function RowsTable({
  columns,
  rows,
  label,
}: {
  columns: ResultSet['columns']
  rows: ResultSet['rows']
  label: string
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // Paper has no scroller: every row (up to the cap) is laid out while printing.
  const printing = usePrinting()
  const virtual = rows.length >= VIRTUALIZE_FROM && !printing
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
            {c.name} <span className="font-normal text-ink-sub">{c.dataType}</span>
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
    const shown = printing ? rows.slice(0, PRINT_MAX_ROWS) : rows
    return (
      <>
        <Table scrollLabel={label}>
          {header}
          <tbody>{shown.map((row, r) => renderRow(row, r))}</tbody>
        </Table>
        {shown.length < rows.length ? (
          <p className="text-xs text-ink-sub">{locale.sql.printCut(PRINT_MAX_ROWS, rows.length)}</p>
        ) : null}
      </>
    )
  }
  const items = virtualizer.getVirtualItems()
  const padTop = items[0]?.start ?? 0
  const padBottom = virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0)
  return (
    <Table scrollLabel={label} scrollRef={scrollRef} scrollClassName="max-h-[70vh] overflow-auto">
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
  )
}

export function ResultsView({
  results,
  maxRows,
  viewTarget,
  handlers,
}: {
  results: StatementResult[]
  maxRows: number
  viewTarget?: ViewTarget
  /** What can be done with a statement after it ran (absent: nothing is offered). */
  handlers?: StatementHandlers
}) {
  /** The statement whose Print button was pressed: only it goes on paper. Ctrl+P alone prints every result. */
  const [printTarget, setPrintTarget] = useState<{ index: number; at: Date } | null>(null)
  useEffect(() => {
    const clear = () => setPrintTarget(null)
    window.addEventListener('afterprint', clear)
    return () => window.removeEventListener('afterprint', clear)
  }, [])
  /** Undoes a Print whose end has not been seen yet; also run when the results go away, so nothing outlives them. */
  const pendingReset = useRef<(() => void) | null>(null)
  useEffect(() => () => pendingReset.current?.(), [])
  // Stable across renders so the memoised statements are not all re-rendered by a new function each time.
  const onPrint = useRef((index: number) => {
    pendingReset.current?.()
    // Committed before the dialog opens: the browser lays the page out for paper at the moment print() is called.
    flushSync(() => {
      setPrintTarget({ index, at: new Date() })
      setPrinting(true)
    })
    let finished = false
    const markFinished = () => {
      finished = true
    }
    // Left set, the next Ctrl+P would print this statement alone and the screen would stay unwindowed. Most
    // browsers block in print() and fire afterprint inside it; one that returns early is reset by afterprint later,
    // and one that never fires it by the user's next key press or click.
    const later = ['afterprint', 'keydown', 'pointerdown'] as const
    const reset = () => {
      for (const type of later) window.removeEventListener(type, reset, true)
      pendingReset.current = null
      setPrinting(false)
      setPrintTarget(null)
    }
    window.addEventListener('afterprint', markFinished)
    try {
      window.print()
    } finally {
      window.removeEventListener('afterprint', markFinished)
      if (finished) reset()
      else {
        for (const type of later) window.addEventListener(type, reset, true)
        pendingReset.current = reset
      }
    }
  }).current
  if (results.length === 0) return <Notice>{locale.sql.empty}</Notice>
  return (
    <div className="print-expand space-y-4" aria-label={locale.sql.results}>
      {printTarget ? (
        <p className="hidden text-xs text-ink-sub print:block">
          {locale.sql.printedAt(printTarget.at.toLocaleString())}
        </p>
      ) : null}
      {results.map((r, i) => (
        <Statement
          key={i}
          index={i}
          result={r}
          maxRows={maxRows}
          printHidden={printTarget !== null && printTarget.index !== i}
          onPrint={onPrint}
          viewTarget={viewTarget}
          handlers={handlers}
        />
      ))}
    </div>
  )
}
