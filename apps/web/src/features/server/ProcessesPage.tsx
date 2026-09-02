import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ProcessInfo } from '@tsmyadmin/shared'
import { useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
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
    mutationFn: (id: string) => mutations.killProcess(id),
    onSuccess: async (_r, id) => {
      setNotice(locale.server.killed(id))
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
      {notice ? (
        <Notice>
          <output aria-live="polite">{notice}</output>
        </Notice>
      ) : null}
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
                <Td className="font-mono text-xs">{p.id}</Td>
                <Td>{p.user ?? ''}</Td>
                <Td className="font-mono text-xs">{p.host ?? ''}</Td>
                <Td>{p.database ?? ''}</Td>
                <Td className="text-xs">{p.state ?? ''}</Td>
                <Td className="text-right tabular-nums">{p.timeSec ?? ''}</Td>
                <Td className="max-w-md truncate font-mono text-xs" title={p.query ?? ''}>
                  {p.query ?? ''}
                </Td>
                <Td>
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
                kill.mutate(victim.id)
              }}
              disabled={kill.isPending}
            >
              {locale.server.kill}
            </Button>
          </>
        }
      >
        <p>{victim ? locale.server.killConfirm(victim.id) : ''}</p>
        {kill.isError ? <ErrorBox error={kill.error} className="mt-2" /> : null}
      </Dialog>
    </section>
  )
}
