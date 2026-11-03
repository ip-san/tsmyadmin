import { EXPLAINABLE } from '@tsmyadmin/shared'
import { tokenizeSql } from './sql-format.ts'
import { findParameters } from './sql-prepare.ts'

/**
 * A statement as the server logged it, made one the SQL tab takes: pg_stat_statements' `$1`, `$2`… (it keeps no
 * values) become the console's `:p1`, `:p2`…, whose values the tab asks for. Strings, identifiers, comments and
 * dollar quotes are left as they are.
 */
export function namedParameters(sql: string): string {
  const tokens = tokenizeSql(sql)
  let out = ''
  let at = 0
  tokens.forEach((t, i) => {
    const number = tokens[i + 1]
    if (t.kind !== 'punct' || t.text !== '$' || number?.kind !== 'word' || number.gap || !/^\d+$/.test(number.text))
      return
    // Glued to what a parameter cannot follow (`a[$1]` reads as a slice), a space keeps it one.
    const before = tokens[i - 1]
    const space = before && !t.gap && !/^[(,=<>+\-*/%!|&]$/.test(before.text) ? ' ' : ''
    out += `${sql.slice(at, t.start)}${space}:p${number.text}`
    at = number.start + number.text.length
  })
  return out + sql.slice(at)
}

/**
 * What the SQL tab is handed for a logged statement whose plan is asked for, or null where there is no plan to read
 * (not a statement EXPLAIN takes: a COMMIT, a SET, a CALL). `drawn`: its plan can be drawn at once; else its values were
 * not logged, and `hint` (a line comment above it) says to give them first.
 */
export function loggedStatementPlan(sql: string, hint: string): { sql: string; drawn: boolean } | null {
  const text = namedParameters(sql.trim())
  if (!EXPLAINABLE.test(text)) return null
  return findParameters(text).length === 0 ? { sql: text, drawn: true } : { sql: `-- ${hint}\n${text}`, drawn: false }
}
