import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SecondFactorSetup } from '@tsmyadmin/shared'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { createPasskey, passkeysSupported } from '@/lib/passkeys.ts'
import { mutations, secondFactorQuery, sessionQuery } from '@/lib/queries.ts'
import { RecoveryCodes } from './RecoveryCodes.tsx'
import { SecondFactorManage, type SecondFactorOutcome } from './SecondFactorManage.tsx'
import { TotpSetup } from './TotpSetup.tsx'

const t = locale.secondFactor

type View = { kind: 'totp'; setup: SecondFactorSetup; fresh: boolean } | { kind: 'codes'; codes: string[] } | null

const NOTICES: Record<SecondFactorOutcome, string> = {
  enrolled: t.enrolledNotice,
  disabled: t.disabledNotice,
  totpAdded: t.totpAddedNotice,
  totpRemoved: t.totpRemovedNotice,
  passkeyAdded: t.passkeyAddedNotice,
  passkeyRemoved: t.passkeyRemovedNotice,
}

/**
 * The second factor of the account this session logged in as: an authenticator app, passkeys, or both, with the
 * recovery codes that come with the first of them.
 */
export function SecondFactorPage() {
  const queryClient = useQueryClient()
  const status = useQuery(secondFactorQuery)
  const [view, setView] = useState<View>(null)
  /** What just happened, said once: the controls that were used are gone, so focus and speech need a new home. */
  const [done, setDone] = useState<SecondFactorOutcome | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const settled = (outcome: SecondFactorOutcome) => {
    setView(null)
    setDone(outcome)
    heading.current?.focus()
    void queryClient.invalidateQueries({ queryKey: secondFactorQuery.queryKey })
    // The session carries the state that gates everything else while enrolment is required.
    void queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey })
  }
  const beginTotp = useMutation({
    mutationFn: () => mutations.beginSecondFactor(),
    onSuccess: (setup) => {
      setDone(null)
      setView({ kind: 'totp', setup, fresh: true })
    },
  })
  // A passkey as the first factor: created in one go, then its recovery codes are shown before anything else.
  const firstPasskey = useMutation({
    mutationFn: async () => {
      const started = await mutations.beginPasskey()
      await mutations.confirmPasskey(await createPasskey(started.options))
      return started.recoveryCodes
    },
    onSuccess: (codes) => {
      settled('passkeyAdded')
      setView({ kind: 'codes', codes })
    },
  })

  if (status.isPending) return <Spinner />
  if (status.isError) return <ErrorBox error={status.error} onRetry={() => void status.refetch()} />
  const { state, passkeysAvailable } = status.data

  return (
    <section className="max-w-2xl space-y-4">
      <h2 ref={heading} tabIndex={-1} className="text-sm font-semibold text-ink outline-none">
        {t.title}
      </h2>
      <p className="text-sm text-ink-sub">{passkeysAvailable ? t.introPasskeys : t.intro}</p>
      {state === 'enrollment_required' && !view ? <Notice role="status">{t.required}</Notice> : null}
      <output aria-live="polite" className="block text-sm text-ink">
        {done ? NOTICES[done] : ''}
      </output>

      {state === 'unsupported' ? (
        <Notice role="status">{t.unsupported}</Notice>
      ) : view?.kind === 'totp' ? (
        <TotpSetup
          setup={view.setup}
          onDone={() => settled(view.fresh ? 'enrolled' : 'totpAdded')}
          onCancel={() => setView(null)}
        />
      ) : view?.kind === 'codes' ? (
        <div className="space-y-3">
          <RecoveryCodes codes={view.codes} />
          <Button variant="primary" onClick={() => setView(null)}>
            {t.recoverySaved}
          </Button>
        </div>
      ) : state === 'enrolled' ? (
        <SecondFactorManage
          status={status.data}
          onSettled={settled}
          onTotpSetup={(setup) => {
            setDone(null)
            setView({ kind: 'totp', setup, fresh: false })
          }}
        />
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => beginTotp.mutate()} disabled={beginTotp.isPending}>
              {t.enrol}
            </Button>
            {passkeysAvailable && passkeysSupported() ? (
              <Button onClick={() => firstPasskey.mutate()} disabled={firstPasskey.isPending}>
                {t.enrolPasskey}
              </Button>
            ) : null}
          </div>
          {beginTotp.isError ? <ErrorBox error={beginTotp.error} /> : null}
          {firstPasskey.isError ? <ErrorBox error={firstPasskey.error} /> : null}
        </div>
      )}
    </section>
  )
}
