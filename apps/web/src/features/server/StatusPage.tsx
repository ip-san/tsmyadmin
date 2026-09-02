import { useQuery } from '@tanstack/react-query'
import { Fragment } from 'react'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { serverInfoQuery, statusQuery } from '@/lib/queries.ts'
import { KeyValueTable } from './KeyValueTable.tsx'

export function StatusPage() {
  const info = useQuery(serverInfoQuery)
  const status = useQuery(statusQuery)
  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-200">{locale.server.infoTitle}</h2>
        {info.isPending ? (
          <Spinner />
        ) : info.isError ? (
          <ErrorBox error={info.error} onRetry={() => void info.refetch()} />
        ) : (
          <dl className="grid max-w-2xl grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-zinc-500 dark:text-zinc-400">{locale.server.version}</dt>
            <dd className="font-mono">{info.data.version}</dd>
            <dt className="text-zinc-500 dark:text-zinc-400">{locale.server.uptime}</dt>
            <dd>
              {info.data.uptimeSec === null ? locale.common.unknown : locale.server.uptimeFormat(info.data.uptimeSec)}
            </dd>
            <dt className="text-zinc-500 dark:text-zinc-400">{locale.server.currentUser}</dt>
            <dd className="font-mono">{info.data.currentUser}</dd>
            {Object.entries(info.data.extra).map(([k, v]) => (
              <Fragment key={k}>
                <dt className="text-zinc-500 dark:text-zinc-400">{k}</dt>
                <dd className="font-mono">{v}</dd>
              </Fragment>
            ))}
          </dl>
        )}
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-200">{locale.server.statusTitle}</h2>
        {status.isPending ? (
          <Spinner />
        ) : status.isError ? (
          <ErrorBox error={status.error} onRetry={() => void status.refetch()} />
        ) : (
          <KeyValueTable items={status.data} label={locale.server.statusTitle} />
        )}
      </section>
    </div>
  )
}
