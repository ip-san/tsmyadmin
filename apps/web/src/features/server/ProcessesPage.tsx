import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { KillMode, ProcessInfo } from '@tsmyadmin/shared'
import { useState } from 'react'
import { CellValue } from '@/components/cells/CellValue.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { Badge, ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { mutations, processesQuery } from '@/lib/queries.ts'

export function ProcessesPage() {
  const [auto, setAuto] = useState(false)
  const [victim, setVictim] = useState<ProcessInfo | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const procs = useQuery({ ...processesQuery, refetchInterval: auto ? 5000 : false })
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
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{locale.server.processesTitle}</h2>
        <Button size="sm" onClick={() => void refresh()}>
          {locale.server.refresh}
        </Button>
        <label className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-300">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          {locale.server.autoRefresh}
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
              <Th>{locale.server.pid}</Th>
              <Th>{locale.server.user}</Th>
              <Th>{locale.server.host}</Th>
              <Th>{locale.server.database}</Th>
              <Th>{locale.server.state}</Th>
              <Th className="text-right">{locale.server.time}</Th>
              <Th>{locale.server.query}</Th>
              <Th>{locale.ddl.actions}</Th>
            </tr>
          </thead>
          <tbody>
            {procs.data.map((p) => (
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
                    <span className="text-zinc-500 dark:text-zinc-400" aria-hidden>
                      –
                    </span>
                  ) : (
                    <CellValue cell={p.query} />
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
            <dt className="text-zinc-500 dark:text-zinc-400">{locale.server.user}</dt>
            <dd>{[victim.user, victim.host].filter(Boolean).join('@') || '–'}</dd>
            <dt className="text-zinc-500 dark:text-zinc-400">{locale.server.database}</dt>
            <dd>{victim.database ?? '–'}</dd>
            <dt className="text-zinc-500 dark:text-zinc-400">{locale.server.query}</dt>
            <dd className="truncate font-mono">{victim.query?.replace(/\s+/g, ' ').trim().slice(0, 200) || '–'}</dd>
          </dl>
        ) : null}
        {kill.isError ? <ErrorBox error={kill.error} className="mt-2" /> : null}
      </Dialog>
    </section>
  )
}
