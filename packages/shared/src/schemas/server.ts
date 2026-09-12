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
