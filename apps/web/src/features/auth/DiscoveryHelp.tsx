import type { DiscoveryDiagnosis, DiscoveryIssue } from '@tsmyadmin/shared'
import { locale } from '@/config/locale.ts'

const t = locale.login.discovery

/** The paragraph that says what to do about one container. */
function IssueHint({ issue, connectHost }: { issue: DiscoveryIssue; connectHost: string }) {
  switch (issue.reason) {
    case 'stopped':
      return <>{t.stopped}</>
    case 'notPublished':
      return (
        <>
          {t.notPublished}
          <pre className="mt-1 overflow-x-auto rounded border border-line bg-surface-sub p-2 font-mono text-xs text-ink">
            {`ports:\n  - "127.0.0.1:${issue.port ?? ''}:${issue.port ?? ''}"`}
          </pre>
        </>
      )
    case 'unreachable':
      return <>{t.unreachable(connectHost, issue.port ?? 0)}</>
  }
}

/**
 * For someone who cannot find or reach their database on the login screen (Docker discovery, development): what
 * discovery saw — Docker unreadable, no database containers, or a container it left out or cannot reach — and the
 * line to fix each. Nothing when everything is on the list and reachable.
 */
export function DiscoveryHelp({ diagnosis }: { diagnosis: DiscoveryDiagnosis | undefined }) {
  if (!diagnosis?.enabled) return null
  const nothingFound = diagnosis.found === 0 && diagnosis.issues.length === 0 && diagnosis.unavailable === null
  if (diagnosis.unavailable === null && diagnosis.issues.length === 0 && !nothingFound) return null
  // Open when the way in is broken (nothing listed, Docker unreadable, a listed one that does not open); folded away
  // when it only names containers left out (the stopped ones of other projects): those are not what they came for.
  const broken =
    diagnosis.found === 0 || diagnosis.unavailable !== null || diagnosis.issues.some((i) => i.reason === 'unreachable')
  return (
    <details open={broken} className="mt-4 rounded border border-line bg-surface-sub p-3 text-sm text-ink-sub">
      <summary className="cursor-pointer text-sm font-semibold text-ink">{t.title}</summary>
      <div className="mt-2 space-y-2">
        {diagnosis.unavailable !== null ? (
          <p>
            {t.unavailable}
            <code className="mt-1 block break-words font-mono text-xs">{diagnosis.unavailable}</code>
          </p>
        ) : null}
        {nothingFound ? <p>{t.none}</p> : null}
        {diagnosis.issues.length > 0 ? (
          <ul className="space-y-2">
            {diagnosis.issues.map((issue) => (
              <li key={`${issue.name}:${issue.reason}`}>
                <span className="font-medium text-ink">{issue.name}</span>:{' '}
                <IssueHint issue={issue} connectHost={diagnosis.connectHost} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </details>
  )
}
