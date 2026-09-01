import type { Dialect, Namespace } from '@tsmyadmin/shared'

/**
 * Identifier quoting. Every user-supplied identifier (database, schema, table, column, index)
 * MUST pass through here before being embedded in SQL text.
 */
export function quoteIdent(dialect: Dialect, name: string): string {
  if (name.includes('\0')) throw new Error('Identifier contains NUL byte')
  return dialect === 'mysql' ? `\`${name.replaceAll('`', '``')}\`` : `"${name.replaceAll('"', '""')}"`
}

/** Fully-qualified table reference for the namespace. */
export function quoteTable(dialect: Dialect, ns: Namespace, table: string): string {
  if (dialect === 'mysql') return `${quoteIdent(dialect, ns.database)}.${quoteIdent(dialect, table)}`
  return `${quoteIdent(dialect, ns.schema ?? 'public')}.${quoteIdent(dialect, table)}`
}

/** Placeholder for the n-th (1-based) parameter. */
export function placeholder(dialect: Dialect, index: number): string {
  return dialect === 'mysql' ? '?' : `$${index}`
}

/** Accumulates parameters and hands back the matching placeholder text. */
export class Params {
  readonly values: unknown[] = []
  constructor(private readonly dialect: Dialect) {}
  add(value: unknown): string {
    this.values.push(value)
    return placeholder(this.dialect, this.values.length)
  }
}
