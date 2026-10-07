import type { EventInfo, Namespace, RoutineKind, TriggerInfo } from '@tsmyadmin/shared'
import { commentText, createCommonExporter, type InsertStyle } from '../sql/export.ts'
import { cellLiteral } from '../sql/literal.ts'
import { quoteIdent } from '../sql/quote.ts'
import type { ProgramStatement, SqlExporter } from '../types.ts'

/**
 * The `DEFINER=user@host` clause in the header of a MySQL CREATE statement (view, routine). Anchored to the
 * header so the same text inside a body's string literal (`SELECT 'DEFINER=root@localhost'`) is left alone.
 */
const DEFINER =
  /^(CREATE\s+(?:ALGORITHM\s*=\s*\w+\s+)?)DEFINER\s*=\s*(?:`(?:[^`]|``)*`|'(?:[^']|'')*'|"(?:[^"]|"")*")@(?:`(?:[^`]|``)*`|'(?:[^']|'')*'|"(?:[^"]|"")*")\s+/i

/**
 * Statement delimiter inside program blocks. `;;` (mysqldump's choice) rather than `$$`: a body may contain `$$`
 * inside an unquoted identifier (`a$$b`), which no string-aware splitter can tell from the delimiter.
 */
const DELIM = ';;'

/**
 * MariaDB's SHOW CREATE TRIGGER / EVENT returns the statement as typed, database qualifiers included; a dump is
 * database-relative, so `db.` / `\`db\`.` are removed from the header (up to the body) when they name the dumped
 * database. The body is left alone.
 */
function unqualifyHeader(statement: string, database: string, bodyStart: RegExp, afterMatch = false): string {
  const m = bodyStart.exec(statement)
  if (!m) return statement
  const escaped = database.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const quoted = quoteIdent('mysql', database).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const qualifier = new RegExp(`(?<![\\w$\`])(?:${quoted}|${escaped})\\.`, 'g')
  if (afterMatch) {
    // Only the token right after the match (the object name) may carry the qualifier.
    const at = m.index + m[0].length
    const rest = statement.slice(at).replace(new RegExp(`^(?:${quoted}|${escaped})\\.`), '')
    return statement.slice(0, at) + rest
  }
  return statement.slice(0, m.index).replace(qualifier, '') + statement.slice(m.index)
}

/** `user@host` as information_schema prints it → `\`user\`@\`host\``. */
function quoteAccount(account: string): string {
  const at = account.lastIndexOf('@')
  const user = at === -1 ? account : account.slice(0, at)
  const host = at === -1 ? '%' : account.slice(at + 1)
  return `${quoteIdent('mysql', user)}@${quoteIdent('mysql', host)}`
}

const mysqlInsertStyle: InsertStyle = {
  verb: (kind, options) => (kind === 'replace' ? 'REPLACE' : options.ignore ? 'INSERT IGNORE' : 'INSERT'),
  needsKey: (kind) => kind === 'update',
  overriding: () => '',
  conflict: () => '',
}

const id = (name: string) => quoteIdent('mysql', name)
const lit = (text: string) => cellLiteral('mysql', text)
const withoutDefiner = (sql: string, strip: boolean) => (strip ? sql.replace(DEFINER, '$1') : sql)

