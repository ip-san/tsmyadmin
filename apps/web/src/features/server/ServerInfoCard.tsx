import { useQuery } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { Fragment, useId } from 'react'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { serverInfoQuery } from '@/lib/queries.ts'

const t = locale.server

/** Which server this is, as the top page shows it (and the status tab): the connection, the version, the uptime. */
export function ServerInfoCard() {
  const { session } = useRouteContext({ from: '/_app' })
  const info = useQuery(serverInfoQuery)
  const heading = useId()
  return (
    <section aria-labelledby={heading} className="mb-6">
      <h2 id={heading} className="mb-2 text-sm font-semibold text-ink">
        {t.infoTitle}
      </h2>
      {info.isPending ? (
        <Spinner />
      ) : info.isError ? (
        <ErrorBox error={info.error} onRetry={() => void info.refetch()} />
      ) : (
        <dl className="grid max-w-2xl grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-ink-sub">{t.connection}</dt>
          <dd className="font-mono">
            {session.host}:{session.port}
          </dd>
          {session.dialect === 'mysql' ? (
            <>
              <dt className="text-ink-sub">{t.connectionCollation}</dt>
              <dd className="font-mono">{session.collation ?? 'utf8mb4_unicode_ci'}</dd>
            </>
          ) : null}
          <dt className="text-ink-sub">{t.version}</dt>
          <dd className="font-mono">{info.data.version}</dd>
          <dt className="text-ink-sub">{t.uptime}</dt>
          <dd>{info.data.uptimeSec === null ? locale.common.unknown : t.uptimeFormat(info.data.uptimeSec)}</dd>
          <dt className="text-ink-sub">{t.currentUser}</dt>
          <dd className="font-mono">{info.data.currentUser}</dd>
          {Object.entries(info.data.extra).map(([k, v]) => (
            <Fragment key={k}>
              <dt className="text-ink-sub">{k}</dt>
              <dd className="font-mono">{v}</dd>
            </Fragment>
          ))}
        </dl>
      )}
    </section>
  )
}
