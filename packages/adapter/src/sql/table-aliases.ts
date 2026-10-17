/** The tables a statement names, by the alias it gives them: what an EXPLAIN that reports aliases is read against. */
import type { Dialect } from '@tsmyadmin/shared'
import { quoteIdent } from './quote.ts'
import { stripComments } from './split.ts'

/** Words that can follow a table where an alias could stand, and so are not one. */
const NOT_ALIAS = new Set(
  (
    'WHERE JOIN ON USING LEFT RIGHT INNER OUTER CROSS NATURAL FULL STRAIGHT_JOIN GROUP ORDER LIMIT OFFSET HAVING ' +
    'WINDOW UNION EXCEPT INTERSECT SET VALUES SELECT FORCE USE IGNORE PARTITION FOR LOCK INTO AS LATERAL RETURNING ' +
    'TABLESAMPLE ONLY DEFAULT'
  ).split(' ')
)

const STRINGS = /'(?:[^'\\]|\\.|'')*'/g

/**
 * Alias (or bare name) → table name, for the tables after FROM (and its comma list), JOIN, UPDATE and INTO. A derived
 * table or a function in FROM has no name to give and is left out, as is anything the reading cannot follow: the
 * caller keeps the alias it has. Quoted names are unquoted; a schema or database before the name is dropped.
 */
export function tableAliases(sql: string, dialect: Dialect): Map<string, string> {
  // The dialect's identifier quote: the first character of an empty quoted name.
  const quote = quoteIdent(dialect, '').charAt(0)
  const ident = `(?:${quote}(?:[^${quote}]|${quote}${quote})+${quote}|[A-Za-z_][\\w$]*)`
  const name = `${ident}(?:\\s*\\.\\s*${ident})*`
  const item = `(${name})(?:\\s+(?:AS\\s+)?(${ident}))?`
  const start = new RegExp(`\\b(?:FROM|JOIN|UPDATE|INTO)\\s+${item}`, 'gi')
  const more = new RegExp(`^\\s*,\\s*${item}`, 'i')
  const unquote = (s: string) => (s.startsWith(quote) ? s.slice(1, -1).replaceAll(`${quote}${quote}`, quote) : s)
  const last = (qualified: string) =>
    unquote(qualified.split(new RegExp(`\\s*\\.\\s*(?=${ident}$)`)).at(-1) ?? qualified)
  const code = stripComments(sql, dialect).replace(STRINGS, "''")
  const out = new Map<string, string>()
  const add = (qualified: string, alias: string | undefined) => {
    const table = last(qualified)
    if (NOT_ALIAS.has(table.toUpperCase())) return
    out.set(table, table)
    if (alias && !NOT_ALIAS.has(alias.toUpperCase())) out.set(unquote(alias), table)
  }
  for (const m of code.matchAll(start)) {
    add(m[1] ?? '', m[2])
    // FROM a x, b y: the tables after the first, while commas follow.
    let rest = code.slice((m.index ?? 0) + m[0].length)
    for (let next = more.exec(rest); next; next = more.exec(rest)) {
      add(next[1] ?? '', next[2])
      rest = rest.slice(next[0].length)
    }
  }
  return out
}
