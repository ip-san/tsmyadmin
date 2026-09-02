import type { Cell, Dialect, EventInfo, Namespace, RoutineKind, TableSchema, TriggerInfo } from '@tsmyadmin/shared'
import { isViewKind } from '@tsmyadmin/shared'
import type { DropTarget, ProgramStatement, SqlExporter } from '../types.ts'
import { cellLiteral, pgLiteral } from './literal.ts'
import { quoteIdent, quoteTable } from './quote.ts'

/**
 * Text for a `--` comment line of a dump. Identifiers may contain line breaks on both servers; left as is, a
 * table named `t\nDROP TABLE x` would turn the comment into a statement the restore executes.
 */
export function commentText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ')
}

/**
 * Columns whose values the server computes and that therefore cannot be part of an INSERT: MySQL
 * `VIRTUAL GENERATED` / `STORED GENERATED`, PostgreSQL `generated stored`. MySQL's `DEFAULT_GENERATED`
 * (an expression default such as CURRENT_TIMESTAMP) is an ordinary column whose values must be dumped.
 */
export function isGeneratedColumn(extra: string): boolean {
  return /^(?:(?:VIRTUAL|STORED) )?GENERATED\b/i.test(extra)
}

/**
 * Moves the sequence behind an identity / serial column past the values now in the table. Nothing happens for
 * an empty table or when there is no sequence, and the value is clamped to the sequence minimum (a `MINVALUE
 * 1000` sequence must not be set to 1, nor to a negative id).
 */
export function pgAdvanceSequence(quotedTable: string, column: string, sequence?: string): string {
  const col = quoteIdent('postgres', column)
  // An inheritance child owns no sequence: the one its inherited nextval() default names is advanced instead.
  const seq = sequence
    ? `${pgLiteral(sequence)}::regclass`
    : `pg_get_serial_sequence(${pgLiteral(quotedTable)}, ${pgLiteral(column)})::regclass`
  return `SELECT setval(s.seqrelid, GREATEST(m.max_id, s.seqmin), m.max_id >= s.seqmin) FROM (SELECT MAX(${col})::bigint AS max_id FROM ${quotedTable}) m JOIN pg_sequence s ON s.seqrelid = ${seq} WHERE m.max_id IS NOT NULL`
}

/** The sequence a `nextval('…'::regclass)` default names, as written. */
function sequenceOfDefault(def: string | null): string | undefined {
  const m = def === null ? null : /^nextval\('((?:[^']|'')*)'::regclass\)$/.exec(def)
  return m ? (m[1] ?? '').replace(/''/g, "'") : undefined
}

/**
 * Table reference inside a dump. MySQL dumps name tables without the database (as mysqldump does): SHOW CREATE
 * TABLE is unqualified anyway, and the target database is chosen at import time — a dump of `prod` must restore
 * into `staging` without touching `prod`. PostgreSQL dumps are schema-qualified (search_path is set as well).
 */
function dumpTable(dialect: Dialect, ns: Namespace, table: string): string {
  return dialect === 'mysql' ? quoteIdent(dialect, table) : quoteTable(dialect, ns, table)
}

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

/** `user@host` as information_schema prints it → `\`user\`@\`host\``. */
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

function quoteAccount(account: string): string {
  const at = account.lastIndexOf('@')
  const user = at === -1 ? account : account.slice(0, at)
  const host = at === -1 ? '%' : account.slice(at + 1)
  return `${quoteIdent('mysql', user)}@${quoteIdent('mysql', host)}`
}

