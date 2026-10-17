import { lineDiff } from '@tsmyadmin/shared'

/**
 * Two texts line by line (definitions, usually): removed lines in red with "- ", added ones in green with "+ ".
 * `label` names the block for screen readers; `empty` is said instead when the two are the same.
 */
export function LineDiff({
  before,
  after,
  label,
  empty,
}: {
  before: string
  after: string
  label: string
  empty: string
}) {
  const lines = lineDiff(before, after)
  if (lines.every((l) => l.kind === 'same')) return <p className="text-sm text-ink-sub">{empty}</p>
  return (
    <pre className="overflow-x-auto rounded border border-line bg-surface-sub p-2 font-mono text-xs" aria-label={label}>
      {lines.map((l, i) => (
        <div
          key={i}
          className={
            l.kind === 'add'
              ? 'bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200'
              : l.kind === 'del'
                ? 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200'
                : 'text-ink'
          }
        >
          {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}
          {l.text}
        </div>
      ))}
    </pre>
  )
}
