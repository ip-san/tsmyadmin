import { Link } from '@tanstack/react-router'
import { Settings } from 'lucide-react'
import { locale } from '@/config/locale.ts'

/** A gear beside a page's title that opens the settings at the section that governs it (phpMyAdmin's "Settings" link). */
export function SettingsLink({ section }: { section: 'main-panel' | 'sql' | 'navigation' | 'export' | 'import' }) {
  return (
    <Link
      to="/settings"
      hash={section}
      className="rounded p-1 text-ink-sub hover:text-ink"
      title={locale.settings.forThisPage}
      aria-label={locale.settings.forThisPage}
    >
      <Settings className="size-4" aria-hidden="true" />
    </Link>
  )
}
