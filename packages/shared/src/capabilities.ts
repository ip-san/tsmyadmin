import type { Dialect } from './schemas/dialect.ts'

/**
 * What the two servers differ in, as facts a caller can read instead of asking which database it is.
 *
 * A comparison of the dialect with a name, in the API or a screen, is a place that knows anyway, and a third database would have to be
 * found in each of them (`bun run check:dialect-leaks` counts them and lets the number only fall). A difference that
 * more than one place cares about is named here once; the code that needs it reads the name.
 */
export interface DialectCapabilities {
  /** The longest identifier the server accepts: MySQL 64 characters, PostgreSQL 63 bytes (longer ones are cut silently). */
  identifier: {
    max: number
    unit: 'chars' | 'bytes'
    /** An account name is shorter than other identifiers on MySQL (32); null where it is not. */
    accountMax: number | null
  }
  /**
   * DDL and account statements take part in a transaction, so all of a script or none of it happens (PostgreSQL). On
   * MySQL they commit implicitly: a transaction around them protects nothing.
   */
  transactionalDdl: boolean
  /** The statement that opens a transaction. */
  beginTransaction: string
  /** The session statement that lets rows be loaded in any order (foreign keys are not checked until it is undone). */
  foreignKeyChecksOff: string
  /** What the server calls a "database" is, to the other server, a schema: a MySQL database list is PostgreSQL's schemas. */
  databasesAreSchemas: boolean
  /** A script may change the statement delimiter for what follows (`DELIMITER //`). */
  scriptDelimiter: boolean
  /** `NO_AUTO_VALUE_ON_ZERO`: a zero in an auto-increment column is stored as zero (a MySQL `sql_mode`). */
  noAutoValueOnZero: boolean
}

const CAPABILITIES: Record<Dialect, DialectCapabilities> = {
  mysql: {
    identifier: { max: 64, unit: 'chars', accountMax: 32 },
    transactionalDdl: false,
    beginTransaction: 'START TRANSACTION',
    foreignKeyChecksOff: 'SET FOREIGN_KEY_CHECKS = 0',
    databasesAreSchemas: true,
    scriptDelimiter: true,
    noAutoValueOnZero: true,
  },
  postgres: {
    identifier: { max: 63, unit: 'bytes', accountMax: null },
    transactionalDdl: true,
    beginTransaction: 'BEGIN',
    foreignKeyChecksOff: 'SET session_replication_role = replica',
    databasesAreSchemas: false,
    scriptDelimiter: false,
    noAutoValueOnZero: false,
  },
}

export function capabilities(dialect: Dialect): DialectCapabilities {
  return CAPABILITIES[dialect]
}
