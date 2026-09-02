import type { Dialect } from '@tsmyadmin/shared'

export type PrivilegeLevel = 'all' | 'some' | 'none'

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Coarse view of what an account can do in one database, derived from its GRANT statements (showGrants):
 * `all` = superuser / ALL PRIVILEGES on the database (MySQL) or write access to the schema's tables (PostgreSQL),
 * `some` = any other grant that names the database or its schema, `none` = nothing mentions it.
 */
export function privilegeLevel(
  dialect: Dialect,
  db: string,
  schema: string | undefined,
  statements: string[]
): PrivilegeLevel {
  const text = statements.join('\n')
  if (dialect === 'mysql') {
    // SHOW GRANTS prints database patterns as stored: `_` / `%` may appear backslash-escaped (my\_db).
    const target = `\`${esc(db).replace(/[_%]/g, (c) => `\\\\?${c}`)}\``
    if (new RegExp(`GRANT ALL PRIVILEGES ON (\\*\\.\\*|${target}\\.\\*) TO`, 'i').test(text)) return 'all'
    return new RegExp(`GRANT [^\\n]* ON ${target}\\.`, 'i').test(text) ? 'some' : 'none'
  }
  if (/ALTER ROLE "[^"]+" SUPERUSER/.test(text)) return 'all'
  const target = `"${esc(schema ?? 'public')}"`
  // Write privileges on the schema's tables count as "all" (what the grant-all op produces); USAGE / SELECT
  // only (e.g. the PUBLIC usage every role has on `public`) is "some".
  if (new RegExp(`GRANT [^\\n]*\\b(INSERT|UPDATE|DELETE)\\b[^\\n]* ON ${target}\\.`).test(text)) return 'all'
  return new RegExp(`ON (SCHEMA ${target}|${target}\\.|DATABASE "${esc(db)}")`).test(text) ? 'some' : 'none'
}
