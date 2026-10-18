import type { ColumnDef, ColumnProfile, Dialect, Namespace } from '@tsmyadmin/shared'
import { PROFILE_MAX_COLUMNS, PROFILE_SAMPLE_ROWS } from '@tsmyadmin/shared'
import { type Conn, firstResult } from '../driver.ts'
import { Params, quoteIdent, quoteTable } from './quote.ts'

/**
 * Types whose values a DISTINCT cannot compare, or compares to little purpose: binary, JSON (PostgreSQL's `json`
 * has no equality at all), XML, spatial and geometric types, full-text vectors and arrays.
 */
const NOT_COMPARED =
  /blob|binary|bytea|\bbit\b|json|xml|geometry|geography|point|polygon|linestring|\bline\b|lseg|\bbox\b|circle|\bpath\b|tsvector|tsquery|\[\]|^array/i

/** Whether a column's distinct values are counted. */
export const comparable = (dataType: string): boolean => !NOT_COMPARED.test(dataType)

/**
 * How many NULLs and distinct values each column holds in the table's first `PROFILE_SAMPLE_ROWS` rows, in one
 * statement over a sample read once (`LIMIT` in a derived table): a full scan of a large table would take as long
 * as the table is large. Columns past `PROFILE_MAX_COLUMNS` are left out, and counted.
 */
export async function columnProfileOn(
  conn: Conn,
  dialect: Dialect,
  ns: Namespace,
  table: string,
  columns: readonly Pick<ColumnDef, 'name' | 'dataType'>[]
): Promise<ColumnProfile> {
  const counted = columns.slice(0, PROFILE_MAX_COLUMNS)
  const params = new Params(dialect)
  // Each column under a name of its own in the sample: two columns may differ only in case, or hold any character.
  const alias = (i: number) => quoteIdent(dialect, `c${i}`)
  const picked = counted.map((c, i) => `${quoteIdent(dialect, c.name)} AS ${alias(i)}`)
  const counts = counted.flatMap((c, i) => [
    `COUNT(${alias(i)})`,
    comparable(c.dataType) ? `COUNT(DISTINCT ${alias(i)})` : 'NULL',
  ])
  const select = picked.length > 0 ? picked.join(', ') : '1 AS one'
  const sql = `SELECT COUNT(*)${counts.map((x) => `, ${x}`).join('')} FROM (SELECT ${select} FROM ${quoteTable(
    dialect,
    ns,
    table
  )} LIMIT ${params.add(PROFILE_SAMPLE_ROWS)}) AS ${quoteIdent(dialect, 'sample')}`
  const row = firstResult(await conn.query(sql, params.values)).rows[0] ?? []
  const sampled = Number(row[0] ?? 0)
  return {
    sampled,
    // A full sample: the table has at least that many rows (perhaps exactly that many).
    capped: sampled >= PROFILE_SAMPLE_ROWS,
    columns: counted.map((c, i) => {
      const present = Number(row[1 + i * 2] ?? 0)
      const distinct = row[2 + i * 2]
      return {
        column: c.name,
        nulls: Math.max(sampled - present, 0),
        distinct: distinct === null || distinct === undefined ? null : Number(distinct),
      }
    }),
    omitted: columns.length - counted.length,
  }
}
