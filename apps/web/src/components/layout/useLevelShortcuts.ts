import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useShortcuts } from '@/lib/shortcuts.ts'

/**
 * Single-key jumps between the tabs of the level the page is on (phpMyAdmin's keyboard navigation):
 * h server home, d the database, t the table's structure, b its rows, s SQL, e export. Ignored while typing.
 */
export function useLevelShortcuts(): void {
  const navigate = useNavigate()
  const { db, table } = useParams({ strict: false }) as { db?: string; table?: string }
  const { schema } = useSearch({ strict: false }) as { schema?: string }
  const search = schema ? { schema } : {}
  const go = (to: string, params?: Record<string, string>) => {
    // The typed router cannot see that these paths exist for whichever level is open: they are checked below.
    void navigate({ to, ...(params ? { params } : {}), search } as never)
  }
  useShortcuts([
    { keys: 'h', handler: () => void navigate({ to: '/' }) },
    ...(db ? [{ keys: 'd', handler: () => go('/db/$db', { db }) }] : []),
    ...(db && table
      ? [
          { keys: 't', handler: () => go('/db/$db/table/$table/structure', { db, table }) },
          { keys: 'b', handler: () => go('/db/$db/table/$table', { db, table }) },
        ]
      : []),
    {
      keys: 's',
      handler: () =>
        db && table ? go('/db/$db/table/$table/sql', { db, table }) : db ? go('/db/$db/sql', { db }) : go('/sql'),
    },
    ...(db
      ? [
          {
            keys: 'e',
            handler: () => (table ? go('/db/$db/table/$table/export', { db, table }) : go('/db/$db/export', { db })),
          },
        ]
      : []),
  ])
}
