import { Link } from '@tanstack/react-router'
import type { SessionInfo } from '@tsmyadmin/shared'
import { LogOut, Moon, Sun } from 'lucide-react'
import type { ReactNode } from 'react'
import { locale } from '@/config/locale.ts'
import { useTheme } from '@/lib/theme.ts'
import { Button } from '../ui/Button.tsx'

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
  return (
    <div className="flex min-h-dvh flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 dark:focus:bg-zinc-800"
      >
        {locale.common.skipToContent}
      </a>
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-2 dark:border-zinc-700 dark:bg-zinc-900">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-base font-bold text-blue-700 dark:text-blue-300">
            {locale.app.name}
          </Link>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {session.dialect === 'mysql' ? locale.login.mysql : locale.login.postgres} ·{' '}
            {locale.nav.connectedAs(session.user, `${session.host}:${session.port}`)}
          </span>
        </div>
        <div className="flex items-center gap-1">
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
      <div className="flex flex-1">
        <aside
          className="w-64 shrink-0 overflow-y-auto border-r border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900"
          aria-label={locale.nav.tree}
        >
          {sidebar}
        </aside>
        <main id="main" className="min-w-0 flex-1 p-4">
          {children}
        </main>
      </div>
    </div>
  )
}
