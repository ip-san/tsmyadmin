/** The rows of a table whose foreign keys name a parent that is not there. */
import type { Dialect, ForeignKeyDef, Namespace, ReferenceCheck } from '@tsmyadmin/shared'
import { type Conn, firstResult } from '../driver.ts'
import { quoteIdent, quoteTable } from './quote.ts'

/** Per foreign key of `table`, the rows naming a missing parent, with the SELECT that lists them. */
export async function checkReferencesOn(
  conn: Conn,
  d: Dialect,
  ns: Namespace,
  table: string,
  foreignKeys: readonly ForeignKeyDef[]
): Promise<ReferenceCheck[]> {
  const out: ReferenceCheck[] = []
  for (const fk of foreignKeys) {
    const child = quoteTable(d, ns, table)
    const parent = quoteTable(d, fk.refNamespace, fk.refTable)
    const on = fk.columns
      .map((c, i) => `c.${quoteIdent(d, c)} = p.${quoteIdent(d, fk.refColumns[i] ?? '')}`)
      .join(' AND ')
    // A key with a NULL in it names no parent (MATCH SIMPLE): only rows with every column set are checked.
    const where = [
      `p.${quoteIdent(d, fk.refColumns[0] ?? '')} IS NULL`,
      ...fk.columns.map((c) => `c.${quoteIdent(d, c)} IS NOT NULL`),
    ].join(' AND ')
    const from = `FROM ${child} c LEFT JOIN ${parent} p ON ${on} WHERE ${where}`
    const count = firstResult(await conn.query(`SELECT COUNT(*) ${from}`)).rows[0]?.[0]
    out.push({
      name: fk.name,
      columns: fk.columns,
      refNamespace: fk.refNamespace,
      refTable: fk.refTable,
      refColumns: fk.refColumns,
      orphans: Number(count ?? 0),
      sql: `SELECT c.* ${from}`,
    })
  }
  return out
}
