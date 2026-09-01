import type { Dialect } from '@tsmyadmin/shared'

/**
 * Editor prefill shown to the user (never executed without them pressing Run).
 * Identifier quoting mirrors packages/adapter/src/sql/quote.ts.
 */
export function selectAllPrefill(dialect: Dialect, table: string, schema?: string): string {
  const q = (name: string) =>
    dialect === 'mysql' ? `\`${name.replaceAll('`', '``')}\`` : `"${name.replaceAll('"', '""')}"`
  const target = dialect === 'postgres' ? `${q(schema ?? 'public')}.${q(table)}` : q(table)
  return `SELECT * FROM ${target} LIMIT 100`
}
