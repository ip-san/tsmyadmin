import { useMutation, useQueryClient } from '@tanstack/react-query'
import { TRACK_DDL_KINDS, TRACK_DML_KINDS, type TrackingState, type TrackKind } from '@tsmyadmin/shared'
import { useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Card } from '@/components/ui/Card.tsx'
import { ErrorBox, Notice } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale, numberLocale } from '@/config/locale.ts'
import { mutations, type TableRef, trackingQuery } from '@/lib/queries.ts'

const t = locale.tracking

/**
 * phpMyAdmin's "Tracking statements": which kinds of statement are recorded against the table, and the ones
 * recorded — as they ran from the SQL console and previews, or, for an edit in the grid, what it touched.
 */
export function TrackedStatements({ tableRef, state }: { tableRef: TableRef; state: TrackingState }) {
  const queryClient = useQueryClient()
  const [kinds, setKinds] = useState<ReadonlySet<TrackKind>>(new Set(state.kinds))
  const save = useMutation({
    mutationFn: () => mutations.setTrackingKinds(tableRef, [...kinds]),
    onSuccess: (next) => queryClient.setQueryData(trackingQuery(tableRef).queryKey, next),
  })
  const changed = [...kinds].sort().join() !== [...state.kinds].sort().join()
  const toggle = (k: TrackKind) =>
    setKinds((all) => {
      const next = new Set(all)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  const when = (at: number) => new Date(at).toLocaleString(numberLocale)
  return (
    <>
      <Card title={t.kinds}>
        <p className="mb-2 text-xs text-ink-sub">{t.kindsHint}</p>
        {save.error ? <ErrorBox error={save.error} /> : null}
        {[TRACK_DDL_KINDS, TRACK_DML_KINDS].map((group) => (
          <div key={group[0]} className="mb-2 flex flex-wrap gap-4 text-sm">
            {group.map((k) => (
              <label key={k} className="flex items-center gap-1 text-ink">
                <input type="checkbox" checked={kinds.has(k)} onChange={() => toggle(k)} />
                {t.kindNames[k]}
              </label>
            ))}
          </div>
        ))}
        <Button size="sm" variant="primary" disabled={!changed || save.isPending} onClick={() => save.mutate()}>
          {t.saveKinds}
        </Button>
      </Card>
      <Card title={t.statements} bleed>
        {state.log === null ? (
          <Notice>{t.logHidden}</Notice>
        ) : state.log.length === 0 ? (
          <Notice>{t.noStatements}</Notice>
        ) : (
          <Table aria-label={t.statements}>
            <thead>
              <tr>
                <Th>{t.recordedAt}</Th>
                <Th>{t.kind}</Th>
                <Th>{t.statement}</Th>
                <Th>{t.recordedBy}</Th>
              </tr>
            </thead>
            <tbody>
              {state.log.map((e) => (
                <Tr key={e.id}>
                  <Td className="whitespace-nowrap text-xs tabular-nums">{when(e.at)}</Td>
                  <Td className="whitespace-nowrap text-xs">{t.kindNames[e.kind]}</Td>
                  <Td className="font-mono text-xs">
                    {e.statement === null ? (
                      <span className="font-sans text-ink-sub">{t.grid(e.rows ?? 0, e.columns ?? [])}</span>
                    ) : (
                      <span className="whitespace-pre-wrap break-all">
                        {e.statement}
                        {e.truncated ? <span className="font-sans text-ink-sub"> {t.cut}</span> : null}
                      </span>
                    )}
                  </Td>
                  <Td className="font-mono text-xs">{e.by}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  )
}
