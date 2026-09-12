import type { Dialect } from '@tsmyadmin/shared'

/** Identifier quoting mirrors packages/adapter/src/sql/quote.ts. */
function quote(dialect: Dialect, name: string): string {
  return dialect === 'mysql' ? `\`${name.replaceAll('`', '``')}\`` : `"${name.replaceAll('"', '""')}"`
}

/**
 * Editor prefill shown to the user (never executed without them pressing Run).
 */
export function selectAllPrefill(dialect: Dialect, table: string, schema?: string): string {
  const target =
    dialect === 'postgres' ? `${quote(dialect, schema ?? 'public')}.${quote(dialect, table)}` : quote(dialect, table)
  return `SELECT * FROM ${target} LIMIT 100`
}
