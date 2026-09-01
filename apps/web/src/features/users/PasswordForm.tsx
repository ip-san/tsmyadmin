import type { FormEvent } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale.ts'
import { PasswordFields, usePasswordConfirm } from './PasswordFields.tsx'

export function PasswordForm({ onSubmit, onCancel }: { onSubmit: (password: string) => void; onCancel: () => void }) {
  const pw = usePasswordConfirm()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!pw.mismatch) onSubmit(pw.password)
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <PasswordFields state={pw} idPrefix="pw" />
      </div>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{locale.common.cancel}</Button>
        <Button type="submit" variant="primary" disabled={pw.mismatch}>
          {locale.ddl.submit}
        </Button>
      </div>
    </form>
  )
}
