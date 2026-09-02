import type { Dialect } from '@tsmyadmin/shared'
import { MysqlAdapter } from './mysql/adapter.ts'
import { mysqlDdl } from './mysql/ddl.ts'
import { PostgresAdapter } from './postgres/adapter.ts'
import { pgDdl } from './postgres/ddl.ts'
import type { ConnectionConfig, DatabaseAdapter, DdlBuilder } from './types.ts'

export { MAX_BINARY_BYTES } from './base.ts'
export { commentText, isGeneratedColumn } from './sql/export.ts'
export { quoteIdent, quoteTable } from './sql/quote.ts'
export { type Statement, splitStatements } from './sql/split.ts'
export * from './types.ts'

/** Creates an adapter. No connection is opened until the first call; use ping() to verify credentials. */
export function createAdapter(config: ConnectionConfig): DatabaseAdapter {
  return config.dialect === 'mysql' ? new MysqlAdapter(config) : new PostgresAdapter(config)
}

export function ddlBuilderFor(dialect: Dialect): DdlBuilder {
  return dialect === 'mysql' ? mysqlDdl : pgDdl
}
export type { DropTarget, ProgramStatement } from './types.ts'
