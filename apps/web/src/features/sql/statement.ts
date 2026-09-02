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
