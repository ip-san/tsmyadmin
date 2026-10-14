import { z } from 'zod'
import { DialectSchema } from './dialect.ts'

export const ServerInfoSchema = z.object({
  dialect: DialectSchema,
  version: z.string(),
  /** Seconds since the server started (null when unavailable). */
  uptimeSec: z.number().nullable(),
  currentUser: z.string(),
  /** Free-form extras (MySQL: version_comment; PostgreSQL: full version() string). */
  extra: z.record(z.string(), z.string()),
})
export type ServerInfo = z.infer<typeof ServerInfoSchema>

export const KeyValueSchema = z.object({ name: z.string(), value: z.string(), description: z.string().nullable() })
export type KeyValue = z.infer<typeof KeyValueSchema>

export const ProcessInfoSchema = z.object({
  id: z.string(),
  user: z.string().nullable(),
  host: z.string().nullable(),
  database: z.string().nullable(),
  /** MySQL COMMAND/STATE, PostgreSQL state (+ wait event). */
  state: z.string().nullable(),
  timeSec: z.number().nullable(),
  query: z.string().nullable(),
  /** One of this tool's own connections (its pools announce themselves as `tsmyadmin`). */
  self: z.boolean().default(false),
})
export type ProcessInfo = z.infer<typeof ProcessInfoSchema>

/** A session that waits for a lock another session holds. */
export const BlockedSessionSchema = z.object({
  id: z.string(),
  user: z.string().nullable(),
  database: z.string().nullable(),
  /** Seconds it has been waiting (PostgreSQL: since its statement started). */
  waitSec: z.number().nullable(),
  query: z.string().nullable(),
})
/** The session holding the lock: usually a transaction left open, often idle between statements. */
export const BlockingSessionSchema = z.object({
  id: z.string(),
  user: z.string().nullable(),
  database: z.string().nullable(),
  /** MySQL COMMAND/STATE, PostgreSQL state (`idle in transaction` …). */
  state: z.string().nullable(),
  /** Doing nothing while its transaction stays open: the usual reason an application seems to hang. */
  idleInTransaction: z.boolean(),
  /** Seconds since its transaction began. */
  transactionSec: z.number().nullable(),
  /** The statement it runs now, or (where the server keeps it) the last one it ran. */
  query: z.string().nullable(),
})
export const LockWaitSchema = z.object({
  blocked: BlockedSessionSchema,
  blocking: BlockingSessionSchema,
  /** The table the waited-for lock is on, and the lock's mode, where the server says. */
  table: z.string().nullable(),
  mode: z.string().nullable(),
})
export type LockWait = z.infer<typeof LockWaitSchema>
export const ConnectionUsageSchema = z.object({
  /** Client connections now. */
  current: z.number(),
  max: z.number().nullable(),
  /** Connections with a transaction open and no statement running; null where it cannot be read. */
  idleInTransaction: z.number().nullable(),
})
export type ConnectionUsage = z.infer<typeof ConnectionUsageSchema>
/**
 * Who waits for whom (GET /server/lock-waits). `status` is about `waits`: the account may not read the lock tables
 * (`denied`) or the server has none to read (`unsupported`); the connection counts are there either way.
 */
export const LockWaitReportSchema = z.object({
  status: z.enum(['ok', 'denied', 'unsupported']),
  waits: z.array(LockWaitSchema),
  connections: ConnectionUsageSchema,
})
export type LockWaitReport = z.infer<typeof LockWaitReportSchema>

export const ProcessIdSchema = z.object({ id: z.string().regex(/^\d+$/, 'process id must be numeric') })

/**
 * What to stop: just the statement the connection is running, or the connection itself. Cancelling a runaway
 * query is the gentler of the two — the client keeps its session, transaction and temporary tables.
 */
export const KillModeSchema = z.enum(['query', 'connection'])
export type KillMode = z.infer<typeof KillModeSchema>
/**
 * Query of POST /server/processes/:id/kill. A query parameter rather than a body on purpose: a body-less POST
 * is what `hono/csrf` inspects, and a JSON body would quietly take this endpoint out of that check.
 */
export const KillQuerySchema = z.object({ mode: KillModeSchema.default('connection') })

/** phpMyAdmin's Charsets / Engines / Plugins tabs; on PostgreSQL collations, access methods and extensions. */
export const ServerCatalogKindSchema = z.enum(['collations', 'engines', 'plugins'])
export type ServerCatalogKind = z.infer<typeof ServerCatalogKindSchema>

