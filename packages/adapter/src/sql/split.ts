import type { Dialect } from '@tsmyadmin/shared'

export interface Statement {
  /** Statement text (leading comments are kept so the user sees what ran). */
  sql: string
  /** 1-based line where the statement text starts in the original script. */
  line: number
}

/**
 * Splits a multi-statement script on top-level semicolons.
 * Handles: '...' / "..." strings (with '' and MySQL backslash escapes), `...` identifiers (MySQL),
 * -- and # (MySQL) line comments, block comments, and PostgreSQL dollar quoting ($$ / $tag$).
 * Chunks that contain only comments/whitespace are dropped.
 * Not supported: the MySQL client `DELIMITER` command (a client-side feature, not SQL).
 */
export function splitStatements(input: string, dialect: Dialect): Statement[] {
  const out: Statement[] = []
  const n = input.length
  let i = 0
  let start = 0
  let line = 1
  let startLine = 1
  let hasCode = false

  const flush = (end: number) => {
    const sql = input.slice(start, end).trim()
    if (hasCode && sql.length > 0) out.push({ sql, line: startLine })
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
    if (ch === '-' && input[i + 1] === '-') {
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
      const end = input.indexOf('*/', i + 2)
      skipTo(end === -1 ? n : end + 2)
      continue
    }
    if (ch === "'" || ch === '"' || (ch === '`' && dialect === 'mysql')) {
      hasCode = true
      let j = i + 1
      while (j < n) {
        const c = input[j]
        if (c === '\\' && dialect === 'mysql' && ch !== '`') {
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
    if (ch === ';') {
      flush(i)
      i++
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
