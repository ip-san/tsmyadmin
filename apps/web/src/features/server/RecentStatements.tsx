import { useQuery } from '@tanstack/react-query'
import { sqlScript } from '@tsmyadmin/shared'
import { useEffect, useRef, useState } from 'react'
import { PreviewDialog } from '@/components/ddl/PreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Select } from '@/components/ui/Field.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale, numberLocale } from '@/config/locale.ts'
import { usePreviewFlow } from '@/lib/preview-flow.ts'
import { mutations, recentStatementsQuery, sessionQuery } from '@/lib/queries.ts'
import { MONITOR_SECONDS } from './monitor.ts'
import { clockTime, EMPTY_HISTORY, foldReport } from './recent-statements.ts'

const t = locale.diagnostics.recent

type LogSwitch = 'on' | 'off'
const SWITCH_SQL: Record<LogSwitch, string[]> = {
  on: ["SET GLOBAL log_output = 'TABLE'", "SET GLOBAL general_log = 'ON'"],
  off: ["SET GLOBAL general_log = 'OFF'"],
}

/** Turning the general log on or off is a server-wide change: previewed, then run through the SQL route. */
function useLogSwitch(db: string) {
  return usePreviewFlow<LogSwitch>({
    preview: async (op) => ({ sql: SWITCH_SQL[op] }),
    execute: async (_op, sql) => ({
      results: await mutations.executeSql(db, { sql: sqlScript('mysql', sql), stopOnError: true }),
    }),
    invalidate: (key) => key[0] === 'server',
  })
}

/**
 * The statements the application under test is running, as they run: MySQL's general log (a table, read from the
 * newest time seen), PostgreSQL's pg_stat_statements (call counts, subtracted between reads). This tool's own
 * statements are left out. The history lives in this page only.
 */
export function RecentStatements() {
  const session = useQuery(sessionQuery).data
  const dialect = session?.dialect ?? 'mysql'
  const [every, setEvery] = useState<number>(2)
  const [paused, setPaused] = useState(false)
  const [history, setHistory] = useState(EMPTY_HISTORY)
  const since = useRef<string | undefined>(undefined)
  since.current = history.since
  const report = useQuery({
    ...recentStatementsQuery(() => since.current),
    refetchInterval: paused ? false : every * 1000,
  })
  useEffect(() => {
    if (report.data) setHistory((h) => foldReport(h, report.data, new Date(report.dataUpdatedAt)))
  }, [report.data, report.dataUpdatedAt])
  const flow = useLogSwitch(session?.serverDatabase ?? '')
  const status = report.data?.status
  const off = status === 'disabled' || status === 'notTable'
  return (
    <section className="space-y-2" aria-labelledby="recent-title">
      <div className="flex flex-wrap items-center gap-3">
        <h3 id="recent-title" className="text-sm text-ink">
          {t.title}
        </h3>
        <label className="flex items-center gap-1 text-xs text-ink-sub">
          {t.every}
          <Select value={String(every)} onChange={(e) => setEvery(Number(e.target.value))} className="w-auto py-1">
            {MONITOR_SECONDS.map((s) => (
              <option key={s} value={s}>
                {locale.server.refreshSeconds(s)}
              </option>
            ))}
          </Select>
        </label>
        {/* Named for what they act on: the charts above have buttons with the same words. */}
        <Button
          size="sm"
          aria-pressed={paused}
          aria-label={`${paused ? locale.monitor.resume : locale.monitor.pause}: ${t.title}`}
          onClick={() => setPaused((p) => !p)}
        >
          {paused ? locale.monitor.resume : locale.monitor.pause}
        </Button>
        <Button
          size="sm"
          aria-label={`${locale.monitor.clear}: ${t.title}`}
          onClick={() => setHistory((h) => ({ ...h, entries: [] }))}
          disabled={history.entries.length === 0}
        >
          {locale.monitor.clear}
        </Button>
        {dialect === 'mysql' && status === 'ok' ? (
          <Button size="sm" onClick={() => flow.preview('off')}>
            {t.turnOff}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-ink-sub">{dialect === 'mysql' ? t.hintMysql : t.hintPostgres}</p>
      {report.isPending ? <Spinner /> : null}
      {report.isError ? <ErrorBox error={report.error} onRetry={() => void report.refetch()} /> : null}
      {status !== undefined && status !== 'ok' ? (
        <Notice>
          {locale.diagnostics.status.recentStatements[status]}
          {dialect === 'mysql' && off ? (
            <Button size="sm" className="ml-2" onClick={() => flow.preview('on')}>
              {t.turnOn}
            </Button>
          ) : null}
        </Notice>
      ) : null}
      {status === 'ok' && history.entries.length === 0 ? <p className="text-sm text-ink-sub">{t.waiting}</p> : null}
      {history.entries.length > 0 ? (
        <Table aria-label={t.title}>
          <thead>
            <tr>
              <Th>{locale.diagnostics.columns.time}</Th>
              <Th>{locale.diagnostics.columns.statement}</Th>
              <Th className="text-right">{locale.diagnostics.columns.runs}</Th>
            </tr>
          </thead>
          <tbody>
            {history.entries.map((e) => (
              <Tr key={e.id}>
                <Td className="whitespace-nowrap font-mono text-xs">{clockTime(e.time)}</Td>
                <Td className="max-w-[60ch] break-words font-mono text-xs">{e.statement}</Td>
                <Td className="text-right tabular-nums">{e.runs.toLocaleString(numberLocale)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      ) : null}
      <PreviewDialog
        flow={flow}
        title={(op) => (op === 'on' ? t.turnOn : t.turnOff)}
        destructive={() => false}
        hint={flow.op === 'off' ? t.offHint : t.onHint}
        successMessage={(op) => (op === 'on' ? t.turnedOn : t.turnedOff)}
      />
    </section>
  )
}
