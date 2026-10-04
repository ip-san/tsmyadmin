import type { Cell, DdlOp, Dialect, Namespace, StatementResult } from '@tsmyadmin/shared'
import type { DatabaseAdapter, ExecuteOptions } from '../../types.ts'

export interface ConformanceContext {
  dialect: Dialect
  create: () => DatabaseAdapter
  /** Same server, wrong password. */
  createBad: () => DatabaseAdapter
  /** Same server, different account. */
  createAs: (user: string, password: string) => DatabaseAdapter
  ns: Namespace
  otherDatabase: string
  /** Expected schemas in ns.database (PostgreSQL) or [] (MySQL). */
  schemas: string[]
  /** Expected wire values for `types_all` row id=1, keyed by column. */
  typesRow1: Record<string, Cell>
  /** A read-only statement that runs for several seconds and can be interrupted by the statement timeout. */
  slowSql: string
}

/**
 * What every group of the suite shares: the context, the scratch names, and the helpers that run SQL on the one
 * connection the runner opens. `db` is read when used, because the runner connects in `beforeAll`.
 */
export interface ConformanceEnv {
  readonly ctx: ConformanceContext
  readonly ns: Namespace
  readonly dialect: Dialect
  readonly scratch: string
  readonly scratchNoPk: string
  readonly scratchDdl: string
  readonly db: DatabaseAdapter
  exec(sql: string, opts?: Partial<ExecuteOptions>): Promise<StatementResult[]>
  execOk(sql: string): Promise<StatementResult[]>
  runDdl(op: DdlOp): Promise<void>
  browseAll(table: string): ReturnType<DatabaseAdapter['browseRows']>
  isMariaDb(): Promise<boolean>
}

/** The helpers the groups of `ddl` share (the group files are called from `ddl.ts`, inside its describe). */
export interface DdlHelpers {
  /** As the web runs a preview: all of an op's statements as one script through the SQL route. */
  runScript(op: DdlOp): ReturnType<ConformanceEnv['execOk']>
  firstValue(sql: string): Promise<unknown>
}
