import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TrackingState } from '@tsmyadmin/shared'
import { lineDiff } from '@tsmyadmin/shared'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Card } from '@/components/ui/Card.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { Badge, ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Field, Select } from '@/components/ui/Field.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale, numberLocale } from '@/config/locale.ts'
import { downloadText, safeFilename } from '@/lib/download.ts'
import { mutations, type TableRef, trackingQuery } from '@/lib/queries.ts'
import { TrackedStatements } from './TrackedStatements.tsx'

const t = locale.tracking
/** The option standing for the definition as it is now. */
const NOW = 'now'

function Diff({ before, after }: { before: string; after: string }) {
  const lines = lineDiff(before, after)
  if (lines.every((l) => l.kind === 'same')) return <p className="text-sm text-ink-sub">{t.noDifference}</p>
  return (
    <pre
      className="overflow-x-auto rounded border border-line bg-surface-sub p-2 font-mono text-xs"
      aria-label={t.diff}
    >
      {lines.map((l, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: lines of one diff, in order; recomputed as a whole
          key={i}
          className={
            l.kind === 'add'
              ? 'bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200'
              : l.kind === 'del'
                ? 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200'
                : 'text-ink'
          }
        >
          {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}
          {l.text}
        </div>
      ))}
    </pre>
  )
}

/**
 * phpMyAdmin's Tracking, as snapshots: each version is the table's definition as the server printed it when it
 * was recorded. Recording is done here, by hand — a change made from anywhere (this tool, a migration, another
 * client) shows up as a difference from the latest version.
 */
export function TrackingPage({ tableRef }: { tableRef: TableRef }) {
  const id = useId()
  const queryClient = useQueryClient()
  const state = useQuery(trackingQuery(tableRef))
  const settle = (next: TrackingState) => queryClient.setQueryData(trackingQuery(tableRef).queryKey, next)
  const record = useMutation({ mutationFn: () => mutations.recordVersion(tableRef), onSuccess: settle })
  const stop = useMutation({
    mutationFn: () => mutations.stopTracking(tableRef),
    onSuccess: (next) => {
      settle(next)
      setConfirming(false)
    },
  })
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState<number | null>(null)
  const removeVersion = useMutation({
    mutationFn: (version: number) => mutations.deleteTrackedVersion(tableRef, version),
    onSuccess: (next) => {
      settle(next)
      setDeleting(null)
    },
  })
  const [from, setFrom] = useState('')
  const [to, setTo] = useState(NOW)
  if (state.isPending) return <Spinner />
  if (state.isError) return <ErrorBox error={state.error} onRetry={() => void state.refetch()} />
  const { versions, current } = state.data
  const latest = versions.at(-1)
  const text = (key: string) =>
    key === NOW ? current : (versions.find((v) => String(v.version) === key)?.definition ?? '')
  const fromKey = versions.some((v) => String(v.version) === from) ? from : String(latest?.version ?? '')
  const error = record.error ?? stop.error ?? removeVersion.error
  return (
    <div className="space-y-4">
      <Notice>{t.notice}</Notice>
      {error ? <ErrorBox error={error} /> : null}
      {!latest ? (
        <Card title={t.title}>
          <p className="mb-3 text-sm text-ink-sub">{t.notTracked}</p>
          <Button variant="primary" onClick={() => record.mutate()} disabled={record.isPending}>
            {t.start}
          </Button>
        </Card>
      ) : (
        <>
          <Card
            title={t.title}
            actions={
              <>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => record.mutate()}
                  disabled={record.isPending || latest.definition === current}
                >
                  {t.record}
                </Button>
                <Button variant="danger" size="sm" aria-haspopup="dialog" onClick={() => setConfirming(true)}>
                  {t.stop}
                </Button>
              </>
            }
            bleed
          >
            <p className="flex items-center gap-2 px-4 pb-2 text-sm text-ink" aria-live="polite">
              {latest.definition === current ? (
                <Badge tone="neutral">{t.unchanged(latest.version)}</Badge>
              ) : (
                <Badge tone="warn">{t.changed(latest.version)}</Badge>
              )}
            </p>
            <Table aria-label={t.versions}>
              <thead>
                <tr>
                  <Th>{t.version}</Th>
                  <Th>{t.recordedAt}</Th>
                  <Th>{t.recordedBy}</Th>
                  <Th>
                    <span className="sr-only">{locale.ddl.actions}</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {[...versions].reverse().map((v) => (
                  <Tr key={v.id}>
                    <Td className="tabular-nums">{v.version}</Td>
                    <Td className="text-xs tabular-nums">{new Date(v.at).toLocaleString(numberLocale)}</Td>
                    <Td className="font-mono text-xs">{v.by}</Td>
                    <Td className="space-x-1 whitespace-nowrap">
                      <Button
                        size="sm"
                        aria-label={t.downloadVersion(v.version)}
                        onClick={() =>
                          downloadText(
                            safeFilename(`${tableRef.table}-version-${v.version}`, 'sql'),
                            `${v.definition};\n`,
                            'application/sql;charset=utf-8'
                          )
                        }
                      >
                        {t.download}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        aria-haspopup="dialog"
                        aria-label={t.deleteVersion(v.version)}
                        onClick={() => setDeleting(v.version)}
                      >
                        {locale.common.delete}
                      </Button>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
          <TrackedStatements key={state.data.kinds.join()} tableRef={tableRef} state={state.data} />
          <Card title={t.compare}>
            <div className="mb-3 flex flex-wrap items-end gap-2">
              <Field id={`${id}-from`} label={t.from}>
                <Select id={`${id}-from`} value={fromKey} onChange={(e) => setFrom(e.target.value)}>
                  {versions.map((v) => (
                    <option key={v.id} value={String(v.version)}>
                      {t.versionLabel(v.version)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id={`${id}-to`} label={t.to}>
                <Select id={`${id}-to`} value={to} onChange={(e) => setTo(e.target.value)}>
                  <option value={NOW}>{t.now}</option>
                  {versions.map((v) => (
                    <option key={v.id} value={String(v.version)}>
                      {t.versionLabel(v.version)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Diff before={text(fromKey)} after={text(to)} />
          </Card>
        </>
      )}
      <Dialog
        open={deleting !== null}
        title={t.deleteVersionTitle}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>{locale.common.cancel}</Button>
            <Button
              variant="danger"
              onClick={() => deleting !== null && removeVersion.mutate(deleting)}
              disabled={removeVersion.isPending}
            >
              {t.deleteVersionConfirm}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink">{deleting !== null ? t.deleteVersionBody(deleting, versions.length) : ''}</p>
      </Dialog>
      <Dialog
        open={confirming}
        title={t.stop}
        onClose={() => setConfirming(false)}
        footer={
          <>
            <Button onClick={() => setConfirming(false)}>{locale.common.cancel}</Button>
            <Button variant="danger" onClick={() => stop.mutate()} disabled={stop.isPending}>
              {t.stopConfirm}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink">{t.stopBody(versions.length)}</p>
      </Dialog>
    </div>
  )
}
