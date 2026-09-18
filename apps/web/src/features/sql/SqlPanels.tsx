import type { SavedQuery } from '@tsmyadmin/shared'
import type { ReactNode } from 'react'
import { NamedListPanel } from '@/components/panels/NamedListPanel.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale.ts'
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
}: {
  entries: HistoryEntry[]
  onLoad: (sql: string) => void
  onClear: () => void
}) {
  return (
    <Panel title={locale.sql.history} count={entries.length}>
      {entries.length === 0 ? (
        <p className={EMPTY}>{locale.sql.noHistory}</p>
      ) : (
        <ul>
          {entries.map((e) => (
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
                {new Date(e.at).toLocaleTimeString('ja-JP')}
                {e.db ? ` · ${locale.sql.historyDb(e.db)}` : ''}
              </span>
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
      entries={entries.map((q) => ({ id: q.id, name: q.name, summary: q.sql }))}
      note={savedOnServer ? locale.sql.savedOnServer : locale.sql.savedInBrowser}
      error={error}
      saveTitle={locale.sql.saveQuery}
      canSave={currentSql.trim().length > 0}
      onSave={onSave}
      onLoad={(entry) => onLoad(entries.find((q) => q.id === entry.id && q.name === entry.name)?.sql ?? entry.summary)}
      loadLabel={locale.sql.load}
      deleteLabel={locale.sql.deleteSaved}
      onDelete={(entry) => onDelete(entry)}
      empty={locale.sql.noSaved}
    />
  )
}
