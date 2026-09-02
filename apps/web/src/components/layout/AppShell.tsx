import { Link } from '@tanstack/react-router'
import type { SessionInfo } from '@tsmyadmin/shared'
import { LogOut, Moon, PanelLeftClose, PanelLeftOpen, Sun } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { z } from 'zod'
import { locale } from '@/config/locale.ts'
import { readPreference, writePreference } from '@/lib/preferences.ts'
import { useShortcuts } from '@/lib/shortcuts.ts'
import { useTheme } from '@/lib/theme.ts'
import { Button } from '../ui/Button.tsx'
import { ShortcutHelp } from './ShortcutHelp.tsx'

const SIDEBAR_PREF = 'sidebar.collapsed'

export function AppShell({
  session,
  sidebar,
  children,
  onLogout,
}: {
  session: SessionInfo
  sidebar: ReactNode
  children: ReactNode
  onLogout: () => void
}) {
  const [theme, toggleTheme] = useTheme()
  const [collapsed, setCollapsed] = useState(() => readPreference(SIDEBAR_PREF, z.boolean(), false))
  const toggleSidebar = () =>
    setCollapsed((c) => {
      writePreference(SIDEBAR_PREF, !c)
      return !c
    })
  useShortcuts([{ keys: 'mod+b', global: true, handler: toggleSidebar }])
  return (
    <div className="flex h-dvh flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 dark:focus:bg-zinc-800"
      >
        {locale.common.skipToContent}
      </a>
      <header className="flex shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-4 py-2 dark:border-zinc-700 dark:bg-zinc-900">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleSidebar}
            aria-label={collapsed ? locale.nav.showSidebar : locale.nav.hideSidebar}
            aria-pressed={!collapsed}
            title={locale.shortcuts.toggleSidebar}
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4" aria-hidden />
            ) : (
              <PanelLeftClose className="size-4" aria-hidden />
            )}
          </Button>
          <Link to="/" className="text-base font-bold text-blue-700 dark:text-blue-300">
            {locale.app.name}
          </Link>
          <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {session.dialect === 'mysql' ? locale.login.mysql : locale.login.postgres} ·{' '}
            {locale.nav.connectedAs(session.user, `${session.host}:${session.port}`)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ShortcutHelp />
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleTheme}
            aria-label={locale.common.theme}
            aria-pressed={theme === 'dark'}
          >
            {theme === 'dark' ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
          </Button>
          <Button variant="ghost" size="sm" onClick={onLogout}>
            <LogOut className="size-4" aria-hidden />
            {locale.nav.logout}
          </Button>
        </div>
      </header>
      {/* Sidebar and main pane scroll independently; the aside is the scroll root for the virtualized table lists. */}
      <div className="flex min-h-0 flex-1">
        <aside
          data-scroll-root
          hidden={collapsed}
          className="w-64 shrink-0 overflow-y-auto border-r border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900"
          aria-label={locale.nav.tree}
        >
          {sidebar}
        </aside>
        <main id="main" className="min-w-0 flex-1 overflow-y-auto p-4">
          {children}
        </main>
      </div>
    </div>
  )
}
