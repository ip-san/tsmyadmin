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

/** One result row as name → value (the replication views have many columns, and they differ by version). */
export const RecordSchema = z.array(z.object({ name: z.string(), value: z.string().nullable() }))

/**
 * phpMyAdmin's Replication and Binary log tabs, and PostgreSQL's streaming replication. Each part is null when
 * the account may not read it (or, for the logs, when the server keeps none).
 */
export const ReplicationInfoSchema = z.object({
  /** This server reads from a source / sends to replicas; both at once for a relay. */
  role: z.enum(['standalone', 'primary', 'replica', 'relay']),
  /** As a replica: its state (MySQL SHOW REPLICA STATUS, PostgreSQL pg_stat_wal_receiver), one per channel. */
  source: z.array(RecordSchema).nullable(),
  /** As a source: the replicas connected to it (MySQL SHOW REPLICAS, PostgreSQL pg_stat_replication). */
  replicas: z.array(RecordSchema).nullable(),
  /** Binary logs (MySQL) or WAL segments (PostgreSQL), with their size in bytes. */
  logs: z.array(z.object({ name: z.string(), size: z.string().nullable() })).nullable(),
})
export type ReplicationInfo = z.infer<typeof ReplicationInfoSchema>
