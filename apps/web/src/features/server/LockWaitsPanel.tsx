import { useQuery } from '@tanstack/react-query'
import type { ConnectionUsage, LockWait, ProcessInfo } from '@tsmyadmin/shared'
import { useId } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Badge, ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { lockWaitsQuery } from '@/lib/queries.ts'
import { blockerAsProcess, isNearLimit, usagePercent } from './lock-waits.ts'
import { abbreviateQuery } from './processes.ts'

/**
 * Who waits for whom, above the process list: the usual cause of an application that "hangs" in development is a
 * transaction someone left open. The blocker is ended through the page's own kill dialog (`onKill`).
 */
export function LockWaitsPanel({ every, onKill }: { every: number; onKill: (p: ProcessInfo) => void }) {
  const titleId = useId()
  const report = useQuery({ ...lockWaitsQuery, refetchInterval: every > 0 ? every * 1000 : false })
  const data = report.data
  return (
    <section aria-labelledby={titleId} className="space-y-2 rounded border border-line p-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 id={titleId} className="text-sm font-semibold text-ink">
          {locale.server.lockWaitsTitle}
        </h3>
        {data ? <UsageLine usage={data.connections} /> : null}
      </div>
      {report.isPending ? (
        <Spinner />
      ) : report.isError ? (
        <ErrorBox error={report.error} onRetry={() => void report.refetch()} />
      ) : (
        <>
          {isNearLimit(report.data.connections) ? (
            <p
              role="status"
              className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200"
            >
              {locale.server.connectionsNearLimit}
            </p>
          ) : null}
          {report.data.status === 'denied' ? (
            <p className="text-xs text-ink-sub">{locale.server.lockWaitsDenied}</p>
          ) : report.data.status === 'unsupported' ? (
            <p className="text-xs text-ink-sub">{locale.server.lockWaitsUnsupported}</p>
          ) : report.data.waits.length === 0 ? (
            <p className="text-xs text-ink-sub">{locale.server.lockWaitsNone}</p>
          ) : (
            <>
              <p className="text-xs text-ink-sub">{locale.server.lockWaitsHint}</p>
              <WaitsTable waits={report.data.waits} onKill={onKill} />
            </>
          )}
        </>
      )}
    </section>
  )
}

function UsageLine({ usage }: { usage: ConnectionUsage }) {
  return (
    <p className="text-xs text-ink-sub">
      {locale.server.connections}:{' '}
      <span className="tabular-nums text-ink">
        {locale.server.connectionsUsage(usage.current, usage.max, usagePercent(usage))}
      </span>
      {usage.idleInTransaction === null ? null : (
        <span className="ml-2 tabular-nums">{locale.server.connectionsIdle(usage.idleInTransaction)}</span>
      )}
    </p>
  )
}

function Statement({ query }: { query: string | null }) {
  if (query === null)
    return (
      <span className="text-ink-sub" aria-hidden>
        –
      </span>
    )
  return (
    <span className="break-all" title={query}>
      {abbreviateQuery(query.replace(/\s+/g, ' ').trim(), false)}
    </span>
  )
}

function WaitsTable({ waits, onKill }: { waits: LockWait[]; onKill: (p: ProcessInfo) => void }) {
  return (
    <Table aria-label={locale.server.lockWaitsTitle}>
      <thead>
        <tr>
          <Th>{locale.server.blockedSession}</Th>
          <Th className="text-right">{locale.server.waited}</Th>
          <Th>{locale.server.blockedQuery}</Th>
          <Th>{locale.server.blockingSession}</Th>
          <Th className="text-right">{locale.server.transactionOpen}</Th>
          <Th>{locale.server.blockingQuery}</Th>
          <Th>{locale.server.lockTarget}</Th>
          <Th>{locale.ddl.actions}</Th>
        </tr>
      </thead>
      <tbody>
        {waits.map((w) => (
          <Tr key={`${w.blocked.id}-${w.blocking.id}`}>
            <Td className="text-xs">
              <span className="font-mono">{w.blocked.id}</span>{' '}
              {[w.blocked.user, w.blocked.database].filter(Boolean).join(' / ')}
            </Td>
            <Td className="text-right tabular-nums">{w.blocked.waitSec ?? ''}</Td>
            <Td className="max-w-xs font-mono text-xs">
              <Statement query={w.blocked.query} />
            </Td>
            <Td className="text-xs">
              <span className="font-mono">{w.blocking.id}</span>{' '}
              {[w.blocking.user, w.blocking.database].filter(Boolean).join(' / ')}
              <div className="mt-0.5">
                {w.blocking.idleInTransaction ? (
                  <Badge tone="warn" title={locale.server.idleInTransactionHint}>
                    {locale.server.idleInTransaction}
                  </Badge>
                ) : (
                  <span className="text-ink-sub">{w.blocking.state ?? ''}</span>
                )}
              </div>
            </Td>
            <Td className="text-right tabular-nums">{w.blocking.transactionSec ?? ''}</Td>
            <Td className="max-w-xs font-mono text-xs">
              <Statement query={w.blocking.query} />
            </Td>
            <Td className="text-xs">
              <span className="font-mono">{w.table ?? ''}</span>
              {w.mode ? <span className="block text-ink-sub">{w.mode}</span> : null}
            </Td>
            <Td className="whitespace-nowrap">
              <Button
                size="sm"
                variant="danger"
                onClick={() => onKill(blockerAsProcess(w))}
                aria-label={`${w.blocking.id}: ${locale.server.killBlocker}`}
              >
                {locale.server.killBlocker}
              </Button>
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  )
}
