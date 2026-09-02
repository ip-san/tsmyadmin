import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import type { HistoryEntry } from './history.ts'
import type { SavedQuery } from './saved-queries.ts'

function Panel({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <details className="rounded border border-zinc-200 dark:border-zinc-700">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-200">
        {title} ({count})
      </summary>
      <div className="max-h-64 overflow-auto border-t border-zinc-200 dark:border-zinc-700">{children}</div>
    </details>
  )
}

const ROW = 'flex items-start gap-2 border-b border-zinc-100 px-3 py-1.5 text-xs dark:border-zinc-800'
const EMPTY = 'px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400'

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
              <span className="text-zinc-500 dark:text-zinc-400">{new Date(e.at).toLocaleTimeString('ja-JP')}</span>
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
  onSave,
  onLoad,
  onDelete,
}: {
  entries: SavedQuery[]
  currentSql: string
  onSave: (name: string) => void
  onLoad: (sql: string) => void
  onDelete: (name: string) => void
}) {
  const [name, setName] = useState('')
  const canSave = name.trim().length > 0 && currentSql.trim().length > 0
  return (
    <Panel title={locale.sql.saved} count={entries.length}>
      <form
        className="flex items-center gap-2 border-b border-zinc-100 px-3 py-2 dark:border-zinc-800"
        onSubmit={(e) => {
          e.preventDefault()
          if (!canSave) return
          onSave(name.trim())
          setName('')
        }}
      >
        <Input
          aria-label={locale.sql.savedName}
          placeholder={locale.sql.savedName}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="max-w-xs py-1 text-xs"
        />
        <Button size="sm" type="submit" disabled={!canSave} title={locale.sql.saveQuery}>
          {locale.sql.save}
        </Button>
      </form>
      {entries.length === 0 ? (
        <p className={EMPTY}>{locale.sql.noSaved}</p>
      ) : (
        <ul>
          {entries.map((q) => (
            <li key={q.name} className={ROW}>
              <span className="font-medium">{q.name}</span>
              <code className="min-w-0 flex-1 truncate font-mono text-zinc-500 dark:text-zinc-400" title={q.sql}>
                {q.sql}
              </code>
              <Button size="sm" onClick={() => onLoad(q.sql)}>
                {locale.sql.load}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onDelete(q.name)}
                aria-label={locale.sql.deleteSaved(q.name)}
              >
                ×
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
