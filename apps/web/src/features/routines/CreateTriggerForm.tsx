import type { DdlOp, Dialect, TriggerDetail } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { DefinerField } from '@/components/ddl/DefinerFields.tsx'
import { parseDefiner } from '@/components/ddl/definer.ts'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input, Select, Textarea } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'

const t = locale.create

const TIMINGS = ['BEFORE', 'AFTER'] as const
const EVENTS = ['INSERT', 'UPDATE', 'DELETE'] as const

/** A starting body in the dialect's shape: PostgreSQL's trigger function has to hand the row back. */
const TEMPLATE = {
  mysql: 'BEGIN\n  SET NEW.updated_at = NOW();\nEND',
  postgres: 'BEGIN\n  NEW.updated_at := now();\n  RETURN NEW;\nEND',
} satisfies Record<Dialect, string>

/** phpMyAdmin's "Add trigger": a row-level trigger on one table. */
export function CreateTriggerForm({
  dialect,
  tables,
  table: fixed,
  onSubmit,
  initial,
  replaces,
  onCancel,
}: {
  dialect: Dialect
  /** Tables to choose from, when the form is not already on one. */
  tables: readonly string[]
  table?: string | undefined
  onSubmit: (op: DdlOp) => void
  /** An existing trigger to edit: the form starts from it and submits a replacement of `replaces`. */
  initial?: TriggerDetail
  replaces?: { name: string; table: string }
  onCancel?: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [table, setTable] = useState(initial?.table ?? fixed ?? tables[0] ?? '')
  const [timing, setTiming] = useState<(typeof TIMINGS)[number]>(initial?.timing ?? 'BEFORE')
  const [event, setEvent] = useState<(typeof EVENTS)[number]>(initial?.event ?? 'INSERT')
  const [body, setBody] = useState(initial?.body ?? TEMPLATE[dialect])
  const [definerText, setDefinerText] = useState(
    initial?.definer ? `${initial.definer.user}@${initial.definer.host}` : ''
  )
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const definer = dialect === 'mysql' ? parseDefiner(definerText) : null
    if (!name.trim() || !table || !body.trim() || definer === 'invalid') return
    const create = { name: name.trim(), table, timing, event, body, ...(definer ? { definer } : {}) }
    onSubmit(replaces ? { op: 'replaceTrigger', ...create, replaces } : { op: 'createTrigger', ...create })
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field id="trigger-name" label={t.name}>
          <Input id="trigger-name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="off" />
        </Field>
        {fixed ? null : (
          <Field id="trigger-table" label={t.trigger.table}>
            <Select id="trigger-table" value={table} onChange={(e) => setTable(e.target.value)} required>
              {tables.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field id="trigger-timing" label={t.trigger.timing}>
          <Select
            id="trigger-timing"
            value={timing}
            onChange={(e) => setTiming(e.target.value as (typeof TIMINGS)[number])}
          >
            {TIMINGS.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="trigger-event" label={t.trigger.event}>
          <Select
            id="trigger-event"
            value={event}
            onChange={(e) => setEvent(e.target.value as (typeof EVENTS)[number])}
          >
            {EVENTS.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Select>
        </Field>
        {dialect === 'mysql' ? (
          <DefinerField id="trigger-definer" value={definerText} onChange={setDefinerText} />
        ) : null}
      </div>
      <Field id="trigger-body" label={t.body} hint={t.trigger.bodyHint[dialect]}>
        <Textarea
          id="trigger-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          spellCheck={false}
          className="w-full font-mono text-xs"
        />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" aria-haspopup="dialog" aria-label={`${t.trigger.title}: ${t.review}`}>
          {t.review}
        </Button>
        {onCancel ? <Button onClick={onCancel}>{locale.common.cancel}</Button> : null}
      </div>
    </form>
  )
}
