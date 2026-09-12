import { useQuery } from '@tanstack/react-query'
import type { Privilege, UserOp, UserRef } from '@tsmyadmin/shared'
import { COLUMN_PRIVILEGES, columnTargetError, PRIVILEGES } from '@tsmyadmin/shared'
import { useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { Notice } from '@/components/ui/Feedback.tsx'
import { Field, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { structureQuery, tablesQuery } from '@/lib/queries.ts'

const columnCapable = (p: Privilege) => (COLUMN_PRIVILEGES as readonly Privilege[]).includes(p)

/**
 * Picks privileges, a table and optionally the columns within it, then goes through the same preview → execute
 * flow as everything else. Privilege names come from a closed list in `packages/shared`, so nothing typed here
 * reaches SQL; column names come from the table's own structure for the same reason.
 */
export function PrivilegeChooser({
  user,
  label,
  db,
  schema,
  onSubmit,
  onClose,
}: {
  user: UserRef
  label: string
  db: string
  schema?: string | undefined
  onSubmit: (op: UserOp) => void
  onClose: () => void
}) {
  const tables = useQuery(tablesQuery(db, schema))
  const [chosen, setChosen] = useState<Privilege[]>(['SELECT'])
  const [table, setTable] = useState('')
  const [columns, setColumns] = useState<string[]>([])
  // Only fetched once a table is chosen: there are no columns to offer for a whole-database grant.
  const structure = useQuery({ ...structureQuery({ db, schema, table }), enabled: table !== '' })
  const target = {
    user,
    privileges: chosen,
    database: db,
    ...(schema ? { schema } : {}),
    ...(table ? { table } : {}),
    ...(columns.length > 0 ? { columns } : {}),
  }
  // The same rule the request schema enforces, so the form says why instead of failing at execute.
  const problem = columnTargetError(target)
  const submittable = chosen.length > 0 && problem === null
  const toggle = <T,>(list: T[], value: T, on: boolean) => (on ? [...list, value] : list.filter((x) => x !== value))
  return (
    <Dialog
      open
      title={locale.users.choosePrivileges(label)}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{locale.common.cancel}</Button>
          <Button
            variant="danger"
            disabled={!submittable}
            aria-haspopup="dialog"
            onClick={() => onSubmit({ op: 'revokePrivileges', ...target })}
          >
            {locale.users.ops.revokePrivileges}
          </Button>
          <Button
            variant="primary"
            disabled={!submittable}
            aria-haspopup="dialog"
            onClick={() => onSubmit({ op: 'grantPrivileges', ...target })}
          >
            {locale.users.ops.grantPrivileges}
          </Button>
        </>
      }
    >
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium text-zinc-700 dark:text-zinc-200">{locale.users.privileges}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {PRIVILEGES.map((p) => (
            <label key={p} className="flex items-center gap-2 py-1 text-sm">
              <input
                type="checkbox"
                checked={chosen.includes(p)}
                onChange={(e) => setChosen((c) => toggle(c, p, e.target.checked))}
              />
              {p}
              {/* Says which privileges can be narrowed to columns before the user picks any. */}
              {columnCapable(p) ? null : (
                <span className="text-xs text-zinc-500 dark:text-zinc-400">{locale.users.wholeTableOnly}</span>
              )}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-3">
        <Field id="priv-table" label={locale.users.privilegeTarget}>
          <Select
            id="priv-table"
            value={table}
            onChange={(e) => {
              setTable(e.target.value)
              // The columns belonged to the previous table.
              setColumns([])
            }}
          >
            <option value="">{locale.users.wholeDatabase}</option>
            {(tables.data ?? [])
              .filter((t) => t.kind === 'table')
              .map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
          </Select>
        </Field>
      </div>
      {table === '' ? null : (
        <fieldset className="mt-3 space-y-1">
          <legend className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
            {locale.users.privilegeColumns}
          </legend>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{locale.users.privilegeColumnsHint}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {(structure.data?.columns ?? []).map((c) => (
              <label key={c.name} className="flex items-center gap-2 py-1 text-sm">
                <input
                  type="checkbox"
                  checked={columns.includes(c.name)}
                  onChange={(e) => setColumns((cols) => toggle(cols, c.name, e.target.checked))}
                />
                {c.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {problem ? <Notice className="mt-3">{locale.users.columnProblem[problem]}</Notice> : null}
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{locale.users.privilegesNote}</p>
    </Dialog>
  )
}
