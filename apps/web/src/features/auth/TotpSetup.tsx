import { useMutation } from '@tanstack/react-query'
import type { SecondFactorSetup } from '@tsmyadmin/shared'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { mutations } from '@/lib/queries.ts'
import { QrCode } from './QrCode.tsx'
import { RecoveryCodes } from './RecoveryCodes.tsx'

const t = locale.secondFactor

/**
 * Adding an authenticator app: the secret is shown once, and only becomes the account's when a code from the app
 * proves it arrived — a half-finished enrolment must not lock anyone out.
 */
export function TotpSetup({
  setup,
  onDone,
  onCancel,
}: {
  setup: SecondFactorSetup
  onDone: () => void
  onCancel: () => void
}) {
  const [code, setCode] = useState('')
  const confirm = useMutation({ mutationFn: mutations.confirmSecondFactor, onSuccess: onDone })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (code.trim()) confirm.mutate(code.trim())
  }
  return (
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
      {/* Only with the first factor: an account adding an app keeps the codes it has. */}
      {setup.recoveryCodes.length > 0 ? <RecoveryCodes codes={setup.recoveryCodes} /> : null}
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <Field id="confirm-code" label={t.codeLabel} hint={t.confirmHint}>
          <Input
            id="confirm-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
            inputMode="numeric"
            className="w-40"
          />
        </Field>
        <Button type="submit" variant="primary" disabled={confirm.isPending || code.trim() === ''}>
          {t.confirm}
        </Button>
        {/* The secret is only held for ten minutes: without this, an expired enrolment would be a dead end. */}
        <Button onClick={onCancel}>{t.restart}</Button>
      </form>
      {confirm.isError ? <ErrorBox error={confirm.error} /> : null}
    </div>
  )
}