/** Dump statements: every identifier is quoted and every value goes through cellLiteral. Dialect-agnostic. */
/** `name(identity arguments)` for DROP FUNCTION / PROCEDURE, read from a pg_get_functiondef statement. */
function pgRoutineSignature(statement: string): string | null {
  // The name may be quoted (and then contain spaces or parentheses) and schema-qualified.
  const m = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+((?:"(?:[^"]|"")*"|[^\s("])+)\(/i.exec(statement)
  if (!m) return null
  // Argument list up to the matching parenthesis, split at top-level commas; DEFAULT expressions are not part
  // of a signature.
  const args: string[] = []
  let depth = 1
  let quote: string | null = null
  let current = ''
  let closed = false
  for (const ch of statement.slice(m[0].length)) {
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') quote = ch
    else if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    if (depth === 0) {
      closed = true
      break
    }
    if (ch === ',' && depth === 1) {
      args.push(current)
      current = ''
    } else current += ch
  }
  if (!closed) return null
  if (current.trim().length > 0) args.push(current)
  const identity = args.map((a) => a.replace(/\s+DEFAULT\s[\s\S]*$/i, '').trim()).filter((a) => a.length > 0)
  return `${m[1]}(${identity.join(', ')})`
}

export function createExporter(dialect: Dialect): SqlExporter {
  const id = (name: string) => quoteIdent(dialect, name)
  const withoutDefiner = (sql: string, strip: boolean) =>
    strip && dialect === 'mysql' ? sql.replace(DEFINER, '$1') : sql
  const lit = (text: string) => cellLiteral(dialect, text)
  return {
    withoutDefiner: (sql) => withoutDefiner(sql, true),
    routine(_ns, kind: RoutineKind, name, definition, stripDefiner): ProgramStatement {
      // PostgreSQL's pg_get_functiondef is a CREATE OR REPLACE (a DROP would fail while a trigger depends on
      // the function); MySQL has no OR REPLACE for routines, so it drops first. The dump is database-relative.
      if (dialect === 'postgres') return { sql: definition }
      // A MariaDB package body is dropped with its package; DROP PACKAGE BODY IF EXISTS is still harmless.
      const object = kind.toUpperCase()
      return { sql: `DROP ${object} IF EXISTS ${id(name)}${DELIM}\n${withoutDefiner(definition, stripDefiner)}` }
    },
    trigger(ns, t: TriggerInfo, stripDefiner): ProgramStatement {
      if (dialect === 'mysql') {
        const definition = t.definition ?? ''
        // The original statement (SHOW CREATE TRIGGER) restores as written; a body from information_schema
        // (escapes already processed) gets the header rebuilt from the trigger's metadata.
        const definer = stripDefiner || !t.definer ? '' : ` DEFINER=${quoteAccount(t.definer)}`
        const create = /^CREATE\s/i.test(definition)
          ? withoutDefiner(
              unqualifyHeader(definition, ns.database, /\bFOR\s+EACH\s+(?:ROW|STATEMENT)\b/i),
              stripDefiner
            )
          : `CREATE${definer} TRIGGER ${id(t.name)} ${t.timing} ${t.events} ON ${id(t.table)} FOR EACH ${t.orientation}\n${definition}`
        return { sql: `DROP TRIGGER IF EXISTS ${id(t.name)}${DELIM}\n${create}`, sqlMode: t.sqlMode }
      }
      // A trigger switched off (or set to fire always / on replicas) comes back the same way.
      const mode = { origin: '', always: 'ENABLE ALWAYS', replica: 'ENABLE REPLICA', disabled: 'DISABLE' }[t.fireMode]
      const fire = mode ? `;\nALTER TABLE ${quoteTable(dialect, ns, t.table)} ${mode} TRIGGER ${id(t.name)}` : ''
      return {
        sql: `DROP TRIGGER IF EXISTS ${id(t.name)} ON ${quoteTable(dialect, ns, t.table)};\n${t.definition ?? ''}${fire}`,
      }
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
      if (dialect !== 'mysql') return statements.map((s) => `${s.sql};\n\n`).join('')
      // MySQL stores the creating session's sql_mode (and an event's time zone) into the program: set them
      // around each CREATE as mysqldump does, then restore the dump's own settings.
      const parts = statements.map((s) => {
        const mode = s.sqlMode === undefined || s.sqlMode === null ? '' : `SET sql_mode = ${lit(s.sqlMode)}${DELIM}\n`
        const zone = s.timeZone ? `SET time_zone = ${lit(s.timeZone)}${DELIM}\n` : ''
        return `${mode}${zone}${s.sql}${DELIM}\n\n`
      })
      return `SET @tsmyadmin_sql_mode = @@sql_mode;\nSET @tsmyadmin_time_zone = @@time_zone;\nDELIMITER ${DELIM}\n${parts.join('')}DELIMITER ;\nSET sql_mode = @tsmyadmin_sql_mode;\nSET time_zone = @tsmyadmin_time_zone;\n\n`
    },
    preamble: (ns: Namespace) =>
      dialect === 'postgres'
        ? // Index / view definitions are printed relative to the schema, so restore into it explicitly. Function
          // bodies are not validated at creation (pg_dump does the same) so their order does not matter.
          [
            `SET search_path TO ${quoteIdent(dialect, ns.schema ?? 'public')};`,
            'SET check_function_bodies = false;',
            'SET standard_conforming_strings = on;',
          ]
        : [
            `-- Database: ${commentText(ns.database)} (statements are unqualified: import into the database of your choice)`,
            // Literals are written with backslash escapes, which NO_BACKSLASH_ESCAPES would break on import.
            "SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';",
            'SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;',
          ],
    postamble: () =>
      dialect === 'mysql' ? ['SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;', 'SET SQL_MODE = @OLD_SQL_MODE;'] : [],
    literal: (cell: Cell) => cellLiteral(dialect, cell),
    dropAll(ns: Namespace, objects: DropTarget[]): string[] {
      const out: string[] = []
      const tables: string[] = []
      for (const o of objects) {
        if (o.kind === 'table') tables.push(dumpTable(dialect, ns, o.name))
        else if (o.kind === 'routine') {
          for (const s of o.statements) {
            const signature = pgRoutineSignature(s)
            const object = /^CREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE/i.test(s) ? 'PROCEDURE' : 'FUNCTION'
            if (signature) out.push(`DROP ${object} IF EXISTS ${signature}`)
          }
        } else {
          const kind = o.kind === 'materialized_view' ? 'MATERIALIZED VIEW' : 'VIEW'
          out.push(`DROP ${kind} IF EXISTS ${dumpTable(dialect, ns, o.name)}`)
        }
      }
      if (tables.length > 0) out.push(`DROP TABLE IF EXISTS ${tables.join(', ')}`)
      return out
    },
    dropIfExists(ns: Namespace, schema: TableSchema): string {
      const kind =
        schema.kind === 'materialized_view'
          ? 'MATERIALIZED VIEW'
          : schema.kind === 'sequence'
            ? 'SEQUENCE'
            : isViewKind(schema.kind)
              ? 'VIEW'
              : 'TABLE'
      // MySQL restores with FOREIGN_KEY_CHECKS off; PostgreSQL dumps drop everything up front through dropAll.
      return `DROP ${kind} IF EXISTS ${dumpTable(dialect, ns, schema.name)}`
    },
    insert(ns: Namespace, table: string, columns: string[], rows: Cell[][], options = {}): string {
      if (rows.length === 0) return ''
      const cols = columns.map((c) => quoteIdent(dialect, c)).join(', ')
      const values = rows.map((r) => `(${columns.map((_, i) => cellLiteral(dialect, r[i] ?? null)).join(', ')})`)
      const overriding = dialect === 'postgres' && options.overriding ? ' OVERRIDING SYSTEM VALUE' : ''
      return `INSERT INTO ${dumpTable(dialect, ns, table)} (${cols})${overriding} VALUES\n${values.join(',\n')};`
    },
    afterData(ns: Namespace, schema: TableSchema): string[] {
      if (dialect !== 'postgres') return [] // AUTO_INCREMENT follows explicit values on MySQL
      const t = quoteTable(dialect, ns, schema.name)
      return schema.columns
        .filter((c) => c.extra.startsWith('identity') || c.extra === 'serial')
        .map(
          (c) =>
            `${pgAdvanceSequence(t, c.name, schema.inherits.length > 0 && c.extra === 'serial' ? sequenceOfDefault(c.default) : undefined)};`
        )
    },
  }
}
