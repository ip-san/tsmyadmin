import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SecondFactorSetup } from '@tsmyadmin/shared'
import { type FormEvent, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { copyText } from '@/lib/clipboard.ts'
import { mutations, secondFactorQuery, sessionQuery } from '@/lib/queries.ts'
import { QrCode } from './QrCode.tsx'

const t = locale.secondFactor

/**
 * Enrolling and removing the second factor of the account this session logged in as. The secret is shown once,
 * and only becomes the account's once a code from the app proves it arrived — a half-finished enrolment must
 * not lock anyone out.
 */
export function SecondFactorPage() {
  const queryClient = useQueryClient()
  const status = useQuery(secondFactorQuery)
  const [setup, setSetup] = useState<SecondFactorSetup | null>(null)
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null)
  /** What just happened, said once: the controls that were used are gone, so focus and speech need a new home. */
  const [done, setDone] = useState<'enrolled' | 'disabled' | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const settled = (outcome: 'enrolled' | 'disabled') => () => {
    setSetup(null)
    setCode('')
    setCopied(null)
    setDone(outcome)
    heading.current?.focus()
    void queryClient.invalidateQueries({ queryKey: secondFactorQuery.queryKey })
    // The session carries the state that gates everything else while enrolment is required.
    void queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey })
  }
  const begin = useMutation({
    mutationFn: mutations.beginSecondFactor,
    onSuccess: (next) => {
      setDone(null)
      setSetup(next)
    },
  })
  const confirm = useMutation({ mutationFn: mutations.confirmSecondFactor, onSuccess: settled('enrolled') })
  const disable = useMutation({ mutationFn: mutations.disableSecondFactor, onSuccess: settled('disabled') })

  if (status.isPending) return <Spinner />
  if (status.isError) return <ErrorBox error={status.error} onRetry={() => void status.refetch()} />
  const state = status.data.state
  const submit = (run: (code: string) => void) => (e: FormEvent) => {
    e.preventDefault()
    if (code.trim()) run(code.trim())
  }

  return (
    <section className="max-w-2xl space-y-4">
      <h2 ref={heading} tabIndex={-1} className="text-sm font-semibold text-ink outline-none">
        {t.title}
      </h2>
      <p className="text-sm text-ink-sub">{t.intro}</p>
      {state === 'enrollment_required' && !setup ? <Notice role="status">{t.required}</Notice> : null}
      <output aria-live="polite" className="block text-sm text-ink">
        {done === 'enrolled' ? t.enrolledNotice : done === 'disabled' ? t.disabledNotice : ''}
      </output>

      {state === 'unsupported' ? (
        <Notice role="status">{t.unsupported}</Notice>
      ) : state === 'enrolled' ? (
        <div className="space-y-3">
          <p className="text-sm text-ink">{t.enrolled(status.data.recoveryCodesLeft)}</p>
          <form onSubmit={submit(disable.mutate)} className="flex flex-wrap items-end gap-2">
            <Field id="disable-code" label={t.codeLabel} hint={t.disableHint}>
              <Input
                id="disable-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="one-time-code"
                inputMode="numeric"
                className="w-40"
                aria-describedby="disable-code-hint"
              />
            </Field>
            <Button type="submit" variant="danger" disabled={disable.isPending || code.trim() === ''}>
              {t.disable}
            </Button>
          </form>
          {disable.isError ? <ErrorBox error={disable.error} /> : null}
        </div>
      ) : setup ? (
        <div className="space-y-3">
          <p className="text-sm text-ink">{t.scan}</p>
          <QrCode rows={setup.qr} label={t.qrLabel} />
          <p className="text-sm text-ink">
            <span className="sr-only">{t.secretLabel}: </span>
            <span id="second-factor-secret" className="font-mono">
              {setup.secret}
            </span>
          </p>
          <p className="break-all text-xs text-ink-sub">{setup.uri}</p>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-ink">{t.recoveryTitle}</h3>
            <p className="text-xs text-ink-sub">{t.recoveryHint}</p>
            <pre className="overflow-x-auto rounded border border-line bg-surface-sub p-3 font-mono text-xs text-ink">
              {setup.recoveryCodes.join('\n')}
            </pre>
            <Button
              size="sm"
              onClick={() => {
                copyText(setup.recoveryCodes.join('\n')).then(
                  () => setCopied('done'),
                  () => setCopied('failed')
                )
              }}
            >
              {t.copyRecovery}
            </Button>
            <output aria-live="polite" className="ml-2 text-xs text-ink-sub">
              {copied === 'done' ? t.copied : copied === 'failed' ? t.copyFailed : ''}
            </output>
          </div>
          <form onSubmit={submit(confirm.mutate)} className="flex flex-wrap items-end gap-2">
            <Field id="confirm-code" label={t.codeLabel} hint={t.confirmHint}>
              <Input
                id="confirm-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="one-time-code"
                inputMode="numeric"
                className="w-40"
                aria-describedby="confirm-code-hint"
              />
            </Field>
            <Button type="submit" variant="primary" disabled={confirm.isPending || code.trim() === ''}>
              {t.confirm}
            </Button>
            {/* The secret is only held for ten minutes: without this, an expired enrolment would be a dead end. */}
            <Button
              onClick={() => {
                setSetup(null)
                setCode('')
              }}
            >
              {t.restart}
            </Button>
          </form>
          {confirm.isError ? <ErrorBox error={confirm.error} /> : null}
        </div>
      ) : (
        <div className="space-y-2">
          <Button variant="primary" onClick={() => begin.mutate()} disabled={begin.isPending}>
            {t.enrol}
          </Button>
          {begin.isError ? <ErrorBox error={begin.error} /> : null}
        </div>
      )}
    </section>
  )
}
