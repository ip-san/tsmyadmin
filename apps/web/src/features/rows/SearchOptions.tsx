import { BROWSE_MAX_LIMIT } from '@tsmyadmin/shared'
import { Field, Input, Select, Textarea } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'

const t = locale.search.options

/** phpMyAdmin's search options: which columns, DISTINCT, conditions typed as SQL, the order and the page size. */
export interface SearchOptionsValue {
  /** Columns to show, in table order; every column when all are ticked. */
  columns: string[]
  distinct: boolean
  whereSql: string
  sort: { column: string; direction: 'asc' | 'desc' } | null
  limit: number | null
}

export const defaultSearchOptions = (columns: string[]): SearchOptionsValue => ({
  columns,
  distinct: false,
  whereSql: '',
  sort: null,
  limit: null,
})

/** Whether the search needs a SELECT of its own (the browse tab cannot show DISTINCT rows or run typed SQL). */
export const needsStatement = (o: SearchOptionsValue): boolean => o.distinct || o.whereSql.trim() !== ''

export function SearchOptions({
  columns,
  value,
  onChange,
}: {
  columns: string[]
  value: SearchOptionsValue
  onChange: (next: SearchOptionsValue) => void
}) {
  const set = (patch: Partial<SearchOptionsValue>) => onChange({ ...value, ...patch })
  const toggle = (c: string) =>
    set({
      columns: value.columns.includes(c)
        ? value.columns.filter((x) => x !== c)
        : columns.filter((x) => x === c || value.columns.includes(x)),
    })
  return (
    <details className="rounded border border-line p-3 text-sm">
      <summary className="cursor-pointer text-xs font-medium text-ink-sub">{t.title}</summary>
      <div className="mt-3 space-y-3">
        <fieldset>
          <legend className="mb-1 text-xs font-medium text-ink-sub">{t.columns}</legend>
          <div className="flex flex-wrap gap-3">
            {columns.map((c) => (
              <label key={c} className="flex items-center gap-1 text-ink">
                <input type="checkbox" checked={value.columns.includes(c)} onChange={() => toggle(c)} />
                {c}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-ink">
          <input type="checkbox" checked={value.distinct} onChange={(e) => set({ distinct: e.target.checked })} />
          {t.distinct}
        </label>
        <Field id="search-where-sql" label={t.whereSql} hint={t.whereSqlHint}>
          <Textarea
            id="search-where-sql"
            value={value.whereSql}
            onChange={(e) => set({ whereSql: e.target.value })}
            rows={2}
            className="font-mono text-xs"
            spellCheck={false}
          />
        </Field>
        <div className="flex flex-wrap items-end gap-3">
          <Field id="search-sort" label={t.sortBy}>
            <Select
              id="search-sort"
              value={value.sort?.column ?? ''}
              onChange={(e) =>
                set({
                  sort: e.target.value ? { column: e.target.value, direction: value.sort?.direction ?? 'asc' } : null,
                })
              }
            >
              <option value="">{t.noSort}</option>
              {columns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          {value.sort ? (
            <Field id="search-sort-dir" label={`${t.sortBy}: ${value.sort.column}`}>
              <Select
                id="search-sort-dir"
                value={value.sort.direction}
                onChange={(e) =>
                  value.sort && set({ sort: { ...value.sort, direction: e.target.value as 'asc' | 'desc' } })
                }
              >
                <option value="asc">{t.asc}</option>
                <option value="desc">{t.desc}</option>
              </Select>
            </Field>
          ) : null}
          <Field id="search-limit" label={t.limit}>
            <Input
              id="search-limit"
              type="number"
              min={1}
              max={BROWSE_MAX_LIMIT}
              value={value.limit ?? ''}
              onChange={(e) => set({ limit: e.target.value === '' ? null : Number(e.target.value) })}
              className="w-28"
            />
          </Field>
        </div>
      </div>
    </details>
  )
}
