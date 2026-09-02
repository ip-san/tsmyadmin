import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Dialect, StatementResult } from '@tsmyadmin/shared'
import { SQL_MAX_ROWS_DEFAULT } from '@tsmyadmin/shared'
import { Play, Square } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { mutations } from '@/lib/queries.ts'
import { streamSql } from '@/lib/sql-stream.ts'
import { clearHistory, type HistoryEntry, loadHistory, pushHistory } from './history.ts'
import { ResultsView } from './ResultsView.tsx'
import { SqlEditor } from './SqlEditor.tsx'
import { HistoryPanel, SavedQueriesPanel } from './SqlPanels.tsx'
import { deleteSaved, loadSaved, type SavedQuery, saveQuery } from './saved-queries.ts'
import { isSingleStatement, stripTrailingSemicolons } from './statement.ts'

const MAX_ROWS_OPTIONS = [100, 1000, 10_000]

export interface SqlConsoleProps {
  db: string
  schema?: string | undefined
  dialect: Dialect
  initialSql?: string
  completion: Record<string, string[]>
}

export function SqlConsole({ db, schema, dialect, initialSql = '', completion }: SqlConsoleProps) {
  const [text, setText] = useState(initialSql)
  const [maxRows, setMaxRows] = useState(SQL_MAX_ROWS_DEFAULT)
  const [stopOnError, setStopOnError] = useState(true)
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory(dialect))
  const [saved, setSaved] = useState<SavedQuery[]>(() => loadSaved(dialect))
  const [results, setResults] = useState<StatementResult[] | null>(null)
  const queryClient = useQueryClient()
  const queryId = useRef<string | null>(null)
  const cancel = useMutation({ mutationFn: (id: string) => mutations.cancelSql(db, id) })
  const run = useMutation({
    // Statement results are appended to the view as the server streams them (NDJSON), so long scripts
    // show progress instead of one big response at the end.
    mutationFn: async (sql: string) => {
      queryId.current = crypto.randomUUID()
      const collected: StatementResult[] = []
      setResults([])
      for await (const event of streamSql(db, {
        sql,
        ...(schema ? { schema } : {}),
        maxRows,
        stopOnError,
        queryId: queryId.current,
      })) {
        if (event.type === 'result') {
          collected[event.index] = event.result
          setResults([...collected])
        } else if (event.type === 'fatal') {
          throw new Error(event.message)
        }
      }
      return collected
    },
    onSettled: () => {
      queryId.current = null
    },
    onSuccess: async (res, sql) => {
      setHistory(pushHistory(dialect, { sql, at: Date.now(), ok: res.every((r) => r.kind !== 'error') }))
      if (res.some((r) => r.kind !== 'rows')) {
        await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'session' })
      }
    },
  })
  const execute = () => {
    if (text.trim().length === 0 || run.isPending) return
    run.mutate(text)
  }
  const explain = () => {
    if (!isSingleStatement(text) || run.isPending) return
    run.mutate(`EXPLAIN ${stripTrailingSemicolons(text)}`)
  }

  return (
    <div className="space-y-3">
      <SqlEditor value={text} onChange={setText} onRun={execute} dialect={dialect} schema={completion} />
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Button
          variant="primary"
          onClick={execute}
          disabled={run.isPending || text.trim().length === 0}
          title={locale.sql.runHint}
        >
          <Play className="size-4" aria-hidden />
          {run.isPending ? locale.sql.running : locale.sql.run}
        </Button>
        {run.isPending ? (
          <Button
            variant="danger"
            onClick={() => queryId.current && cancel.mutate(queryId.current)}
            disabled={cancel.isPending}
            aria-label={locale.sql.cancel}
          >
            <Square className="size-4" aria-hidden />
            {cancel.isPending ? locale.sql.cancelling : locale.sql.cancel}
          </Button>
        ) : null}
        <Button onClick={explain} disabled={run.isPending || !isSingleStatement(text)} title={locale.sql.explainHint}>
          {locale.sql.explain}
        </Button>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">{locale.sql.runHint}</span>
        <label
          htmlFor="sql-max-rows"
          className="ml-auto flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-300"
        >
          {locale.sql.maxRows}
          <Select
            id="sql-max-rows"
            value={maxRows}
            onChange={(e) => setMaxRows(Number(e.target.value))}
            className="w-auto py-1"
          >
            {MAX_ROWS_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString('ja-JP')}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-300">
          <input type="checkbox" checked={stopOnError} onChange={(e) => setStopOnError(e.target.checked)} />
          {locale.sql.stopOnError}
        </label>
      </div>
      {run.isError ? <ErrorBox error={run.error} /> : null}
      {/* Screen readers hear the outcome; results themselves stream into the DOM below without announcements. */}
      <output aria-live="polite" className="sr-only">
        {run.isPending
          ? locale.sql.running
          : run.isSuccess && results
            ? locale.sql.completed(results.length, results.filter((r) => r.kind === 'error').length)
            : ''}
      </output>
      {results ? <ResultsView results={results} maxRows={maxRows} /> : null}
      <SavedQueriesPanel
        entries={saved}
        currentSql={text}
        onSave={(name) => setSaved(saveQuery(dialect, { name, sql: text, at: Date.now() }))}
        onLoad={setText}
        onDelete={(name) => setSaved(deleteSaved(dialect, name))}
      />
      <HistoryPanel
        entries={history}
        onLoad={setText}
        onClear={() => {
          clearHistory(dialect)
          setHistory([])
        }}
      />
    </div>
  )
}
