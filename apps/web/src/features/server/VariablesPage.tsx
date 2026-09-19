import { useQuery } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import type { KeyValue } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import { variablesQuery } from '@/lib/queries.ts'
import { KeyValueTable } from './KeyValueTable.tsx'

const t = locale.server

/** The value of a variable to change and what to change it to; blank puts it back to its default. */
function EditVariable({
  item,
  dialect,
  onSubmit,
  onCancel,
}: {
  item: KeyValue
  dialect: 'mysql' | 'postgres'
  onSubmit: (value: string | undefined) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(item.value)
  const [reset, setReset] = useState(false)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    onSubmit(reset ? undefined : value)
  }
  return (
    <form onSubmit={submit} className="space-y-3" aria-label={`${item.name}: ${t.editVariable}`}>
      <p className="text-xs text-ink-sub">
        {dialect === 'mysql' ? t.editVariableHintMysql : t.editVariableHintPostgres}
      </p>
      {item.description ? <p className="text-xs text-ink-sub">{item.description}</p> : null}
      <Field id="variable-value" label={item.name}>
        <Input
          id="variable-value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={reset}
          className="font-mono"
          autoComplete="off"
        />
      </Field>
      <label className="flex items-center gap-1 text-sm text-ink">
        <input type="checkbox" checked={reset} onChange={(e) => setReset(e.target.checked)} />
        {t.resetVariable}
      </label>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" aria-haspopup="dialog">
          {locale.create.review}
        </Button>
        <Button type="button" onClick={onCancel}>
          {locale.common.cancel}
        </Button>
      </div>
    </form>
  )
}

/** phpMyAdmin's Variables tab, including changing a setting (MySQL SET GLOBAL, PostgreSQL ALTER SYSTEM). */
export function VariablesPage() {
  const { session } = useRouteContext({ from: '/_app' })
  const vars = useQuery(variablesQuery)
  const [editing, setEditing] = useState<KeyValue | null>(null)
  const flow = useDdlFlow(session.serverDatabase, undefined)
  return (
    <section>
      <DdlPreviewDialog flow={flow} />
      <h2 className="mb-2 text-sm font-semibold text-ink">{t.variablesTitle}</h2>
      {vars.isPending ? (
        <Spinner />
      ) : vars.isError ? (
        <ErrorBox error={vars.error} onRetry={() => void vars.refetch()} />
      ) : (
        <KeyValueTable items={vars.data} label={t.variablesTitle} onEdit={setEditing} />
      )}
      <Dialog open={editing !== null} title={t.editVariable} onClose={() => setEditing(null)}>
        {editing ? (
          <EditVariable
            item={editing}
            dialect={session.dialect}
            onCancel={() => setEditing(null)}
            onSubmit={(value) => {
              setEditing(null)
              flow.preview({ op: 'setServerVariable', name: editing.name, ...(value === undefined ? {} : { value }) })
            }}
          />
        ) : null}
      </Dialog>
    </section>
  )
}
