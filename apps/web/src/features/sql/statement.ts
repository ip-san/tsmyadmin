export function stripTrailingSemicolons(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '')
}

/**
 * EXPLAIN only makes sense for exactly one statement. A `;` before the end means several — a conservative
 * check (a `;` inside a string literal also disables the button), which is fine for a convenience action.
 */
export function isSingleStatement(sql: string): boolean {
  const body = stripTrailingSemicolons(sql)
  return body.length > 0 && !body.includes(';')
}

/**
 * The text with comments and string / identifier literals blanked out, so keywords are looked for in code only.
 * Deliberately not the adapter's lexer: `apps/web` may not import it (`check:arch`), and this powers an advisory
 * warning, not a correctness decision — over-blanking costs a confirmation, never a wrong answer.
 */
function codeOnly(sql: string): string {
  let out = ''
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i] as string
    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end
      out += ' '
    } else if (c === '#') {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end
      out += ' '
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 1
      out += ' '
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === '\\') j += 2
        else if (sql[j] === c && sql[j + 1] === c) j += 2
        else if (sql[j] === c) break
        else j++
      }
      i = Math.min(j, sql.length)
      out += ' '
    } else out += c
  }
  return out
}

/**
 * Statements in `sql` that would change every row: an `UPDATE` or `DELETE` without a `WHERE`. Advisory only —
 * it asks for a confirmation, so a false positive costs a click and a miss is merely today's behaviour. A
 * `LIMIT` without `WHERE` still counts: it bounds the damage but not which rows.
 */
export function unboundedWrites(sql: string): string[] {
  const code = codeOnly(sql)
  const found: string[] = []
  for (const part of code.split(';')) {
    const body = part.trim()
    if (body === '') continue
    if (/^(?:UPDATE|DELETE)\b/i.test(body) && !/\bWHERE\b/i.test(body)) found.push(body.split(/\s+/)[0] ?? '')
  }
  return found
}
