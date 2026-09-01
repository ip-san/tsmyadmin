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
import { clearHistory, type HistoryEntry, loadHistory, pushHistory } from './history.ts'
import { ResultsView } from './ResultsView.tsx'
import { SqlEditor } from './SqlEditor.tsx'

const MAX_ROWS_OPTIONS = [100, 1000, 10_000]

export interface SqlConsoleProps {
  db: string
  schema?: string | undefined
  dialect: Dialect
  initialSql?: string
  completion: Record<string, string[]>
}

function HistoryPanel({
  entries,
  onLoad,
  onClear,
}: {
  entries: HistoryEntry[]
  onLoad: (sql: string) => void
  onClear: () => void
}) {
  return (
    <details className="rounded border border-zinc-200 dark:border-zinc-700">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-200">
        {locale.sql.history} ({entries.length})
      </summary>
      <div className="max-h-64 overflow-auto border-t border-zinc-200 dark:border-zinc-700">
        {entries.length === 0 ? (
          <p className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">{locale.sql.noHistory}</p>
        ) : (
          <ul>
            {entries.map((e) => (
              <li
                key={`${e.at}-${e.sql}`}
                className="flex items-start gap-2 border-b border-zinc-100 px-3 py-1.5 text-xs dark:border-zinc-800"
              >
                <span
                  className={e.ok ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}
                  title={e.ok ? locale.sql.ok : locale.sql.failed}
                >
                  {e.ok ? '✓' : '✗'}
                </span>
                <span className="text-zinc-400 dark:text-zinc-500">{new Date(e.at).toLocaleTimeString('ja-JP')}</span>
                <code className="min-w-0 flex-1 truncate font-mono" title={e.sql}>
                  {e.sql}
                </code>
                <Button size="sm" onClick={() => onLoad(e.sql)}>
                  {locale.sql.load}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {entries.length > 0 ? (
          <div className="px-3 py-2">
            <Button size="sm" onClick={onClear}>
              {locale.sql.clearHistory}
            </Button>
          </div>
        ) : null}
      </div>
    </details>
  )
}

export function SqlConsole({ db, schema, dialect, initialSql = '', completion }: SqlConsoleProps) {
  const [text, setText] = useState(initialSql)
  const [maxRows, setMaxRows] = useState(SQL_MAX_ROWS_DEFAULT)
  const [stopOnError, setStopOnError] = useState(true)
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory(dialect))
  const [results, setResults] = useState<StatementResult[] | null>(null)
  const queryClient = useQueryClient()
  const queryId = useRef<string | null>(null)
  const cancel = useMutation({ mutationFn: (id: string) => mutations.cancelSql(db, id) })
  const run = useMutation({
    mutationFn: () => {
      queryId.current = crypto.randomUUID()
      return mutations.executeSql(db, {
        sql: text,
        ...(schema ? { schema } : {}),
        maxRows,
        stopOnError,
        queryId: queryId.current,
      })
    },
    onSettled: () => {
      queryId.current = null
    },
    onSuccess: async (res) => {
      setResults(res)
      setHistory(pushHistory(dialect, { sql: text, at: Date.now(), ok: res.every((r) => r.kind !== 'error') }))
      if (res.some((r) => r.kind !== 'rows')) {
        await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'session' })
      }
    },
  })
  const execute = () => {
    if (text.trim().length === 0 || run.isPending) return
    run.mutate()
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
      {results ? <ResultsView results={results} maxRows={maxRows} /> : null}
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
