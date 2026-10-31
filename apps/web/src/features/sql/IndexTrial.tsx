import type { ExplainResult } from '@tsmyadmin/shared'
import { useLayoutEffect, useRef } from 'react'
import { PreviewDialog } from '@/components/ddl/PreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale-screens.ts'
import { compareReads, readSaid, speedup, usesIndex } from './plan-compare.ts'
import type { IndexCandidate } from './plan-index.ts'
import type { IndexTrial as Trial } from './use-index-trial.ts'

const t = locale.plan

/**
 * Trying an index the plan suggests: the candidates (each with why), and once one is made, the run before beside the
 * run after: the whole time, each table's read, whether the server used the index at all, and a way to drop it again.
 * Offered once the statement was measured, so both sides are runs.
 */
export function IndexTrial({
  trial,
  candidates,
  before,
}: {
  trial: Trial
  candidates: readonly IndexCandidate[]
  before: ExplainResult
}) {
  const { tried, after, measuring, stopping, stopped, error, flow } = trial
  const busy = flow.running || measuring
  // The stop button goes when the run ends: the focus it had goes to measuring again, never to the page. A blur as it
  // is taken away (some browsers send one) has no element it went to, unlike a move of the focus elsewhere.
  const again = useRef<HTMLButtonElement>(null)
  const stopFocused = useRef(false)
  useLayoutEffect(() => {
    if (measuring || !stopFocused.current) return
    stopFocused.current = false
    if (document.activeElement === null || document.activeElement === document.body) again.current?.focus()
  }, [measuring])
  const said = stopping
    ? locale.plan.measureStopping
    : measuring
      ? t.trialMeasuring
      : stopped
        ? t.trialStopped
        : after && tried
          ? t.trialDone(tried.name)
          : ''
  const factor = speedup(before.measured?.ms, after?.measured?.ms)
  const changes = after ? compareReads(before.plan, after.plan).filter((c) => c.after) : []
  return (
    <section aria-label={t.trialGroup} className="space-y-2 rounded border border-line p-2 text-xs">
      <h4 className="font-semibold text-ink">{t.trialGroup}</h4>
      <p role="status" className="text-ink-sub empty:sr-only">
        {said}
      </p>
      {tried === null ? (
        candidates.length === 0 ? (
          <p className="text-ink-sub">{t.trialNone}</p>
        ) : (
          <>
            <p className="text-ink-sub">{t.trialIntro}</p>
            <ul className="space-y-1">
              {candidates.map((c) => (
                <li key={`${c.table}\0${c.name}`} className="flex flex-wrap items-center gap-2">
                  <span className="text-ink">{t.trialWhy[c.reason](c.table)}</span>
                  <Button size="sm" aria-disabled={busy || undefined} onClick={() => !busy && trial.start(c)}>
                    {t.trialTry(c.table, c.columns)}
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )
      ) : (
        <>
          {after ? (
            <>
              <p className="text-ink">
                {t.trialTotal(
                  before.measured?.ms == null ? null : t.duration(before.measured.ms),
                  after.measured?.ms == null ? null : t.duration(after.measured.ms),
                  factor
                )}
              </p>
              <ul className="list-disc pl-4 text-ink">
                {changes.map((c, i) => (
                  <li key={`${c.table}-${i}`}>
                    {c.table}: {readSaid(c.before)} → {c.after ? readSaid(c.after) : ''}
                  </li>
                ))}
              </ul>
              {usesIndex(after.plan, tried.table, tried.name) ? null : (
                <p className="text-amber-900 dark:text-amber-200">{t.trialUnused(tried.name)}</p>
              )}
            </>
          ) : null}
          {/* Said for as long as the index is there: closing this view does not take it away. */}
          <p className="text-ink-sub">{t.trialNote}</p>
          <div className="flex flex-wrap gap-2">
            {/* Only while it measures: stops that run (the server's cancel). */}
            {measuring ? (
              <Button
                size="sm"
                aria-disabled={stopping || undefined}
                onClick={trial.stop}
                onFocus={() => {
                  stopFocused.current = true
                }}
                onBlur={(e) => {
                  if (e.relatedTarget) stopFocused.current = false
                }}
              >
                {t.trialStop}
              </Button>
            ) : null}
            <Button
              ref={again}
              size="sm"
              aria-disabled={busy || undefined}
              onClick={() => !busy && void trial.measure()}
            >
              {t.trialAgain}
            </Button>
            <Button size="sm" aria-disabled={busy || undefined} onClick={() => !busy && trial.undo()}>
              {t.trialUndo(tried.name)}
            </Button>
          </div>
        </>
      )}
      {error ? <ErrorBox error={error} /> : null}
      <PreviewDialog
        flow={flow}
        title={(op) => locale.ddl.titles[op.op]}
        destructive={(op) => op.op === 'dropIndex'}
        hint={flow.op?.op === 'dropIndex' ? t.trialUndoHint : t.trialHint}
        successMessage={(op) => locale.ddl.executed(locale.ddl.titles[op.op])}
      />
    </section>
  )
}
