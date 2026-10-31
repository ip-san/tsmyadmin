import { ANALYZE_TIMEOUT_DEFAULT_MS } from '@tsmyadmin/shared'
import { useLayoutEffect, useRef } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale-screens.ts'
import type { MeasuredPlan } from './use-measured-plan.ts'

const t = locale.plan

/**
 * "Run and measure": asks first, since it runs the statement on the server (a read only, rolled back, stopped after
 * the time limit), then runs it once. What it is doing is there from the start (empty) and said as it changes. The
 * focus goes to the run button when asked, and back to this one when the question closes, so it is never lost.
 */
export function MeasurePlan({ measure }: { measure: MeasuredPlan }) {
  const { step, result, error } = measure
  const opener = useRef<HTMLButtonElement>(null)
  const runner = useRef<HTMLButtonElement>(null)
  const was = useRef(step)
  // Before the browser paints: the run button the focus was on is gone in the same commit, so the focus never rests
  // on the page.
  useLayoutEffect(() => {
    if (step === 'confirming') runner.current?.focus()
    else if (step === 'idle' && was.current !== 'idle') opener.current?.focus()
    was.current = step
  }, [step])
  const ms = result?.measured?.ms ?? null
  const said = step === 'running' ? t.measuring : result ? t.measured(ms === null ? null : t.duration(ms)) : ''
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          ref={opener}
          size="sm"
          title={t.measureHint}
          aria-disabled={step === 'running' || undefined}
          aria-expanded={step !== 'idle'}
          onClick={measure.ask}
        >
          {t.measure}
        </Button>
        <span role="status" className="text-xs text-ink-sub empty:sr-only">
          {said}
        </span>
      </div>
      {step === 'idle' ? null : (
        <fieldset aria-label={t.measureGroup} className="space-y-2 rounded border border-line p-2 text-xs">
          <p className="text-ink">{t.measureConfirm(ANALYZE_TIMEOUT_DEFAULT_MS / 1000)}</p>
          <div className="flex gap-2">
            <Button
              ref={runner}
              size="sm"
              variant="primary"
              aria-disabled={step === 'running' || undefined}
              onClick={() => void measure.run()}
            >
              {t.measureRun}
            </Button>
            <Button size="sm" aria-disabled={step === 'running' || undefined} onClick={measure.cancel}>
              {t.measureCancel}
            </Button>
          </div>
        </fieldset>
      )}
      {error ? <ErrorBox error={error} /> : null}
    </div>
  )
}
