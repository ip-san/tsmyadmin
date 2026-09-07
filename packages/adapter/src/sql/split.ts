import type { Dialect } from '@tsmyadmin/shared'

export interface Statement {
  /** Statement text (leading comments are kept so the user sees what ran). */
  sql: string
  /** 1-based line of the statement's first code token in the original script (its leading comments sit above). */
  line: number
}

const DELIMITER_LINE = /^[ \t]*DELIMITER[ \t]+(\S+)[ \t]*(?:\r?\n|$)/i

/**
 * Splits a multi-statement script on top-level statement terminators (`;` by default).
 * Handles: '...' / "..." strings (with '' and MySQL backslash escapes), `...` identifiers (MySQL),
 * -- and # (MySQL) line comments, block comments, PostgreSQL dollar quoting ($$ / $tag$), and the MySQL client's
 * `DELIMITER xx` command (a line on its own; `DELIMITER ;` restores the default) so stored routines can be pasted as-is.
 * Chunks that contain only comments/whitespace are dropped.
 */
/** `COPY table (cols) FROM stdin` — the data that follows is part of the statement (see splitStatements). */
const COPY_FROM_STDIN = /^COPY\b[\s\S]*?\bFROM\s+STDIN\b/i

const VERSION_COMMENT = /^\/\*!\d*\s*([\s\S]*?)\s*\*\/$/

/**
 * The statement text without the comments a dump writes above it, read as the server reads them: `#` and `-- `
 * (space required) on MySQL, `--` and nested block comments on PostgreSQL. A MySQL `/*!…*\/` versioned comment is
 * code and stays.
 */
