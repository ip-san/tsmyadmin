import type { DdlOp, Dialect, SqlSecurity } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input, Select, Textarea } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { DefinerField, SecuritySelect } from './DefinerFields.tsx'
import { parseDefiner } from './definer.ts'
import type { ParsedView } from './view-definition.ts'

const t = locale.create
const ALGORITHMS = ['UNDEFINED', 'MERGE', 'TEMPTABLE'] as const

/**
 * phpMyAdmin's "Create view" (and, with `fixedName`, its edit): a name over a SELECT, optional column names and
 * check option, and on MySQL the ALGORITHM, DEFINER and SQL SECURITY.
 */
export function ViewForm({
  dialect,
  onSubmit,
  initialSelect = '',
  initial,
  fixedName,
}: {
  dialect: Dialect
  onSubmit: (op: DdlOp) => void
  initialSelect?: string | undefined
  /** An existing view's parts, when editing one. */
  initial?: ParsedView
  /** Editing: the view keeps its name and is replaced. */
  fixedName?: string
}) {
  const [name, setName] = useState(fixedName ?? '')
  const [select, setSelect] = useState(initial?.select ?? initialSelect)
  const [orReplace, setOrReplace] = useState(false)
  const [columnsText, setColumnsText] = useState('')
  const [checkOption, setCheckOption] = useState<'' | 'CASCADED' | 'LOCAL'>(initial?.checkOption ?? '')
  const [algorithm, setAlgorithm] = useState<(typeof ALGORITHMS)[number] | ''>(initial?.algorithm ?? '')
  const [definerText, setDefinerText] = useState(
    initial?.definer ? `${initial.definer.user}@${initial.definer.host}` : ''
  )
  const [sqlSecurity, setSqlSecurity] = useState<SqlSecurity | ''>(initial?.sqlSecurity ?? '')
  const mysql = dialect === 'mysql'
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const definer = mysql ? parseDefiner(definerText) : null
    if (!name.trim() || !select.trim() || definer === 'invalid') return
    const columns = columnsText
      .split(',')
      .map((c) => c.trim())
      .filter((c) => c !== '')
    onSubmit({
      op: 'createView',
      name: name.trim(),
      select,
      orReplace: fixedName !== undefined || orReplace,
      ...(columns.length > 0 ? { columns } : {}),
      ...(checkOption ? { checkOption } : {}),
      ...(mysql && algorithm ? { algorithm } : {}),
      ...(mysql && sqlSecurity ? { sqlSecurity } : {}),
      ...(definer ? { definer } : {}),
    })
  }
  return (
    <form onSubmit={submit} className="space-y-3" aria-label={fixedName ? t.view.editTitle : t.view.title}>
      <Field id="view-name" label={t.name}>
        <Input
          id="view-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          readOnly={fixedName !== undefined}
          autoComplete="off"
        />
      </Field>
      <Field id="view-select" label={t.view.select}>
        <Textarea
          id="view-select"
          value={select}
          onChange={(e) => setSelect(e.target.value)}
          rows={5}
          spellCheck={false}
          className="w-full font-mono text-xs"
          required
        />
      </Field>
      <div className="flex flex-wrap items-start gap-3">
        <Field id="view-columns" label={t.view.columns} hint={t.view.columnsHint}>
          <Input
            id="view-columns"
            value={columnsText}
            onChange={(e) => setColumnsText(e.target.value)}
            autoComplete="off"
          />
        </Field>
        <Field id="view-check" label={t.view.checkOption}>
          <Select
            id="view-check"
            value={checkOption}
            onChange={(e) => setCheckOption(e.target.value as typeof checkOption)}
          >
            <option value="">{t.security.defaultOption}</option>
            <option value="CASCADED">WITH CASCADED CHECK OPTION</option>
            <option value="LOCAL">WITH LOCAL CHECK OPTION</option>
          </Select>
        </Field>
        {mysql ? (
          <>
            <Field id="view-algorithm" label={t.view.algorithm}>
              <Select
                id="view-algorithm"
                value={algorithm}
                onChange={(e) => setAlgorithm(e.target.value as typeof algorithm)}
              >
                <option value="">{t.security.defaultOption}</option>
                {ALGORITHMS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </Select>
            </Field>
            <SecuritySelect id="view-security" value={sqlSecurity} onChange={setSqlSecurity} />
            <DefinerField id="view-definer" value={definerText} onChange={setDefinerText} />
          </>
        ) : null}
      </div>
      {fixedName === undefined ? (
        <label className="flex items-center gap-1 text-sm text-ink">
          <input type="checkbox" checked={orReplace} onChange={(e) => setOrReplace(e.target.checked)} />
          {t.view.orReplace}
        </label>
      ) : null}
      <Button
        type="submit"
        variant="primary"
        aria-haspopup="dialog"
        aria-label={`${fixedName ? t.view.editTitle : t.view.title}: ${t.review}`}
      >
        {t.review}
      </Button>
    </form>
  )
}
