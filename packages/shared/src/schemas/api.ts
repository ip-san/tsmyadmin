import { z } from 'zod'
import { RowValuesSchema } from './cell.ts'
import { DdlOpSchema } from './ddl.ts'
import { DialectSchema } from './dialect.ts'
import { StatementResultSchema } from './result.ts'
import { RoutineKindSchema } from './routines.ts'
import { RowKeySchema } from './row-key.ts'

/** Bounded so an unauthenticated request cannot park large strings in the rate limiter / session store. */
export const ConnectRequestSchema = z.object({
  dialect: DialectSchema,
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1).max(128),
  password: z.string().max(1024),
  database: z.string().min(1).max(128).optional(),
})
export type ConnectRequest = z.infer<typeof ConnectRequestSchema>

export const SessionInfoSchema = ConnectRequestSchema.omit({ password: true })
export type SessionInfo = z.infer<typeof SessionInfoSchema>

/** What GET/POST /session return: the identity plus the namespace usable for server-level SQL/DDL. */
/**
 * The longest statement the server will bookmark. Far more than anything written by hand, and unlike the 16 MB a
 * run is allowed this is kept on disk: with the 200-per-account cap it bounds what one account can store. It
 * bounds the request only — `SavedQuerySchema` also parses lists this browser saved before the cap existed, and
 * rejecting one of those entries would throw the rest of the list away with it.
 */
export const SAVED_QUERY_MAX_SQL = 100_000

/** A bookmarked statement. `id` is assigned by the server; the browser-side list leaves it empty. */
export const SavedQuerySchema = z.object({
  id: z.string().default(''),
  name: z.string().min(1).max(200),
  sql: z.string().min(1),
  at: z.number(),
})
export type SavedQuery = z.infer<typeof SavedQuerySchema>
export const SaveQueryRequestSchema = SavedQuerySchema.pick({ name: true, sql: true }).extend({
  sql: z.string().min(1).max(SAVED_QUERY_MAX_SQL),
})
export const SavedQueryIdSchema = z.object({ id: z.string().min(1) })

/**
 * Where the account stands with its second factor: nothing enrolled, enrolled (so a code was given at login),
 * the deployment requires one and this account has not enrolled yet — which is the only state that restricts
 * what a session may do — or the deployment cannot keep one at all, because its session store is not persistent.
 */
export const SecondFactorStateSchema = z.enum(['none', 'enrolled', 'enrollment_required', 'unsupported'])
export type SecondFactorState = z.infer<typeof SecondFactorStateSchema>

export const SessionStateSchema = SessionInfoSchema.extend({
  serverDatabase: z.string().min(1),
  /**
   * Where bookmarked statements live. 'server' when the deployment has a persistent session store, so they
   * follow the account; 'browser' when it does not, and they stay in this browser as before.
   */
  savedQueries: z.enum(['server', 'browser']).default('browser'),
  secondFactor: SecondFactorStateSchema.default('none'),
})
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
  /** The login target is outside TSMYADMIN_ALLOWED_HOSTS (403). */
  'HOST_NOT_ALLOWED',
  /** Login over plain HTTP while the session cookie is `Secure` — the browser would drop it (400). */
  'INSECURE_TRANSPORT',
  'PERMISSION_DENIED',
  /** The account has a second factor and the login carried no code (401). */
  'SECOND_FACTOR_REQUIRED',
  /** The code (or recovery code) was wrong, already used, or expired (401). */
  'SECOND_FACTOR_INVALID',
  'RATE_LIMITED',
  /** Request body / uploaded file over the limit (413). */
  'PAYLOAD_TOO_LARGE',
  'INTERNAL',
])
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>

export const SqlStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('result'), index: z.number().int().min(0), result: StatementResultSchema }),
  z.object({
    type: z.literal('done'),
    statements: z.number().int().min(0),
    /** The script left a transaction open; each run is autocommitted, so it was rolled back. */
    openTransaction: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('fatal'),
    message: z.string(),
    code: ApiErrorCodeSchema.optional(),
    nativeCode: z.string().optional(),
  }),
])
export type SqlStreamEvent = z.infer<typeof SqlStreamEventSchema>

export const SqlCancelRequestSchema = z.object({ queryId: z.string().uuid() })
export const SqlCancelResponseSchema = z.object({ cancelled: z.boolean() })

export const DdlPreviewRequestSchema = z.object({ schema: z.string().min(1).optional(), op: DdlOpSchema })
export const DdlPreviewResponseSchema = z.object({ sql: z.array(z.string()) })
export type DdlPreviewResponse = z.infer<typeof DdlPreviewResponseSchema>

export const ApiErrorSchema = z.object({
  code: ApiErrorCodeSchema,
  message: z.string(),
  detail: z.string().optional(),
  /** Driver / server error code (MySQL ER_*, PostgreSQL SQLSTATE) when the error came from the database. */
  nativeCode: z.string().optional(),
  /** Machine-readable reason of a VALIDATION error (the client localises it), with its parameters. */
  reason: z.string().optional(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
})
export type ApiError = z.infer<typeof ApiErrorSchema>

/** A one-time code: six digits from an authenticator app, or a ten-character recovery code. */
export const SecondFactorCodeSchema = z.string().min(6).max(20)

/**
 * Login. The code travels with the credentials rather than in a second request: nothing is kept server-side
 * between the two, so a refused code leaves no session, no connection and nothing to expire.
 */
export const LoginRequestSchema = ConnectRequestSchema.extend({ code: SecondFactorCodeSchema.optional() })
export type LoginRequest = z.infer<typeof LoginRequestSchema>

export const SecondFactorCodeRequestSchema = z.object({ code: SecondFactorCodeSchema })

/** What enrolment hands back, once: the secret to scan or type, and the recovery codes to write down. */
export const SecondFactorSetupSchema = z.object({
  secret: z.string().min(1),
  /** `otpauth://` URI for a QR code or a paste into the app. */
  uri: z.string().min(1),
  recoveryCodes: z.array(z.string().min(1)),
})
export type SecondFactorSetup = z.infer<typeof SecondFactorSetupSchema>

export const SecondFactorStatusSchema = z.object({
  state: SecondFactorStateSchema,
  /** How many recovery codes are still unused (0 when nothing is enrolled). */
  recoveryCodesLeft: z.number().int().min(0),
})
export type SecondFactorStatus = z.infer<typeof SecondFactorStatusSchema>
