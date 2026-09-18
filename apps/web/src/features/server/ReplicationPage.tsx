import { useQuery } from '@tanstack/react-query'
import type { Dialect, ReplicationInfo } from '@tsmyadmin/shared'
import { Badge, ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { replicationQuery } from '@/lib/queries.ts'

const t = locale.replication

type Records = NonNullable<ReplicationInfo['source']>

/** One record per column pair: a replica's status is a long list of fields, easier to read down than across. */
function RecordTable({ record, label }: { record: Records[number]; label: string }) {
  return (
    <Table aria-label={label}>
      <tbody>
        {record.map((f) => (
          <Tr key={f.name}>
            <Th scope="row" className="w-64 font-mono text-xs font-normal">
              {f.name}
            </Th>
            <Td className="font-mono text-xs">{f.value ?? ''}</Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  )
}

function Part({ title, records, empty }: { title: string; records: Records | null; empty: string }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {records === null ? (
        <Notice>{t.unavailable}</Notice>
      ) : records.length === 0 ? (
        <p className="text-sm text-ink-sub">{empty}</p>
      ) : (
        records.map((r, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: channels / replicas in server order, shown once per load
          <RecordTable key={i} record={r} label={records.length > 1 ? `${title} ${i + 1}` : title} />
        ))
      )}
    </section>
  )
}

/** phpMyAdmin's Replication and Binary log tabs; PostgreSQL's streaming replication and WAL in the same places. */
export function ReplicationPage({ dialect }: { dialect: Dialect }) {
  const info = useQuery(replicationQuery)
  if (info.isPending) return <Spinner />
  if (info.isError) return <ErrorBox error={info.error} onRetry={() => void info.refetch()} />
  const { role, source, replicas, logs } = info.data
  return (
    <div className="space-y-6">
      <p className="flex items-center gap-2 text-sm text-ink">
        {t.role}: <Badge tone={role === 'standalone' || role === 'unknown' ? 'neutral' : 'info'}>{t.roles[role]}</Badge>
      </p>
      <Part title={t.source[dialect]} records={source} empty={t.notReplica} />
      <Part title={t.replicas} records={replicas} empty={t.noReplicas} />
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-ink">{t.logs[dialect]}</h3>
        {logs === null ? (
          <Notice>{t.logsUnavailable[dialect]}</Notice>
        ) : (
          <Table aria-label={t.logs[dialect]}>
            <thead>
              <tr>
                <Th>{t.logName}</Th>
                <Th className="text-right">{t.logSize}</Th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <Tr key={l.name}>
                  <Td className="font-mono text-xs">{l.name}</Td>
                  <Td className="text-right text-xs tabular-nums">
                    {l.size === null ? '' : locale.common.bytes(Number(l.size))}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  )
}
