import { z } from 'zod'
import { RelationDefSchema, TableKindSchema } from './structure.ts'

/** A saved copy of one database (or PostgreSQL schema) that it can be put back to: kept by the server, in memory. */
export const SnapshotSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  /** When it was taken (ISO 8601). */
  at: z.string(),
  /** What it takes in memory: the dump, and the definitions kept beside it to compare the schema with. */
  bytes: z.number().int().min(0),
  /** Tables and views it holds. */
  objects: z.number().int().min(0),
})
export type Snapshot = z.infer<typeof SnapshotSchema>

export const SnapshotListSchema = z.object({
  snapshots: z.array(SnapshotSchema),
  /** The most a database keeps, and the most bytes one dump may take: what "too many / too large" is measured by. */
  maxCount: z.number().int(),
  maxBytes: z.number().int(),
})
export type SnapshotList = z.infer<typeof SnapshotListSchema>

export const SnapshotCreateSchema = z.object({ name: z.string().trim().min(1).max(80) })
export type SnapshotCreate = z.infer<typeof SnapshotCreateSchema>

/** What putting a snapshot back would do, before it does it. */
export const SnapshotRestorePreviewSchema = z.object({
  snapshot: SnapshotSchema,
  /** Statements of the dump that will run. */
  statements: z.number().int().min(0),
  /** The statements that remove what the snapshot does not have (tables and views made since). */
  drops: z.array(z.string()),
})
export type SnapshotRestorePreview = z.infer<typeof SnapshotRestorePreviewSchema>

export const SnapshotRestoreResultSchema = z.object({
  statements: z.number().int().min(0),
  failed: z.number().int().min(0),
  /** The first errors, as the server printed them. */
  errors: z.array(z.string()),
  durationMs: z.number(),
})
export type SnapshotRestoreResult = z.infer<typeof SnapshotRestoreResultSchema>

/** One table or view in a comparison: its definition (CREATE statements) then and now, null where it has none. */
export const SnapshotDiffEntrySchema = z.object({
  name: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
})
export type SnapshotDiffEntry = z.infer<typeof SnapshotDiffEntrySchema>

/** The tables and views a snapshot held, and the foreign keys between them: what draws its schema on a diagram. */
export const SnapshotShapeSchema = z.object({
  tables: z.array(z.object({ name: z.string(), kind: TableKindSchema })),
  relations: z.array(RelationDefSchema),
})
export type SnapshotShape = z.infer<typeof SnapshotShapeSchema>

/**
 * What changed in the schema since a snapshot was taken (a migration, say): the tables and views made since, the
 * ones gone, and the ones whose definition differs. Row values are not compared, nor counters that move with them
 * (MySQL's AUTO_INCREMENT=, a sequence's position).
 */
export const SnapshotDiffSchema = z.object({
  snapshot: SnapshotSchema,
  /** The schema as it was, to draw what is gone. */
  shape: SnapshotShapeSchema,
  added: z.array(SnapshotDiffEntrySchema),
  removed: z.array(SnapshotDiffEntrySchema),
  changed: z.array(SnapshotDiffEntrySchema),
  /** How many are the same as they were. */
  unchanged: z.number().int().min(0),
  /** In both, but one of the two definitions could not be read (a view this account cannot SHOW): not compared. */
  unreadable: z.array(z.string()),
})
export type SnapshotDiff = z.infer<typeof SnapshotDiffSchema>
