import { useQuery } from '@tanstack/react-query'
import type { ColumnDef, Filter, FilterOp } from '@tsmyadmin/shared'
import { FilterOpSchema } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { Input, Select } from '@/components/ui/Field.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { structureQuery, type TableRef } from '@/lib/queries.ts'

type Op = FilterOp | ''
interface Condition {
  op: Op
  value: string
}

const NO_VALUE: ReadonlySet<FilterOp> = new Set(['is_null', 'is_not_null'])

/** Builds the Filter[] for the browse route from per-column conditions. */
export function conditionsToFilters(columns: ColumnDef[], conditions: Record<string, Condition>): Filter[] {
  const out: Filter[] = []
  for (const c of columns) {
    const cond = conditions[c.name]
    if (!cond || cond.op === '') continue
    out.push(
      NO_VALUE.has(cond.op) ? { column: c.name, op: cond.op } : { column: c.name, op: cond.op, value: cond.value }
    )
  }
  return out
}

export function filtersToConditions(filters: Filter[]): Record<string, Condition> {
  const out: Record<string, Condition> = {}
  for (const f of filters)
    out[f.column] = { op: f.op, value: f.value === undefined || f.value === null ? '' : String(f.value) }
  return out
}

export function SearchForm({
  tableRef,
  initial,
  onSearch,
}: {
  tableRef: TableRef
  initial: Filter[]
  onSearch: (filters: Filter[]) => void
}) {
  const structure = useQuery(structureQuery(tableRef))
  const [conditions, setConditions] = useState<Record<string, Condition>>(() => filtersToConditions(initial))
  if (structure.isPending) return <Spinner />
  if (structure.isError) return <ErrorBox error={structure.error} onRetry={() => void structure.refetch()} />
  const columns = structure.data.columns
  const update = (name: string, patch: Partial<Condition>) =>
    setConditions((c) => ({ ...c, [name]: { op: '', value: '', ...c[name], ...patch } }))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    onSearch(conditionsToFilters(columns, conditions))
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{locale.search.title}</h2>
      <Table>
        <thead>
          <tr>
            <Th>{locale.rows.column}</Th>
            <Th>{locale.rows.type}</Th>
            <Th>{locale.search.operator}</Th>
            <Th className="w-full">{locale.rows.value}</Th>
          </tr>
        </thead>
        <tbody>
          {columns.map((c) => {
            const cond = conditions[c.name] ?? { op: '', value: '' }
            const needsValue = cond.op !== '' && !NO_VALUE.has(cond.op)
            return (
              <Tr key={c.name}>
                <Td className="whitespace-nowrap font-medium">{c.name}</Td>
                <Td className="font-mono text-xs text-zinc-500 dark:text-zinc-400">{c.dataType}</Td>
                <Td className="w-px whitespace-nowrap">
                  <Select
                    aria-label={`${c.name}: ${locale.search.operator}`}
                    value={cond.op}
                    onChange={(e) => update(c.name, { op: e.target.value as Op })}
                    className="w-auto"
                  >
                    <option value="">{locale.search.noCondition}</option>
                    {FilterOpSchema.options.map((op) => (
                      <option key={op} value={op}>
                        {locale.search.ops[op]}
                      </option>
                    ))}
                  </Select>
                </Td>
                <Td className="min-w-40">
                  <Input
                    aria-label={`${c.name}: ${locale.rows.value}`}
                    value={cond.value}
                    disabled={!needsValue}
                    onChange={(e) => update(c.name, { value: e.target.value })}
                    className="font-mono text-xs"
                  />
                </Td>
              </Tr>
            )
          })}
        </tbody>
      </Table>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <p className="mr-auto text-xs text-zinc-500 dark:text-zinc-400">{locale.search.likeHint}</p>
        <Button onClick={() => setConditions({})}>{locale.search.clear}</Button>
        <Button type="submit" variant="primary">
          {locale.search.apply}
        </Button>
      </div>
    </form>
  )
}
