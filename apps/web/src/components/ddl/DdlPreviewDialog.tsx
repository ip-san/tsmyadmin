import { locale } from '@/config/locale.ts'
import type { DdlFlow } from '@/lib/ddl.ts'
import { Button } from '../ui/Button.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { ErrorBox, Spinner } from '../ui/Feedback.tsx'

const DESTRUCTIVE = new Set(['dropTable', 'truncateTable', 'dropColumn', 'dropIndex'])

/** Shows the generated SQL for a DDL operation and executes it only on explicit confirmation. */
export function DdlPreviewDialog({ flow }: { flow: DdlFlow }) {
  const op = flow.op
  const title = op ? locale.ddl.titles[op.op] : ''
  const ready = flow.sql.length > 0 && !flow.previewing
  return (
    <Dialog
      open={op !== null}
      title={title}
      onClose={flow.cancel}
      footer={
        <>
          <Button onClick={flow.cancel} disabled={flow.running}>
            {locale.common.cancel}
          </Button>
          <Button
            variant={op && DESTRUCTIVE.has(op.op) ? 'danger' : 'primary'}
            onClick={flow.confirm}
            disabled={!ready || flow.running}
          >
            {flow.running ? locale.sql.running : locale.ddl.execute}
          </Button>
        </>
      }
    >
      <p className="mb-2 text-sm text-zinc-600 dark:text-zinc-300">{locale.ddl.previewHint}</p>
      {flow.previewing ? (
        <Spinner label={locale.ddl.generating} />
      ) : (
        <pre
          aria-label="SQL"
          className="overflow-x-auto rounded border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
        >
          {flow.sql.map((s) => `${s};`).join('\n')}
        </pre>
      )}
      {flow.error ? <ErrorBox error={flow.error} className="mt-2" /> : null}
      {flow.failed && flow.failed.kind === 'error' ? (
        <div
          role="alert"
          className="mt-2 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
        >
          <strong>{locale.ddl.failedStatement}:</strong> {flow.failed.message}
          <pre className="mt-1 overflow-x-auto font-mono text-xs">{flow.failed.sql}</pre>
        </div>
      ) : null}
    </Dialog>
  )
}
