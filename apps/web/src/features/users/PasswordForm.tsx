import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Notice } from '@/components/ui/Feedback.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'

export function PasswordForm({ onSubmit, onCancel }: { onSubmit: (password: string) => void; onCancel: () => void }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const mismatch = password !== confirm
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!mismatch) onSubmit(password)
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <Field id="pw-new" label={locale.users.password}>
        <Input
          id="pw-new"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
        />
      </Field>
      <Field id="pw-confirm" label={locale.users.passwordConfirm}>
        <Input
          id="pw-confirm"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
        />
      </Field>
      {mismatch ? <Notice>{locale.users.passwordMismatch}</Notice> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{locale.common.cancel}</Button>
        <Button type="submit" variant="primary" disabled={mismatch}>
          {locale.ddl.submit}
        </Button>
      </div>
    </form>
  )
}
