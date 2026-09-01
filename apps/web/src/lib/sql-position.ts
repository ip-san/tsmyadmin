/** Resolves a 1-based character offset (PostgreSQL error position) to line/column plus the offending line. */
export function locateInSql(sql: string, position: number): { line: number; column: number; text: string } | null {
  if (!Number.isInteger(position) || position < 1 || position > sql.length + 1) return null
  const before = sql.slice(0, position - 1)
  const lines = before.split('\n')
  const line = lines.length
  const column = (lines[lines.length - 1]?.length ?? 0) + 1
  const text = sql.split('\n')[line - 1] ?? ''
  return { line, column, text }
}