/** The MySQL / MariaDB dump statements: the common ones, and the routines, triggers, events and settings only it has. */
export const mysqlExporter: SqlExporter = {
  ...createCommonExporter('mysql', mysqlInsertStyle, () => null),
  withoutDefiner: (sql) => withoutDefiner(sql, true),
  routine(_ns, kind: RoutineKind, name, definition, stripDefiner): ProgramStatement {
    // MySQL has no OR REPLACE for routines, so it drops first. The dump is database-relative.
    // A MariaDB package body is dropped with its package; DROP PACKAGE BODY IF EXISTS is still harmless.
    const object = kind.toUpperCase()
    return { sql: `DROP ${object} IF EXISTS ${id(name)}${DELIM}\n${withoutDefiner(definition, stripDefiner)}` }
  },
  trigger(ns, t: TriggerInfo, stripDefiner): ProgramStatement {
    const definition = t.definition ?? ''
    // The original statement (SHOW CREATE TRIGGER) restores as written; a body from information_schema
    // (escapes already processed) gets the header rebuilt from the trigger's metadata.
    const definer = stripDefiner || !t.definer ? '' : ` DEFINER=${quoteAccount(t.definer)}`
    const create = /^CREATE\s/i.test(definition)
      ? withoutDefiner(unqualifyHeader(definition, ns.database, /\bFOR\s+EACH\s+(?:ROW|STATEMENT)\b/i), stripDefiner)
      : `CREATE${definer} TRIGGER ${id(t.name)} ${t.timing} ${t.events} ON ${id(t.table)} FOR EACH ${t.orientation}\n${definition}`
    return { sql: `DROP TRIGGER IF EXISTS ${id(t.name)}${DELIM}\n${create}`, sqlMode: t.sqlMode }
  },
  event(ns, e: EventInfo, stripDefiner): ProgramStatement {
    // SHOW CREATE EVENT text restores as written (a COMMENT precedes DO, so only the name is unqualified);
    // a DO body from information_schema gets its header rebuilt.
    const definition = unqualifyHeader(e.definition ?? '', ns.database, /\bEVENT\s+(?:IF\s+NOT\s+EXISTS\s+)?/i, true)
    if (/^CREATE\s/i.test(definition)) {
      return {
        sql: `DROP EVENT IF EXISTS ${id(e.name)}${DELIM}\n${withoutDefiner(definition, stripDefiner)}`,
        sqlMode: e.sqlMode,
        timeZone: e.timeZone,
      }
    }
    const definer = stripDefiner || !e.definer ? '' : ` DEFINER=${quoteAccount(e.definer)}`
    const schedule = e.schedule.startsWith('AT ') ? `AT ${lit(e.schedule.slice(3))}` : e.schedule
    const starts = e.starts ? ` STARTS ${lit(e.starts)}` : ''
    const ends = e.ends ? ` ENDS ${lit(e.ends)}` : ''
    const completion = e.onCompletion ? ` ON COMPLETION ${e.onCompletion}` : ''
    const status = e.status === 'ENABLED' ? 'ENABLE' : 'DISABLE'
    const comment = e.comment ? ` COMMENT ${lit(e.comment)}` : ''
    return {
      sql: `DROP EVENT IF EXISTS ${id(e.name)}${DELIM}\nCREATE${definer} EVENT ${id(e.name)} ON SCHEDULE ${schedule}${starts}${ends}${completion} ${status}${comment}\nDO ${e.definition ?? ''}`,
      sqlMode: e.sqlMode,
      timeZone: e.timeZone,
    }
  },
  programBlock(statements) {
    if (statements.length === 0) return ''
    // MySQL stores the creating session's sql_mode (and an event's time zone) into the program: set them
    // around each CREATE as mysqldump does, then restore the dump's own settings.
    const parts = statements.map((s) => {
      const mode = s.sqlMode === undefined || s.sqlMode === null ? '' : `SET sql_mode = ${lit(s.sqlMode)}${DELIM}\n`
      const zone = s.timeZone ? `SET time_zone = ${lit(s.timeZone)}${DELIM}\n` : ''
      return `${mode}${zone}${s.sql}${DELIM}\n\n`
    })
    return `SET @tsmyadmin_sql_mode = @@sql_mode;\nSET @tsmyadmin_time_zone = @@time_zone;\nDELIMITER ${DELIM}\n${parts.join('')}DELIMITER ;\nSET sql_mode = @tsmyadmin_sql_mode;\nSET time_zone = @tsmyadmin_time_zone;\n\n`
  },
  preamble: (ns: Namespace) => [
    `-- Database: ${commentText(ns.database)} (statements are unqualified: import into the database of your choice)`,
    // Literals are written with backslash escapes, which NO_BACKSLASH_ESCAPES would break on import.
    "SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';",
    'SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;',
  ],
  postamble: () => ['SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;', 'SET SQL_MODE = @OLD_SQL_MODE;'],
  // AUTO_INCREMENT follows explicit values on MySQL.
  afterData: (): string[] => [],
}
