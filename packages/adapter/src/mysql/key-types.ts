/**
 * How a key value is typed for the MySQL column it is compared with, and how a scan orders by a key column. These
 * are plain functions of the placeholder (or the quoted column) and the column's declared type.
 */

/** Character column types, whose collation would otherwise decide what counts as the same row. */
const CHARACTER_KEY_TYPE = /^(?:char|varchar|tinytext|text|mediumtext|longtext|enum|set)\b/i

/** Placeholders are sent as string / double literals; these column types need the value coerced server-side. */
export function keyParam(placeholder: string, type: string): string {
  const t = type.toLowerCase()
  if (t.startsWith('json')) return `CAST(${placeholder} AS JSON)`
  // A FLOAT column holding 0.1 is not equal to the DOUBLE literal 0.1 (8.0.17+ / MariaDB 10.4.5+ syntax).
  if (t.startsWith('float')) return `CAST(${placeholder} AS FLOAT)`
  // Integers beyond 2^53 travel as strings; inside a row constructor MySQL compares them as DOUBLE (the
  // scalar `col = 'str'` path converts exactly, the `(a, b) > (?, ?)` path does not), so keyset paging
  // over a composite BIGINT key would skip rows. An UNSIGNED column needs the unsigned cast (2^64-2 as
  // SIGNED is -2).
  if (/^(?:big|medium|small|tiny)?int\b/.test(t)) {
    return t.includes('unsigned') ? `CAST(${placeholder} AS UNSIGNED)` : `CAST(${placeholder} AS SIGNED)`
  }
  // A BIT value travels as a binary literal (X'80'). MySQL reads that as a number in numeric context; MariaDB
  // reads it as a binary string and converts it to 0, so it is turned into a number explicitly.
  if (t.startsWith('bit')) return `CAST(CONV(HEX(${placeholder}), 16, 10) AS UNSIGNED)`
  const decimal = /^decimal\((\d+),\s*(\d+)\)/.exec(t)
  if (decimal) return `CAST(${placeholder} AS DECIMAL(${Number(decimal[1])},${Number(decimal[2])}))`
  return placeholder
}

/**
 * An all-columns key must match the row byte for byte. Comparing in the column's own collation makes rows
 * that differ only by case (`a` / `A` under general_ci), accent (`cafe` / `café` under 0900_ai_ci) or a
 * trailing space (PAD SPACE) equal, and the `LIMIT 1` that follows would then edit whichever the scan found
 * first. Both sides are converted to utf8mb4 (lossless, and it makes a latin1 column comparable with the
 * utf8mb4 parameter) and compared as binary, which is exact and never pads.
 */
export function keyMatchExpr(expr: string, type: string): string {
  return CHARACTER_KEY_TYPE.test(type) ? `CAST(CONVERT(${expr} USING utf8mb4) AS BINARY)` : expr
}

/**
 * ENUM/SET order by member index but compare with a string literal by label: page over the label instead,
 * in the binary collation — CAST AS CHAR would take collation_connection (case-insensitive), making labels
 * that differ only by case or accent tie in ORDER BY and be skipped by the `>` comparison.
 */
export function keyColumnExpr(quoted: string, type: string): string {
  return /^(?:enum|set)\(/i.test(type) ? `CAST(${quoted} AS CHAR) COLLATE utf8mb4_bin` : quoted
}
