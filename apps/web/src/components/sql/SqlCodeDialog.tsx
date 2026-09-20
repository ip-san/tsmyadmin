import { useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { copyText } from '@/lib/clipboard.ts'
import { CODE_LANGUAGES, type CodeLanguage, sqlToCode } from './sql-code.ts'

const t = locale.sql.code

/** A statement as a string literal in the language chosen, to copy into an application. */
export function SqlCodeDialog({ sql, onClose }: { sql: string | null; onClose: () => void }) {
  const [language, setLanguage] = useState<CodeLanguage>('php')
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null)
  const code = sql === null ? '' : sqlToCode(language, sql)
  return (
    <Dialog
      open={sql !== null}
      title={t.title}
      onClose={() => {
        setCopied(null)
        onClose()
      }}
      footer={
        <>
          <Button
            variant="primary"
            onClick={() =>
              void copyText(code).then(
                () => setCopied('done'),
                () => setCopied('failed')
              )
            }
          >
            {t.copy}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm">
          {t.language}
          <Select
            value={language}
            onChange={(e) => {
              setCopied(null)
              setLanguage(e.target.value as CodeLanguage)
            }}
            className="w-auto"
          >
            {CODE_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {t.languages[l]}
              </option>
            ))}
          </Select>
        </label>
        <pre
          tabIndex={0}
          className="max-h-64 overflow-auto rounded border border-line bg-surface-sub p-2 font-mono text-xs"
        >
          {code}
        </pre>
        <p className="text-xs text-ink-sub">{t.note}</p>
        <output aria-live="polite" className="text-xs text-ink-sub">
          {copied === 'done' ? locale.sql.copied : copied === 'failed' ? locale.sql.copyFailed : ''}
        </output>
      </div>
    </Dialog>
  )
}
