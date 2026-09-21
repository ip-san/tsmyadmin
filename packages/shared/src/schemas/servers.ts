import { z } from 'zod'
import { DialectSchema } from './dialect.ts'

/**
 * Operator-defined connection preset (no credentials). Configured with TSMYADMIN_SERVERS. Strict so a
 * `password` (never accepted) or a misspelled key fails at startup instead of being silently dropped.
 */
export const ServerPresetSchema = z.strictObject({
  name: z.string().min(1),
  dialect: DialectSchema,
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  database: z.string().min(1).optional(),
  /**
   * Only ever set by Docker discovery, and only with TSMYADMIN_DOCKER_LOGIN: the server holds the container's own
   * login for this preset and signs in with it (`dockerPreset` of a login). It carries no credential itself.
   */
  autoLogin: z.literal(true).optional(),
})
export type ServerPreset = z.infer<typeof ServerPresetSchema>
export const ServerPresetsSchema = z.array(ServerPresetSchema)

/**
 * Why a database container is not on the login screen's list, or is on it but cannot be reached: `stopped`, running
 * without a published port (`notPublished`; `port` is the usual one to publish), or published on a port this process
 * cannot open (`unreachable`).
 */
export const DiscoveryIssueSchema = z.object({
  name: z.string(),
  dialect: DialectSchema,
  reason: z.enum(['stopped', 'notPublished', 'unreachable']),
  port: z.number().int().nullable(),
})
export type DiscoveryIssue = z.infer<typeof DiscoveryIssueSchema>

/** What Docker discovery can say to someone who cannot find or reach their database (development only). */
export const DiscoveryDiagnosisSchema = z.object({
  /** False when discovery is off: there is nothing to diagnose. */
  enabled: z.boolean(),
  /** The host name discovery reaches published ports by (what `unreachable` was tried against). */
  connectHost: z.string(),
  /** Why Docker itself could not be read (no socket, no permission); null when it could. */
  unavailable: z.string().nullable(),
  /** How many containers are on the list. */
  found: z.number().int().min(0),
  issues: z.array(DiscoveryIssueSchema),
})
export type DiscoveryDiagnosis = z.infer<typeof DiscoveryDiagnosisSchema>
