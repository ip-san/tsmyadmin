import { z } from 'zod'
import { RowKeySchema } from './row-key.ts'

/** What a foreign key does to the rows that refer to a deleted row (its ON DELETE). */
export const DeleteActionSchema = z.enum(['cascade', 'setNull', 'setDefault', 'restrict', 'noAction'])
export type DeleteAction = z.infer<typeof DeleteActionSchema>

/**
 * A key's ON DELETE as both servers report it (`CASCADE`, `SET NULL`, …). A key that reports none does nothing,
 * which is what NO ACTION means.
 */
export function deleteActionOf(onDelete: string | null): DeleteAction {
  switch (onDelete?.toUpperCase()) {
    case 'CASCADE':
      return 'cascade'
    case 'SET NULL':
      return 'setNull'
    case 'SET DEFAULT':
      return 'setDefault'
    case 'RESTRICT':
      return 'restrict'
    default:
      return 'noAction'
  }
}

/** The rows a delete would ask for, by the same keys the delete itself takes. */
export const DeleteImpactRequestSchema = z.object({ keys: z.array(RowKeySchema).min(1).max(100) })

/**
 * One key followed: the rows of `table` that refer, through `constraint`, to rows of `refTable` the delete reaches
 * at `depth - 1`. Rows reached along two keys are counted on each.
 */
export const DeleteImpactStepSchema = z.object({
  depth: z.number().int().min(1),
  table: z.string(),
  constraint: z.string(),
  columns: z.array(z.string()),
  refTable: z.string(),
  action: DeleteActionSchema,
  rows: z.number(),
})
export type DeleteImpactStep = z.infer<typeof DeleteImpactStepSchema>

/**
 * What deleting rows would reach, without deleting them. `blocked`: a key that refuses (RESTRICT, NO ACTION) still
 * has rows referring, so the delete would fail. `capped`: the walk stopped at the depth limit with keys left to follow.
 */
export const DeleteImpactSchema = z.object({
  table: z.string(),
  rows: z.number(),
  steps: z.array(DeleteImpactStepSchema),
  blocked: z.boolean(),
  capped: z.boolean(),
})
export type DeleteImpact = z.infer<typeof DeleteImpactSchema>

/** As deep as MySQL follows ON DELETE CASCADE before it gives up: a walk past it would describe a delete that fails. */
export const DELETE_IMPACT_MAX_DEPTH = 15
