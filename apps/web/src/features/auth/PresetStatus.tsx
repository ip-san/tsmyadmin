import type { ServerPreset } from '@tsmyadmin/shared'
import { useState } from 'react'
import { Notice } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'

const t = locale.login

/** What changed between two lists of server names, as one sentence (empty when only the order changed). */
export function describePresetChanges(before: readonly string[], after: readonly string[]): string {
  const added = after.filter((n) => !before.includes(n))
  const removed = before.filter((n) => !after.includes(n))
  return [
    ...(added.length > 0 ? [t.presetsAdded(added.join(', '))] : []),
    ...(removed.length > 0 ? [t.presetsRemoved(removed.join(', '))] : []),
  ].join(' ')
}

/** The last change to the server list since this screen was opened (Docker containers started or stopped). */
function usePresetChanges(presets: readonly ServerPreset[]): string {
  const names = presets.map((p) => p.name)
  const key = names.join('\n')
  const [seen, setSeen] = useState({ key, names })
  const [message, setMessage] = useState('')
  // Compared while rendering (React's "previous value" pattern): no effect, no extra render pass that shows stale text.
  if (seen.key !== key) {
    setSeen({ key, names })
    setMessage(describePresetChanges(seen.names, names))
  }
  return message
}

/**
 * A polite status line under the server list: that the selected server has left the list (kept selected, not
 * switched behind the user's back), or else what was added or removed while the screen was open. Always in the
 * DOM, so a screen reader announces the change without the focus moving.
 */
export function PresetStatus({ presets, missing }: { presets: readonly ServerPreset[]; missing: string | null }) {
  const message = usePresetChanges(presets)
  return (
    // Empty, it takes no room: no height, and no gap from the form's spacing.
    <div role="status" aria-live="polite" className={missing === null && message === '' ? 'mb-0' : undefined}>
      {missing !== null ? (
        <Notice>{t.presetGoneNotice(missing)}</Notice>
      ) : message !== '' ? (
        <p className="text-xs text-ink-sub">{message}</p>
      ) : null}
    </div>
  )
}
