import { z } from 'zod'

export const RoutineInfoSchema = z.object({
  name: z.string(),
  kind: z.enum(['procedure', 'function']),
  language: z.string().nullable(),
  /** Return type for functions, null for procedures. */
  returns: z.string().nullable(),
  /** Parameter list as the dialect prints it, e.g. "IN uid int" / "uid integer". */
  parameters: z.string(),
  /** Full definition (CREATE statement or body) when the account may read it, else null. */
  definition: z.string().nullable(),
  comment: z.string().nullable(),
})
export type RoutineInfo = z.infer<typeof RoutineInfoSchema>

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
})
export type TriggerInfo = z.infer<typeof TriggerInfoSchema>
