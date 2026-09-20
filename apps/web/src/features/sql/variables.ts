import type { Dialect } from '@tsmyadmin/shared'

/** What a bookmarked statement may name with `[NAME]`: the place it is loaded into (phpMyAdmin's bookmark variables). */
export interface BookmarkContext {
  db: string
  schema?: string | undefined
  user: string
  host: string
  dialect: Dialect
}

const PLAIN = /^[A-Za-z_][A-Za-z0-9_$]*$/
const VARIABLE = /^\[(DB|SCHEMA|USER|HOST)\]/

const identifier = (name: string, dialect: Dialect) => {
  if (PLAIN.test(name)) return name
  const q = dialect === 'mysql' ? '`' : '"'
  return `${q}${name.replaceAll(q, q + q)}${q}`
}

/**
 * `[DB]`, `[SCHEMA]`, `[USER]` and `[HOST]` replaced by where the statement is loaded, so one bookmark serves every
 * database. Where the name stands as an identifier (`[DB].orders`) it is quoted the way the server wants unless it is
 * a plain name; inside a string literal (`'[DB]'`) it is written into the text with the quote doubled. `[USER]` and
 * `[HOST]` are values, written as they are. A name it does not know is left alone, and so is `[DB` without its bracket.
 * The statement is shown in the editor for the user to read before it runs.
 */
export function expandVariables(sql: string, context: BookmarkContext): string {
  const values: Record<string, string | undefined> = {
    DB: context.db,
    SCHEMA: context.schema,
    USER: context.user,
    HOST: context.host,
  }
  let out = ''
  // The quote character we are inside of, or '' for code. Doubling and backslashes end a literal only on a lone quote.
  let inside = ''
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i] as string
    if (inside === '') {
      if (ch === "'" || ch === '"' || ch === '`') inside = ch
      else if (ch === '[') {
        const m = VARIABLE.exec(sql.slice(i))
        const value = m ? values[m[1] as string] : undefined
        if (m && value !== undefined) {
          out += m[1] === 'DB' || m[1] === 'SCHEMA' ? identifier(value, context.dialect) : value
          i += m[0].length - 1
          continue
        }
      }
    } else if (ch === '\\' && inside !== '`') {
      out += ch + (sql[i + 1] ?? '')
      i++
      continue
    } else if (ch === inside) {
      if (sql[i + 1] === inside) {
        out += ch + ch
        i++
        continue
      }
      inside = ''
    } else if (ch === '[') {
      const m = VARIABLE.exec(sql.slice(i))
      const value = m ? values[m[1] as string] : undefined
      if (m && value !== undefined) {
        out += inside === '`' ? value.replaceAll('`', '``') : value.replaceAll(inside, inside + inside)
        i += m[0].length - 1
        continue
      }
    }
    out += ch
  }
  return out
}
