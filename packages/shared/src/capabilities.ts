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
  /**
   * A database can be copied rows only, into one that already has the tables (MySQL). PostgreSQL copies a database from a
   * template, with its structure and its data together.
   */
  copyDatabaseWithoutStructure: boolean
  /** Several routines may share a name, told apart by their arguments (PostgreSQL). */
  routineOverloads: boolean
  /** Scheduled events (MySQL). */
  events: boolean
  /** How a SQL dump is written for this server. */
  dump: {
    /** Drops are written as one section ahead of everything, in the reverse of the order of dependency (PostgreSQL); otherwise each object is dropped where it is created. */
    dropsInOneSection: boolean
    /** The catalog says which object depends on which, so the dump can order routines and views by it (PostgreSQL). */
    dependencyCatalog: boolean
    /** Foreign keys are written after every table exists and is loaded: there is no switch to turn the check off (PostgreSQL). */
    deferForeignKeys: boolean
    /** A materialized view is created empty and refreshed once its sources hold their rows (PostgreSQL). */
    materializedViews: boolean
    /** `LOCK TABLES … WRITE` around the rows of a table (MySQL). */
    lockTables: boolean
    /** The session statements that put the dump's times in UTC, and the one that undoes them (null where nothing needs undoing). */
    utc: { set: string; restore: string | null }
  }
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
    copyDatabaseWithoutStructure: true,
    routineOverloads: false,
    events: true,
    dump: {
      dropsInOneSection: false,
      dependencyCatalog: false,
      deferForeignKeys: false,
      materializedViews: false,
      lockTables: true,
      utc: { set: "SET @OLD_TIME_ZONE = @@TIME_ZONE, TIME_ZONE = '+00:00'", restore: 'SET TIME_ZONE = @OLD_TIME_ZONE' },
    },
    noAutoValueOnZero: true,
  },
  postgres: {
    identifier: { max: 63, unit: 'bytes', accountMax: null },
    transactionalDdl: true,
    beginTransaction: 'BEGIN',
    foreignKeyChecksOff: 'SET session_replication_role = replica',
    databasesAreSchemas: false,
    scriptDelimiter: false,
    copyDatabaseWithoutStructure: false,
    routineOverloads: true,
    events: false,
    dump: {
      dropsInOneSection: true,
      dependencyCatalog: true,
      deferForeignKeys: true,
      materializedViews: true,
      lockTables: false,
      utc: { set: "SET TIME ZONE 'UTC'", restore: null },
    },
    noAutoValueOnZero: false,
  },
}

export function capabilities(dialect: Dialect): DialectCapabilities {
  return CAPABILITIES[dialect]
}
