import { z } from 'zod'
import { DialectSchema } from './dialect.ts'

/** Operator-defined connection preset (no credentials). Configured with TSMYADMIN_SERVERS. */
export const ServerPresetSchema = z.object({
  name: z.string().min(1),
  dialect: DialectSchema,
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  database: z.string().min(1).optional(),
})
export type ServerPreset = z.infer<typeof ServerPresetSchema>
export const ServerPresetsSchema = z.array(ServerPresetSchema)
