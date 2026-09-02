import { z } from 'zod'

export const RoutineInfoSchema = z.object({
  name: z.string(),
  /** 'package' / 'package body' are MariaDB (Oracle-mode) packages: listed and dumped, never created here. */
  kind: z.enum(['procedure', 'function', 'package', 'package body']),
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
  /**
   * The complete CREATE TRIGGER statement as the server prints it (MySQL: SHOW CREATE TRIGGER, DEFINER included;
   * PostgreSQL: pg_get_triggerdef). MySQL falls back to the body alone when SHOW CREATE is not permitted.
   */
  definition: z.string().nullable(),
  /** sql_mode the trigger was created under (MySQL). */
  sqlMode: z.string().nullable().default(null),
  /** `user@host` that owns the trigger (MySQL); kept in dumps unless DEFINER clauses are stripped. */
  definer: z.string().nullable().default(null),
  /** PostgreSQL firing mode (`tgenabled`): origin (default), always, replica, or disabled (the dump restores it). */
  fireMode: z.enum(['origin', 'always', 'replica', 'disabled']).default('origin'),
})
export type TriggerInfo = z.infer<typeof TriggerInfoSchema>

/**
 * Catalog dependency of a view or a routine on other objects of the namespace, by name (routine overloads share
 * one entry). Used to order a dump; servers without such a catalog (MariaDB) report null instead.
 */
export const ObjectDependencySchema = z.object({
  kind: z.enum(['view', 'routine']),
  name: z.string(),
  dependsOn: z.array(z.object({ kind: z.enum(['table', 'view', 'routine']), name: z.string() })),
})
export type ObjectDependency = z.infer<typeof ObjectDependencySchema>
