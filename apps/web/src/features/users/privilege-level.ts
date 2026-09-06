import type { Dialect } from '@tsmyadmin/shared'

export type PrivilegeLevel = 'all' | 'some' | 'none'

/** MySQL privileges that together amount to "everything" on a database (8.4 prints them instead of ALL). */
const WRITE_SET = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER']

/**
 * MySQL: what a global grant (`ON *.*`) gives — it applies to every database and a database-level REVOKE does
 * not touch it. `null` when the account has no global grant beyond USAGE.
 */
export function globalPrivilegeLevel(statements: string[]): Exclude<PrivilegeLevel, 'none'> | null {
  let level: Exclude<PrivilegeLevel, 'none'> | null = null
  for (const s of statements) {
    const m = /^GRANT\s+([\s\S]*?)\s+ON\s+\*\.\*\s+TO\b/i.exec(s)
    if (!m) continue
    const privileges = (m[1] ?? '').toUpperCase()
    if (/\bALL(?:\s+PRIVILEGES)?\b/.test(privileges) || WRITE_SET.every((p) => privileges.includes(p))) return 'all'
    if (privileges.trim() !== 'USAGE') level = 'some'
  }
  return level
}

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
    if (new RegExp(`GRANT ALL PRIVILEGES ON ${target}\\.\\* TO`, 'i').test(text)) return 'all'
    const global = globalPrivilegeLevel(statements)
    if (global === 'all') return 'all'
    return global === 'some' || new RegExp(`GRANT [^\\n]* ON ${target}\\.`, 'i').test(text) ? 'some' : 'none'
  }
  if (/ALTER ROLE "[^"]+" SUPERUSER/.test(text)) return 'all'
  const target = `"${esc(schema ?? 'public')}"`
  // Write privileges on the schema's tables count as "all" (what the grant-all op produces); USAGE / SELECT
  // only (e.g. the PUBLIC usage every role has on `public`) is "some".
  if (new RegExp(`GRANT [^\\n]*\\b(INSERT|UPDATE|DELETE)\\b[^\\n]* ON ${target}\\.`).test(text)) return 'all'
  return new RegExp(`ON (SCHEMA ${target}|${target}\\.|DATABASE "${esc(db)}")`).test(text) ? 'some' : 'none'
}
