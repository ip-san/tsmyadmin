import { useState } from 'react'
import { Notice } from '@/components/ui/Feedback.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'

/** Password + confirmation inputs with a mismatch notice, shared by the create-user and change-password forms. */
export function usePasswordConfirm() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  return { password, confirm, setPassword, setConfirm, mismatch: password !== confirm }
}

export function PasswordFields({
  state,
  idPrefix,
}: {
  state: ReturnType<typeof usePasswordConfirm>
  idPrefix: string
}) {
  return (
    <>
      <Field id={`${idPrefix}-password`} label={locale.users.password}>
        <Input
          id={`${idPrefix}-password`}
          type="password"
          value={state.password}
          onChange={(e) => state.setPassword(e.target.value)}
          autoComplete="new-password"
        />
      </Field>
      <Field id={`${idPrefix}-confirm`} label={locale.users.passwordConfirm}>
        <Input
          id={`${idPrefix}-confirm`}
          type="password"
          value={state.confirm}
          onChange={(e) => state.setConfirm(e.target.value)}
          autoComplete="new-password"
        />
      </Field>
      {state.mismatch ? (
        <div className="col-span-2">
          <Notice>{locale.users.passwordMismatch}</Notice>
        </div>
      ) : null}
    </>
  )
}
