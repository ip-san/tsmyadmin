import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale, numberLocale } from '@/config/locale.ts'
import { serverInfoQuery, sessionQuery, statusQuery, variablesQuery } from '@/lib/queries.ts'
import { advise, fill } from './advisor.ts'
import { queryStatistics, statusCategory, traffic } from './insights.ts'
import { KeyValueTable } from './KeyValueTable.tsx'
import { ServerInfoCard } from './ServerInfoCard.tsx'

const t = locale.server

export function StatusPage() {
  const info = useQuery(serverInfoQuery)
  const status = useQuery(statusQuery)
  const variables = useQuery(variablesQuery)
  const dialect = useQuery(sessionQuery).data?.dialect ?? 'mysql'
  const uptime = info.data?.uptimeSec ?? null
  const findings =
    status.data && variables.data
      ? advise({ dialect, status: status.data, variables: variables.data, uptimeSec: uptime })
      : []
  const warnings = findings.filter((f) => f.level === 'warn')
  const flags = new Map(
    warnings.flatMap((f) => f.flags.map((name) => [name, locale.advisor.rules[f.id].title] as const))
  )
  const figures = status.data ? traffic(dialect, status.data, uptime) : []
  const statements = status.data ? queryStatistics(dialect, status.data) : []
  return (
    <div className="space-y-6">
      <ServerInfoCard />
      {warnings.length > 0 ? (
        <section aria-label={t.alertsTitle}>
          <Notice>
            <p className="font-medium">{t.alertsTitle}</p>
            <ul className="list-disc pl-5">
              {warnings.map((f) => (
                <li key={f.id}>
                  {locale.advisor.rules[f.id].title}: {fill(locale.advisor.rules[f.id].detail, f.values)}
                </li>
              ))}
            </ul>
            <Link to="/advisor" className="text-blue-700 hover:underline dark:text-blue-300">
              {t.alertsMore}
            </Link>
          </Notice>
        </section>
      ) : null}
      {figures.length > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-ink">{t.overviewTitle}</h2>
          <Table aria-label={t.overviewTitle}>
            <thead>
              <tr>
                <Th>{t.figure}</Th>
                <Th className="text-right">{t.value}</Th>
                <Th className="text-right">{t.perHour}</Th>
              </tr>
            </thead>
            <tbody>
              {figures.map((f) => (
                <Tr key={f.key}>
                  <Td>{t.traffic[f.key]}</Td>
                  <Td className="text-right tabular-nums">
                    {f.kind === 'bytes' ? locale.common.bytes(f.value) : f.value.toLocaleString(numberLocale)}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {f.perHour === null
                      ? ''
                      : f.kind === 'bytes'
                        ? locale.common.bytes(f.perHour)
                        : Math.round(f.perHour).toLocaleString(numberLocale)}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </section>
      ) : null}
      {statements.length > 0 ? (
        <section>
          <h2 className="mb-1 text-sm font-semibold text-ink">{t.queryStatsTitle}</h2>
          <p className="mb-2 text-xs text-ink-sub">
            {dialect === 'mysql' ? t.queryStatsHintMysql : t.queryStatsHintPostgres}
          </p>
          <Table aria-label={t.queryStatsTitle}>
            <thead>
              <tr>
                <Th>{t.statement}</Th>
                <Th className="text-right">{t.count}</Th>
                <Th className="text-right">{t.share}</Th>
              </tr>
            </thead>
            <tbody>
              {statements.map((s) => (
                <Tr key={s.name}>
                  <Td className="font-mono text-xs">{s.name}</Td>
                  <Td className="text-right tabular-nums">{s.count.toLocaleString(numberLocale)}</Td>
                  <Td className="text-right tabular-nums">{(s.share * 100).toFixed(1)}%</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </section>
      ) : null}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">{t.statusTitle}</h2>
        {status.isPending ? (
          <Spinner />
        ) : status.isError ? (
          <ErrorBox error={status.error} onRetry={() => void status.refetch()} />
        ) : (
          <KeyValueTable
            items={status.data}
            label={t.statusTitle}
            categorize={(name) => statusCategory(dialect, name)}
            flags={flags}
          />
        )}
      </section>
    </div>
  )
}
