import { useQuery } from '@tanstack/react-query'
import type { DiagnosticColumn, DiagnosticKind } from '@tsmyadmin/shared'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { diagnosticsQuery } from '@/lib/queries.ts'

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
    ? n.toLocaleString('ja-JP', { maximumFractionDigits: 3 })
    : n.toLocaleString('ja-JP')
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
  return (
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
        {rows.map((row) => (
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
                </Td>
              )
            })}
          </Tr>
        ))}
      </tbody>
    </Table>
  )
}
