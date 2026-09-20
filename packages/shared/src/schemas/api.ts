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
  /** MySQL / MariaDB: the collation the connection talks in (its character set is the part before the first `_`). */
  collation: z
    .string()
    .regex(/^[A-Za-z0-9]+_[A-Za-z0-9_]+$/)
    .max(64)
    .optional(),
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

/** A statement bookmarked for every account of the server: who saved it is the only one who can remove it. */
export const SharedQuerySchema = SavedQuerySchema.extend({ by: z.string() })
export type SharedQuery = z.infer<typeof SharedQuerySchema>

/** One run in the SQL console's history. */
export const HistoryEntrySchema = z.object({
  sql: z.string(),
  at: z.number(),
  ok: z.boolean(),
  db: z.string().optional(),
})
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>

/** The most a history keeps (and the statement text kept per entry): it is stored with the account, so it is bounded. */
export const SQL_HISTORY_MAX_ENTRIES = 1000
export const SQL_HISTORY_MAX_SQL = 10_000
/** The account's history, newest first. */
export const SqlHistorySchema = z.object({ entries: z.array(HistoryEntrySchema) })
export type SqlHistory = z.infer<typeof SqlHistorySchema>

/**
 * One run to add to the account's history. The server puts it first (an identical statement moves up), and keeps
 * `limit` entries: adding rather than replacing, so two browsers on the same account do not overwrite each other.
 */
export const AddHistoryRequestSchema = z.object({
  entry: HistoryEntrySchema.extend({ sql: z.string().max(SQL_HISTORY_MAX_SQL) }),
  limit: z.number().int().min(1).max(SQL_HISTORY_MAX_ENTRIES),
})

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

/** `stats=0` skips the size and table-count aggregates of the database list. */
export const DatabasesQuerySchema = z.object({ stats: z.enum(['0', '1']).optional() })
export const SchemaQuerySchema = z.object({ schema: z.string().min(1).optional() })
export const TriggerQuerySchema = SchemaQuerySchema.extend({ table: z.string().min(1).optional() })
export const RoutineDefinitionQuerySchema = SchemaQuerySchema.extend({ kind: RoutineKindSchema })
/** `parameters` (as the routine list prints them) picks one overload of a PostgreSQL routine. */
export const RoutineDetailQuerySchema = RoutineDefinitionQuerySchema.extend({
  parameters: z.string().max(4000).optional(),
})
export const TriggerDetailQuerySchema = SchemaQuerySchema.extend({ table: z.string().min(1) })

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
  /** Time each statement's stages (MySQL / MariaDB `SHOW PROFILE`); PostgreSQL has no such breakdown. */
  profile: z.boolean().default(false),
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
  /** A concurrent change landed first and this one was not applied (409). */
  'CONFLICT',
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

export const SecondFactorCodeSchema = z.string().min(6).max(20)

/**
 * A passkey's answer as the browser serialises it (base64url fields). Only bounded here: the server verifies it
 * cryptographically, and the fields differ between registration and sign-in.
 */
export const PasskeyResponseSchema = z.object({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal('public-key'),
  // Strings (base64url), the COSE algorithm number of a new key, and the transports list.
  response: z.record(z.string(), z.union([z.string().max(16_384), z.number(), z.array(z.string().max(32)).max(16)])),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.string().max(32).optional(),
})
export type PasskeyResponse = z.input<typeof PasskeyResponseSchema>

/** A passkey assertion together with the ticket its challenge was issued under. */
export const PasskeyAnswerSchema = z.object({ ticket: z.string().min(1).max(128), response: PasskeyResponseSchema })
export type PasskeyAnswer = z.infer<typeof PasskeyAnswerSchema>

/** WebAuthn options as the browser API takes them (JSON form); produced and checked by the server library. */
const PasskeyOptionsSchema = z.record(z.string(), z.unknown())

/** A challenge to answer with a passkey, and the ticket that ties the answer to it. */
export const PasskeyChallengeSchema = z.object({ ticket: z.string().min(1), options: PasskeyOptionsSchema })
export type PasskeyChallenge = z.infer<typeof PasskeyChallengeSchema>

