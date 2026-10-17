/** The CREATE text of a MySQL / MariaDB table or sequence, and the column defaults information_schema cannot carry. */
import type { Namespace, TableSchema } from '@tsmyadmin/shared'
import { type Conn, firstResult } from '../driver.ts'
import { quoteIdent, quoteTable } from '../sql/quote.ts'
import { AdapterError } from '../types.ts'

/** The table option MariaDB prints for a sequence (`CREATE TABLE … SEQUENCE=1`), outside string literals. */
const SEQUENCE_OPTION = /^\)(?:[^'\n]|'(?:[^']|'')*')*\bSEQUENCE=1\b/m

/** The statements that recreate a table, or a MariaDB sequence and the value it would hand out next. */
export async function mysqlShowCreateTable(
  conn: Conn,
  ns: Namespace,
  table: string,
  known?: TableSchema
): Promise<string[]> {
  const t = quoteTable('mysql', ns, table)
  const r = firstResult(await conn.query(`SHOW CREATE TABLE ${t}`))
  const row = r.rows[0]
  if (!row) throw new AdapterError('NOT_FOUND', `Table not found: ${ns.database}.${table}`)
  const create = String(row[1] ?? '')
  // MariaDB answers SHOW CREATE TABLE for a sequence with `CREATE TABLE … SEQUENCE=1`: no catalog round trip
  // is needed to tell the two apart when the caller did not pass the schema.
  const kind = known?.kind ?? (SEQUENCE_OPTION.test(create) ? 'sequence' : 'table')
  if (kind === 'sequence') {
    // MariaDB SEQUENCE: the definition plus the value it would hand out next, so a restore continues.
    const r = firstResult(await conn.query(`SHOW CREATE SEQUENCE ${t}`))
    const next = firstResult(await conn.query(`SELECT next_not_cached_value FROM ${t}`))
    const create = String(r.rows[0]?.[1] ?? '')
    const value = next.rows[0]?.[0]
    return value === null || value === undefined
      ? [create]
      : [create, `ALTER SEQUENCE ${quoteIdent('mysql', table)} RESTART WITH ${String(value).replace(/[^\d-]/g, '')}`]
  }
  // MariaDB prints sequence defaults database-qualified (`DEFAULT nextval(\`db\`.\`seq\`)`); a dump is
  // database-relative. Only the DEFAULT position is rewritten: a comment may quote the same text.
  const qualified = `DEFAULT nextval(${quoteIdent('mysql', ns.database)}.`
  return [create.replaceAll(qualified, 'DEFAULT nextval(')]
}

/**
 * `information_schema.COLUMNS.COLUMN_DEFAULT` is a utf8mb3 column, so a literal default holding a character
 * outside the BMP (an emoji, CJK Ext-B) comes back with that character replaced by `?`; replaying it would
 * quietly rewrite the default. MySQL prints such a default as a hex literal in `SHOW CREATE TABLE` precisely
 * because the text form cannot carry it — which both recovers the bytes and tells a mangled value apart from
 * a `?` the user really typed. MariaDB prints `?` there too, so its defaults are left as reported (a
 * documented limitation), and the extra round trip only happens when a default actually contains a `?`.
 */
export async function mysqlRecoverLossyDefaults(
  conn: Conn,
  ns: Namespace,
  table: string,
  columns: TableSchema['columns']
): Promise<void> {
  const suspect = columns.filter((c) => !c.defaultIsExpression && c.default?.includes('?'))
  if (suspect.length === 0) return
  const create = firstResult(await conn.query(`SHOW CREATE TABLE ${quoteTable('mysql', ns, table)}`))
  const text = String(create.rows[0]?.[1] ?? '')
  for (const c of suspect) {
    const name = c.name.replaceAll('`', '``').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const line = new RegExp(`^\\s*\`${name}\` [^\n]*`, 'm').exec(text)?.[0]
    const hex = line ? /\bDEFAULT (0x[0-9A-Fa-f]+)/.exec(line)?.[1] : undefined
    if (hex) {
      c.default = hex
      c.defaultIsExpression = true
    }
  }
}
