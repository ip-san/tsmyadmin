import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { ServerTabs } from '@/components/layout/ServerTabs.tsx'
import { locale } from '@/config/locale.ts'
import { SqlConsole } from '@/features/sql/SqlConsole.tsx'

export const Route = createFileRoute('/_app/sql')({ component: Page })

/** Server-level SQL console (SHOW PROCESSLIST, information_schema queries, …) without choosing a database first. */
function Page() {
  const { session } = useRouteContext({ from: '/_app' })
  return (
    <>
      <ServerTabs tab={locale.tabs.sql} />
      <SqlConsole
        key="server"
        db={session.serverDatabase}
        dialect={session.dialect}
        completion={EMPTY}
        draftId="server"
      />
    </>
  )
}

const EMPTY: Record<string, string[]> = {}
