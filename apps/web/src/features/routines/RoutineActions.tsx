import type { DATA_ACCESS, DdlOp, Dialect, RoutineInfo, SqlSecurity, UserOp } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { SecuritySelect } from '@/components/ddl/DefinerFields.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { useOpenInDatabaseConsole } from '@/lib/open-in-console.ts'
import { callSql, parseParameters } from '@/lib/routine-call.ts'
import { RoutinePrivilegesDialog } from './RoutinePrivilegesDialog.tsx'
import { signatureOf } from './routine-signature.ts'

const t = locale.routines
const DATA_ACCESS_OPTIONS: readonly (typeof DATA_ACCESS)[number][] = [
  'CONTAINS SQL',
  'NO SQL',
  'READS SQL DATA',
  'MODIFIES SQL DATA',
]

function RunDialog({
  routine,
  dialect,
  db,
  schema,
  onClose,
}: {
  routine: RoutineInfo & { kind: 'procedure' | 'function' }
  dialect: Dialect
  db: string
  schema: string | undefined
  onClose: () => void
}) {
  const params = parseParameters(routine.parameters)
  const inputs = params.map((p, i) => ({ p, i })).filter(({ p }) => p.mode !== 'OUT')
  const [values, setValues] = useState<(string | null)[]>(() => params.map(() => ''))
  const open = useOpenInDatabaseConsole(db, schema)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    open(callSql({ dialect, kind: routine.kind, name: routine.name, params, values }))
  }
  const set = (i: number, v: string | null) => setValues((all) => all.map((x, j) => (j === i ? v : x)))
  return (
    <Dialog open title={`${routine.name}: ${t.run}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3" aria-label={`${routine.name}: ${t.run}`}>
        <p className="text-xs text-ink-sub">{t.runHint}</p>
        {inputs.length === 0 ? <p className="text-sm text-ink-sub">{t.noParameters}</p> : null}
        {inputs.map(({ p, i }) => (
          <div key={`${p.name}:${i}`} className="flex flex-wrap items-end gap-2">
            <Field id={`run-${i}`} label={`${p.name} (${p.type})`}>
              <Input
                id={`run-${i}`}
                value={values[i] ?? ''}
                disabled={values[i] === null}
                onChange={(e) => set(i, e.target.value)}
                autoComplete="off"
                className="font-mono"
              />
            </Field>
            <label className="flex items-center gap-1 pb-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={values[i] === null}
                onChange={(e) => set(i, e.target.checked ? null : '')}
                aria-label={`${p.name}: NULL`}
              />
              NULL
            </label>
          </div>
        ))}
        <Button type="submit" variant="primary">
          {t.openInSql}
        </Button>
      </form>
    </Dialog>
  )
}

function CharacteristicsDialog({
  routine,
  dialect,
  onSubmit,
  onClose,
}: {
  routine: RoutineInfo & { kind: 'procedure' | 'function' }
  dialect: Dialect
  onSubmit: (op: DdlOp) => void
  onClose: () => void
}) {
  const [sqlSecurity, setSqlSecurity] = useState<SqlSecurity | ''>('')
  const [dataAccess, setDataAccess] = useState<(typeof DATA_ACCESS_OPTIONS)[number] | ''>('')
  const [comment, setComment] = useState(routine.comment ?? '')
  const mysql = dialect === 'mysql'
  const parameters = signatureOf(dialect, routine.parameters)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const commentChanged = comment !== (routine.comment ?? '')
    if (!sqlSecurity && !dataAccess && !commentChanged) return
    onClose()
    onSubmit({
      op: 'alterRoutine',
      kind: routine.kind,
      name: routine.name,
      ...(parameters !== undefined ? { parameters } : {}),
      ...(sqlSecurity ? { sqlSecurity } : {}),
      ...(mysql && dataAccess ? { dataAccess } : {}),
      ...(commentChanged ? { comment } : {}),
    })
  }
  return (
    <Dialog open title={`${routine.name}: ${t.characteristics}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3" aria-label={`${routine.name}: ${t.characteristics}`}>
        <p className="text-xs text-ink-sub">{t.characteristicsHint}</p>
        <SecuritySelect id="routine-security" value={sqlSecurity} onChange={setSqlSecurity} />
        {mysql ? (
          <Field id="routine-access" label={locale.create.security.dataAccess}>
            <Select
              id="routine-access"
              value={dataAccess}
              onChange={(e) => setDataAccess(e.target.value as typeof dataAccess)}
            >
              <option value="">{locale.create.security.defaultOption}</option>
              {DATA_ACCESS_OPTIONS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field id="routine-comment" label={t.comment}>
          <Input id="routine-comment" value={comment} onChange={(e) => setComment(e.target.value)} autoComplete="off" />
        </Field>
        <Button type="submit" variant="primary" aria-haspopup="dialog">
          {locale.create.review}
        </Button>
      </form>
    </Dialog>
  )
}

/** Run (opens a CALL / SELECT in the SQL tab), change characteristics, and drop: phpMyAdmin's routine row actions. */
export function RoutineActions({
  routine,
  dialect,
  db,
  schema,
  onPreview,
  onUserOp,
}: {
  routine: RoutineInfo
  dialect: Dialect
  db: string
  schema: string | undefined
  onPreview: (op: DdlOp) => void
  onUserOp: (op: UserOp) => void
}) {
  const [dialog, setDialog] = useState<'run' | 'alter' | 'privileges' | null>(null)
  if (routine.kind !== 'procedure' && routine.kind !== 'function') return null
  const r = routine as RoutineInfo & { kind: 'procedure' | 'function' }
  const close = () => setDialog(null)
  return (
    <div className="space-x-1 whitespace-nowrap">
      <Button size="sm" onClick={() => setDialog('run')} aria-haspopup="dialog" aria-label={`${r.name}: ${t.run}`}>
        {t.run}
      </Button>
      <Button
        size="sm"
        onClick={() => setDialog('alter')}
        aria-haspopup="dialog"
        aria-label={`${r.name}: ${t.characteristics}`}
      >
        {t.characteristics}
      </Button>
      <Button
        size="sm"
        onClick={() => setDialog('privileges')}
        aria-haspopup="dialog"
        aria-label={`${r.name}: ${t.privileges}`}
      >
        {t.privileges}
      </Button>
      <Button
        size="sm"
        variant="danger"
        aria-haspopup="dialog"
        aria-label={`${r.name}: ${t.drop}`}
        onClick={() => {
          const parameters = signatureOf(dialect, r.parameters)
          onPreview({
            op: 'dropRoutine',
            kind: r.kind,
            name: r.name,
            ...(parameters !== undefined ? { parameters } : {}),
          })
        }}
      >
        {t.drop}
      </Button>
      {dialog === 'run' ? <RunDialog routine={r} dialect={dialect} db={db} schema={schema} onClose={close} /> : null}
      {dialog === 'privileges' ? (
        <RoutinePrivilegesDialog
          routine={r}
          dialect={dialect}
          db={db}
          schema={schema}
          onSubmit={onUserOp}
          onClose={close}
        />
      ) : null}
      {dialog === 'alter' ? (
        <CharacteristicsDialog routine={r} dialect={dialect} onSubmit={onPreview} onClose={close} />
      ) : null}
    </div>
  )
}
