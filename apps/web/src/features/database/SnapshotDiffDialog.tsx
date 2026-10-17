import { useQuery } from '@tanstack/react-query'
import type { SnapshotDiff, SnapshotDiffEntry } from '@tsmyadmin/shared'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { LineDiff } from '@/components/ui/LineDiff.tsx'
import { locale } from '@/config/locale-screens.ts'
import { snapshotDiffQuery } from '@/lib/queries.ts'

const t = locale.snapshots

/** One group of the comparison (changed, added or removed): each table with its definition, then and now. */
function Group({ title, entries, open }: { title: string; entries: SnapshotDiffEntry[]; open: boolean }) {
  if (entries.length === 0) return null
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">
        {title} ({entries.length})
      </h3>
      <ul className="space-y-2">
        {entries.map((e) => (
          <li key={e.name}>
            <details open={open} className="rounded border border-line">
              <summary className="cursor-pointer px-2 py-1 font-mono text-sm">{e.name}</summary>
              <div className="p-2">
                {e.before === null && e.after === null ? (
                  <p className="text-sm text-ink-sub">{t.diffNoDefinition}</p>
                ) : (
                  <LineDiff
                    before={e.before ?? ''}
                    after={e.after ?? ''}
                    label={t.diffLabel(e.name)}
                    empty={t.diffSame}
                  />
                )}
              </div>
            </details>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Result({ diff }: { diff: SnapshotDiff }) {
  const none = diff.added.length + diff.removed.length + diff.changed.length === 0
  return (
    <div className="space-y-4">
      <p className="text-sm" role="status">
        {t.diffSummary(diff.added.length, diff.removed.length, diff.changed.length, diff.unchanged)}
      </p>
      {none ? <Notice>{t.diffNone}</Notice> : null}
      <Group title={t.diffChanged} entries={diff.changed} open />
      <Group title={t.diffAdded} entries={diff.added} open={false} />
      <Group title={t.diffRemoved} entries={diff.removed} open={false} />
      {diff.unreadable.length > 0 ? (
        <p className="text-xs text-ink-sub">{t.diffUnreadable(diff.unreadable.join(', '))}</p>
      ) : null}
      <p className="text-xs text-ink-sub">{t.diffHint}</p>
    </div>
  )
}

/**
 * The schema now against a snapshot: what a migration run since added, removed and changed, each changed table or
 * view with a line diff of its definition. Read-only; it is read afresh each time it opens.
 */
export function SnapshotDiffDialog({
  db,
  schema,
  target,
  onClose,
}: {
  db: string
  schema: string | undefined
  target: { id: string; name: string } | null
  onClose: () => void
}) {
  const diff = useQuery({ ...snapshotDiffQuery(db, schema, target?.id ?? ''), enabled: target !== null })
  return (
    <Dialog
      open={target !== null}
      title={target ? t.diffTitle(target.name) : ''}
      onClose={onClose}
      footer={
        <>
          <Button onClick={() => void diff.refetch()} disabled={diff.isFetching}>
            {t.diffAgain}
          </Button>
          <Button onClick={onClose}>{locale.common.close}</Button>
        </>
      }
    >
      {diff.isPending || diff.isFetching ? <Spinner /> : null}
      {diff.isError ? <ErrorBox error={diff.error} onRetry={() => void diff.refetch()} /> : null}
      {diff.data && !diff.isFetching ? <Result diff={diff.data} /> : null}
    </Dialog>
  )
}
