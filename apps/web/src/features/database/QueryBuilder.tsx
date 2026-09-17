import { useMutation, useQueries, useQuery } from '@tanstack/react-query'
import { useNavigate, useRouteContext } from '@tanstack/react-router'

import { type FormEvent, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Input, Select } from '@/components/ui/Field.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { setDatabaseConsoleDraft } from '@/lib/console-draft.ts'
import { mutations, structureQuery, tablesQuery } from '@/lib/queries.ts'
import { type ColumnOption, ColumnSelect, QueryBuilderCriteria } from './QueryBuilderCriteria.tsx'
import { type ConditionGroup, columnKey, type OutputRow, toRequest, withoutTable } from './query-builder-model.ts'

const t = locale.queryBuilder

/**
 * phpMyAdmin's Query tab: pick tables, columns and conditions, and get a SELECT to edit and run in the SQL tab.
 * The server writes the SQL — joins along the foreign keys between the chosen tables, values as quoted literals —
 * so nothing typed here is pasted into a statement as text.
 */
export function QueryBuilder({ db, schema }: { db: string; schema?: string | undefined }) {
  const tables = useQuery(tablesQuery(db, schema))
  const { session } = useRouteContext({ from: '/_app' })
  const navigate = useNavigate()
  /** In the order they were chosen: the first is the one the rest are joined to. */
  const [chosen, setChosen] = useState<string[]>([])
  const [outputs, setOutputs] = useState<OutputRow[]>([])
  const [groups, setGroups] = useState<ConditionGroup[]>([])
  const lastId = useRef(0)
  const addColumnButton = useRef<HTMLButtonElement>(null)
  const newId = () => {
    lastId.current += 1
    return lastId.current
  }
  const structures = useQueries({ queries: chosen.map((table) => structureQuery({ db, schema, table })) })
  const build = useMutation({ mutationFn: (body: ReturnType<typeof toRequest>) => mutations.buildQuery(db, body) })

  if (tables.isPending) return <Spinner />
  if (tables.isError) return <ErrorBox error={tables.error} onRetry={() => void tables.refetch()} />
  const names = tables.data.filter((x) => x.kind !== 'sequence').map((x) => x.name)
  if (names.length === 0) return <Notice>{t.noTables}</Notice>
  // A table dropped since it was ticked (the list refetches) is left out rather than sent to fail on the server.
  const active = chosen.filter((name) => names.includes(name))

  const options: ColumnOption[] = chosen.flatMap((table, i) =>
    active.includes(table)
      ? (structures[i]?.data?.columns ?? []).map((c) => ({
          key: columnKey(table, c.name),
          label: active.length > 1 ? `${table}.${c.name}` : c.name,
        }))
      : []
  )
  const loadingColumns = structures.some((s) => s.isPending)
  const failed = structures.find((s) => s.isError)
  const request = toRequest(active, outputs, groups, schema)
  // The SQL shown is for the choices it was built from; after any change it is hidden rather than left looking current.
  const current = build.isSuccess && JSON.stringify(build.variables) === JSON.stringify(request)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (active.length > 0) build.mutate(request)
  }
  const updateOutput = (id: number, patch: Partial<OutputRow>) =>
    setOutputs((prev) => prev.map((o) => (o.id === id ? { ...o, ...patch } : o)))
  const openInSql = (sql: string) => {
    setDatabaseConsoleDraft(`${session.dialect}.${session.host}.${session.port}`, db, schema, sql)
    void navigate({ to: '/db/$db/sql', params: { db }, search: schema ? { schema } : {} })
  }

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold text-ink">{t.title}</h2>
        <p className="max-w-3xl text-sm text-ink-sub">{t.intro}</p>
      </div>
      <form onSubmit={submit} className="space-y-4" aria-label={t.title}>
        <fieldset className="space-y-1">
          <legend className="text-sm text-ink-sub">{t.tables}</legend>
          <p className="text-xs text-ink-sub">{t.tablesHint}</p>
          <div className="flex max-h-48 flex-wrap gap-x-4 gap-y-1 overflow-y-auto rounded border border-line p-2">
            {names.map((name) => (
              <label key={name} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={chosen.includes(name)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setChosen((prev) => [...prev, name])
                      return
                    }
                    setChosen((prev) => prev.filter((x) => x !== name))
                    const rest = withoutTable(name, outputs, groups)
                    setOutputs(rest.outputs)
                    setGroups(rest.groups)
                  }}
                />
                {name}
              </label>
            ))}
          </div>
        </fieldset>
        {/* Which table the rest join to follows the order they were ticked, which the grid above cannot show. */}
        {active.length > 1 ? <p className="text-xs text-ink-sub">{t.joinOrder(active.join(' → '))}</p> : null}

        {active.length === 0 ? (
          <p className="text-sm text-ink-sub">{t.chooseTable}</p>
        ) : (
          <>
            {failed ? (
              <ErrorBox error={failed.error} onRetry={() => void failed.refetch()} />
            ) : loadingColumns ? (
              <Spinner />
            ) : null}
            <fieldset className="space-y-2">
              <legend className="text-sm text-ink-sub">{t.columns}</legend>
              {outputs.length === 0 ? (
                <p className="text-xs text-ink-sub">{t.allColumnsHint}</p>
              ) : (
                <Table aria-label={t.columns}>
                  <thead>
                    <tr>
                      <Th>{t.column}</Th>
                      <Th>{t.alias}</Th>
                      <Th>{t.show}</Th>
                      <Th>{t.sort}</Th>
                      <Th>
                        <span className="sr-only">{t.remove}</span>
                      </Th>
                    </tr>
                  </thead>
                  <tbody>
                    {outputs.map((o, i) => {
                      const label = t.outputLabel(i + 1)
                      return (
                        <Tr key={o.id}>
                          <Td>
                            <ColumnSelect
                              value={o.key}
                              options={options}
                              label={t.fieldLabel(label, t.column)}
                              onChange={(key) => updateOutput(o.id, { key })}
                            />
                          </Td>
                          <Td>
                            <Input
                              aria-label={t.fieldLabel(label, t.alias)}
                              value={o.alias}
                              maxLength={64}
                              onChange={(e) => updateOutput(o.id, { alias: e.target.value })}
                              className="w-40"
                              autoComplete="off"
                            />
                          </Td>
                          <Td>
                            <input
                              type="checkbox"
                              aria-label={t.fieldLabel(label, t.show)}
                              checked={o.show}
                              onChange={(e) => updateOutput(o.id, { show: e.target.checked })}
                            />
                          </Td>
                          <Td>
                            <Select
                              aria-label={t.fieldLabel(label, t.sort)}
                              value={o.sort}
                              onChange={(e) => updateOutput(o.id, { sort: e.target.value as OutputRow['sort'] })}
                              className="w-28"
                            >
                              <option value="">{t.noSort}</option>
                              <option value="asc">{t.asc}</option>
                              <option value="desc">{t.desc}</option>
                            </Select>
                          </Td>
                          <Td>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={t.removeOutput(label)}
                              onClick={() => {
                                setOutputs((prev) => prev.filter((x) => x.id !== o.id))
                                addColumnButton.current?.focus()
                              }}
                            >
                              {t.remove}
                            </Button>
                          </Td>
                        </Tr>
                      )
                    })}
                  </tbody>
                </Table>
              )}
              <Button
                ref={addColumnButton}
                type="button"
                size="sm"
                onClick={() =>
                  setOutputs((prev) => [...prev, { id: newId(), key: '', alias: '', show: true, sort: '' }])
                }
              >
                {t.addColumn}
              </Button>
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="text-sm text-ink-sub">{t.criteria}</legend>
              <QueryBuilderCriteria groups={groups} options={options} onChange={setGroups} newId={newId} />
            </fieldset>
          </>
        )}

        <Button type="submit" variant="primary" disabled={active.length === 0 || build.isPending}>
          {build.isPending ? t.building : t.build}
        </Button>
      </form>

      {build.isError ? <ErrorBox error={build.error} /> : null}
      <output aria-live="polite" className="sr-only">
        {current ? t.built : null}
      </output>
      {current ? (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">{t.result}</h3>
          <pre className="overflow-x-auto rounded border border-line bg-surface-sub p-3 font-mono text-xs text-ink">
            {build.data.sql}
          </pre>
          <Button type="button" variant="primary" onClick={() => openInSql(build.data.sql)}>
            {t.openInSql}
          </Button>
        </div>
      ) : build.isSuccess ? (
        <p role="status" className="text-sm text-ink-sub">
          {t.stale}
        </p>
      ) : null}
    </section>
  )
}