/** Column ids, labelled by the client in its language (what each kind returns differs by dialect). */
export const CatalogColumnSchema = z.enum([
  'charset',
  'collation',
  'isDefault',
  'provider',
  'encoding',
  'name',
  'support',
  'transactions',
  'comment',
  'type',
  'status',
  'library',
  'license',
  'version',
  'installedVersion',
])
export type CatalogColumn = z.infer<typeof CatalogColumnSchema>

export const ServerCatalogSchema = z.object({
  columns: z.array(CatalogColumnSchema),
  rows: z.array(z.array(z.string().nullable())),
})
export type ServerCatalog = z.infer<typeof ServerCatalogSchema>

/**
 * What phpMyAdmin's Monitor, Engines and Binary log tabs read beyond the counters: the statements the server has
 * logged (MySQL's slow / general log tables, PostgreSQL's pg_stat_statements), InnoDB's own status, and the events
 * of one binary log.
 */
export const DiagnosticKindSchema = z.enum([
  'slowLog',
  'generalLog',
  'statements',
  'recentStatements',
  'engineStatus',
  'binlogEvents',
])
export type DiagnosticKind = z.infer<typeof DiagnosticKindSchema>
export const DiagnosticColumnSchema = z.enum([
  'time',
  'statement',
  'runs',
  'totalSeconds',
  'maxSeconds',
  'rowsExamined',
  'rows',
  'logName',
  'position',
  'eventType',
  'serverId',
  'endPosition',
  'info',
])
export type DiagnosticColumn = z.infer<typeof DiagnosticColumnSchema>
export const DiagnosticReportSchema = z.object({
  /**
   * `ok`, or why there is nothing to show: the log is off (`disabled`) or goes to a file (`notTable`), the account
   * may not read it (`denied`), the extension is not installed (`noExtension`), or this server has no such thing.
   */
  status: z.enum(['ok', 'disabled', 'notTable', 'denied', 'noExtension', 'unsupported']),
  columns: z.array(DiagnosticColumnSchema),
  rows: z.array(z.array(z.string().nullable())),
  /** A report that is one block of text (InnoDB status). */
  text: z.string().nullable(),
})
export type DiagnosticReport = z.infer<typeof DiagnosticReportSchema>
/** A logged time as the server prints it (`2026-09-21 10:00:00.123456`): the newest one a caller has seen. */
export const LogTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/)
/** `file` picks the binary log whose events are listed; `since` limits `recentStatements` to what ran after it. */
export const DiagnosticQuerySchema = z.object({
  file: z.string().min(1).max(255).optional(),
  since: LogTimeSchema.optional(),
})
export type DiagnosticQuery = z.infer<typeof DiagnosticQuerySchema>

/** One result row as name → value (the replication views have many columns, and they differ by version). */
export const RecordSchema = z.array(z.object({ name: z.string(), value: z.string().nullable() }))

/**
 * phpMyAdmin's Replication and Binary log tabs, and PostgreSQL's streaming replication. Each part is null when
 * the account may not read it (or, for the logs, when the server keeps none).
 */
export const ReplicationInfoSchema = z.object({
  /**
   * This server reads from a source / sends to replicas; both at once for a relay. `unknown` when nothing shows a
   * role and the account could not read part of it — "standalone" would be a guess.
   */
  role: z.enum(['standalone', 'primary', 'replica', 'relay', 'unknown']),
  /** As a replica: its state (MySQL SHOW REPLICA STATUS, PostgreSQL pg_stat_wal_receiver), one per channel. */
  source: z.array(RecordSchema).nullable(),
  /** As a source: the replicas connected to it (MySQL SHOW REPLICAS, PostgreSQL pg_stat_replication). */
  replicas: z.array(RecordSchema).nullable(),
  /** Binary logs (MySQL) or WAL segments (PostgreSQL), with their size in bytes. */
  logs: z.array(z.object({ name: z.string(), size: z.string().nullable() })).nullable(),
})
export type ReplicationInfo = z.infer<typeof ReplicationInfoSchema>

/** The role the parts show: a part that could not be read (null) proves nothing either way. */
export function replicationRole(source: unknown[] | null, replicas: unknown[] | null): ReplicationInfo['role'] {
  const reading = (source?.length ?? 0) > 0
  const sending = (replicas?.length ?? 0) > 0
  if (reading && sending) return 'relay'
  if (reading) return 'replica'
  if (sending) return 'primary'
  return source === null || replicas === null ? 'unknown' : 'standalone'
}
