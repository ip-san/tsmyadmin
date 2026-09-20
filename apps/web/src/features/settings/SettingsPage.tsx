import { useLocation, useRouteContext } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { PageTitle } from '@/components/layout/PageTitle.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { Notice } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { useDocumentTitle } from '@/lib/document-title.ts'
import {
  parseSettingsFile,
  type ResolvedSettings,
  resetSettings,
  resolveSettings,
  type Settings,
  saveSettings,
  settingsFile,
} from '@/lib/settings.ts'
import {
  ExportDefaultsSection,
  ImportDefaultsSection,
  MainPanelSection,
  NavigationSection,
  SqlSection,
} from './SettingsSections.tsx'

const t = locale.settings
/** Set before the reload that follows a save, so the next page can say it worked. */
const SAVED_FLAG = 'tsmyadmin.settings.saved'

const wasSaved = (): boolean => {
  try {
    const saved = sessionStorage.getItem(SAVED_FLAG) !== null
    sessionStorage.removeItem(SAVED_FLAG)
    return saved
  } catch {
    return false
  }
}

/** The settings as the file / server takes them: a number the box was emptied of is not a value. */
const valid = (v: ResolvedSettings) =>
  [v.browseLimit, v.sqlHistoryMax, v.navPageSize, v.navWidth, v.insertRowCount, v.headerEvery].every((n) =>
    Number.isFinite(n)
  ) &&
  v.navWidth >= 200 &&
  v.navWidth <= 480 &&
  v.insertRowCount >= 1 &&
  v.insertRowCount <= 10 &&
  v.headerEvery >= 0 &&
  v.headerEvery <= 1000 &&
  v.browseLimit >= 1 &&
  v.browseLimit <= 1000 &&
  v.sqlHistoryMax >= 10 &&
  v.sqlHistoryMax <= 1000 &&
  v.navPageSize >= 0 &&
  v.navPageSize <= 1000

export function SettingsPage() {
  useDocumentTitle(t.title)
  const { session } = useRouteContext({ from: '/_app' })
  const [value, setValue] = useState<ResolvedSettings>(() => resolveSettings())
  const [saved] = useState(wasSaved)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const set = (patch: Partial<ResolvedSettings>) => {
    setMessage(null)
    setValue((v) => ({ ...v, ...patch }))
  }
  // Saved, then the page is loaded again: the console, the sidebar and the forms read their settings when they mount.
  const finish = () => {
    try {
      sessionStorage.setItem(SAVED_FLAG, '1')
    } catch {
      // ignored: the reload just does not say so
    }
    location.reload()
  }
  const save = async () => {
    if (!valid(value)) return setMessage({ text: t.invalid, error: true })
    setBusy(true)
    await saveSettings(value)
    finish()
  }
  const reset = async () => {
    setBusy(true)
    await resetSettings()
    finish()
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([settingsFile(value)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'tsmyadmin-settings.json'
    link.click()
    URL.revokeObjectURL(url)
  }
  const upload = async (file: File | undefined) => {
    if (!file) return
    const parsed: Settings | null = parseSettingsFile(await file.text())
    if (!parsed) return setMessage({ text: t.badFile, error: true })
    setValue(resolveSettings(parsed))
    setMessage({ text: t.loaded, error: false })
    if (fileInput.current) fileInput.current.value = ''
  }
  // Arriving by a gear beside a page's title (`/settings#sql`): the section that governs that page is brought into view.
  const hash = useLocation().hash
  useEffect(() => {
    if (hash) document.getElementById(hash)?.scrollIntoView({ block: 'start' })
  }, [hash])
  const mysql = session.dialect === 'mysql'
  return (
    <div className="max-w-3xl space-y-4">
      <PageTitle>{t.title}</PageTitle>
      <p className="text-sm text-ink-sub">{t.intro}</p>
      {saved ? <Notice role="status">{t.saved}</Notice> : null}
      <MainPanelSection value={value} set={set} />
      <SqlSection value={value} set={set} />
      <NavigationSection value={value} set={set} />
      <ExportDefaultsSection
        value={value.exportDefaults}
        set={(exportDefaults) => set({ exportDefaults })}
        dialect={session.dialect}
      />
      <ImportDefaultsSection
        value={value.importDefaults}
        set={(importDefaults) => set({ importDefaults })}
        mysql={mysql}
      />
      <fieldset className="space-y-2 rounded border border-line p-4">
        <legend className="px-1 text-sm font-semibold text-ink">{t.sections.file}</legend>
        <p className="text-xs text-ink-sub">{t.fileHint}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={download}>{t.download}</Button>
          <label className="inline-flex cursor-pointer items-center gap-1 text-sm">
            <span className="rounded-control border border-line-strong px-3 py-1.5 font-medium hover:bg-surface-sub">
              {t.upload}
            </span>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              className="sr-only"
              onChange={(e) => void upload(e.target.files?.[0])}
            />
          </label>
        </div>
      </fieldset>
      {message ? (
        <p
          role={message.error ? 'alert' : 'status'}
          className={message.error ? 'text-sm text-red-800 dark:text-red-200' : 'text-sm text-ink-sub'}
        >
          {message.text}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => void save()} aria-disabled={busy}>
          {t.save}
        </Button>
        <Button onClick={() => setConfirming(true)}>{t.reset}</Button>
      </div>
      <Dialog
        open={confirming}
        title={t.resetTitle}
        onClose={() => setConfirming(false)}
        footer={
          <>
            <Button onClick={() => setConfirming(false)}>{locale.common.cancel}</Button>
            <Button variant="danger" onClick={() => void reset()}>
              {t.resetExecute}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink">{t.resetBody}</p>
      </Dialog>
    </div>
  )
}
