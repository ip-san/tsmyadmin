import { useQuery } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { Fragment, useId, useState } from 'react'
import { UserOpPreviewDialog } from '@/components/ddl/UserOpPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { locale, numberLocale } from '@/config/locale.ts'
import { PasswordForm } from '@/features/users/PasswordForm.tsx'
import { useOwnAccount } from '@/lib/own-account.ts'
import { serverInfoQuery } from '@/lib/queries.ts'
import { useUserOpFlow } from '@/lib/user-ops.ts'
import { startedAt } from './insights.ts'

const t = locale.server

/** Which server this is, as the top page shows it (and the status tab): the connection, the version, the uptime. */
export function ServerInfoCard() {
  const { session } = useRouteContext({ from: '/_app' })
  const info = useQuery(serverInfoQuery)
  const heading = useId()
  const own = useOwnAccount().ref
  const flow = useUserOpFlow()
  const [changing, setChanging] = useState(false)
  const started = startedAt(info.data?.uptimeSec ?? null)
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
          {started ? (
            <>
              <dt className="text-ink-sub">{t.startedAt}</dt>
              <dd>{started.toLocaleString(numberLocale)}</dd>
            </>
          ) : null}
          <dt className="text-ink-sub">{t.currentUser}</dt>
          <dd className="flex items-center gap-2 font-mono">
            {info.data.currentUser}
            <Button size="sm" aria-haspopup="dialog" data-print-hide onClick={() => setChanging(true)}>
              {t.changeOwnPassword}
            </Button>
          </dd>
          {Object.entries(info.data.extra).map(([k, v]) => (
            <Fragment key={k}>
              <dt className="text-ink-sub">{k}</dt>
              <dd className="font-mono">{v}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      <Dialog open={changing} title={t.changeOwnPassword} onClose={() => setChanging(false)}>
        {changing ? (
          <PasswordForm
            onCancel={() => setChanging(false)}
            onSubmit={(password) => {
              setChanging(false)
              flow.preview({ op: 'setPassword', user: own, password })
            }}
          />
        ) : null}
      </Dialog>
      <UserOpPreviewDialog flow={flow} />
    </section>
  )
}
