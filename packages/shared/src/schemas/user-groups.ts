import { z } from 'zod'

/**
 * The tabs a user group can hide (phpMyAdmin's "User groups" menu restriction), by level. The first tab of each
 * level — the database list, a database's structure, a table's rows — always stays, so there is somewhere to land,
 * and so does the security tab, where an account manages its own second factor.
 */
export const GROUP_TABS = {
  server: ['sql', 'status', 'variables', 'processes', 'users', 'replication', 'collations', 'engines', 'plugins'],
  db: [
    'sql',
    'search',
    'query',
    'designer',
    'export',
    'import',
    'privileges',
    'routines',
    'triggers',
    'events',
    'central',
    'tracking',
    'operations',
  ],
  table: [
    'structure',
    'sql',
    'search',
    'insert',
    'export',
    'import',
    'triggers',
    'privileges',
    'tracking',
    'operations',
  ],
} as const
export type GroupTabLevel = keyof typeof GROUP_TABS

const TAB_IDS = new Set(
  (Object.keys(GROUP_TABS) as GroupTabLevel[]).flatMap((level) => GROUP_TABS[level].map((tab) => `${level}:${tab}`))
)

/** `level:tab`, e.g. `db:export`. */
export const GroupTabSchema = z.string().refine((id) => TAB_IDS.has(id), { message: 'Unknown tab' })

/**
 * The tab a route path stands for (`/db/$db/export` → `db:export`), or null for one no group can hide. Kept beside
 * the list so the two cannot drift: a path whose tab is not listed is never hidden.
 */
export function groupTabOf(to: string): string | null {
  const table = /^\/db\/\$db\/table\/\$table\/([a-z]+)$/.exec(to)
  const db = /^\/db\/\$db\/([a-z]+)$/.exec(to)
  const server = /^\/([a-z]+)$/.exec(to)
  const id = table ? `table:${table[1]}` : db ? `db:${db[1]}` : server ? `server:${server[1]}` : null
  return id && TAB_IDS.has(id) ? id : null
}

export const UserGroupBodySchema = z.object({
  name: z.string().trim().min(1).max(64),
  /** Login names (MySQL user names without the host part; PostgreSQL role names). */
  members: z.array(z.string().min(1).max(256)).min(1).max(500),
  hiddenTabs: z.array(GroupTabSchema).max(100),
})
export type UserGroupBody = z.infer<typeof UserGroupBodySchema>

export const UserGroupSchema = UserGroupBodySchema.extend({ id: z.string(), at: z.number() })
export type UserGroup = z.infer<typeof UserGroupSchema>

/** What the signed-in account's groups hide, together. */
export const MyGroupTabsSchema = z.object({ hiddenTabs: z.array(z.string()) })
export type MyGroupTabs = z.infer<typeof MyGroupTabsSchema>
