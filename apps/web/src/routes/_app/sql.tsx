import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { z } from 'zod'
import { ServerTabs } from '@/components/layout/ServerTabs.tsx'
import { Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { SqlConsole } from '@/features/sql/SqlConsole.tsx'
import { databasesQuery } from '@/lib/queries.ts'

export const Route = createFileRoute('/_app/sql')({
  component: Page,
  validateSearch: z.object({
    db: z
      .string()
      .optional()
      .transform((v) => (v ? v : undefined))
      .catch(undefined),
  }),
})

/**
 * Server-level SQL console. Unqualified names resolve in the selected database (the server's default one —
 * information_schema on MySQL, the login database on PostgreSQL — until the user picks another).
 */
function Page() {
  const { session } = useRouteContext({ from: '/_app' })
  const { db: chosen } = Route.useSearch()
  const navigate = Route.useNavigate()
  const databases = useQuery(databasesQuery)
  const db = chosen ?? session.serverDatabase
  const options = databases.data?.map((d) => d.name) ?? []
  if (!options.includes(db)) options.unshift(db)
  return (
    <>
      <ServerTabs tab={locale.tabs.sql} />
      <label className="mb-3 flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-200">
        {locale.nav.currentDatabase}
        <Select value={db} onChange={(e) => void navigate({ search: { db: e.target.value } })} className="w-auto py-1">
          {options.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Select>
      </label>
      <SqlConsole key="server" db={db} dialect={session.dialect} completion={EMPTY} draftId="server" />
    </>
  )
}

const EMPTY: Record<string, string[]> = {}
