import type { Dialect, Privilege } from '@tsmyadmin/shared'
import { PRIVILEGES } from '@tsmyadmin/shared'

/** Where a privilege on a table comes from: the whole server, the database, the table itself, or some of its columns. */
export type Grant = { scope: 'server' | 'database' | 'table' } | { scope: 'columns'; columns: string[] }
export type TableAccess = Record<Privilege, Grant[]>

interface ParsedGrant {
  /** MySQL prints a partial revoke (`partial_revokes`) as a REVOKE line beside the global GRANT it narrows. */
  verb: 'GRANT' | 'REVOKE'
  privileges: { name: string; columns: string[] | null }[]
  /** `*` for a wildcard part; identifiers unquoted. */
  object: [string, string]
}

/**
 * One `GRANT <privileges> ON <a>.<b> TO …` (or `REVOKE … FROM …`) statement as showGrants prints it (MySQL's SHOW GRANTS; the
 * statements the PostgreSQL adapter builds from the catalog). Anything else — role memberships, `ON SCHEMA`,
 * `ON DATABASE`, PROXY — gives null. Scanned rather than matched with one pattern because identifiers, column lists
 * included, may contain any character, `ON` and `,` among them.
 */
export function parseGrant(dialect: Dialect, statement: string): ParsedGrant | null {
  const quote = dialect === 'mysql' ? '`' : '"'
  const s = statement
  let i = 0
  const space = () => {
    while (i < s.length && /\s/.test(s[i] ?? '')) i++
  }
  const word = (): string | null => {
    const m = /^[A-Za-z_]+/.exec(s.slice(i))
    if (!m) return null
    i += m[0].length
    return m[0].toUpperCase()
  }
  const ident = (): string | null => {
    if (s[i] !== quote) return null
    let out = ''
    for (i++; i < s.length; i++) {
      if (s[i] !== quote) out += s[i]
      else if (s[i + 1] === quote) {
        out += quote
        i++
      } else {
        i++
        return out
      }
    }
    return null
  }

  const verb = word()
  if (verb !== 'GRANT' && verb !== 'REVOKE') return null
  const privileges: ParsedGrant['privileges'] = []
  for (;;) {
    const words: string[] = []
    for (;;) {
      space()
      const at = i
      const w = word()
      if (w === null) break
      if (w === 'ON') {
        i = at
        break
      }
      words.push(w)
    }
    if (words.length === 0) return null
    space()
    let columns: string[] | null = null
    if (s[i] === '(') {
      i++
      columns = []
      for (;;) {
        space()
        const c = ident()
        if (c === null) return null
        columns.push(c)
        space()
        if (s[i] === ',') i++
        else if (s[i] === ')') {
          i++
          break
        } else return null
      }
    }
    privileges.push({ name: words.join(' '), columns })
    space()
    if (s[i] !== ',') break
    i++
  }
  space()
  if (word() !== 'ON') return null
  space()
  const part = () => {
    if (s[i] !== '*') return ident()
    i++
    return '*'
  }
  const a = part()
  if (a === null || s[i] !== '.') return null
  i++
  const b = part()
  if (b === null) return null
  space()
  return word() === (verb === 'GRANT' ? 'TO' : 'FROM') ? { verb, privileges, object: [a, b] } : null
}

/** Whether a MySQL database-level grant's name (`_` and `%` are wildcards unless escaped) covers `db`. */
function coversDatabase(pattern: string, db: string): boolean {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? ''
    if (c === '\\' && i + 1 < pattern.length) {
      i++
      source += (pattern[i] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    } else if (c === '_') source += '.'
    else if (c === '%') source += '[\\s\\S]*'
    else source += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`).test(db)
}

/**
 * What each account may do to one table, privilege by privilege, and why: a grant on the table or on some of its
 * columns, one on the whole database (MySQL), or the whole server (MySQL `*.*`, a PostgreSQL superuser).
 */
export function tableAccess(
  dialect: Dialect,
  db: string,
  schema: string | undefined,
  table: string,
  statements: readonly string[]
): TableAccess {
  const access = Object.fromEntries(PRIVILEGES.map((p) => [p, [] as Grant[]])) as TableAccess
  const add = (names: readonly string[], grant: Grant) => {
    for (const name of names) {
      const all = name === 'ALL' || name === 'ALL PRIVILEGES'
      for (const p of PRIVILEGES) {
        // Two database patterns covering this one say the same thing: listed once.
        if ((all || name === p) && !access[p].some((g) => JSON.stringify(g) === JSON.stringify(grant))) {
          access[p].push(grant)
        }
      }
    }
  }
  /** Privileges a MySQL partial revoke takes away from the global grant, for this database. */
  const revokedHere = new Set<string>()
  for (const statement of statements) {
    if (dialect === 'postgres' && /^ALTER ROLE "(?:[^"]|"")*" SUPERUSER\b/.test(statement)) {
      add(['ALL'], { scope: 'server' })
      continue
    }
    const g = parseGrant(dialect, statement)
    if (!g) continue
    const [a, b] = g.object
    if (g.verb === 'REVOKE') {
      // A partial revoke names one database exactly (no wildcards) and narrows only the grant on *.*.
      if (dialect === 'mysql' && b === '*' && a === db) for (const p of g.privileges) revokedHere.add(p.name)
      continue
    }
    const whole = g.privileges.filter((p) => p.columns === null).map((p) => p.name)
    if (dialect === 'mysql' && a === '*' && b === '*') add(whole, { scope: 'server' })
    else if (dialect === 'mysql' && b === '*' && coversDatabase(a, db)) add(whole, { scope: 'database' })
    else if (a === (dialect === 'mysql' ? db : (schema ?? 'public')) && b === table) {
      add(whole, { scope: 'table' })
      for (const p of g.privileges) if (p.columns !== null) add([p.name], { scope: 'columns', columns: p.columns })
    }
  }
  for (const p of PRIVILEGES) {
    if (revokedHere.has(p) || revokedHere.has('ALL') || revokedHere.has('ALL PRIVILEGES')) {
      access[p] = access[p].filter((g) => g.scope !== 'server')
    }
  }
  return access
}
