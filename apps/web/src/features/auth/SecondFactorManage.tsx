import { useMutation } from '@tanstack/react-query'
import type { SecondFactorProof, SecondFactorSetup, SecondFactorStatus } from '@tsmyadmin/shared'
import { useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { locale, numberLocale } from '@/config/locale.ts'
import { answerChallenge, createPasskey, passkeysSupported } from '@/lib/passkeys.ts'
import { mutations } from '@/lib/queries.ts'

const t = locale.secondFactor

/** What a change did, for the page to announce once the controls that made it are gone. */
export type SecondFactorOutcome =
  | 'enrolled'
  | 'disabled'
  | 'totpAdded'
  | 'totpRemoved'
  | 'passkeyAdded'
  | 'passkeyRemoved'

type Action =
  | { kind: 'disable' }
  | { kind: 'removeTotp' }
  | { kind: 'addTotp' }
  | { kind: 'addPasskey' }
  | { kind: 'removePasskey'; id: string }

/**
 * Proof for a change: the code typed, or — with the field left empty — one of the account's passkeys. Recovery
 * codes are not proof: they are for getting in, not for changing what protects the account.
 */
async function prove(code: string, withPasskey: boolean): Promise<SecondFactorProof> {
  if (code.trim()) return { code: code.trim() }
  if (!withPasskey) throw new Error(t.proofNeeded)
  return { passkey: await answerChallenge(await mutations.passkeyChallenge()) }
}

const passkeyDate = (at: number) => new Date(at).toLocaleDateString(numberLocale)

/** The methods an enrolled account has, and the changes it can make to them. */
export function SecondFactorManage({
  status,
  onSettled,
  onTotpSetup,
}: {
  status: SecondFactorStatus
  onSettled: (outcome: SecondFactorOutcome) => void
  onTotpSetup: (setup: SecondFactorSetup) => void
}) {
  const [code, setCode] = useState('')
  const browserPasskeys = passkeysSupported()
  const withPasskey = status.passkeys.length > 0 && browserPasskeys
  const act = useMutation({
    mutationFn: async (action: Action): Promise<SecondFactorOutcome | SecondFactorSetup> => {
      const proof = await prove(code, withPasskey)
      switch (action.kind) {
        case 'disable':
          await mutations.disableSecondFactor(proof)
          return 'disabled'
        case 'removeTotp':
          await mutations.removeTotp(proof)
          return 'totpRemoved'
        case 'removePasskey':
          await mutations.removePasskey(action.id, proof)
          return 'passkeyRemoved'
        case 'addTotp':
          return mutations.beginSecondFactor(proof)
        case 'addPasskey': {
          const started = await mutations.beginPasskey(proof)
          await mutations.confirmPasskey(await createPasskey(started.options))
          return 'passkeyAdded'
        }
      }
    },
    onSuccess: (result) => {
      setCode('')
      if (typeof result === 'string') onSettled(result)
      else onTotpSetup(result)
    },
  })
  const busy = act.isPending || (code.trim() === '' && !withPasskey)

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink">{t.enrolled(status.recoveryCodesLeft)}</p>
      <h3 className="text-sm font-semibold text-ink">{t.methodsTitle}</h3>
      <ul className="space-y-2 text-sm text-ink">
        <li className="flex flex-wrap items-center gap-2">
          <span>{status.totp ? t.totpMethod : t.totpMissing}</span>
          {status.totp && status.passkeys.length > 0 ? (
            <Button size="sm" onClick={() => act.mutate({ kind: 'removeTotp' })} disabled={busy}>
              {t.removeTotp}
            </Button>
          ) : null}
          {status.totp ? null : (
            <Button size="sm" onClick={() => act.mutate({ kind: 'addTotp' })} disabled={busy}>
              {t.addTotp}
            </Button>
          )}
        </li>
        {status.passkeys.map((p, i) => {
          const name = t.passkeyMethod(i + 1, passkeyDate(p.at))
          return (
            <li key={p.id} className="flex flex-wrap items-center gap-2">
              <span>{name}</span>
              <Button
                size="sm"
                onClick={() => act.mutate({ kind: 'removePasskey', id: p.id })}
                disabled={busy}
                aria-label={`${name}: ${t.removePasskey}`}
              >
                {t.removePasskey}
              </Button>
            </li>
          )
        })}
      </ul>
      {status.passkeysAvailable && browserPasskeys ? (
        <Button size="sm" onClick={() => act.mutate({ kind: 'addPasskey' })} disabled={busy}>
          {t.addPasskey}
        </Button>
      ) : null}
      <div className="flex flex-wrap items-start gap-2 border-t border-line pt-3">
        <Field id="proof-code" label={t.codeLabel} hint={withPasskey ? t.proofHintPasskey : t.proofHint}>
          <Input
            id="proof-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
            inputMode="numeric"
            className="w-40"
          />
        </Field>
        <Button variant="danger" onClick={() => act.mutate({ kind: 'disable' })} disabled={busy} className="mt-5">
          {t.disable}
        </Button>
      </div>
      {act.isError ? <ErrorBox error={act.error} /> : null}
    </div>
  )
}
