import { Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { type ColumnOption, ColumnSelect } from './QueryBuilderCriteria.tsx'
import type { ColumnKey, JoinRow } from './query-builder-model.ts'

const t = locale.queryBuilder

const tableOf = (key: ColumnKey): string => {
  try {
    return (JSON.parse(key) as [string, string])[0]
  } catch {
    return ''
  }
}

/**
 * phpMyAdmin's relationship rows: for each table after the first, along a foreign key (the default) or a join of
 * a kind on a column of it and a column of a table before it.
 */
export function QueryBuilderJoins({
  tables,
  options,
  joins,
  onChange,
}: {
  tables: readonly string[]
  options: readonly ColumnOption[]
  joins: Readonly<Record<string, JoinRow>>
  onChange: (table: string, row: JoinRow) => void
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm text-ink-sub">{t.joins}</legend>
      {tables.slice(1).map((table, i) => {
        const row = joins[table] ?? { kind: '', from: '', to: '' }
        const before = new Set(tables.slice(0, i + 1))
        return (
          <div key={table} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-32 truncate font-medium">{table}</span>
            <Select
              aria-label={t.joinKind(table)}
              value={row.kind}
              onChange={(e) => onChange(table, { ...row, kind: e.target.value as JoinRow['kind'] })}
              className="w-48"
            >
              <option value="">{t.joinAuto}</option>
              <option value="inner">INNER JOIN</option>
              <option value="left">LEFT JOIN</option>
              <option value="right">RIGHT JOIN</option>
            </Select>
            {row.kind ? (
              <>
                <ColumnSelect
                  value={row.from}
                  options={options.filter((o) => tableOf(o.key) === table)}
                  label={t.joinFrom(table)}
                  onChange={(from) => onChange(table, { ...row, from })}
                />
                <span aria-hidden>=</span>
                <ColumnSelect
                  value={row.to}
                  options={options.filter((o) => before.has(tableOf(o.key)))}
                  label={t.joinTo(table)}
                  onChange={(to) => onChange(table, { ...row, to })}
                />
              </>
            ) : null}
          </div>
        )
      })}
    </fieldset>
  )
}
