import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { KillMode, ProcessInfo } from '@tsmyadmin/shared'
import { useState } from 'react'
import { CellValue } from '@/components/cells/CellValue.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { Badge, ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Select } from '@/components/ui/Field.tsx'
import { nextListSort, SortTh } from '@/components/ui/SortTh.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { mutations, processesQuery } from '@/lib/queries.ts'
import { abbreviateQuery, isActiveProcess, type ProcessColumn, REFRESH_SECONDS, sortProcesses } from './processes.ts'

export function ProcessesPage() {
  // 0: only when asked.
  const [every, setEvery] = useState(0)
  const [activeOnly, setActiveOnly] = useState(false)
  const [fullQuery, setFullQuery] = useState(false)
  const [sort, setSort] = useState<{ key: ProcessColumn; dir: 'asc' | 'desc' } | null>(null)
  const [victim, setVictim] = useState<ProcessInfo | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const procs = useQuery({ ...processesQuery, refetchInterval: every > 0 ? every * 1000 : false })
  const refresh = async () => {
    setNotice(null)
    await procs.refetch()
  }
  const kill = useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: KillMode }) => mutations.killProcess(id, mode),
    onSuccess: async (_r, { id, mode }) => {
      setNotice(mode === 'query' ? locale.server.cancelled(id) : locale.server.killed(id))
      setVictim(null)
      await queryClient.invalidateQueries({ queryKey: ['server', 'processes'] })
    },
  })
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-ink">{locale.server.processesTitle}</h2>
        <Button size="sm" onClick={() => void refresh()}>
          {locale.server.refresh}
        </Button>
        <label className="flex items-center gap-1 text-xs text-ink-sub">
          {locale.server.refreshEvery}
          <Select value={String(every)} onChange={(e) => setEvery(Number(e.target.value))} className="w-auto py-1">
            <option value="0">{locale.server.refreshManual}</option>
            {REFRESH_SECONDS.map((s) => (
              <option key={s} value={s}>
                {locale.server.refreshSeconds(s)}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-1 text-xs text-ink-sub">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
          {locale.server.activeOnly}
        </label>
        <label className="flex items-center gap-1 text-xs text-ink-sub">
          <input type="checkbox" checked={fullQuery} onChange={(e) => setFullQuery(e.target.checked)} />
          {locale.server.fullQuery}
        </label>
      </div>
      <output aria-live="polite" className={notice ? 'block' : 'sr-only'}>
        {notice ? <Notice>{notice}</Notice> : null}
      </output>
      {procs.isPending ? (
        <Spinner />
      ) : procs.isError ? (
        <ErrorBox error={procs.error} onRetry={() => void procs.refetch()} />
      ) : (
        <Table aria-label={locale.server.processesTitle}>
          <thead>
            <tr>
              {(
                [
                  ['id', locale.server.pid],
                  ['user', locale.server.user],
                  ['host', locale.server.host],
                  ['database', locale.server.database],
                  ['state', locale.server.state],
                  ['timeSec', locale.server.time],
                  ['query', locale.server.query],
                ] as const
              ).map(([key, label]) => (
                <SortTh
                  key={key}
                  dir={sort?.key === key ? sort.dir : null}
                  onSort={() => setSort(nextListSort(sort, key))}
                  {...(key === 'timeSec' ? { className: 'text-right' } : {})}
                >
                  {label}
                </SortTh>
              ))}
              <Th>{locale.ddl.actions}</Th>
            </tr>
          </thead>
          <tbody>
            {(sort ? sortProcesses(procs.data, sort.key, sort.dir) : procs.data)
              .filter((p) => !activeOnly || isActiveProcess(p))
              .map((p) => (
                <Tr key={p.id}>
                  <Td className="whitespace-nowrap font-mono text-xs">
                    {p.id}
                    {p.self ? (
                      <>
                        {' '}
                        <Badge tone="neutral" title={locale.server.selfConnectionHint}>
                          {locale.server.selfConnection}
                        </Badge>
                      </>
                    ) : null}
                  </Td>
                  <Td>{p.user ?? ''}</Td>
                  <Td className="font-mono text-xs">{p.host ?? ''}</Td>
                  <Td>{p.database ?? ''}</Td>
                  <Td className="text-xs">{p.state ?? ''}</Td>
                  <Td className="text-right tabular-nums">{p.timeSec ?? ''}</Td>
                  <Td className="max-w-md font-mono text-xs">
                    {p.query === null ? (
                      <span className="text-ink-sub" aria-hidden>
                        –
                      </span>
                    ) : (
                      <CellValue cell={abbreviateQuery(p.query, fullQuery)} />
                    )}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {/* Ending the statement is the gentler action: the session, its transaction and its
                      temporary tables survive, so it needs no confirmation. */}
                    <Button
                      size="sm"
                      onClick={() => {
                        setNotice(null)
                        kill.mutate({ id: p.id, mode: 'query' })
                      }}
                      disabled={kill.isPending}
                      title={locale.server.cancelQueryHint}
                      aria-label={`${p.id}: ${locale.server.cancelQuery}`}
                    >
                      {locale.server.cancelQuery}
                    </Button>{' '}
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => setVictim(p)}
                      aria-label={`${p.id}: ${locale.server.kill}`}
                    >
                      {locale.server.kill}
                    </Button>
                  </Td>
                </Tr>
              ))}
          </tbody>
        </Table>
      )}
      <Dialog
        open={victim !== null}
        title={locale.server.kill}
        onClose={() => setVictim(null)}
        footer={
          <>
            <Button onClick={() => setVictim(null)} disabled={kill.isPending}>
              {locale.common.cancel}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (!victim) return
                setNotice(null)
                kill.mutate({ id: victim.id, mode: 'connection' })
              }}
              disabled={kill.isPending}
            >
              {locale.server.killExecute}
            </Button>
          </>
        }
      >
        <p>{victim ? locale.server.killConfirm(victim.id) : ''}</p>
        {victim?.self ? (
          <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            {locale.server.killSelfWarning}
          </p>
        ) : null}
        {victim ? (
          <dl className="mt-2 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <dt className="text-ink-sub">{locale.server.user}</dt>
            <dd>{[victim.user, victim.host].filter(Boolean).join('@') || '–'}</dd>
            <dt className="text-ink-sub">{locale.server.database}</dt>
            <dd>{victim.database ?? '–'}</dd>
            <dt className="text-ink-sub">{locale.server.query}</dt>
            <dd className="truncate font-mono">{victim.query?.replace(/\s+/g, ' ').trim().slice(0, 200) || '–'}</dd>
          </dl>
        ) : null}
        {kill.isError ? <ErrorBox error={kill.error} className="mt-2" /> : null}
      </Dialog>
    </section>
  )
}
