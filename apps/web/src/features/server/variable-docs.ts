import type { Dialect } from '@tsmyadmin/shared'

/** A variable name is letters, digits, `_` and `.`: anything else never becomes part of a link. */
const SAFE_NAME = /^[A-Za-z0-9_.]+$/

/** The MySQL page a variable is documented on, by its prefix (the reference splits the variables over several pages). */
function mysqlPage(name: string): string {
  if (name.startsWith('innodb_')) return 'innodb-parameters'
  if (/^(gtid_|binlog_|log_bin|sync_binlog|server_id|log_replica|log_slave|relay_log|replica_|slave_|rpl_)/.test(name))
    return name.startsWith('gtid_') ? 'replication-options-gtids' : 'replication-options-binary-log'
  return 'server-system-variables'
}

/**
 * The manual page for a server variable, or null when the name is not one a link can be made from. Fixed hosts only
 * (the vendors' own documentation): the name is the one thing that varies, and it is checked, not just encoded.
 * PostgreSQL's manual has no page per setting, so it links to the manual's own search for the name.
 */
export function variableDocUrl(dialect: Dialect, version: string, name: string): string | null {
  if (!SAFE_NAME.test(name)) return null
  if (dialect === 'postgres') {
    const major = /^(\d+)/.exec(version)?.[1] ?? 'current'
    return `https://www.postgresql.org/search/?u=${encodeURIComponent(`/docs/${major}/`)}&q=${encodeURIComponent(name)}`
  }
  if (/mariadb/i.test(version))
    return `https://mariadb.com/kb/en/${name.startsWith('innodb_') ? 'innodb-system-variables' : 'server-system-variables'}/#${name.toLowerCase()}`
  const release = /^(\d+\.\d+)/.exec(version)?.[1] ?? '8.4'
  return `https://dev.mysql.com/doc/refman/${release}/en/${mysqlPage(name)}.html#sysvar_${name}`
}
