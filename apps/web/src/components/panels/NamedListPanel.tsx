import type { ReactNode } from 'react'
import { useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'

export interface NamedEntry {
  id: string
  name: string
  /** One line describing what is stored, shown beside the name (and in full on hover). */
  summary: string
}

/**
 * A collapsible list of things saved under a name — bookmarked statements, export templates — with the form that
 * saves the current one. Where the list is kept (with the account or in this browser) is the caller's to say.
 */
export function NamedListPanel({
  title,
  nameLabel,
  entries,
  note,
  error = null,
  saveTitle,
  canSave,
  onSave,
  onLoad,
  loadLabel,
  deleteLabel,
  onDelete,
  empty,
  children,
}: {
  title: string
  /** Label of the name field (what this list calls one of its entries). */
  nameLabel: string
  entries: NamedEntry[]
  note: string
  /** A failed read or write of the server-side list (nothing is shown when null). */
  error?: Error | null
  saveTitle: string
  canSave: boolean
  onSave: (name: string) => void
  onLoad: (entry: NamedEntry) => void
  loadLabel: string
  deleteLabel: (name: string) => string
  onDelete: (entry: NamedEntry) => void
  empty: string
  /** Extra controls under the save form (the export form puts what will be saved there). */
  children?: ReactNode
}) {
  const [name, setName] = useState('')
  const ready = name.trim().length > 0 && canSave
  return (
    <details className="rounded border border-line">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink">
        {title} ({entries.length})
      </summary>
      <div className="max-h-64 overflow-auto border-t border-line">
        <form
          className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!ready) return
            onSave(name.trim())
            setName('')
          }}
        >
          <Input
            aria-label={nameLabel}
            placeholder={nameLabel}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="max-w-xs py-1 text-xs"
          />
          <Button size="sm" type="submit" disabled={!ready} title={saveTitle}>
            {locale.sql.save}
          </Button>
          {children}
        </form>
        <p className="px-3 pt-2 text-xs text-ink-sub">{note}</p>
        {error ? (
          <div className="px-3 pt-2">
            <ErrorBox error={error} />
          </div>
        ) : null}
        {entries.length === 0 ? (
          <p className="px-3 py-2 text-xs text-ink-sub">{empty}</p>
        ) : (
          <ul>
            {entries.map((entry) => (
              <li
                key={entry.id || entry.name}
                className="flex items-start gap-2 border-b border-line px-3 py-1.5 text-xs"
              >
                <span className="font-medium">{entry.name}</span>
                <code className="min-w-0 flex-1 truncate font-mono text-ink-sub" title={entry.summary}>
                  {entry.summary}
                </code>
                <Button size="sm" onClick={() => onLoad(entry)}>
                  {loadLabel}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onDelete(entry)} aria-label={deleteLabel(entry.name)}>
                  ×
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  )
}
