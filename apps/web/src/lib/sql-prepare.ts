import type { Dialect } from '@tsmyadmin/shared'
import { tokenizeSql } from './sql-format.ts'

/** A `:name` placeholder in the text, and where it sits. */
interface Placeholder {
  name: string
  start: number
  end: number
}

/** Punctuation that can stand right before a placeholder with no space (`(:a`, `,:b`, `=:c`). */
const BEFORE = new Set(['(', ',', '=', '<', '>', '+', '-', '*', '/', '%', '!', '|', '&'])

/**
 * The `:name` placeholders of a statement. Strings, identifiers and comments are skipped, and so are `::` casts,
 * `:=` assignments and `a[i:j]` slices, which look like one.
 */
function placeholders(sql: string): Placeholder[] {
  const tokens = tokenizeSql(sql)
  const out: Placeholder[] = []
  tokens.forEach((t, i) => {
    const name = tokens[i + 1]
    if (t.kind !== 'punct' || t.text !== ':' || name?.kind !== 'word' || name.gap || !/^[A-Za-z_]/.test(name.text))
      return
    const before = tokens[i - 1]
    // Not the second colon of `::`, and not glued to a word or `]` (`a[1:n]`).
    if (before?.text === ':' && !t.gap) return
    if (before && !t.gap && !BEFORE.has(before.text)) return
    out.push({ name: name.text, start: t.start, end: name.start + name.text.length })
  })
  return out
}

/** The names of the placeholders, in order of first appearance. */
export function findParameters(sql: string): string[] {
  return [...new Set(placeholders(sql).map((p) => p.name))]
}

/** A value as an SQL literal: NULL, a plain number as itself, anything else quoted (a backslash escapes on MySQL). */
export function bindLiteral(dialect: Dialect, value: string | null): string {
  if (value === null) return 'NULL'
  if (/^-?\d+(?:\.\d+)?$/.test(value.trim())) return value.trim()
  const text = dialect === 'mysql' ? value.replaceAll('\\', '\\\\') : value
  return `'${text.replaceAll("'", "''")}'`
}

/** The statement with each `:name` replaced by its value's literal (a name with no value keeps its text). */
export function bindParameters(sql: string, dialect: Dialect, values: Readonly<Record<string, string | null>>): string {
  let out = ''
  let at = 0
  for (const p of placeholders(sql)) {
    const value = values[p.name]
    if (value === undefined) continue
    out += sql.slice(at, p.start) + bindLiteral(dialect, value)
    at = p.end
  }
  return out + sql.slice(at)
}

export interface RunOptions {
  /** MySQL: the statement delimiter, as the mysql client's `DELIMITER` (blank or `;` for the default). */
  delimiter: string
  /** Everything runs in one transaction that is rolled back when the script ends. */
  rollback: boolean
  /** MySQL `FOREIGN_KEY_CHECKS = 0`; PostgreSQL `session_replication_role = replica` (superuser). */
  foreignKeyChecks: boolean
  /** Values of the `:name` placeholders; null is NULL. */
  values: Readonly<Record<string, string | null>>
}

export const DEFAULT_RUN_OPTIONS: RunOptions = { delimiter: ';', rollback: false, foreignKeyChecks: true, values: {} }

/** A delimiter is a run of non-space characters: what the client would take after `DELIMITER`. */
export const isValidDelimiter = (d: string) => /^\S{1,16}$/.test(d)

/**
 * The script to send for what is in the editor: placeholders bound, then whatever the options ask to run before it
 * (foreign key checks off, a transaction that stays open and is rolled back by the server when the script ends)
 * and a `DELIMITER` line. The statements added are ordinary ones and show up among the results.
 */
export function prepareScript(sql: string, dialect: Dialect, o: RunOptions): string {
  const bound = bindParameters(sql, dialect, o.values)
  const head: string[] = []
  if (!o.foreignKeyChecks)
    head.push(dialect === 'mysql' ? 'SET FOREIGN_KEY_CHECKS = 0;' : "SET session_replication_role = 'replica';")
  if (o.rollback) head.push(dialect === 'mysql' ? 'START TRANSACTION;' : 'BEGIN;')
  const delimiter =
    dialect === 'mysql' && isValidDelimiter(o.delimiter) && o.delimiter !== ';' ? [`DELIMITER ${o.delimiter}`] : []
  return [...head, ...delimiter, bound].join('\n')
}
