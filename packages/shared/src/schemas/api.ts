import { z } from 'zod'
import { RowValuesSchema } from './cell.ts'
import { DdlOpSchema } from './ddl.ts'
import { DialectSchema } from './dialect.ts'
import { StatementResultSchema } from './result.ts'
import { RoutineKindSchema } from './routines.ts'
import { RowKeySchema } from './row-key.ts'

export const ConnectRequestSchema = z.object({
  dialect: DialectSchema,
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1),
  password: z.string(),
  database: z.string().min(1).optional(),
})
export type ConnectRequest = z.infer<typeof ConnectRequestSchema>

export const SessionInfoSchema = ConnectRequestSchema.omit({ password: true })
export type SessionInfo = z.infer<typeof SessionInfoSchema>

/** What GET/POST /session return: the identity plus the namespace usable for server-level SQL/DDL. */
export const SessionStateSchema = SessionInfoSchema.extend({ serverDatabase: z.string().min(1) })
export type SessionState = z.infer<typeof SessionStateSchema>

export const SchemaQuerySchema = z.object({ schema: z.string().min(1).optional() })
export const TriggerQuerySchema = SchemaQuerySchema.extend({ table: z.string().min(1).optional() })
export const RoutineDefinitionQuerySchema = SchemaQuerySchema.extend({ kind: RoutineKindSchema })

export const InsertRowRequestSchema = z.object({ values: RowValuesSchema })
export const UpdateRowRequestSchema = z.object({ key: RowKeySchema, values: RowValuesSchema })
export const DeleteRowsRequestSchema = z.object({ keys: z.array(RowKeySchema).min(1) })
export const AffectedRowsSchema = z.object({ affectedRows: z.number() })

export const SQL_MAX_ROWS_DEFAULT = 1000
export const SQL_MAX_ROWS_LIMIT = 10_000
export const SQL_TIMEOUT_DEFAULT_MS = 30_000

export const SqlRequestSchema = z.object({
  sql: z.string().min(1),
  schema: z.string().min(1).optional(),
  /** Client-generated id so the run can be cancelled with POST /sql/cancel while it is executing. */
  queryId: z.string().uuid().optional(),
  maxRows: z.number().int().min(1).max(SQL_MAX_ROWS_LIMIT).default(SQL_MAX_ROWS_DEFAULT),
  timeoutMs: z.number().int().min(1000).max(300_000).default(SQL_TIMEOUT_DEFAULT_MS),
  stopOnError: z.boolean().default(true),
})
export type SqlRequest = z.infer<typeof SqlRequestSchema>

/**
 * One line of the NDJSON stream from POST /sql/stream: a statement result as it completes, then a final
 * `done` line (absent when the connection dropped — clients treat a missing `done` as an aborted run).
 */
export const SqlStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('result'), index: z.number().int().min(0), result: StatementResultSchema }),
  z.object({ type: z.literal('done'), statements: z.number().int().min(0) }),
  z.object({ type: z.literal('fatal'), message: z.string() }),
])
export type SqlStreamEvent = z.infer<typeof SqlStreamEventSchema>

export const SqlCancelRequestSchema = z.object({ queryId: z.string().uuid() })
export const SqlCancelResponseSchema = z.object({ cancelled: z.boolean() })

export const DdlPreviewRequestSchema = z.object({ schema: z.string().min(1).optional(), op: DdlOpSchema })
export const DdlPreviewResponseSchema = z.object({ sql: z.array(z.string()) })
export type DdlPreviewResponse = z.infer<typeof DdlPreviewResponseSchema>

export const ApiErrorCodeSchema = z.enum([
  'UNAUTHENTICATED',
  'VALIDATION',
  'CONNECTION_FAILED',
  'AUTH_FAILED',
  'NOT_FOUND',
  'QUERY_FAILED',
  'KEY_MISMATCH',
  'UNSUPPORTED',
  'FORBIDDEN',
  'PERMISSION_DENIED',
  'RATE_LIMITED',
  'INTERNAL',
])
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>

export const ApiErrorSchema = z.object({
  code: ApiErrorCodeSchema,
  message: z.string(),
  detail: z.string().optional(),
  /** Driver / server error code (MySQL ER_*, PostgreSQL SQLSTATE) when the error came from the database. */
  nativeCode: z.string().optional(),
})
export type ApiError = z.infer<typeof ApiErrorSchema>
