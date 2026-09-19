import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { sessionQuery, statusQuery } from '@/lib/queries.ts'
import { DiagnosticReport } from './DiagnosticReport.tsx'
import { MonitorChart } from './MonitorChart.tsx'
import { CHARTS, MONITOR_SECONDS, pushSample, type Sample, seriesValues, toSample } from './monitor.ts'

const t = locale.monitor

const formatters = {
  perSecond: (v: number) => t.perSecond(v),
  count: (v: number) => v.toLocaleString('ja-JP'),
  bytesPerSecond: (v: number) => `${locale.common.bytes(v)}/s`,
}

/**
 * phpMyAdmin's real-time Monitor: the server's own counters sampled every few seconds and drawn as they change
 * (counters as a rate, connection counts as they are). Samples live in this page only; leaving it starts afresh.
 */
export function MonitorPage() {
  const dialect = useQuery(sessionQuery).data?.dialect ?? 'mysql'
  const [every, setEvery] = useState<number>(2)
  const [paused, setPaused] = useState(false)
  const [samples, setSamples] = useState<Sample[]>([])
  const status = useQuery({ ...statusQuery, refetchInterval: paused ? false : every * 1000, staleTime: 0 })
  useEffect(() => {
    if (status.data) setSamples((s) => pushSample(s, toSample(status.data, status.dataUpdatedAt)))
  }, [status.data, status.dataUpdatedAt])
  const times = samples.map((s) => s.at)
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-ink">{t.title}</h2>
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
        <Button size="sm" aria-pressed={paused} onClick={() => setPaused((p) => !p)}>
          {paused ? t.resume : t.pause}
        </Button>
        <Button size="sm" onClick={() => setSamples([])} disabled={samples.length === 0}>
          {t.clear}
        </Button>
      </div>
      <p className="text-xs text-ink-sub">{dialect === 'mysql' ? t.hintMysql : t.hintPostgres}</p>
      {status.isPending ? <Spinner /> : null}
      {status.isError ? <ErrorBox error={status.error} onRetry={() => void status.refetch()} /> : null}
      {samples.length === 1 ? <Notice>{t.waiting}</Notice> : null}
      {samples.length > 0 ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {CHARTS[dialect].map((chart) => (
            <MonitorChart
              key={chart.id}
              title={t.charts[chart.id as keyof typeof t.charts]}
              times={times}
              format={formatters[chart.unit]}
              lines={chart.series.map((s) => ({
                label: t.series[s.key as keyof typeof t.series],
                values: seriesValues(s, samples),
              }))}
            />
          ))}
        </div>
      ) : null}
      <div className="space-y-2 pt-3">
        <h2 className="text-sm font-semibold text-ink">{locale.diagnostics.logsTitle}</h2>
        {dialect === 'mysql' ? (
          <>
            <h3 className="text-sm text-ink">{locale.diagnostics.slowLog}</h3>
            <DiagnosticReport kind="slowLog" title={locale.diagnostics.slowLog} />
            <h3 className="text-sm text-ink">{locale.diagnostics.generalLog}</h3>
            <DiagnosticReport kind="generalLog" title={locale.diagnostics.generalLog} />
          </>
        ) : (
          <DiagnosticReport kind="statements" title={locale.diagnostics.statements} />
        )}
      </div>
    </section>
  )
}
