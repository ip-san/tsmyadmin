import { useQuery } from '@tanstack/react-query'
import { Link, useRouterState } from '@tanstack/react-router'
import type { SessionInfo } from '@tsmyadmin/shared'
import {
  CircleHelp,
  LogOut,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Settings as SettingsIcon,
  SquareTerminal,
  Sun,
  X,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { z } from 'zod'
import { LOCALE_CODES, LOCALE_NAMES, type LocaleCode, locale, localeCode, setLocale } from '@/config/locale.ts'
import { sharePreference, sharePreferenceNow } from '@/lib/account-prefs.ts'
import { readPreference, writePreference } from '@/lib/preferences.ts'
import { myGroupTabsQuery } from '@/lib/queries.ts'
import { useShortcuts } from '@/lib/shortcuts.ts'
import { useTheme } from '@/lib/theme.ts'
import { Button } from '../ui/Button.tsx'
import { Select } from '../ui/Field.tsx'
import { BrandMark } from './BrandMark.tsx'
import { ShortcutHelp } from './ShortcutHelp.tsx'

const SIDEBAR_PREF = 'sidebar.collapsed'
const DOCK_PREF = 'console.docked'

export function AppShell({
  session,
  sidebar,
  dock,
  children,
  onLogout,
}: {
  session: SessionInfo
  sidebar: ReactNode
  /** The SQL console kept at the foot of the page; mounted only while it is open. */
  dock?: ReactNode
  children: ReactNode
  onLogout: () => void
}) {
  const [theme, toggleTheme] = useTheme()
  // Narrow viewports start with the tree hidden (it overlays the content there); the preference applies from md up.
  const narrow = () => typeof matchMedia === 'function' && matchMedia('(max-width: 767px)').matches
  const [collapsed, setCollapsed] = useState(() => (narrow() ? true : readPreference(SIDEBAR_PREF, z.boolean(), false)))
  const location = useRouterState({ select: (s) => s.location.href })
  const [prevLocation, setPrevLocation] = useState(location)
  if (prevLocation !== location) {
    setPrevLocation(location)
    if (narrow() && !collapsed) setCollapsed(true)
  }
  const toggleSidebar = () =>
    setCollapsed((c) => {
      if (!narrow()) writePreference(SIDEBAR_PREF, !c)
      return !c
    })
  useShortcuts([{ keys: 'mod+b', global: true, handler: toggleSidebar }])
  // A user group that hides the server's SQL tab hides the console too: it is the same thing at the foot of the page.
  const consoleHidden = useQuery(myGroupTabsQuery).data?.hiddenTabs.includes('server:sql') ?? false
  const [docked, setDocked] = useState(() => readPreference(DOCK_PREF, z.boolean(), false))
  const setDock = (open: boolean) => {
    setDocked(open)
    writePreference(DOCK_PREF, open)
    sharePreference({ consoleDocked: open })
  }
  return (
    <div className="flex h-dvh flex-col bg-canvas text-ink print:block print:h-auto">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
      >
        {locale.common.skipToContent}
      </a>
      <header className="flex shrink-0 items-center justify-between border-b border-line bg-surface px-4 py-2 print:hidden">
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
          <Link to="/" className="flex shrink-0 items-center gap-2">
            <BrandMark size={22} />
            <span className="text-base font-semibold tracking-tight text-ink">{locale.app.name}</span>
          </Link>
          {/* The connection is the one piece of context that has to be visible on every screen: give it a
              chip rather than letting it trail off as small grey text in a wide empty bar. */}
          <span className="truncate rounded-control bg-surface-sub px-2 py-1 text-xs text-ink-sub">
            {session.dialect === 'mysql' ? locale.login.mysql : locale.login.postgres} ·{' '}
            {locale.nav.connectedAs(session.user, `${session.host}:${session.port}`)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <a
            href={locale.nav.helpUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-ink hover:bg-surface-sub"
          >
            <CircleHelp className="size-4" aria-hidden />
            {locale.nav.help}
            <span className="sr-only">{locale.nav.opensNewTab}</span>
          </a>
          {dock && !consoleHidden ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDock(!docked)}
              aria-expanded={docked}
              aria-controls={docked ? 'sql-dock' : undefined}
            >
              <SquareTerminal className="size-4" aria-hidden />
              {locale.dock.toggle}
            </Button>
          ) : null}
          <Link
            to="/settings"
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-ink hover:bg-surface-sub"
          >
            <SettingsIcon className="size-4" aria-hidden />
            {locale.settings.title}
          </Link>
          <ShortcutHelp />
          {/* Switching reloads the page: every string is read once at load, so a live swap would leave half the
              screen in the other language. */}
          <Select
            aria-label={locale.common.language}
            value={localeCode}
            onChange={(e) => {
              const code = e.target.value as LocaleCode
              void sharePreferenceNow({ locale: code }).finally(() => setLocale(code))
            }}
            className="w-auto py-1 text-xs"
          >
            {LOCALE_CODES.map((code) => (
              <option key={code} value={code}>
                {LOCALE_NAMES[code]}
              </option>
            ))}
          </Select>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              toggleTheme()
              sharePreference({ theme: theme === 'dark' ? 'light' : 'dark' })
            }}
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
      <div className="relative flex min-h-0 flex-1 print:block">
        {/* Narrow viewports (reflow at 320px): the tree overlays the content instead of squeezing it. */}
        {!collapsed ? (
          <button
            type="button"
            className="fixed inset-0 z-10 bg-black/30 md:hidden print:hidden"
            aria-label={locale.nav.hideSidebar}
            onClick={() => setCollapsed(true)}
          />
        ) : null}
        <aside
          data-scroll-root
          hidden={collapsed}
          className="absolute inset-y-0 left-0 z-20 mt-[49px] w-64 shrink-0 overflow-y-auto border-r border-line bg-surface shadow-lg md:static md:mt-0 md:shadow-none print:hidden"
          aria-label={locale.nav.tree}
        >
          {sidebar}
        </aside>
        <div className="flex min-w-0 flex-1 flex-col print:block">
          <main id="main" className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 print:overflow-visible print:p-0">
            {children}
          </main>
          {dock && docked && !consoleHidden ? (
            <section
              id="sql-dock"
              aria-labelledby="sql-dock-title"
              className="flex h-[45vh] shrink-0 flex-col border-t-2 border-line-strong bg-surface print:hidden"
            >
              <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-1">
                <h2 id="sql-dock-title" className="text-sm font-semibold text-ink">
                  {locale.dock.title}
                </h2>
                <Button variant="ghost" size="sm" onClick={() => setDock(false)} aria-label={locale.dock.close}>
                  <X className="size-4" aria-hidden />
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">{dock}</div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  )
}
