import { useQuery } from '@tanstack/react-query'
import { capabilities, type DiagnosticColumn, type DiagnosticKind } from '@tsmyadmin/shared'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { numberLocale } from '@/config/locale.ts'
import { locale } from '@/config/locale-screens.ts'
import { loggedStatementPlan } from '@/lib/logged-statement.ts'
import { useOpenInDatabaseConsole } from '@/lib/open-in-console.ts'
import { diagnosticsQuery } from '@/lib/queries.ts'
import { useDialect } from '@/lib/session.ts'

const t = locale.diagnostics

const NUMERIC: ReadonlySet<DiagnosticColumn> = new Set([
  'runs',
  'totalSeconds',
  'maxSeconds',
  'rowsExamined',
  'rows',
  'position',
  'serverId',
  'endPosition',
])

/** A number of seconds or rows as text, kept short. */
function figure(column: DiagnosticColumn, value: string | null): string {
  if (value === null) return ''
  const n = Number(value)
  if (!Number.isFinite(n)) return value
  return column === 'totalSeconds' || column === 'maxSeconds'
    ? n.toLocaleString(numberLocale, { maximumFractionDigits: 3 })
    : n.toLocaleString(numberLocale)
}

/**
 * A logged statement's plan, read in the database it ran in: the statement goes to that database's SQL tab, which
 * draws its plan on arrival (EXPLAIN only, nothing runs), or, where its values were not logged, asks for them first.
 */
function PlanButton({ db, sql, table, n }: { db: string; sql: string; table: string; n: number }) {
  const open = useOpenInDatabaseConsole(db, undefined)
  const plan = loggedStatementPlan(
    sql,
    { fill: t.fillValues, forAny: t.planForAny },
    capabilities(useDialect()).genericPlan
  )
  if (plan === null) return null
  return (
    <Button
      size="sm"
      className="mt-1"
      aria-label={t.planLabel(table, n)}
      title={t.planHint}
      onClick={() => open(plan.sql, plan.drawn ? 'plan' : undefined)}
    >
      {t.plan}
    </Button>
  )
}

/**
 * One of the server's diagnostic reads: a table of rows, one block of text, or the reason there is nothing (the log
 * is off, it goes to a file, the account may not read it, the server has no such thing).
 */
export function DiagnosticReport({
  kind,
  file,
  title,
  enabled = true,
}: {
  kind: DiagnosticKind
  file?: string
  title: string
  enabled?: boolean
}) {
  const report = useQuery({ ...diagnosticsQuery(kind, file), enabled })
  if (report.isPending) return enabled ? <Spinner /> : null
  if (report.isError) return <ErrorBox error={report.error} onRetry={() => void report.refetch()} />
  const { status, columns, rows, text } = report.data
  if (status !== 'ok') return <Notice>{t.status[kind][status]}</Notice>
  if (text !== null)
    return (
      <pre
        tabIndex={0}
        aria-label={title}
        className="max-h-[32rem] overflow-auto whitespace-pre rounded border border-line bg-surface-sub p-3 font-mono text-xs"
      >
        {text}
      </pre>
    )
  if (rows.length === 0) return <p className="text-sm text-ink-sub">{t.empty}</p>
  // Where the server says which database a statement ran in, its plan can be read there.
  const at = columns.indexOf('database')
  const databaseOf = (row: (string | null)[]) => (at < 0 ? null : (row[at] ?? null))
  return (
    <div className="space-y-2">
      {report.data.othersHidden ? <Notice>{t.othersHidden}</Notice> : null}
      <Table aria-label={title}>
        <thead>
          <tr>
            {columns.map((c) => (
              <Th key={c} className={NUMERIC.has(c) ? 'text-right' : ''}>
                {t.columns[c]}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, n) => {
            const db = databaseOf(row)
            return (
              <Tr key={JSON.stringify(row)}>
                {row.map((value, i) => {
                  const column = columns[i] ?? 'statement'
                  return (
                    <Td
                      key={`${column}:${i}`}
                      className={
                        NUMERIC.has(column)
                          ? 'whitespace-nowrap text-right text-xs tabular-nums'
                          : 'max-w-xl break-words font-mono text-xs'
                      }
                    >
                      {NUMERIC.has(column) ? figure(column, value) : (value ?? '')}
                      {column === 'statement' && value !== null && db ? (
                        <div>
                          <PlanButton db={db} sql={value} table={title} n={n + 1} />
                        </div>
                      ) : null}
                    </Td>
                  )
                })}
              </Tr>
            )
          })}
        </tbody>
      </Table>
    </div>
  )
}
