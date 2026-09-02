import { z } from 'zod'

export const RoutineInfoSchema = z.object({
  name: z.string(),
  kind: z.enum(['procedure', 'function']),
  language: z.string().nullable(),
  /** Return type for functions, null for procedures. */
  returns: z.string().nullable(),
  /** Parameter list as the dialect prints it, e.g. "IN uid int" / "uid integer". */
  parameters: z.string(),
  comment: z.string().nullable(),
  /** sql_mode the routine was created under (MySQL; restored programs must run with the same one). */
  sqlMode: z.string().nullable().default(null),
})
export type RoutineInfo = z.infer<typeof RoutineInfoSchema>

export const RoutineKindSchema = RoutineInfoSchema.shape.kind
export type RoutineKind = z.infer<typeof RoutineKindSchema>

/** Definition of one routine, fetched on demand (MySQL SHOW CREATE is one round trip per routine). */
export const RoutineDefinitionSchema = z.object({
  /** CREATE statement (all overloads joined on PostgreSQL); null when the account may not read it. */
  definition: z.string().nullable(),
})
export type RoutineDefinition = z.infer<typeof RoutineDefinitionSchema>

export const TriggerInfoSchema = z.object({
  name: z.string(),
  table: z.string(),
  /** BEFORE / AFTER / INSTEAD OF */
  timing: z.string(),
  /** INSERT, UPDATE, DELETE (comma-joined when several). */
  events: z.string(),
  /** ROW / STATEMENT */
  orientation: z.string(),
  definition: z.string().nullable(),
  /** sql_mode the trigger was created under (MySQL). */
  sqlMode: z.string().nullable().default(null),
  /** `user@host` that owns the trigger (MySQL); kept in dumps unless DEFINER clauses are stripped. */
  definer: z.string().nullable().default(null),
})
export type TriggerInfo = z.infer<typeof TriggerInfoSchema>
