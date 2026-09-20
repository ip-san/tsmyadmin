import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import type { Dialect, StatementResult } from '@tsmyadmin/shared'
import { SQL_MAX_ROWS_DEFAULT } from '@tsmyadmin/shared'
import { Play, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { SqlCodeDialog } from '@/components/sql/SqlCodeDialog.tsx'
import type { StatementHandlers } from '@/components/sql/StatementActions.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { ApiError } from '@/lib/api.ts'
import { consoleDraftKey } from '@/lib/console-draft.ts'
import { readPreference } from '@/lib/preferences.ts'
import { mutations } from '@/lib/queries.ts'
import { bookmarkName } from '@/lib/saved-queries.ts'
import { formatSql } from '@/lib/sql-format.ts'
import { DEFAULT_RUN_OPTIONS, prepareScript, type RunOptions } from '@/lib/sql-prepare.ts'
import { streamSql } from '@/lib/sql-stream.ts'
import { newQueryId } from '@/lib/uuid.ts'
import { MaxRowsSelect, ProfileOption, SAFE_MODE_PREF, SafeModeOption } from './ConsoleOptions.tsx'
import { ResultsView } from './ResultsView.tsx'
import { RunOptionsPanel } from './RunOptionsPanel.tsx'
import { SafeModeDialog } from './SafeModeDialog.tsx'
import { SqlEditor } from './SqlEditor.tsx'
import { HistoryPanel, SavedQueriesPanel, SharedQueriesPanel } from './SqlPanels.tsx'
import { isSingleStatement, stripTrailingSemicolons, unboundedWrites } from './statement.ts'
import { useConsoleDraft } from './use-console-draft.ts'
import { useConsoleLists } from './use-console-lists.ts'
import { expandVariables } from './variables.ts'

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
  // History and bookmarks belong to a server: two MySQL hosts opened from the same browser keep separate lists.
  const { session } = useRouteContext({ from: '/_app' })
  const scope = `${dialect}.${session.host}.${session.port}`
  // Unsent editor text survives tab switches and a session-expiry round trip (per console, this browser tab).
  // The server console is one editor whose target database can change: its draft is not keyed by database.
  const key = consoleDraftKey(scope, db, schema, draftId)
  const [text, setText] = useConsoleDraft(key, initialSql)
  const [maxRows, setMaxRows] = useState(SQL_MAX_ROWS_DEFAULT)
  const [stopOnError, setStopOnError] = useState(true)
  const [profile, setProfile] = useState(false)
  const [runOptions, setRunOptions] = useState<RunOptions>(DEFAULT_RUN_OPTIONS)
  const lists = useConsoleLists({
    scope,
    db,
    schema,
    dialect,
    user: session.user,
    host: session.host,
    onServer: session.savedQueries === 'server',
  })
  const { onServer, history, saved, shared, bookmarkContext } = lists
  const [results, setResults] = useState<StatementResult[] | null>(null)
  const [safeMode, setSafeMode] = useState(() => readPreference(SAFE_MODE_PREF, z.boolean(), true))
  /** Statement kinds waiting for confirmation because they would change every row (empty = no dialog). */
  const [confirming, setConfirming] = useState<string[]>([])
  // The script left a transaction open; the server rolled it back when the run finished.
  const [openTransaction, setOpenTransaction] = useState(false)
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
    mutationFn: async ({ script: sql }: { script: string; shown: string }) => {
      queryId.current = newQueryId()
      const collected: StatementResult[] = []
      setResults([])
      setOpenTransaction(false)
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
            profile,
            queryId: queryId.current,
          },
          abort.current.signal
        )) {
          if (event.type === 'result') {
            collected[event.index] = event.result
            scheduleFlush()
          } else if (event.type === 'done') {
            setOpenTransaction(event.openTransaction)
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
    onSuccess: async (res, { shown: sql }) => {
      const entry = { sql, at: Date.now(), ok: res.every((r) => r.kind !== 'error'), db }
      lists.record(entry)
      if (res.some((r) => r.kind !== 'rows')) {
        await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'session' })
      }
    },
  })
  const cancelled = cancel.isSuccess && cancel.data.cancelled && !run.isPending
  const send = () => {
    cancel.reset()
    run.mutate({ script: prepareScript(text, dialect, runOptions), shown: text })
  }
  const execute = () => {
    if (text.trim().length === 0 || run.isPending) return
    // An UPDATE / DELETE with no WHERE changes every row. The check reads the text, so it is advisory: it can
    // ask once too often, never too seldom, and the user can turn it off.
    const unbounded = safeMode ? unboundedWrites(text) : []
    if (unbounded.length > 0) {
      setConfirming(unbounded)
      return
    }
    send()
  }
  const explainSql = (sql: string) => {
    if (!isSingleStatement(sql) || run.isPending) return
    const explained = `EXPLAIN ${stripTrailingSemicolons(sql)}`
    run.mutate({ script: prepareScript(explained, dialect, runOptions), shown: explained })
  }
  const explain = () => explainSql(text)
  // What to do with a statement that ran. Held in a ref behind stable functions: the results are memoised, and a
  // new function on every render would redo them all each time a streamed result arrives.
  const [codeOf, setCodeOf] = useState<string | null>(null)
  const latest = useRef<StatementHandlers | null>(null)
  latest.current = {
    edit: setText,
    rerun: (sql) => {
      if (run.isPending) return
      // The same guard as Run: a statement that changes every row is asked about first (its text goes to the editor,
      // which is what the confirmation runs).
      const unbounded = safeMode ? unboundedWrites(sql) : []
      if (unbounded.length > 0) {
        setText(sql)
        setConfirming(unbounded)
        return
      }
      cancel.reset()
      run.mutate({ script: prepareScript(sql, dialect, runOptions), shown: sql })
    },
    explain: explainSql,
    code: setCodeOf,
  }
  const [handlers] = useState<StatementHandlers>(() => ({
    edit: (sql) => latest.current?.edit(sql),
    rerun: (sql) => latest.current?.rerun(sql),
    explain: (sql) => latest.current?.explain(sql),
    code: (sql) => latest.current?.code(sql),
  }))

  return (
    <div className="space-y-3">
      <div className="print:hidden">
        <SqlEditor value={text} onChange={setText} onRun={execute} dialect={dialect} schema={completion} />
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm print:hidden">
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
        <Button
          onClick={() => setText(formatSql(text))}
          disabled={run.isPending || text.trim().length === 0}
          title={locale.sql.formatHint}
        >
          {locale.sql.format}
        </Button>
        <span className="text-xs text-ink-sub">{locale.sql.runHint}</span>
        <MaxRowsSelect value={maxRows} onChange={setMaxRows} />
        <label className="flex items-center gap-1 text-xs text-ink-sub">
          <input type="checkbox" checked={stopOnError} onChange={(e) => setStopOnError(e.target.checked)} />
          {locale.sql.stopOnError}
        </label>
        {dialect === 'mysql' ? <ProfileOption checked={profile} onChange={setProfile} /> : null}
        <SafeModeOption checked={safeMode} onChange={setSafeMode} />
      </div>
      <RunOptionsPanel dialect={dialect} text={text} options={runOptions} onChange={setRunOptions} />
      <SafeModeDialog
        kinds={confirming}
        onCancel={() => setConfirming([])}
        onRun={() => {
          setConfirming([])
          send()
        }}
      />
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
      {/* Every run is autocommitted on its own connection: say so rather than losing the work silently. */}
      {openTransaction && !run.isPending ? <Notice role="status">{locale.sql.openTransaction}</Notice> : null}
      {/* Bookmarks and history (each collapsible) sit above the results: a 1,000-row result must not bury them. */}
      <div className="space-y-3 print:hidden">
        <SavedQueriesPanel
          entries={saved.entries}
          savedOnServer={saved.onServer}
          error={saved.error}
          currentSql={text}
          onSave={(name) => saved.save(name, text)}
          onLoad={(sql) => setText(expandVariables(sql, bookmarkContext))}
          onDelete={saved.remove}
        />
        {onServer ? (
          <SharedQueriesPanel
            entries={shared.entries}
            error={shared.error}
            currentSql={text}
            onSave={(name) => shared.save(name, text)}
            onLoad={(sql) => setText(expandVariables(sql, bookmarkContext))}
            onDelete={shared.remove}
          />
        ) : null}
        <HistoryPanel
          entries={history}
          onServer={onServer}
          onLoad={setText}
          onBookmark={(sql) => saved.save(bookmarkName(sql), sql)}
          onClear={lists.clear}
        />
      </div>
      {results ? (
        <ResultsView results={results} maxRows={maxRows} viewTarget={{ db, schema }} handlers={handlers} />
      ) : null}
      <SqlCodeDialog sql={codeOf} onClose={() => setCodeOf(null)} />
    </div>
  )
}