export function stripLeadingComments(sql: string, dialect: Dialect): string {
  let i = 0
  for (;;) {
    while (i < sql.length && /\s/.test(sql[i] as string)) i++
    if (sql.startsWith('--', i) && (dialect !== 'mysql' || /\s/.test(sql[i + 2] ?? '\n'))) {
      const end = sql.indexOf('\n', i)
      i = end < 0 ? sql.length : end + 1
    } else if (sql[i] === '#' && dialect === 'mysql') {
      const end = sql.indexOf('\n', i)
      i = end < 0 ? sql.length : end + 1
    } else if (sql.startsWith('/*', i) && (dialect !== 'mysql' || !sql.startsWith('/*!', i))) {
      let depth = 0
      let k = i
      for (; k < sql.length; k++) {
        if (sql.startsWith('/*', k)) {
          depth++
          k++
        } else if (sql.startsWith('*/', k)) {
          depth--
          k++
          if (depth === 0 || dialect === 'mysql') break
        }
      }
      // An unterminated comment swallows the rest: nothing left to run.
      if (k >= sql.length) return ''
      i = k + 1
    } else return sql.slice(i)
  }
}
/** One `name = value` pair of a SET list (the value runs to the next comma outside quotes / parentheses). */
const SET_ASSIGNMENT =
  /(?:^|,)\s*(?:(?:SESSION|LOCAL)\s+|@@(?:session\.|global\.|persist\.|persist_only\.)?)?(sql_mode|autocommit|@[A-Za-z0-9_$.]+)\s*:?=\s*((?:'[^']*'|"[^"]*"|\([^)]*\)|[^,'"()])*)/gi
const SQL_MODE_REF = /^@@(?:session\.)?sql_mode$/i

/**
 * The session-level `name = value` pairs of a MySQL SET statement (sql_mode, autocommit, user variables) —
 * `SET @@global.x = …, @@session.x = …` keeps only the session pair — with names lower-cased and values trimmed.
 * [] for any other statement. Comments above the statement and a `/*!…*\/` wrapper are ignored.
 */
export function setAssignments(statement: string): { name: string; value: string }[] {
  let sql = stripLeadingComments(statement, 'mysql')
  sql = VERSION_COMMENT.exec(sql)?.[1] ?? sql
  if (!/^SET\s/i.test(sql) || /^SET\s+(?:GLOBAL|PERSIST|PERSIST_ONLY)\s/i.test(sql)) return []
  const out: { name: string; value: string }[] = []
  for (const m of sql.slice(3).matchAll(SET_ASSIGNMENT)) {
    if (/@@(?:global|persist|persist_only)\./i.test(m[0] ?? '')) continue
    out.push({ name: (m[1] ?? '').toLowerCase(), value: (m[2] ?? '').trim() })
  }
  return out
}

/**
 * Follows what a MySQL `SET` statement does to NO_BACKSLASH_ESCAPES: a literal value decides directly, a user
 * variable restores what it was saved from (`SET @saved = @@sql_mode`; the default mode when the script never saved
 * it), REPLACE / CONCAT of the token are read as removing / adding it, and any other expression leaves the flag
 * as it is rather than guessing. The mysql CLI
 * does not parse this at all (it reads the server status after each statement); this is the closest static form.
 */
function trackSqlMode(statement: string, current: boolean, saved: Map<string, boolean>): boolean {
  let next = current
  for (const { name, value } of setAssignments(statement)) {
    if (name.startsWith('@')) {
      // `SET @saved = @@sql_mode` remembers the mode in force now.
      if (SQL_MODE_REF.test(value)) saved.set(name, next)
      continue
    }
    if (name !== 'sql_mode') continue
    const literal = /^(['"])([\s\S]*)\1$/.exec(value)
    if (literal) next = /NO_BACKSLASH_ESCAPES/i.test(literal[2] ?? '')
    // The server default never has the flag; a single unquoted mode name is read like a literal.
    else if (/^DEFAULT$/i.test(value)) next = false
    else if (/^[A-Z_]+$/i.test(value)) next = /^NO_BACKSLASH_ESCAPES$/i.test(value)
    // An unknown variable was saved before the script started: restoring it means back to the usual mode.
    else if (value.startsWith('@') && !value.startsWith('@@')) next = saved.get(value.toLowerCase()) ?? false
    else if (/^REPLACE\s*\(\s*@@(?:session\.)?sql_mode\s*,\s*['"]NO_BACKSLASH_ESCAPES['"]/i.test(value)) next = false
    else if (/^CONCAT(?:_WS)?\s*\([^)]*NO_BACKSLASH_ESCAPES/i.test(value)) next = true
  }
  return next
}

export function splitStatements(
  input: string,
  dialect: Dialect,
  /**
   * Receives the statement delimiter in force when the input ends (`;` unless a DELIMITER line changed it) and
   * whether the input ended inside a literal, comment or COPY block (whatever follows would be swallowed).
   */
  state?: { delimiter?: string; unterminated?: boolean }
): Statement[] {
  let unterminated = false
  const out: Statement[] = []
  const n = input.length
  let i = 0
  let start = 0
  let line = 1
  let startLine = 1
  let hasCode = false
  let delimiter = ';'
  // PostgreSQL SQL-standard function bodies: `BEGIN ATOMIC ... END` holds statements separated by `;`.
  // CASE ... END inside such a body must not close it.
  let atomicDepth = 0
  let caseDepth = 0
  // MySQL: a `SET sql_mode = '…NO_BACKSLASH_ESCAPES…'` statement changes how later string literals are read
  // (a dump wraps programs created under that mode in exactly such statements).
  let noBackslash = false
  // `SET @saved = @@sql_mode` … `SET sql_mode = @saved`: the value a user variable holds, when known.
  const savedModes = new Map<string, boolean>()

  /** After a `COPY … FROM stdin;` the data lines up to the `\.` terminator belong to that statement. */
  let copyData = false
  const flush = (end: number) => {
    const sql = input.slice(start, end).trim()
    if (hasCode && sql.length > 0) {
      // pg_dump / mysqldump put a comment block above every statement: errors point at the code below it.
      const body = stripLeadingComments(sql, dialect)
      const lead = sql.slice(0, sql.length - body.length)
      out.push({ sql, line: startLine + lead.split('\n').length - 1 })
      if (dialect === 'mysql') noBackslash = trackSqlMode(sql, noBackslash, savedModes)
      if (dialect === 'postgres' && COPY_FROM_STDIN.test(body)) copyData = true
    }
    hasCode = false
  }
  const countLines = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (input[k] === '\n') line++
  }
  const skipTo = (stop: number) => {
    countLines(i, stop)
    i = stop
  }

  while (i < n) {
    const ch = input[i] as string
    if (copyData) {
      // The block ends at a line holding only `\.`; the data (tabs, backslashes, quotes) is not SQL.
      copyData = false
      // The data starts on the next line (CRLF files included: a leading `\r` would be a phantom empty row).
      const from = input.startsWith('\r\n', i) ? i + 2 : input[i] === '\n' ? i + 1 : i
      const m = /(?:^|\n)\\\.[ \t]*(?:\r?\n|$)/.exec(input.slice(from))
      const stop = m ? from + m.index + m[0].length : n
      if (!m) unterminated = true
      const last = out[out.length - 1]
      // The terminator line itself is kept (`\.`), minus its line ending, so the executor can find the block's end.
      if (last) last.sql = `${last.sql}\n${input.slice(from, stop).replace(/[ \t]*\r?\n$/, '')}`
      skipTo(stop)
      start = i
      startLine = line
      continue
    }
    // psql meta-commands (`\restrict`, `\connect`, `\.`) are a line each, only between statements.
    if (dialect === 'postgres' && ch === '\\' && !hasCode && /(?:^|\n)[ \t]*$/.test(input.slice(start, i))) {
      const end = input.indexOf('\n', i)
      const stop = end < 0 ? n : end
      const command = input.slice(i, stop).trim()
      // pg_dump ≥ 17.6 brackets the file in \restrict / \unrestrict, which only psql understands: no-ops here.
      if (!/^\\(?:un)?restrict\b/.test(command)) out.push({ sql: command, line })
      skipTo(stop)
      start = i
      startLine = line
      continue
    }
    if (i === start && /\s/.test(ch)) {
      if (ch === '\n') line++
      i++
      start = i
      startLine = line
      continue
    }
    // DELIMITER is a client command: it must start a line and no code of the current statement may precede it
    // (leading comments are fine — mysqldump routine dumps begin with them).
    if (
      !hasCode &&
      dialect === 'mysql' &&
      (ch === 'D' || ch === 'd') &&
      /(?:^|\n)[ \t]*$/.test(input.slice(start, i))
    ) {
      const m = DELIMITER_LINE.exec(input.slice(i))
      if (m) {
        delimiter = m[1] as string
        skipTo(i + m[0].length)
        start = i
        startLine = line
        continue
      }
    }
    // MySQL only opens a `--` comment when whitespace (or the end of input) follows: `2--2` is `2 - (-2)`.
    if (ch === '-' && input[i + 1] === '-' && (dialect !== 'mysql' || /\s/.test(input[i + 2] ?? '\n'))) {
      const end = input.indexOf('\n', i)
      skipTo(end === -1 ? n : end)
      continue
    }
    if (ch === '#' && dialect === 'mysql') {
      const end = input.indexOf('\n', i)
      skipTo(end === -1 ? n : end)
      continue
    }
    if (ch === '/' && input[i + 1] === '*') {
      // MySQL executes "/*!40014 ... */" version comments (mysqldump's whole preamble is written that way), so
      // such a chunk is real code and must not be dropped as comment-only.
      if (dialect === 'mysql' && input[i + 2] === '!') hasCode = true
      // PostgreSQL nests block comments; MySQL ends at the first */.
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (dialect === 'postgres' && input[j] === '/' && input[j + 1] === '*') {
          depth++
          j += 2
        } else if (input[j] === '*' && input[j + 1] === '/') {
          depth--
          j += 2
        } else j++
      }
      if (depth !== 0) unterminated = true
      skipTo(depth === 0 ? j : n)
      continue
    }
    if (ch === "'" || ch === '"' || (ch === '`' && dialect === 'mysql')) {
      hasCode = true
      // PostgreSQL E'...' strings use backslash escapes like MySQL literals do.
      const escapeString =
        (dialect === 'mysql' && ch !== '`' && !noBackslash) ||
        (dialect === 'postgres' && ch === "'" && /[eE]/.test(input[i - 1] ?? '') && !/[\w$]/.test(input[i - 2] ?? ''))
      let j = i + 1
      while (j < n) {
        const c = input[j]
        if (c === '\\' && escapeString) {
          j += 2
          continue
        }
        if (c === ch) {
          if (input[j + 1] === ch) {
            j += 2
            continue
          }
          break
        }
        j++
      }
      if (j >= n) unterminated = true
      skipTo(Math.min(j + 1, n))
      continue
    }
    if (ch === '$' && dialect === 'postgres') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(input.slice(i))
      if (m) {
        hasCode = true
        const tag = m[0]
        const end = input.indexOf(tag, i + tag.length)
        if (end === -1) unterminated = true
        skipTo(end === -1 ? n : end + tag.length)
        continue
      }
    }
    if (dialect === 'postgres' && /[A-Za-z_]/.test(ch) && !/[\w$]/.test(input[i - 1] ?? '')) {
      const word = /^[A-Za-z_][\w$]*/.exec(input.slice(i))?.[0] ?? ''
      const upper = word.toUpperCase()
      if (upper === 'BEGIN' && /^\s+ATOMIC\b/i.test(input.slice(i + word.length))) atomicDepth++
      else if (atomicDepth > 0 && upper === 'CASE') caseDepth++
      else if (atomicDepth > 0 && upper === 'END') {
        if (caseDepth > 0) caseDepth--
        else atomicDepth--
      }
      hasCode = true
      skipTo(i + word.length)
      continue
    }
    if (atomicDepth === 0 && (delimiter.length === 1 ? ch === delimiter : input.startsWith(delimiter, i))) {
      flush(i)
      i += delimiter.length
      start = i
      startLine = line
      continue
    }
    if (ch === '\n') line++
    else if (!/\s/.test(ch)) hasCode = true
    i++
  }
  flush(n)
  if (state) {
    state.delimiter = delimiter
    state.unterminated = unterminated
  }
  return out
}
