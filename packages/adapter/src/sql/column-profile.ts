import type { ColumnDef, ColumnProfile, Dialect, Namespace } from '@tsmyadmin/shared'
import { PROFILE_MAX_COLUMNS, PROFILE_SAMPLE_ROWS } from '@tsmyadmin/shared'
import { type Conn, firstResult } from '../driver.ts'
import { AdapterError } from '../types.ts'
import { Params, quoteIdent, quoteTable } from './quote.ts'

/**
 * The types whose distinct values are counted: numbers, text, dates and times, booleans, UUIDs and enumerations,
 * as both servers name them (MySQL's DATA_TYPE with its length, PostgreSQL's format_type). Anything else (binary,
 * JSON, spatial, arrays, domains, composite types, a type this list does not know) is not: a DISTINCT on it may
 * fail, and one failing column would fail the statement that counts them all.
 */
const COMPARED =
  /^(tiny|small|medium|big)?int(eger)?\b|^(int[248]|serial|bigserial|smallserial)\b|^(decimal|numeric|float|double|real|money)\b|^(var)?char|^"char"$|^character\b|^(tiny|medium|long)?text\b|^citext\b|^(date|datetime|time|timestamp|year|interval)\b|^bool(ean)?\b|^uuid\b|^enum\(|^set\(|^inet[46]?\b|^cidr\b|^macaddr/i

/** Text that may be long: compared by its first characters, so a sample of large values stays small. */
const LONG_TEXT = /^(tiny|medium|long)?text\b|^citext\b/i

/** Characters of a long text value compared: enough to tell values apart, few enough to keep the sample light. */
const TEXT_PREFIX = 256

/** Whether a column's distinct values are counted by its first characters (an estimate, said so). */
const byPrefix = (dataType: string): boolean => comparable(dataType) && LONG_TEXT.test(dataType.trim())

/** Whether a column's distinct values are counted. */
// An array of a plain type (integer[]) is not plain: its name starts as its element's does.
export const comparable = (dataType: string): boolean => !dataType.includes('[]') && COMPARED.test(dataType.trim())

/**
 * What the sample holds of a column: the value; its first characters (long text); or only whether it is NULL (a
 * type not compared): a sample of whole BLOBs and documents would be as heavy as the table is wide, and MySQL
 * materialises a derived table with a LIMIT.
 */
function sampled(dialect: Dialect, c: Pick<ColumnDef, 'name' | 'dataType'>): string {
  const col = quoteIdent(dialect, c.name)
  if (!comparable(c.dataType)) return `CASE WHEN ${col} IS NULL THEN NULL ELSE 1 END`
  if (byPrefix(c.dataType)) return `LEFT(${col}, ${TEXT_PREFIX})`
  return col
}

/** What a server says when a statement runs too long or is stopped: not a reason to count again. */
const STOPPED = new Set([
  '57014',
  'ER_QUERY_TIMEOUT',
  'ER_QUERY_INTERRUPTED',
  'ER_STATEMENT_TIMEOUT',
  'ER_1969',
  '1969',
])

/** The statement failed on what it was asked to compute, not on time, rights or the connection. */
const refusedTheValues = (err: unknown): boolean =>
  err instanceof AdapterError && err.code === 'QUERY_FAILED' && !STOPPED.has(err.nativeCode ?? '')

/** The statement that counts the sample: NULLs per column, and distinct values where `distinct` says so. */
function profileSql(
  dialect: Dialect,
  ns: Namespace,
  table: string,
  columns: readonly Pick<ColumnDef, 'name' | 'dataType'>[],
  distinct: boolean
): { sql: string; params: unknown[] } {
  const params = new Params(dialect)
  // Each column under a name of its own in the sample: two columns may differ only in case, or hold any character.
  const alias = (i: number) => quoteIdent(dialect, `c${i}`)
  const picked = columns.map((c, i) => `${sampled(dialect, c)} AS ${alias(i)}`)
  const counts = columns.flatMap((c, i) => [
    `COUNT(${alias(i)})`,
    distinct && comparable(c.dataType) ? `COUNT(DISTINCT ${alias(i)})` : 'NULL',
  ])
  const select = picked.length > 0 ? picked.join(', ') : '1 AS one'
  const from = quoteTable(dialect, ns, table)
  const sql = `SELECT COUNT(*)${counts.map((x) => `, ${x}`).join('')} FROM (SELECT ${select} FROM ${from} LIMIT ${params.add(PROFILE_SAMPLE_ROWS)}) AS ${quoteIdent(dialect, 'sample')}`
  return { sql, params: params.values }
}

/**
 * How many NULLs and distinct values each column holds in the table's first `PROFILE_SAMPLE_ROWS` rows (the first
 * the server returns: no order, so not a random sample), in one statement over a sample read once: a full scan of
 * a large table would take as long as the table is large. Columns past `PROFILE_MAX_COLUMNS` are left out, and
 * counted. Should counting distinct values fail all the same (a type the list takes for plain), the NULLs are
 * counted again without them.
 */
export async function columnProfileOn(
  conn: Conn,
  dialect: Dialect,
  ns: Namespace,
  table: string,
  columns: readonly Pick<ColumnDef, 'name' | 'dataType'>[]
): Promise<ColumnProfile> {
  const counted = columns.slice(0, PROFILE_MAX_COLUMNS)
  const run = async (distinct: boolean) => {
    const { sql, params } = profileSql(dialect, ns, table, counted, distinct)
    return firstResult(await conn.query(sql, params)).rows[0] ?? []
  }
  // Counted again only when the server would not count the values (a type, an operator): a timeout, a refusal or
  // a lost connection would fail the second time too, and take as long again.
  const row = await run(true).catch((err: unknown) => (refusedTheValues(err) ? run(false) : Promise.reject(err)))
  const sampledRows = Number(row[0] ?? 0)
  return {
    sampled: sampledRows,
    // A full sample: the table has at least that many rows (perhaps exactly that many).
    capped: sampledRows >= PROFILE_SAMPLE_ROWS,
    columns: counted.map((c, i) => {
      const present = Number(row[1 + i * 2] ?? 0)
      const distinct = row[2 + i * 2]
      return {
        column: c.name,
        nulls: Math.max(sampledRows - present, 0),
        distinct: distinct === null || distinct === undefined ? null : Number(distinct),
        prefix: byPrefix(c.dataType),
      }
    }),
    omitted: columns.length - counted.length,
  }
}
