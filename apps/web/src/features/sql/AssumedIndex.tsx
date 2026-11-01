import type { ExplainResult, PlanNode } from '@tsmyadmin/shared'
import { useRef } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale-screens.ts'
import { compareReads } from './plan-compare.ts'
import type { IndexCandidate } from './plan-index.ts'
import type { AssumedPlan } from './use-assumed-plan.ts'

const t = locale.plan

/** How a read is expected to go, in a few words: through which index or in full, and the rows expected. */
const expected = (n: PlanNode) => t.assumeRead(n.access === 'fullScan' ? null : n.index, n.estRows)

/**
 * Trying an index without building it: the server plans the statement as if the index were there (PostgreSQL with
 * HypoPG), and the estimate before is set beside the estimate after: the planner's cost and each table's read. Shown
 * on the estimate, before anything is run: on a busy server, the way to see whether an index would help at all. Where
 * the server could (PostgreSQL) but has no HypoPG, says what would make it so.
 */
export function AssumedIndex({
  assumed,
  before,
  candidates,
  onBuild,
}: {
  assumed: AssumedPlan
  /** The estimated plan, as it is. */
  before: ExplainResult
  candidates: readonly IndexCandidate[]
  /** Builds the index and measures again (once the statement was measured); absent until then. */
  onBuild?: ((c: IndexCandidate) => void) | undefined
}) {
  // The buttons under the comparison go with it: the focus they had goes to the heading, never to the page.
  const heading = useRef<HTMLHeadingElement>(null)
  // Absent where the server has no such thing (MySQL): nothing to say.
  if (before.canAssume === undefined || candidates.length === 0) return null
  const { candidate, result, running, error } = assumed
  const said = running ? t.assumeRunning : result && candidate ? t.assumeDone(candidate.name) : ''
  const changes = result ? compareReads(before.plan, result.plan).filter((c) => c.after) : []
  return (
    <section aria-label={t.assumeGroup} className="space-y-2 rounded border border-line p-2 text-xs">
      <h4 ref={heading} tabIndex={-1} className="font-semibold text-ink">
        {t.assumeGroup}
      </h4>
      <p role="status" className="text-ink-sub empty:sr-only">
        {said}
      </p>
      {before.canAssume ? (
        <>
          <p className="text-ink-sub">{t.assumeIntro}</p>
          <ul className="space-y-1">
            {candidates.map((c) => (
              <li key={`${c.table}\0${c.name}`} className="flex flex-wrap items-center gap-2">
                <span className="text-ink">{t.trialWhy[c.reason](c.table)}</span>
                <Button size="sm" aria-disabled={running || undefined} onClick={() => !running && assumed.assume(c)}>
                  {t.assumeTry(c.table, c.columns)}
                </Button>
              </li>
            ))}
          </ul>
          {result && candidate ? (
            <>
              {before.plan.cost !== null && result.plan.cost !== null ? (
                <p className="text-ink">{t.assumeCost(before.plan.cost, result.plan.cost)}</p>
              ) : null}
              <ul className="list-disc pl-4 text-ink">
                {changes.map((c, i) => (
                  <li key={`${c.table}-${i}`}>
                    {c.table}: {expected(c.before)} → {c.after ? expected(c.after) : ''}
                  </li>
                ))}
              </ul>
              {result.assumed?.includes(candidate.name) ? null : (
                <p className="text-amber-900 dark:text-amber-200">{t.assumeUnused(candidate.name)}</p>
              )}
              <p className="text-ink-sub">{t.assumeNote}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  aria-disabled={running || undefined}
                  onClick={() => {
                    if (running) return
                    heading.current?.focus()
                    assumed.clear()
                  }}
                >
                  {t.assumeBack}
                </Button>
                {onBuild ? (
                  <Button
                    size="sm"
                    aria-disabled={running || undefined}
                    onClick={() => {
                      if (running) return
                      // The preview opens from here, and gives the focus back here when it closes.
                      heading.current?.focus()
                      onBuild(candidate)
                    }}
                  >
                    {t.assumeBuild(candidate.table, candidate.columns)}
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
        </>
      ) : (
        <p className="text-ink-sub">{t.assumeMissing}</p>
      )}
      {error ? <ErrorBox error={error} /> : null}
    </section>
  )
}
