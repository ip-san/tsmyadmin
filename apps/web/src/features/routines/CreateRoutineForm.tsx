import type { DdlOp, Dialect, RoutineParam } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input, Select, Textarea } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'

const t = locale.create

type Kind = 'procedure' | 'function'

/** A starting body in the dialect's shape, so the form shows what goes where. */
function template(dialect: Dialect, kind: Kind): string {
  if (kind === 'function') return 'BEGIN\n  RETURN NULL;\nEND'
  return dialect === 'mysql' ? 'BEGIN\n  SELECT 1;\nEND' : 'BEGIN\n  NULL;\nEND'
}

/**
 * phpMyAdmin's "Add routine": name, parameters, return type and body. The body is the server's own code, so it
 * is written as is; the statement around it is built for the dialect and shown before it runs.
 */
export function CreateRoutineForm({ dialect, onSubmit }: { dialect: Dialect; onSubmit: (op: DdlOp) => void }) {
  const [kind, setKind] = useState<Kind>('procedure')
  const [name, setName] = useState('')
  const [params, setParams] = useState<RoutineParam[]>([])
  const [returns, setReturns] = useState('INT')
  const [language, setLanguage] = useState('plpgsql')
  const [deterministic, setDeterministic] = useState(false)
  const [comment, setComment] = useState('')
  const [body, setBody] = useState(template(dialect, 'procedure'))
  // A MySQL function's parameters are IN only; PostgreSQL functions and procedures take OUT / INOUT too.
  const modes = dialect === 'mysql' && kind === 'function' ? (['IN'] as const) : (['IN', 'OUT', 'INOUT'] as const)
  const changeKind = (next: Kind) => {
    // Only the untouched template follows the kind: a body the user wrote stays.
    if (body === template(dialect, kind)) setBody(template(dialect, next))
    setKind(next)
  }
  const setParam = (i: number, patch: Partial<RoutineParam>) =>
    setParams((all) => all.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !body.trim()) return
    onSubmit({
      op: 'createRoutine',
      kind,
      name: name.trim(),
      params: params
        .filter((p) => p.name.trim() && p.type.trim())
        .map((p) => ({
          mode: modes.includes(p.mode as never) ? p.mode : 'IN',
          name: p.name.trim(),
          type: p.type.trim(),
        })),
      ...(kind === 'function' ? { returns: returns.trim() } : {}),
      body,
      language,
      deterministic,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    })
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field id="routine-kind" label={t.routine.kind}>
          <Select id="routine-kind" value={kind} onChange={(e) => changeKind(e.target.value as Kind)}>
            <option value="procedure">{locale.routines.kinds.procedure}</option>
            <option value="function">{locale.routines.kinds.function}</option>
          </Select>
        </Field>
        <Field id="routine-name" label={t.name}>
          <Input id="routine-name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="off" />
        </Field>
        {kind === 'function' ? (
          <Field id="routine-returns" label={t.routine.returns}>
            <Input id="routine-returns" value={returns} onChange={(e) => setReturns(e.target.value)} required />
          </Field>
        ) : null}
        {dialect === 'postgres' ? (
          <Field id="routine-language" label={t.routine.language}>
            <Select id="routine-language" value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="plpgsql">plpgsql</option>
              <option value="sql">sql</option>
            </Select>
          </Field>
        ) : null}
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink">{t.routine.params}</legend>
        {params.map((p, i) => {
          const n = i + 1
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own besides their place
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Select
                aria-label={t.routine.paramMode(n)}
                value={p.mode}
                onChange={(e) => setParam(i, { mode: e.target.value as RoutineParam['mode'] })}
              >
                {modes.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
              <Input
                aria-label={t.routine.paramName(n)}
                value={p.name}
                onChange={(e) => setParam(i, { name: e.target.value })}
              />
              <Input
                aria-label={t.routine.paramType(n)}
                value={p.type}
                onChange={(e) => setParam(i, { type: e.target.value })}
              />
              <Button size="sm" onClick={() => setParams((all) => all.filter((_, j) => j !== i))}>
                {t.routine.removeParam(n)}
              </Button>
            </div>
          )
        })}
        <Button size="sm" onClick={() => setParams((all) => [...all, { mode: 'IN', name: '', type: 'INT' }])}>
          {t.routine.addParam}
        </Button>
      </fieldset>
      <Field id="routine-body" label={t.body} hint={t.routine.bodyHint[dialect]}>
        <Textarea
          id="routine-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          spellCheck={false}
          className="w-full font-mono text-xs"
        />
      </Field>
      <div className="flex flex-wrap items-end gap-3">
        {dialect === 'mysql' ? (
          <label className="flex items-center gap-1 text-sm text-ink">
            <input type="checkbox" checked={deterministic} onChange={(e) => setDeterministic(e.target.checked)} />
            {t.routine.deterministic}
          </label>
        ) : null}
        <Field id="routine-comment" label={t.comment}>
          <Input id="routine-comment" value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
      </div>
      <Button type="submit" variant="primary" aria-haspopup="dialog" aria-label={`${t.routine.title}: ${t.review}`}>
        {t.review}
      </Button>
    </form>
  )
}
