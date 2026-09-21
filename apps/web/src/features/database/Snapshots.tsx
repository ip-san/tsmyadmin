import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { PreviewDialog } from '@/components/ddl/PreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Card } from '@/components/ui/Card.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Input } from '@/components/ui/Field.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale, numberLocale } from '@/config/locale.ts'
import { usePreviewFlow } from '@/lib/preview-flow.ts'
import { mutations, snapshotsQuery } from '@/lib/queries.ts'

const t = locale.snapshots

interface RestoreOp {
  id: string
  name: string
  statements: number
}

/**
 * Snapshots of a database: save its state before a migration or a seed, put it back if it went wrong. Putting one
 * back is previewed like any other change (what it drops), then run from the copy the server holds.
 */
export function Snapshots({ db, schema }: { db: string; schema: string | undefined }) {
  const queryClient = useQueryClient()
  const list = useQuery(snapshotsQuery(db, schema))
  const [name, setName] = useState('')
  const take = useMutation({
    mutationFn: (n: string) => mutations.takeSnapshot(db, schema, n),
    onSuccess: (next) => {
      queryClient.setQueryData(snapshotsQuery(db, schema).queryKey, next)
      setName('')
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) => mutations.deleteSnapshot(db, schema, id),
    onSuccess: (next) => queryClient.setQueryData(snapshotsQuery(db, schema).queryKey, next),
  })
  const flow = usePreviewFlow<RestoreOp>({
    preview: async (op) => {
      const plan = await mutations.previewRestore(db, schema, op.id)
      // The dump itself is too long to show: the statements that remove what was made since, and a line for the rest.
      return { sql: [...plan.drops, `-- ${t.replayNote(plan.statements)}`] }
    },
    execute: async (op) => {
      const r = await mutations.restoreSnapshot(db, schema, op.id)
      return {
        results:
          r.failed > 0
            ? [{ kind: 'error', sql: `-- ${op.name}`, message: r.errors.join('\n') || t.failed }]
            : [{ kind: 'affected', sql: `-- ${op.name}`, affectedRows: 0, durationMs: r.durationMs }],
      }
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (name.trim() !== '') take.mutate(name.trim())
  }
  const data = list.data
  const full = data !== undefined && data.snapshots.length >= data.maxCount
  return (
    <div className="space-y-4">
      <Card title={t.title}>
        <p className="mb-3 text-sm text-ink-sub">{t.notice}</p>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <label className="text-sm text-ink">
            {t.name}
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder={t.namePlaceholder}
              className="mt-1 w-72"
            />
          </label>
          <Button type="submit" variant="primary" disabled={name.trim() === '' || take.isPending || full}>
            {take.isPending ? t.taking : t.take}
          </Button>
          {full ? <span className="text-xs text-ink-sub">{t.full(data.maxCount)}</span> : null}
        </form>
        {take.isError ? <ErrorBox error={take.error} /> : null}
      </Card>
      {list.isPending ? <Spinner /> : null}
      {list.isError ? <ErrorBox error={list.error} onRetry={() => void list.refetch()} /> : null}
      {data ? (
        <Card title={t.list} bleed>
          {data.snapshots.length === 0 ? (
            <Notice>{t.none}</Notice>
          ) : (
            <Table aria-label={t.list}>
              <thead>
                <tr>
                  <Th>{t.name}</Th>
                  <Th>{t.at}</Th>
                  <Th className="text-right">{t.objects}</Th>
                  <Th className="text-right">{t.size}</Th>
                  <Th>{locale.database.actions}</Th>
                </tr>
              </thead>
              <tbody>
                {data.snapshots.map((s) => (
                  <Tr key={s.id}>
                    <Td>{s.name}</Td>
                    <Td className="text-xs tabular-nums">{new Date(s.at).toLocaleString(numberLocale)}</Td>
                    <Td className="text-right tabular-nums">{s.objects.toLocaleString(numberLocale)}</Td>
                    <Td className="text-right tabular-nums">{locale.common.bytes(s.bytes)}</Td>
                    <Td className="space-x-2 whitespace-nowrap">
                      <Button
                        size="sm"
                        aria-haspopup="dialog"
                        aria-label={`${s.name}: ${t.restore}`}
                        onClick={() => flow.preview({ id: s.id, name: s.name, statements: 0 })}
                      >
                        {t.restore}
                      </Button>
                      <Button
                        size="sm"
                        aria-label={`${s.name}: ${t.delete}`}
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(s.id)}
                      >
                        {t.delete}
                      </Button>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      ) : null}
      {remove.isError ? <ErrorBox error={remove.error} /> : null}
      <PreviewDialog
        flow={flow}
        title={(op) => t.restoreTitle(op.name)}
        destructive={() => true}
        confirmName={(op) => op.name}
        lossWarning={() => t.lossWarning}
        hint={t.restoreHint}
        successMessage={(op) => t.restored(op.name)}
      />
    </div>
  )
}
