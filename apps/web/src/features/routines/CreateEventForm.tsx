import { type DdlOp, EVENT_INTERVAL_UNITS, type EventDetail, type EventSchedule } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { DefinerField } from '@/components/ddl/DefinerFields.tsx'
import { parseDefiner } from '@/components/ddl/definer.ts'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input, Select, Textarea } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'

const t = locale.create

type Unit = (typeof EVENT_INTERVAL_UNITS)[number]

/** A `datetime-local` value (`2026-09-18T09:30`) as the scheduler's `YYYY-MM-DD HH:MM:SS`. */
export function toMoment(local: string): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/.exec(local)
  return m ? `${m[1]} ${m[2]}:${m[3] ?? '00'}` : undefined
}

/** The scheduler's `YYYY-MM-DD HH:MM:SS` as a `datetime-local` value. */
const toLocal = (moment: string) => moment.replace(' ', 'T')

/** phpMyAdmin's "Add event" (MySQL event scheduler): once at a moment, or every so often. */
export function CreateEventForm({
  onSubmit,
  initial,
  replaces,
  onCancel,
}: {
  onSubmit: (op: DdlOp) => void
  /** An existing event to edit: the form starts from it and submits a replacement of `replaces` (its name). */
  initial?: EventDetail
  replaces?: string
  onCancel?: () => void
}) {
  const schedule0 = initial?.schedule
  const [name, setName] = useState(initial?.name ?? '')
  const [kind, setKind] = useState<'at' | 'every'>(schedule0?.kind ?? 'every')
  const [at, setAt] = useState(schedule0?.kind === 'at' ? toLocal(schedule0.at) : '')
  const [interval, setInterval] = useState(schedule0?.kind === 'every' ? String(schedule0.interval) : '1')
  const [unit, setUnit] = useState<Unit>(schedule0?.kind === 'every' ? schedule0.unit : 'DAY')
  const [starts, setStarts] = useState(schedule0?.kind === 'every' && schedule0.starts ? toLocal(schedule0.starts) : '')
  const [ends, setEnds] = useState(schedule0?.kind === 'every' && schedule0.ends ? toLocal(schedule0.ends) : '')
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [preserve, setPreserve] = useState(initial?.preserve ?? false)
  const [definerText, setDefinerText] = useState(
    initial?.definer ? `${initial.definer.user}@${initial.definer.host}` : ''
  )
  const [comment, setComment] = useState(initial?.comment ?? '')
  const [body, setBody] = useState(initial?.body ?? 'BEGIN\n  SELECT 1;\nEND')
  const schedule = (): EventSchedule | null => {
    if (kind === 'at') {
      const moment = toMoment(at)
      return moment ? { kind: 'at', at: moment } : null
    }
    const every = Number(interval)
    if (!Number.isInteger(every) || every < 1) return null
    const from = toMoment(starts)
    const until = toMoment(ends)
    return {
      kind: 'every',
      interval: every,
      unit,
      ...(from ? { starts: from } : {}),
      ...(until ? { ends: until } : {}),
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const s = schedule()
    const definer = parseDefiner(definerText)
    if (!name.trim() || !s || !body.trim() || definer === 'invalid') return
    const create = {
      name: name.trim(),
      schedule: s,
      body,
      enabled,
      ...(preserve ? { preserve: true } : {}),
      ...(definer ? { definer } : {}),
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    }
    onSubmit(replaces ? { op: 'replaceEvent', ...create, replaces } : { op: 'createEvent', ...create })
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field id="event-name" label={t.name}>
          <Input id="event-name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="off" />
        </Field>
        <fieldset className="flex items-center gap-3 text-sm text-ink">
          <legend className="sr-only">{locale.events.schedule}</legend>
          <label className="flex items-center gap-1">
            <input type="radio" name="event-kind" checked={kind === 'every'} onChange={() => setKind('every')} />
            {t.event.every}
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" name="event-kind" checked={kind === 'at'} onChange={() => setKind('at')} />
            {t.event.once}
          </label>
        </fieldset>
      </div>
      {kind === 'at' ? (
        <Field id="event-at" label={t.event.at}>
          <Input
            id="event-at"
            type="datetime-local"
            step={1}
            value={at}
            onChange={(e) => setAt(e.target.value)}
            required
          />
        </Field>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <Field id="event-interval" label={t.event.interval}>
            <Input
              id="event-interval"
              type="number"
              min={1}
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
              className="w-24"
              required
            />
          </Field>
          <Field id="event-unit" label={t.event.unit}>
            <Select id="event-unit" value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
              {EVENT_INTERVAL_UNITS.map((u) => (
                <option key={u} value={u}>
                  {t.event.units[u]}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="event-starts" label={t.event.starts}>
            <Input
              id="event-starts"
              type="datetime-local"
              step={1}
              value={starts}
              onChange={(e) => setStarts(e.target.value)}
            />
          </Field>
          <Field id="event-ends" label={t.event.ends}>
            <Input
              id="event-ends"
              type="datetime-local"
              step={1}
              value={ends}
              onChange={(e) => setEnds(e.target.value)}
            />
          </Field>
        </div>
      )}
      <Field id="event-body" label={t.body} hint={t.event.bodyHint}>
        <Textarea
          id="event-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          spellCheck={false}
          className="w-full font-mono text-xs"
        />
      </Field>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex items-center gap-1 text-sm text-ink">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t.event.enabled}
        </label>
        <label className="flex items-center gap-1 text-sm text-ink" title={t.event.preserveHint}>
          <input type="checkbox" checked={preserve} onChange={(e) => setPreserve(e.target.checked)} />
          {t.event.preserve}
        </label>
        <Field id="event-comment" label={t.comment}>
          <Input id="event-comment" value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
        <DefinerField id="event-definer" value={definerText} onChange={setDefinerText} />
      </div>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" aria-haspopup="dialog" aria-label={`${t.event.title}: ${t.review}`}>
          {t.review}
        </Button>
        {onCancel ? <Button onClick={onCancel}>{locale.common.cancel}</Button> : null}
      </div>
    </form>
  )
}
