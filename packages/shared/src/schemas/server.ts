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
})
export type ProcessInfo = z.infer<typeof ProcessInfoSchema>

export const ProcessIdSchema = z.object({ id: z.string().regex(/^\d+$/, 'process id must be numeric') })
