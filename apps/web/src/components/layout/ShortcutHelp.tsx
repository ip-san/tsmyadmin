import { Keyboard } from 'lucide-react'
import { useState } from 'react'
import { locale } from '@/config/locale.ts'
import { shortcutLabel, useShortcuts } from '@/lib/shortcuts.ts'
import { Button } from '../ui/Button.tsx'
import { Dialog } from '../ui/Dialog.tsx'

const ROWS: { keys: string; label: string }[] = [
  { keys: 'mod+k', label: locale.shortcuts.search },
  { keys: 'arrowleft', label: locale.shortcuts.prevPage },
  { keys: 'arrowright', label: locale.shortcuts.nextPage },
  { keys: 'mod+enter', label: locale.shortcuts.runSql },
  { keys: 'shift+?', label: locale.shortcuts.help },
]

export function ShortcutHelp() {
  const [open, setOpen] = useState(false)
  useShortcuts([{ keys: 'shift+?', handler: () => setOpen(true) }])
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={locale.shortcuts.open}
        title={locale.shortcuts.open}
      >
        <Keyboard className="size-4" aria-hidden />
      </Button>
      <Dialog open={open} title={locale.shortcuts.title} onClose={() => setOpen(false)}>
        <table className="w-full text-sm">
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.keys} className="border-b border-zinc-100 dark:border-zinc-800">
                <td className="py-1 pr-4">
                  <kbd className="rounded border border-zinc-300 bg-zinc-50 px-1.5 py-0.5 font-mono text-xs dark:border-zinc-600 dark:bg-zinc-800">
                    {shortcutLabel(r.keys)}
                  </kbd>
                </td>
                <td className="py-1">{r.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{locale.shortcuts.editHint}</p>
      </Dialog>
    </>
  )
}
