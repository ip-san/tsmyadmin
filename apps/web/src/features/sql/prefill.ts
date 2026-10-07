import { capabilities, type Dialect, quoteIdentifier as quote } from '@tsmyadmin/shared'

/**
 * Editor prefill shown to the user (never executed without them pressing Run).
 */
export function selectAllPrefill(dialect: Dialect, table: string, schema?: string): string {
  const target = capabilities(dialect).databasesAreSchemas
    ? quote(dialect, table)
    : `${quote(dialect, schema ?? 'public')}.${quote(dialect, table)}`
  return `SELECT * FROM ${target} LIMIT 100`
}
