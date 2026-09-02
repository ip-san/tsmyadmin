import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Dialect, StatementResult } from '@tsmyadmin/shared'
import { SQL_MAX_ROWS_DEFAULT } from '@tsmyadmin/shared'
import { Play, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice } from '@/components/ui/Feedback.tsx'
import { Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { ApiError } from '@/lib/api.ts'
import { readPreference, writePreference } from '@/lib/preferences.ts'
import { mutations } from '@/lib/queries.ts'
import { streamSql } from '@/lib/sql-stream.ts'
import { clearHistory, type HistoryEntry, loadHistory, pushHistory } from './history.ts'
import { ResultsView } from './ResultsView.tsx'
import { SqlEditor } from './SqlEditor.tsx'
import { HistoryPanel, SavedQueriesPanel } from './SqlPanels.tsx'
import { deleteSaved, loadSaved, type SavedQuery, saveQuery } from './saved-queries.ts'
import { isSingleStatement, stripTrailingSemicolons } from './statement.ts'

const MAX_ROWS_OPTIONS = [100, 1000, 10_000]

function sessionStore() {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

export interface SqlConsoleProps {
  db: string
  schema?: string | undefined
  dialect: Dialect
  initialSql?: string
  completion: Record<string, string[]>
  /** Distinguishes consoles that share a database: 'server' | 'db' | `table:<name>`. */
  draftId: string
}

export function SqlConsole({ db, schema, dialect, initialSql = '', completion, draftId }: SqlConsoleProps) {
  // Unsent editor text survives tab switches and a session-expiry round trip (per console, this browser tab).
  const key = `sql.draft.${dialect}.${db}.${schema ?? ''}.${draftId}`
  const [text, setTextState] = useState(() => readPreference(key, z.string(), initialSql, sessionStore()))
  // Draft writes are debounced: a multi-MB pasted script would otherwise be serialised on every keystroke.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestText = useRef(text)
  const setText = (next: string) => {
    setTextState(next)
    latestText.current = next
    if (pending.current !== null) clearTimeout(pending.current)
    pending.current = setTimeout(() => {
      pending.current = null
      writePreference(key, latestText.current, sessionStore())
    }, 300)
  }
  useEffect(() => {
    // Flush a pending draft when the console unmounts or the document is left / reloaded.
    const flushDraft = () => {
      if (pending.current === null) return
      clearTimeout(pending.current)
      pending.current = null
      writePreference(key, latestText.current, sessionStore())
    }
    window.addEventListener('pagehide', flushDraft)
    return () => {
      window.removeEventListener('pagehide', flushDraft)
      flushDraft()
    }
  }, [key])
  const [maxRows, setMaxRows] = useState(SQL_MAX_ROWS_DEFAULT)
  const [stopOnError, setStopOnError] = useState(true)
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory(dialect))
  const [saved, setSaved] = useState<SavedQuery[]>(() => loadSaved(dialect))
  const [results, setResults] = useState<StatementResult[] | null>(null)
  const queryClient = useQueryClient()
  const queryId = useRef<string | null>(null)
  // Leaving the page aborts the stream, which makes the server cancel the running statement.
  const abort = useRef(new AbortController())
  useEffect(() => {
    const controller = abort.current
    return () => controller.abort()
  }, [])
  const cancel = useMutation({ mutationFn: (id: string) => mutations.cancelSql(db, id) })
  const run = useMutation({
    // Statement results are appended to the view as the server streams them (NDJSON), so long scripts
    // show progress instead of one big response at the end.
    mutationFn: async (sql: string) => {
      queryId.current = crypto.randomUUID()
      const collected: StatementResult[] = []
      setResults([])
      // Results are flushed to React at most once per animation frame: a pasted dump can be thousands of
      // statements, and one render per statement would be quadratic in the results view.
      let flush: number | null = null
      const scheduleFlush = () => {
        if (flush !== null) return
        flush = requestAnimationFrame(() => {
          flush = null
          setResults([...collected])
        })
      }
      try {
        for await (const event of streamSql(
          db,
          {
            sql,
            ...(schema ? { schema } : {}),
            maxRows,
            stopOnError,
            queryId: queryId.current,
          },
          abort.current.signal
        )) {
          if (event.type === 'result') {
            collected[event.index] = event.result
            scheduleFlush()
          } else if (event.type === 'fatal') {
            // Carries the API error code so an AUTH/UNAUTHENTICATED fatal redirects like any other 401.
            throw new ApiError(event.code === 'UNAUTHENTICATED' || event.code === 'AUTH_FAILED' ? 401 : 500, {
              code: event.code ?? 'INTERNAL',
              message: event.message,
              ...(event.nativeCode ? { nativeCode: event.nativeCode } : {}),
            })
          }
        }
      } finally {
        if (flush !== null) cancelAnimationFrame(flush)
        setResults([...collected])
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
  const cancelled = cancel.isSuccess && cancel.data.cancelled && !run.isPending
  const execute = () => {
    if (text.trim().length === 0 || run.isPending) return
    cancel.reset()
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
      {/* One always-mounted live region: running → completed / cancelled (visible as a notice when cancelled). */}
      <output aria-live="polite" className={cancelled ? 'block' : 'sr-only'}>
        {cancelled ? (
          <Notice>{locale.sql.cancelled}</Notice>
        ) : run.isPending ? (
          locale.sql.running
        ) : run.isSuccess && results ? (
          locale.sql.completed(results.length, results.filter((r) => r.kind === 'error').length)
        ) : (
          ''
        )}
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
