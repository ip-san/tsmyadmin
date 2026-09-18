import { type DdlOp, EVENT_INTERVAL_UNITS, type EventSchedule } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
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

/** phpMyAdmin's "Add event" (MySQL event scheduler): once at a moment, or every so often. */
export function CreateEventForm({ onSubmit }: { onSubmit: (op: DdlOp) => void }) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'at' | 'every'>('every')
  const [at, setAt] = useState('')
  const [interval, setInterval] = useState('1')
  const [unit, setUnit] = useState<Unit>('DAY')
  const [starts, setStarts] = useState('')
  const [ends, setEnds] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [comment, setComment] = useState('')
  const [body, setBody] = useState('BEGIN\n  SELECT 1;\nEND')
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
    if (!name.trim() || !s || !body.trim()) return
    onSubmit({
      op: 'createEvent',
      name: name.trim(),
      schedule: s,
      body,
      enabled,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    })
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
        <Field id="event-comment" label={t.comment}>
          <Input id="event-comment" value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
      </div>
      <Button type="submit" variant="primary" aria-haspopup="dialog" aria-label={`${t.event.title}: ${t.review}`}>
        {t.review}
      </Button>
    </form>
  )
}
