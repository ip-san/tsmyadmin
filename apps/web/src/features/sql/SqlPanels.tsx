import type { SavedQuery, SharedQuery } from '@tsmyadmin/shared'
import { type ReactNode, useState } from 'react'
import { NamedListPanel } from '@/components/panels/NamedListPanel.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Input } from '@/components/ui/Field.tsx'
import { locale, numberLocale } from '@/config/locale.ts'
import type { HistoryEntry } from './history.ts'

function Panel({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <details className="rounded border border-line">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink">
        {title} ({count})
      </summary>
      <div className="max-h-64 overflow-auto border-t border-line">{children}</div>
    </details>
  )
}

const ROW = 'flex items-start gap-2 border-b border-line px-3 py-1.5 text-xs'
const EMPTY = 'px-3 py-2 text-xs text-ink-sub'

export function HistoryPanel({
  entries,
  onLoad,
  onClear,
  onBookmark,
  onServer = false,
}: {
  entries: HistoryEntry[]
  onLoad: (sql: string) => void
  onClear: () => void
  /** Keeps a run's statement as a bookmark (under a name made from its start). */
  onBookmark?: (sql: string) => void
  /** The list is kept with the account (else in this browser). */
  onServer?: boolean
}) {
  const [term, setTerm] = useState('')
  const [failedOnly, setFailedOnly] = useState(false)
  const needle = term.trim().toLowerCase()
  const shown = entries.filter((e) => (!failedOnly || !e.ok) && (needle === '' || e.sql.toLowerCase().includes(needle)))
  return (
    <Panel title={locale.sql.history} count={entries.length}>
      {entries.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-2">
          <Input
            type="search"
            aria-label={locale.sql.historySearch}
            placeholder={locale.sql.historySearch}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            className="max-w-xs py-1 text-xs"
          />
          <label className="flex items-center gap-1 text-xs text-ink-sub">
            <input type="checkbox" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} />
            {locale.sql.historyFailedOnly}
          </label>
          <span className="text-xs text-ink-sub" role="status">
            {term.trim() !== '' || failedOnly ? locale.sql.historyMatches(shown.length) : ''}
          </span>
          <span className="ml-auto text-xs text-ink-sub">
            {onServer ? locale.sql.historyOnServer : locale.sql.historyInBrowser}
          </span>
        </div>
      ) : null}
      {entries.length === 0 ? (
        <p className={EMPTY}>{locale.sql.noHistory}</p>
      ) : (
        <ul>
          {shown.map((e) => (
            <li key={`${e.at}-${e.sql}`} className={ROW}>
              <span
                className={e.ok ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}
                title={e.ok ? locale.sql.ok : locale.sql.failed}
                aria-label={e.ok ? locale.sql.ok : locale.sql.failed}
                role="img"
              >
                {e.ok ? '✓' : '✗'}
              </span>
              <span className="text-ink-sub">
                {new Date(e.at).toLocaleTimeString(numberLocale, { hour12: false })}
                {e.db ? ` · ${locale.sql.historyDb(e.db)}` : ''}
              </span>
              <code className="min-w-0 flex-1 truncate font-mono" title={e.sql}>
                {e.sql}
              </code>
              <Button size="sm" onClick={() => onLoad(e.sql)}>
                {locale.sql.load}
              </Button>
              {onBookmark ? (
                <Button size="sm" onClick={() => onBookmark(e.sql)}>
                  {locale.sql.bookmark}
                </Button>
              ) : null}
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
    </Panel>
  )
}

/** Bookmarked queries: save the editor text under a name, load or delete it later. */
export function SavedQueriesPanel({
  entries,
  currentSql,
  savedOnServer = false,
  error = null,
  onSave,
  onLoad,
  onDelete,
}: {
  entries: SavedQuery[]
  /** Whether the list is kept with the account or only in this browser. */
  savedOnServer?: boolean
  /** A failed read or write of the server-side list (nothing is shown when null). */
  error?: Error | null
  currentSql: string
  onSave: (name: string) => void
  onLoad: (sql: string) => void
  onDelete: (entry: { id: string; name: string }) => void
}) {
  return (
    <NamedListPanel
      title={locale.sql.saved}
      nameLabel={locale.sql.savedName}
      entries={entries.map((q) => ({ id: q.id, name: q.name, summary: q.sql, payload: q.sql }))}
      note={savedOnServer ? locale.sql.savedOnServer : locale.sql.savedInBrowser}
      error={error}
      saveTitle={locale.sql.saveQuery}
      canSave={currentSql.trim().length > 0}
      onSave={onSave}
      onLoad={(entry) => onLoad(entry.payload ?? entry.summary)}
      loadLabel={locale.sql.load}
      deleteLabel={locale.sql.deleteSaved}
      onDelete={(entry) => onDelete(entry)}
      empty={locale.sql.noSaved}
    />
  )
}

/** Statements bookmarked for every account of the server (only the account that saved one can remove it). */
export function SharedQueriesPanel({
  entries,
  error = null,
  currentSql,
  onSave,
  onLoad,
  onDelete,
}: {
  entries: SharedQuery[]
  error?: Error | null
  currentSql: string
  onSave: (name: string) => void
  onLoad: (sql: string) => void
  onDelete: (entry: { id: string; name: string }) => void
}) {
  return (
    <NamedListPanel
      title={locale.sql.shared}
      nameLabel={locale.sql.sharedName}
      entries={entries.map((q) => ({ id: q.id, name: q.name, summary: `${q.by}: ${q.sql}`, payload: q.sql }))}
      note={locale.sql.sharedNote}
      error={error}
      saveTitle={locale.sql.saveShared}
      saveLabel={locale.sql.share}
      canSave={currentSql.trim().length > 0}
      onSave={onSave}
      onLoad={(entry) => onLoad(entry.payload ?? '')}
      loadLabel={locale.sql.load}
      deleteLabel={locale.sql.deleteSaved}
      onDelete={onDelete}
      empty={locale.sql.noShared}
    />
  )
}
