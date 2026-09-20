import type { Dialect } from '@tsmyadmin/shared'

/** A page of each vendor's manual, by what the tab is about. `null`: that server has nothing to point to. */
const PAGES: Record<string, { mysql: string; postgres: string | null }> = {
  databases: { mysql: 'show-databases', postgres: 'managing-databases' },
  sql: { mysql: 'sql-statements', postgres: 'sql-commands' },
  status: { mysql: 'server-status-variables', postgres: 'monitoring-stats' },
  variables: { mysql: 'server-system-variables', postgres: 'runtime-config' },
  processes: { mysql: 'show-processlist', postgres: 'monitoring-stats' },
  users: { mysql: 'account-management-statements', postgres: 'user-manag' },
  privileges: { mysql: 'privilege-system', postgres: 'ddl-priv' },
  export: { mysql: 'mysqldump', postgres: 'app-pgdump' },
  import: { mysql: 'load-data', postgres: 'sql-copy' },
  structure: { mysql: 'create-table', postgres: 'sql-createtable' },
  browse: { mysql: 'select', postgres: 'sql-select' },
  search: { mysql: 'select', postgres: 'sql-select' },
  query: { mysql: 'select', postgres: 'sql-select' },
  insert: { mysql: 'insert', postgres: 'sql-insert' },
  operations: { mysql: 'alter-table', postgres: 'sql-altertable' },
  routines: { mysql: 'stored-routines', postgres: 'xfunc' },
  triggers: { mysql: 'triggers', postgres: 'triggers' },
  events: { mysql: 'event-scheduler', postgres: null },
  replication: { mysql: 'replication', postgres: 'high-availability' },
  collations: { mysql: 'charset-charsets', postgres: 'collation' },
  engines: { mysql: 'storage-engines', postgres: 'tableam' },
  plugins: { mysql: 'plugins', postgres: 'extend-extensions' },
}

/** The topic a tab route is about (`/db/$db/table/$table/insert` → insert), or null for one with no manual page. */
export function manualTopic(route: string): string | null {
  const path = route.length > 1 ? route.replace(/\/$/, '') : route
  if (path === '/') return 'databases'
  if (path === '/db/$db') return 'structure'
  if (path === '/db/$db/table/$table') return 'browse'
  const last = path.slice(path.lastIndexOf('/') + 1).replace(/^server-/, '')
  return last in PAGES ? last : null
}

/**
 * The vendor's manual page for a tab. Fixed hosts and a fixed list of pages: nothing from the page or the server
 * (other than its version's major / minor number) reaches the address.
 */
export function manualUrl(dialect: Dialect, version: string, topic: string): string | null {
  const page = PAGES[topic]
  if (!page) return null
  if (dialect === 'postgres') {
    const major = /^(\d+)/.exec(version)?.[1] ?? 'current'
    return page.postgres ? `https://www.postgresql.org/docs/${major}/${page.postgres}.html` : null
  }
  if (/mariadb/i.test(version)) return 'https://mariadb.com/kb/en/documentation/'
  const release = /^(\d+\.\d+)/.exec(version)?.[1] ?? '8.4'
  return `https://dev.mysql.com/doc/refman/${release}/en/${page.mysql}.html`
}
