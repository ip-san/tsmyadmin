import { useQuery } from '@tanstack/react-query'
import { useNavigate, useRouteContext } from '@tanstack/react-router'
import type { TableSearchResult } from '@tsmyadmin/shared'
import { SEARCH_TERM_MAX } from '@tsmyadmin/shared'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { setDatabaseConsoleDraft } from '@/lib/console-draft.ts'
import { searchTable, tablesQuery } from '@/lib/queries.ts'

type Outcome = { table: string } & ({ result: TableSearchResult } | { error: unknown })

/**
 * Searches every chosen table of a database for a term, as phpMyAdmin's database Search tab does. Tables are
 * searched one request at a time: each is a full scan, so running them together would only queue on the session's
 * small connection pool, and one at a time is what lets Stop take effect between tables.
 */
export function DatabaseSearch({ db, schema }: { db: string; schema?: string | undefined }) {
  const tables = useQuery(tablesQuery(db, schema))
  const { session } = useRouteContext({ from: '/_app' })
  const navigate = useNavigate()
  const [term, setTerm] = useState('')
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set())
  const [outcomes, setOutcomes] = useState<Outcome[]>([])
  const [planned, setPlanned] = useState(0)
  const [running, setRunning] = useState(false)
  const [stopped, setStopped] = useState(false)
  /** The run that may still append results; a new run, Stop, or leaving the page invalidates the previous one. */
  const currentRun = useRef(0)
  // Leaving the page must end the loop: otherwise every remaining table is still scanned in the background, each
  // holding one of the session's few pooled connections, and a later visit starts a second loop alongside it.
  useEffect(
    () => () => {
      currentRun.current += 1
    },
    []
  )

  if (tables.isPending) return <Spinner />
  if (tables.isError) return <ErrorBox error={tables.error} onRetry={() => void tables.refetch()} />
  // A sequence holds one value, not rows to search.
  const names = tables.data.filter((t) => t.kind !== 'sequence').map((t) => t.name)
  const chosen = names.filter((n) => !excluded.has(n))

  const run = async (e: FormEvent) => {
    e.preventDefault()
    const q = term.trim()
    if (q === '' || chosen.length === 0 || running) return
    currentRun.current += 1
    const runId = currentRun.current
    setStopped(false)
    setOutcomes([])
    setPlanned(chosen.length)
    setRunning(true)
    try {
      for (const table of chosen) {
        if (currentRun.current !== runId) break
        const outcome: Outcome = await searchTable({ db, schema, table }, q).then(
          (result) => ({ table, result }),
          (error: unknown) => ({ table, error })
        )
        // The table that was in flight when this run was superseded still finishes; its result is not shown.
        if (currentRun.current !== runId) break
        setOutcomes((prev) => [...prev, outcome])
      }
    } finally {
      if (currentRun.current === runId) setRunning(false)
    }
  }

  const openInSql = (sql: string) => {
    setDatabaseConsoleDraft(`${session.dialect}.${session.host}.${session.port}`, db, schema, sql)
    void navigate({ to: '/db/$db/sql', params: { db }, search: schema ? { schema } : {} })
  }

  const found = outcomes.flatMap((o) => ('result' in o ? [o.result] : []))
  const totalRows = found.reduce((sum, r) => sum + r.total, 0)
  const lowerBound = found.some((r) => r.count === 'lower_bound')
  const matchedTables = found.filter((r) => r.total > 0).length

  if (names.length === 0) return <Notice>{locale.databaseSearch.noTables}</Notice>
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-ink">{locale.databaseSearch.title}</h2>
      <form onSubmit={run} className="space-y-3" aria-label={locale.databaseSearch.title}>
        <div className="flex max-w-xl items-end gap-2">
          <div className="flex-1">
            <Field id="database-search-term" label={locale.databaseSearch.term} hint={locale.databaseSearch.termHint}>
              <Input
                id="database-search-term"
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                maxLength={SEARCH_TERM_MAX}
                required
                autoComplete="off"
              />
            </Field>
          </div>
          {/* Disabled while running rather than swapped for Stop: anything appearing in this row would also resize
              the field and move the buttons under the pointer, so a double click could land its second click on it. */}
          <Button type="submit" variant="primary" disabled={running || term.trim() === '' || chosen.length === 0}>
            {locale.databaseSearch.run}
          </Button>
        </div>
        <fieldset className="space-y-1">
          <legend className="flex items-center gap-2 text-sm text-ink-sub">
            {locale.databaseSearch.tables}
            <Button type="button" variant="ghost" size="sm" onClick={() => setExcluded(new Set())} disabled={running}>
              {locale.databaseSearch.selectAll}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setExcluded(new Set(names))}
              disabled={running}
            >
              {locale.databaseSearch.selectNone}
            </Button>
          </legend>
          <div className="flex max-h-48 flex-wrap gap-x-4 gap-y-1 overflow-y-auto rounded border border-line p-2">
            {names.map((name) => (
              <label key={name} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={!excluded.has(name)}
                  disabled={running}
                  onChange={(e) =>
                    setExcluded((prev) => {
                      const next = new Set(prev)
                      if (e.target.checked) next.delete(name)
                      else next.add(name)
                      return next
                    })
                  }
                />
                {name}
              </label>
            ))}
          </div>
          {chosen.length === 0 ? <p className="text-sm text-critical">{locale.databaseSearch.noneSelected}</p> : null}
        </fieldset>
      </form>

      <div className="flex min-h-7 items-center gap-3">
        <output aria-live="polite" className="block text-sm text-ink-sub">
          {planned > 0 ? locale.databaseSearch.progress(outcomes.length, planned) : null}
          {stopped ? ` — ${locale.databaseSearch.stopped}` : null}
        </output>
        {running ? (
          <Button
            type="button"
            size="sm"
            onClick={() => {
              currentRun.current += 1
              setRunning(false)
              setStopped(true)
            }}
          >
            {locale.databaseSearch.stop}
          </Button>
        ) : null}
      </div>

      {outcomes.length > 0 ? (
        <>
          <p className="text-sm text-ink">{locale.databaseSearch.summary(totalRows, matchedTables, lowerBound)}</p>
          <Table aria-label={locale.databaseSearch.title}>
            <thead>
              <tr>
                <Th>{locale.databaseSearch.table}</Th>
                <Th className="text-right">{locale.databaseSearch.matches}</Th>
                <Th>{locale.databaseSearch.actions}</Th>
              </tr>
            </thead>
            <tbody>
              {outcomes.map((o) => (
                <Tr key={o.table}>
                  <Td>{o.table}</Td>
                  {'error' in o ? (
                    <Td colSpan={2}>
                      <ErrorBox error={o.error} />
                    </Td>
                  ) : o.result.columns.length === 0 ? (
                    <Td colSpan={2} className="text-ink-sub">
                      {locale.databaseSearch.noColumns}
                    </Td>
                  ) : (
                    <>
                      <Td className="text-right tabular-nums">
                        {locale.databaseSearch.rows(o.result.total, o.result.count === 'lower_bound')}
                      </Td>
                      <Td>
                        {o.result.total > 0 ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={locale.databaseSearch.openInSqlLabel(o.table)}
                            onClick={() => openInSql(o.result.sql)}
                          >
                            {locale.databaseSearch.openInSql}
                          </Button>
                        ) : null}
                      </Td>
                    </>
                  )}
                </Tr>
              ))}
            </tbody>
          </Table>
        </>
      ) : running ? (
        <p className="text-sm text-ink-sub">{locale.databaseSearch.searching}</p>
      ) : null}
    </section>
  )
}
