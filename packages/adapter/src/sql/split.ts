import type { Dialect } from '@tsmyadmin/shared'

export interface Statement {
  /** Statement text (leading comments are kept so the user sees what ran). */
  sql: string
  /** 1-based line where the statement text starts in the original script. */
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
export function splitStatements(input: string, dialect: Dialect): Statement[] {
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

  const flush = (end: number) => {
    const sql = input.slice(start, end).trim()
    if (hasCode && sql.length > 0) {
      out.push({ sql, line: startLine })
      const mode = /^SET\s+(?:SESSION\s+)?sql_mode\s*=\s*(.*)$/is.exec(sql)
      if (dialect === 'mysql' && mode) noBackslash = /NO_BACKSLASH_ESCAPES/i.test(mode[1] ?? '')
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
      skipTo(Math.min(j + 1, n))
      continue
    }
    if (ch === '$' && dialect === 'postgres') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(input.slice(i))
      if (m) {
        hasCode = true
        const tag = m[0]
        const end = input.indexOf(tag, i + tag.length)
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
  return out
}