/**
 * Proof of the second factor already enrolled, for changing it: a current code from the app, or a passkey
 * (recovery codes are for getting in, not for changing what protects the account).
 */
export const SecondFactorProofSchema = z.union([
  z.object({ code: SecondFactorCodeSchema }),
  z.object({ passkey: PasskeyAnswerSchema }),
])
export type SecondFactorProof = z.infer<typeof SecondFactorProofSchema>

/** Starting an enrolment: empty for the first factor, proof of the current one when adding another. */
export const SecondFactorBeginRequestSchema = z.union([SecondFactorProofSchema, z.object({})])

export const ApiErrorSchema = z.object({
  code: ApiErrorCodeSchema,
  message: z.string(),
  detail: z.string().optional(),
  /** Driver / server error code (MySQL ER_*, PostgreSQL SQLSTATE) when the error came from the database. */
  nativeCode: z.string().optional(),
  /** Machine-readable reason of a VALIDATION error (the client localises it), with its parameters. */
  reason: z.string().optional(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  /** With SECOND_FACTOR_REQUIRED: a passkey challenge, when the account has passkeys and the deployment allows them. */
  passkey: PasskeyChallengeSchema.optional(),
})
export type ApiError = z.infer<typeof ApiErrorSchema>

/** A one-time code: six digits from an authenticator app, or a ten-character recovery code. */

/**
 * Login. The code travels with the credentials rather than in a second request: nothing is kept server-side
 * between the two, so a refused code leaves no session, no connection and nothing to expire.
 */
export const LoginRequestSchema = ConnectRequestSchema.extend({
  code: SecondFactorCodeSchema.optional(),
  /** A passkey's answer to the challenge the previous (refused) login attempt handed out. */
  passkey: PasskeyAnswerSchema.optional(),
})
export type LoginRequest = z.infer<typeof LoginRequestSchema>

export const SecondFactorCodeRequestSchema = z.object({ code: SecondFactorCodeSchema })

/** What enrolment hands back, once: the secret to scan or type, and the recovery codes to write down. */
export const SecondFactorSetupSchema = z.object({
  secret: z.string().min(1),
  /** `otpauth://` URI for a QR code or a paste into the app. */
  uri: z.string().min(1),
  recoveryCodes: z.array(z.string().min(1)),
  /** The URI as a QR code: one string per row, '1' for a dark module, without the quiet zone. */
  qr: z.array(z.string().regex(/^[01]+$/)),
})
export type SecondFactorSetup = z.infer<typeof SecondFactorSetupSchema>

/** Starting a passkey registration: the options for the browser, and recovery codes if this is the first factor. */
export const PasskeyRegistrationSchema = z.object({
  options: PasskeyOptionsSchema,
  recoveryCodes: z.array(z.string().min(1)),
})
export type PasskeyRegistration = z.infer<typeof PasskeyRegistrationSchema>
export const PasskeyConfirmRequestSchema = z.object({ response: PasskeyResponseSchema })
export const PasskeyIdSchema = z.object({ id: z.string().min(1).max(1024) })

export const SecondFactorStatusSchema = z.object({
  state: SecondFactorStateSchema,
  /** How many recovery codes are still unused (0 when nothing is enrolled). */
  recoveryCodesLeft: z.number().int().min(0),
  /** An authenticator app is enrolled. */
  totp: z.boolean(),
  /** Passkeys enrolled, by credential ID and when each was added. */
  passkeys: z.array(z.object({ id: z.string(), at: z.number() })),
  /** The deployment can take passkeys (TSMYADMIN_PASSKEY_ORIGIN is set). */
  passkeysAvailable: z.boolean(),
})
export type SecondFactorStatus = z.infer<typeof SecondFactorStatusSchema>

/**
 * Other accounts on this server that have a second factor and whose sign-in this account could already take over
 * (it could change their password): the ones an operator may reset for someone who lost their device. Its own
 * is never listed — that goes through the security tab, with a code.
 */
export const AccountSecondFactorsSchema = z.object({ accounts: z.array(z.string()) })
export type AccountSecondFactors = z.infer<typeof AccountSecondFactorsSchema>

export const ResetSecondFactorRequestSchema = z.object({ user: z.string().min(1).max(256) })
