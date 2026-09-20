import type { Cell, Dialect, Namespace } from '@tsmyadmin/shared'
import { AdapterError } from '../types.ts'
import { cellLiteral } from './literal.ts'

/**
 * Identifier quoting. Every user-supplied identifier (database, schema, table, column, index)
 * MUST pass through here before being embedded in SQL text.
 */
export function quoteIdent(dialect: Dialect, name: string): string {
  if (name.includes('\0')) throw new AdapterError('VALIDATION', 'Identifier contains a NUL byte')
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

/**
 * Accumulates parameters and hands back the matching placeholder text. In `literal` mode it hands back the value
 * written as an SQL literal instead: the same statement, for reading and for the SQL tab — never the one that runs.
 */
export class Params {
  readonly values: unknown[] = []
  constructor(
    private readonly dialect: Dialect,
    private readonly literal = false
  ) {}
  add(value: unknown): string {
    this.values.push(value)
    if (!this.literal) return placeholder(this.dialect, this.values.length)
    const cell = value instanceof Uint8Array ? { $bin: Buffer.from(value).toString('base64') } : (value as Cell)
    return cellLiteral(this.dialect, cell)
  }
}
