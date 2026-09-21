export function stripTrailingSemicolons(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '')
}

/** `EXPLAIN <sql>`; a statement that already starts with EXPLAIN is returned as it is (`EXPLAIN EXPLAIN` is a syntax error). */
export function explainStatement(sql: string): string {
  const body = stripTrailingSemicolons(sql)
  return /^EXPLAIN\b/i.test(body) ? body : `EXPLAIN ${body}`
}
