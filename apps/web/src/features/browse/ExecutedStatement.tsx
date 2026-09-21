import { useRouteContext } from '@tanstack/react-router'
import type { BrowseStatement, Cell } from '@tsmyadmin/shared'
import { useState } from 'react'
import { ProfileView } from '@/components/results/ProfileView.tsx'
import { SqlCodeDialog } from '@/components/sql/SqlCodeDialog.tsx'
import { StatementActions } from '@/components/sql/StatementActions.tsx'
import { locale } from '@/config/locale.ts'
import { useOpenInDatabaseConsole } from '@/lib/open-in-console.ts'
import type { TableRef } from '@/lib/queries.ts'
import { bookmarkName } from '@/lib/saved-queries.ts'
import { explainStatement } from '@/lib/sql-text.ts'
import { useSavedQueries } from '@/lib/use-saved-queries.ts'

/** A bound value as text for reading, not for pasting back: strings are shown as they are, only marked. */
export function formatBoundValue(value: Cell): string {
  if (value === null) return 'NULL'
  if (typeof value === 'string') return `'${value}'`
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if ('$bin' in value) return locale.browse.binaryValue
  return `'${value.$text}…'`
}

/**
 * The statement behind the page, as phpMyAdmin shows it above every result. It is the statement that ran, with
 * its placeholders; the bound values are listed beneath rather than spliced in, so nothing here looks runnable
 * that is not exactly what was sent.
 */
export function ExecutedStatement({
  statement,
  tableRef,
  onRefresh,
}: {
  statement: BrowseStatement
  tableRef: TableRef
  /** Runs the statement again (the page's rows are read again). */
  onRefresh: () => void
}) {
  const { session } = useRouteContext({ from: '/_app' })
  const openInSql = useOpenInDatabaseConsole(tableRef.db, tableRef.schema)
  const saved = useSavedQueries(`${session.dialect}.${session.host}.${session.port}`, session.savedQueries === 'server')
  const [codeOf, setCodeOf] = useState<string | null>(null)
  const [bookmarked, setBookmarked] = useState(false)
  return (
    <figure className="rounded-control border border-line bg-surface-sub px-3 py-2 text-xs">
      <figcaption className="mb-1 flex items-baseline justify-between gap-2 text-ink-sub">
        <span>{locale.browse.executedSql}</span>
        {/* Fixed width and tabular digits: the time changes on every page and must not shift the caption. */}
        <span className="min-w-24 text-right tabular-nums">{locale.browse.queryTime(statement.durationMs)}</span>
      </figcaption>
      <pre className="whitespace-pre-wrap break-all font-mono text-ink">
        <code>{statement.sql}</code>
      </pre>
      {statement.params.length > 0 ? (
        <p className="mt-1 text-ink-sub">
          {locale.browse.boundValues}{' '}
          <code className="font-mono text-ink">{statement.params.map(formatBoundValue).join(', ')}</code>
        </p>
      ) : null}
      <ProfileView profile={statement.profile} />
      {/* The actions work on the statement with its values written in: it is the one that can be edited and run. */}
      <div className="mt-2">
        <StatementActions
          sql={statement.literal}
          index={0}
          handlers={{
            edit: openInSql,
            rerun: onRefresh,
            explain: (sql) => openInSql(explainStatement(sql), true),
            code: setCodeOf,
            bookmark: (sql) => {
              saved.save(bookmarkName(sql), sql)
              setBookmarked(true)
            },
          }}
        />
        <output aria-live="polite" className="mt-1 block text-ink-sub">
          {bookmarked ? locale.browse.bookmarked : ''}
        </output>
      </div>
      <SqlCodeDialog sql={codeOf} onClose={() => setCodeOf(null)} />
    </figure>
  )
}
