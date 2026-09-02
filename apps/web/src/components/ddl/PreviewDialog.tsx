import { useEffect, useRef, useState } from 'react'
import { locale } from '@/config/locale.ts'
import type { PreviewFlow } from '@/lib/preview-flow.ts'
import { Button } from '../ui/Button.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { ErrorBox, Notice, Spinner } from '../ui/Feedback.tsx'
import { Input } from '../ui/Field.tsx'

export interface PreviewDialogProps<Op> {
  flow: PreviewFlow<Op>
  title: (op: Op) => string
  destructive: (op: Op) => boolean
  /** Name the user must retype before an irreversible, data-destroying op may run (null = plain confirmation). */
  confirmName?: (op: Op) => string | null
  /** Extra sentence for ops that destroy stored data (dropping an index or an account loses none). */
  lossWarning?: (op: Op) => string | null
  hint: string
  /** Message shown (and announced) after the last op succeeded. */
  successMessage: (op: Op) => string
}

/** Shows generated SQL for a pending operation and executes it only on explicit confirmation. */
export function PreviewDialog<Op>({
  flow,
  title,
  destructive,
  confirmName,
  lossWarning,
  hint,
  successMessage,
}: PreviewDialogProps<Op>) {
  const op = flow.op
  // The success notice receives focus so keyboard users are not dropped on <body> when the trigger disappears.
  const noticeRef = useRef<HTMLOutputElement>(null)
  useEffect(() => {
    if (flow.executed) noticeRef.current?.focus()
  }, [flow.executed])
  const required = op === null ? null : (confirmName?.(op) ?? null)
  const warning = op === null ? '' : `${locale.ddl.irreversible}${lossWarning?.(op) ? ` ${lossWarning(op) ?? ''}` : ''}`
  const [typed, setTyped] = useState('')
  // Reset the confirmation text whenever a different op is previewed (state-from-props reset pattern).
  const [prevOp, setPrevOp] = useState(op)
  if (prevOp !== op) {
    setPrevOp(op)
    setTyped('')
  }
  const confirmed = required === null || typed === required
  const ready = flow.sql.length > 0 && !flow.previewing && confirmed
  return (
    <>
      {/* Always mounted so the announcement is picked up; visible as a notice once an op has run. */}
      <output ref={noticeRef} tabIndex={-1} aria-live="polite" className={flow.executed ? 'block' : 'sr-only'}>
        {flow.executed ? <Notice>{successMessage(flow.executed)}</Notice> : null}
      </output>
      <Dialog
        open={op !== null}
        title={op === null ? '' : title(op)}
        onClose={flow.cancel}
        busy={flow.running}
        footer={
          <>
            <Button onClick={flow.cancel} disabled={flow.running}>
              {locale.common.cancel}
            </Button>
            <Button
              variant={op !== null && destructive(op) ? 'danger' : 'primary'}
              onClick={flow.confirm}
              disabled={!ready || flow.running}
            >
              {flow.running ? locale.sql.running : locale.ddl.execute}
            </Button>
          </>
        }
      >
        <p className="mb-2 text-sm text-zinc-600 dark:text-zinc-300">{hint}</p>
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
        {/* Every destructive op says so; the ones that lose whole objects additionally require the name. */}
        {op !== null && destructive(op) && required === null ? (
          <p role="alert" className="mt-3 text-sm font-medium text-red-800 dark:text-red-200">
            {warning}
          </p>
        ) : null}
        {required !== null ? (
          <div className="mt-3 space-y-1 rounded border border-red-300 bg-red-50 p-3 dark:border-red-700 dark:bg-red-950">
            <p className="text-sm font-medium text-red-800 dark:text-red-200">{warning}</p>
            <label htmlFor="confirm-name" className="block text-xs text-red-800 dark:text-red-200">
              {locale.ddl.typeToConfirm(required)}
            </label>
            <Input
              id="confirm-name"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-xs"
            />
          </div>
        ) : null}
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
    </>
  )
}
