import { useQuery } from '@tanstack/react-query'
import { Badge, ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { serverInfoQuery, sessionQuery, statusQuery, variablesQuery } from '@/lib/queries.ts'
import { advise, fill } from './advisor.ts'

const t = locale.advisor

/** phpMyAdmin's Advisor: what the server's counters and settings suggest changing (nothing is changed here). */
export function AdvisorPage() {
  const status = useQuery(statusQuery)
  const variables = useQuery(variablesQuery)
  const info = useQuery(serverInfoQuery)
  const dialect = useQuery(sessionQuery).data?.dialect ?? 'mysql'
  const failed = status.error ?? variables.error
  if (status.isPending || variables.isPending) return <Spinner />
  if (!status.data || !variables.data)
    return <ErrorBox error={failed} onRetry={() => void Promise.all([status.refetch(), variables.refetch()])} />
  const findings = advise({
    dialect,
    status: status.data,
    variables: variables.data,
    uptimeSec: info.data?.uptimeSec ?? null,
  })
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-ink">{t.title}</h2>
      <p className="max-w-3xl text-xs text-ink-sub">{t.intro}</p>
      {findings.length === 0 ? (
        <Notice>{t.none}</Notice>
      ) : (
        <ul className="space-y-3" aria-label={t.title}>
          {findings.map((f) => {
            const rule = t.rules[f.id]
            return (
              <li key={f.id} className="max-w-3xl rounded border border-line p-3">
                <div className="flex items-center gap-2">
                  <Badge tone={f.level === 'warn' ? 'warn' : 'neutral'}>{t.levels[f.level]}</Badge>
                  <h3 className="text-sm font-medium text-ink">{rule.title}</h3>
                </div>
                <p className="mt-1 text-sm text-ink">{fill(rule.detail, f.values)}</p>
                {rule.fix ? (
                  <p className="mt-1 text-sm text-ink-sub">
                    <span className="font-medium">{t.fix}: </span>
                    {rule.fix}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
