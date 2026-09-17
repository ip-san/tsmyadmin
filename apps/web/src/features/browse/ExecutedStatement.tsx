import type { BrowseStatement, Cell } from '@tsmyadmin/shared'
import { locale } from '@/config/locale.ts'

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
export function ExecutedStatement({ statement }: { statement: BrowseStatement }) {
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
    </figure>
  )
}
