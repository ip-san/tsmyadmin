import { useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale.ts'
import { copyText } from '@/lib/clipboard.ts'

const t = locale.secondFactor

/** Recovery codes, shown once when the first factor is enrolled, with a way to copy them. */
export function RecoveryCodes({ codes }: { codes: readonly string[] }) {
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null)
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-semibold text-ink">{t.recoveryTitle}</h3>
      <p className="text-xs text-ink-sub">{t.recoveryHint}</p>
      <pre className="overflow-x-auto rounded border border-line bg-surface-sub p-3 font-mono text-xs text-ink">
        {codes.join('\n')}
      </pre>
      <Button
        size="sm"
        onClick={() => {
          copyText(codes.join('\n')).then(
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
  )
}
